package telegram

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"sort"
	"strconv"
	"strings"

	"devdeck/backend/internal/agentcore/orchestration"
	"devdeck/backend/internal/domain"
)

// Publishing a whole PROJECT, and creating its sessions on demand.
//
// The model, end to end:
//
//	/init p-3460c4ff     binds THIS TOPIC to a project
//	<first message>      creates a NEW session and answers in it
//	/agents              picks which agent the next session starts on
//	/new                 replaces the active session with a fresh one
//	/resume              switches back to one of the last 5 sessions
//	/unpublish           releases the project
//
// The session is created by the FIRST message rather than mirrored from the
// worktrees that already exist, and that is the whole difference. Mirroring
// meant an operator opening Telegram to a wall of topics for sessions they
// were not thinking about, and it made the common case — "I want to ask this
// project something from my phone" — require a session to already exist. On
// demand means the destination is empty until you use it, and then it holds
// exactly one conversation.
//
// A destination keeps its session until /new replaces it, so a follow-up
// message continues the same conversation rather than starting a fresh one.
// That stickiness is recorded as an ordinary telegram_bindings row, which is
// what keeps inbound routing a pure (chat_id, message_thread_id) lookup with
// no "active session" pointer anywhere: the binding IS the pointer, and it is
// per-destination rather than global.
//
// One project = one TOPIC, and one topic = one ACTIVE session.
//
// Both halves are scoping decisions that make this manageable rather than
// noisy. Binding a project to a whole GROUP made it answer in every topic at
// once — a topic about something else would suddenly carry another project's
// transcript — so the binding records the destination the /init was sent
// from. And a destination holds exactly one live session, so there is never a
// question of which conversation a message continues: /new replaces it,
// /resume switches to an earlier one, and both are explicit acts.
//
// A forum group is not required. A DM is simply a chat with one destination
// (topic 0), so it holds one project and one session — which is the whole
// model, just without room for a second.

// activeSession is the one session bound to this project's destination, if
// any. At most one by construction: a binding is keyed by (chat, topic), and
// a project now owns exactly one of those.
func (b *Bridge) activeSession(project domain.TelegramProjectBinding) (domain.TelegramBinding, bool) {
	return b.bindingForChat(project.ChatID, project.TopicID)
}

// recentSessions lists the project's most recently touched threads, newest
// first, for /resume. Sourced from the agent_thread projection rather than
// from Telegram bindings, so a session started in the DevDeck app — the usual
// case — is resumable from the phone too.
func (b *Bridge) recentSessions(project domain.TelegramProjectBinding, limit int) []domain.AgentThread {
	anchor, ok := b.projectAnchorWorktree(project.ProjectID)
	if !ok {
		return nil
	}
	threads, err := b.store.AgentThreads(anchor.ID)
	if err != nil {
		log.Printf("telegram: list threads for %s: %v", anchor.ID, err)
		return nil
	}
	if len(threads) > limit {
		threads = threads[:limit]
	}
	return threads
}

// projectAnchorWorktree is the worktree a project's Telegram sessions run in.
//
// A thread needs a working directory — the reactor resolves a thread id to a
// worktree to get one (see InstanceFor in main.go) — so a session cannot
// float free of one. The root worktree is the right anchor: it is the
// project's checkout rather than a feature branch someone may delete, and it
// is what an operator asking "how is this project doing" means.
func (b *Bridge) projectAnchorWorktree(projectID string) (domain.Worktree, bool) {
	worktrees, err := b.store.WorktreesByProjectID(projectID)
	if err != nil || len(worktrees) == 0 {
		if err != nil {
			log.Printf("telegram: list worktrees for project %s: %v", projectID, err)
		}
		return domain.Worktree{}, false
	}
	for _, wt := range worktrees {
		if wt.Root {
			return wt, true
		}
	}
	// No row is flagged root (possible on older projects). Lowest id is at
	// least stable, which matters more here than which one it picks.
	sort.Slice(worktrees, func(i, j int) bool { return worktrees[i].ID < worktrees[j].ID })
	return worktrees[0], true
}

// createProjectSession mints a new agent thread for a project and binds it to
// one destination. Returns the new thread id.
//
// The id is "<anchorWorktree>::chat-N" — the same shape the frontend's own
// extra chat panes use (paneTree.ts, and NextChatSuffix server-side), so the
// session is an ordinary DevDeck chat that shows up in the app rather than a
// Telegram-only construct the UI knows nothing about.
//
// model is the destination's current /model pick, "" for none. It is a
// parameter rather than something looked up here because the only caller that
// has one (cmdNewProjectSession) has already deleted the row it lived on by the
// time this runs.
func (b *Bridge) createProjectSession(ctx context.Context, project domain.TelegramProjectBinding, chatID, topicID int64, model string) (string, error) {
	anchor, ok := b.projectAnchorWorktree(project.ProjectID)
	if !ok {
		return "", errors.New("project has no worktree to run a session in")
	}

	threadID := NextChatSuffix(b.knownThreadIDs(anchor.ID), anchor.ID)

	// project.Agent is /agents' choice; "" falls through to the default.
	// Fixed here and never changed afterwards — there is no command to
	// re-point a live thread at a different agent, which is exactly why
	// /agents chooses for the NEXT session rather than this one.
	instanceID := orchestration.InstanceIDForAgent(project.Agent)
	createPayload, err := json.Marshal(struct {
		InstanceID string `json:"instanceId"`
	}{InstanceID: string(instanceID)})
	if err != nil {
		return "", err
	}
	if _, err := b.dispatch(ctx, orchestration.Command{
		Type: orchestration.CmdThreadCreate, ThreadID: threadID, Payload: createPayload,
	}); err != nil {
		return "", err
	}

	// LastSeq at the thread's head: the session was created a moment ago, so
	// there is nothing before this point worth mirroring, and starting at 0
	// would re-send the thread.created bookkeeping event.
	head, err := b.headSeq(threadID)
	if err != nil {
		log.Printf("telegram: head seq for %s: %v", threadID, err)
		head = 0
	}
	if err := b.store.SetTelegramBinding(domain.TelegramBinding{
		ThreadID: threadID, ChatID: chatID, TopicID: topicID, LastSeq: head,
		// Carried forward, exactly as cmdNew does it for a thread publish, or
		// the choice would last exactly one session: /model writes the model on
		// the SESSION's row, and /new deletes that row. The operator would pick
		// a model, run the /new that /agents' own confirmation tells them to
		// run, and silently be back on the agent's default.
		Model: model,
	}); err != nil {
		return "", err
	}
	// Same reason as in handleResumeSelection: the LastSeq above is only honoured
	// on an INSERT — the upsert's ON CONFLICT never writes last_seq. A fresh id
	// normally means a fresh row, so this is belt to that braces; it costs one
	// statement and the alternative, should an id ever be re-issued, is the whole
	// of that thread's history landing in the topic.
	if err := b.store.SetTelegramBindingSeq(threadID, head); err != nil {
		log.Printf("telegram: session cursor for %s: %v", threadID, err)
	}
	return threadID, nil
}

// knownThreadIDs is every thread id that could collide with a new one for
// this worktree — from the engine AND from the store.
//
// The store half is load-bearing. The engine holds only what it has replayed
// into memory, and numbering a new session off that alone handed out an id a
// PREVIOUS conversation already owned: the binding then pointed at a thread
// full of unrelated history, and the "new session" the operator asked for
// silently never existed. Thread ids have to be unique against everything
// ever created, which is the store's answer, not the engine's.
func (b *Bridge) knownThreadIDs(worktreeID string) []string {
	ids := make([]string, 0, 16)
	for id := range b.engine.State().Threads {
		ids = append(ids, id)
	}
	threads, err := b.store.AgentThreads(worktreeID)
	if err != nil {
		// Degraded, not fatal: the engine's view alone is still a lower
		// bound, and refusing to make a session because the read failed is
		// worse than a small chance of the collision this guards against.
		log.Printf("telegram: list threads for %s: %v", worktreeID, err)
		return ids
	}
	for _, thread := range threads {
		ids = append(ids, thread.ID)
	}
	// Duplicates are fine — NextChatSuffix takes the maximum suffix it sees.
	return ids
}

// cmdInitProject handles /init <projectId>: this chat now belongs to a
// project, and its sessions are created as they are needed.
func (b *Bridge) cmdInitProject(ctx context.Context, m *Message, project domain.Project) {
	if _, ok := b.projectAnchorWorktree(project.ID); !ok {
		// Nothing to run a session in. Better said outright than discovered
		// when the first message produces an error instead of an answer.
		b.reply(ctx, m.Chat.ID, m.MessageThreadID,
			"project ini belum punya worktree, jadi belum ada tempat sesi bisa jalan. Buat worktree dulu di DevDeck.")
		return
	}

	// A chat already publishing a DIFFERENT project would interleave two
	// projects' sessions with no way to tell them apart.
	existing, err := b.store.TelegramProjectBindings()
	if err != nil {
		log.Printf("telegram: list project bindings: %v", err)
		b.reply(ctx, m.Chat.ID, m.MessageThreadID, "gagal menyimpan binding")
		return
	}
	for _, other := range existing {
		// (chat, topic), not chat: two projects in two topics of one forum is
		// the arrangement this scoping exists to allow.
		if other.ChatID == m.Chat.ID && other.TopicID == m.MessageThreadID && other.ProjectID != project.ID {
			b.reply(ctx, m.Chat.ID, m.MessageThreadID,
				"topic ini sudah dipakai project lain — /unpublish dulu")
			return
		}
	}

	// Carry the agent choice across a re-publish; losing it would silently
	// send the next session back to the default.
	agent := ""
	prev, err := b.store.TelegramProjectBindingByID(project.ID)
	if err == nil {
		agent = prev.Agent
		b.unpinProject(ctx, prev)
	} else if !errors.Is(err, sql.ErrNoRows) {
		log.Printf("telegram: lookup project binding %s: %v", project.ID, err)
		b.reply(ctx, m.Chat.ID, m.MessageThreadID, "gagal menyimpan binding")
		return
	}

	if err := b.store.SetTelegramProjectBinding(domain.TelegramProjectBinding{
		ProjectID: project.ID, ChatID: m.Chat.ID, TopicID: m.MessageThreadID, Agent: agent,
	}); err != nil {
		log.Printf("telegram: bind project %s: %v", project.ID, err)
		b.reply(ctx, m.Chat.ID, m.MessageThreadID, "gagal menyimpan binding")
		return
	}
	b.replyAndPinProject(ctx, project, m.Chat.ID, m.MessageThreadID)
}

// handleProjectMessage answers a message in a project-published chat that has
// no session of its own yet — the FIRST message in a fresh destination.
//
// This is where a session comes from: the message creates one, binds it here,
// and then runs as its first turn. Everything after it routes through the
// ordinary per-session path, because the binding written here is what
// bindingForChat finds next time.
func (b *Bridge) handleProjectMessage(ctx context.Context, m *Message, project domain.TelegramProjectBinding) {
	if pc, isCmd := ParseCommand(m.Text); isCmd {
		switch pc.Name {
		case "unpublish":
			b.unpublishProject(ctx, m, project)
			return
		case "status":
			b.replyProjectStatus(ctx, m, project)
			return
		case "agents":
			b.cmdAgentsForProject(ctx, m, project)
			return
		case "new":
			b.cmdNewProjectSession(ctx, m, project)
			return
		case "resume":
			b.cmdResume(ctx, m, project)
			return
		default:
			// Every other command acts on a session, and there is not one
			// here yet. Saying so beats the generic "not connected", which is
			// false — this chat is connected, just not to a session.
			b.reply(ctx, m.Chat.ID, m.MessageThreadID,
				"belum ada sesi di sini. Kirim pesan biasa untuk memulai sesi baru, atau /agents untuk pilih agent dulu.")
			return
		}
	}

	// A sticker, photo or voice note carries no instruction. Creating a
	// session for one would leave an empty conversation behind.
	text := strings.TrimSpace(m.Text)
	if text == "" {
		return
	}

	// No model: this destination has no session, so nothing has been picked
	// here yet — /model only exists once there is a session to act on.
	threadID, err := b.createProjectSession(ctx, project, m.Chat.ID, m.MessageThreadID, "")
	if err != nil {
		log.Printf("telegram: create session for project %s: %v", project.ProjectID, err)
		b.reply(ctx, m.Chat.ID, m.MessageThreadID, "gagal membuat sesi baru")
		return
	}

	binding, err := b.store.TelegramBindingByThread(threadID)
	if err != nil {
		log.Printf("telegram: read new binding %s: %v", threadID, err)
		b.reply(ctx, m.Chat.ID, m.MessageThreadID, "gagal membuat sesi baru")
		return
	}
	b.reply(ctx, m.Chat.ID, m.MessageThreadID, "🆕 sesi baru — "+b.agentLabel(project.Agent)+". /new untuk sesi lain.")
	b.startTurn(ctx, m, binding, m.Text)
}

// cmdNewProjectSession handles /new: replace this destination's active
// session with a fresh one.
//
// It no longer opens a topic. Creating one needed the bot to be an admin with
// can_manage_topics — a permission it usually does not have, which turned an
// everyday command into "gagal membuat topic baru" — and with one project per
// topic there is nowhere for a second session to live anyway. The previous
// thread is released, not deleted: it stays in DevDeck and /resume brings it
// back.
func (b *Bridge) cmdNewProjectSession(ctx context.Context, m *Message, project domain.TelegramProjectBinding) {
	chatID, topicID := project.ChatID, project.TopicID

	// Read BEFORE the delete: the outgoing session's row is the only record of
	// this destination's /model pick, and /new is precisely what /agents tells
	// the operator to run next.
	model := ""
	if old, bound := b.activeSession(project); bound {
		model = b.carryModel(old.ThreadID, orchestration.InstanceIDForAgent(project.Agent), old.Model)
		// Released first, so the destination is never briefly claimed by two
		// sessions at once.
		b.UnpinBinding(ctx, old)
		if err := b.store.DeleteTelegramBinding(old.ThreadID); err != nil {
			log.Printf("telegram: release session %s: %v", old.ThreadID, err)
		}
	}

	threadID, err := b.createProjectSession(ctx, project, chatID, topicID, model)
	if err != nil {
		log.Printf("telegram: create session for project %s: %v", project.ProjectID, err)
		b.reply(ctx, chatID, topicID, "gagal membuat sesi baru")
		return
	}
	b.reply(ctx, chatID, topicID, "🆕 sesi baru `"+escapeMarkdownV2Code(threadID)+"` — "+b.agentLabel(project.Agent)+". /resume untuk kembali ke sesi sebelumnya.")
}

// cmdResume offers the project's last few sessions so an operator can go back
// to one instead of losing it to a /new. Tapping re-points this destination;
// nothing is created and nothing is deleted.
func (b *Bridge) cmdResume(ctx context.Context, m *Message, project domain.TelegramProjectBinding) {
	threads := b.recentSessions(project, resumeListSize)
	if len(threads) == 0 {
		b.reply(ctx, m.Chat.ID, m.MessageThreadID, "belum ada sesi untuk di-resume. Kirim pesan biasa untuk memulai.")
		return
	}
	active, hasActive := b.activeSession(project)

	kb := make(InlineKeyboard, 0, len(threads))
	for _, thread := range threads {
		if hasActive && thread.ID == active.ThreadID {
			// Listed but not tappable: resuming what is already open would
			// re-point the binding to itself and read as a no-op bug.
			kb = append(kb, []InlineButton{{Text: "✅ " + resumeLabel(thread) + " (aktif)", CallbackData: noopCallback}})
			continue
		}
		kb = append(kb, []InlineButton{{
			Text:         resumeLabel(thread),
			CallbackData: b.mintCallback(callbackTarget{Kind: cbResume, ProjectID: project.ProjectID, ThreadID: thread.ID}),
		}})
	}

	if err := b.callWithRetry(ctx, func() error {
		_, err := b.client.SendMessage(ctx, SendOptions{
			ChatID: m.Chat.ID, TopicID: m.MessageThreadID,
			Text:     EscapeMarkdownV2("sesi terakhir — pilih untuk lanjut di topic ini:"),
			Keyboard: kb,
		})
		return err
	}); err != nil {
		log.Printf("telegram: send resume picker: %v", err)
	}
}

// handleResumeSelection re-points this destination at an earlier session.
func (b *Bridge) handleResumeSelection(ctx context.Context, cq *CallbackQuery, target callbackTarget) {
	project, err := b.store.TelegramProjectBindingByID(target.ProjectID)
	if err != nil {
		log.Printf("telegram: lookup project %s: %v", target.ProjectID, err)
		b.answerCallback(ctx, cq.ID, "project ini sudah tidak terhubung")
		return
	}
	if old, bound := b.activeSession(project); bound && old.ThreadID != target.ThreadID {
		b.UnpinBinding(ctx, old)
		if err := b.store.DeleteTelegramBinding(old.ThreadID); err != nil {
			log.Printf("telegram: release session %s: %v", old.ThreadID, err)
		}
	}
	// Head, not 0: resuming must not re-mirror the whole conversation into
	// the topic. The transcript is already in DevDeck; Telegram picks up from
	// the next thing that happens.
	head, err := b.headSeq(target.ThreadID)
	if err != nil {
		log.Printf("telegram: head seq for %s: %v", target.ThreadID, err)
		head = 0
	}
	if err := b.store.SetTelegramBinding(domain.TelegramBinding{
		ThreadID: target.ThreadID, ChatID: project.ChatID, TopicID: project.TopicID, LastSeq: head,
	}); err != nil {
		log.Printf("telegram: resume session %s: %v", target.ThreadID, err)
		b.answerCallback(ctx, cq.ID, "gagal pindah sesi")
		return
	}
	// The LastSeq above only lands when the row is NEW: SetTelegramBinding's ON
	// CONFLICT deliberately never writes last_seq, so that a re-point cannot
	// rewind a cursor. A session that is still published elsewhere (its own
	// /init, in another chat) therefore keeps that destination's cursor and
	// mirrors its entire conversation into this topic. The narrow setter is what
	// actually moves it.
	if err := b.store.SetTelegramBindingSeq(target.ThreadID, head); err != nil {
		log.Printf("telegram: resume cursor for %s: %v", target.ThreadID, err)
	}
	b.forgetCallback(cq.Data)
	b.answerCallback(ctx, cq.ID, "")
	b.editCallbackMessage(ctx, cq.Message, EscapeMarkdownV2("▶️ lanjut di sesi "+target.ThreadID))
}

// resumeLabel names a session in the picker. The projected title is the last
// thing the user actually said in it, which is what makes one session
// distinguishable from another; the id is the fallback for a thread that
// never got a message.
func resumeLabel(thread domain.AgentThread) string {
	title := strings.TrimSpace(thread.Title)
	if title == "" {
		return thread.ID
	}
	const maxLabel = 48
	r := []rune(title)
	if len(r) > maxLabel {
		return string(r[:maxLabel]) + "…"
	}
	return title
}

// cmdAgents offers the agent picker. Tapping records the choice for NEW
// sessions — a live thread's agent is fixed at thread.create and no command
// changes it, so silently swapping one would either be a lie or would destroy
// the conversation to make it true.
// agentScope is what an /agents choice is recorded against. A project
// destination creates its sessions from the project (createProjectSession); a
// destination publishing a single thread creates them with /new. Both fix the
// agent at thread.create, so both can only choose for the NEXT session — the
// difference is only which row remembers it.
type agentScope struct {
	// ProjectID is set for a project destination, ThreadID for a single
	// published thread. Exactly one is non-empty.
	ProjectID string
	ThreadID  string
	Current   string
}

func (b *Bridge) projectAgentScope(project domain.TelegramProjectBinding) agentScope {
	return agentScope{ProjectID: project.ProjectID, Current: project.Agent}
}

func (b *Bridge) threadAgentScope(binding domain.TelegramBinding) agentScope {
	return agentScope{ThreadID: binding.ThreadID, Current: binding.Agent}
}

func (b *Bridge) cmdAgentsForProject(ctx context.Context, m *Message, project domain.TelegramProjectBinding) {
	b.cmdAgents(ctx, m, b.projectAgentScope(project))
}

// cmdAgentsForThread serves a destination publishing ONE thread — an SSH
// connection, typically. Before this, /agents there answered "only works in a
// chat that publishes a project", which left an SSH publish with no way to
// pick its agent from Telegram at all.
func (b *Bridge) cmdAgentsForThread(ctx context.Context, m *Message, binding domain.TelegramBinding) {
	b.cmdAgents(ctx, m, b.threadAgentScope(binding))
}

func (b *Bridge) cmdAgents(ctx context.Context, m *Message, scope agentScope) {
	if b.listAgents == nil {
		b.reply(ctx, m.Chat.ID, m.MessageThreadID, "daftar agent tidak tersedia di proses ini")
		return
	}
	agents, err := b.listAgents()
	if err != nil {
		log.Printf("telegram: list agents: %v", err)
		b.reply(ctx, m.Chat.ID, m.MessageThreadID, "gagal memuat daftar agent")
		return
	}

	kb := make(InlineKeyboard, 0, len(agents))
	for _, agent := range agents {
		// An uninstalled agent is shown, not hidden — its absence is a
		// machine problem the operator can fix, and a silently short list
		// would just look like the agent does not exist. It is not tappable,
		// though: picking it would produce a session that fails every turn.
		label := agent.Name
		if !agent.Installed {
			kb = append(kb, []InlineButton{{Text: "🚫 " + label + " (belum terpasang)", CallbackData: noopCallback}})
			continue
		}
		if agent.ID == scope.Current {
			label = "✅ " + label
		}
		kb = append(kb, []InlineButton{{
			Text: label,
			CallbackData: b.mintCallback(callbackTarget{
				Kind: cbAgent, ProjectID: scope.ProjectID, ThreadID: scope.ThreadID, Agent: agent.ID,
			}),
		}})
	}
	if len(kb) == 0 {
		b.reply(ctx, m.Chat.ID, m.MessageThreadID, "tidak ada agent tersedia")
		return
	}

	if err := b.callWithRetry(ctx, func() error {
		_, err := b.client.SendMessage(ctx, SendOptions{
			ChatID: m.Chat.ID, TopicID: m.MessageThreadID,
			Text:     EscapeMarkdownV2("pilih agent untuk sesi berikutnya (sesi yang sedang jalan tidak berubah — agent-nya dikunci saat sesi dibuat):"),
			Keyboard: kb,
		})
		return err
	}); err != nil {
		log.Printf("telegram: send agent picker: %v", err)
	}
}

// agentLabel renders an agent id for a confirmation line, preferring the
// human name the catalog knows.
func (b *Bridge) agentLabel(agentID string) string {
	if agentID == "" {
		return "agent default"
	}
	if b.listAgents != nil {
		if agents, err := b.listAgents(); err == nil {
			for _, agent := range agents {
				if agent.ID == agentID {
					return agent.Name
				}
			}
		}
	}
	return agentID
}

// unpublishProject releases the project and every session bound in its chat.
// The forum topics themselves are left alone: this bridge created them, but
// they hold the transcript, and deleting an operator's history to undo a
// subscription is not a trade it gets to make on their behalf.
func (b *Bridge) unpublishProject(ctx context.Context, m *Message, project domain.TelegramProjectBinding) {
	b.unpinProject(ctx, project)

	released := 0
	if active, ok := b.activeSession(project); ok {
		b.UnpinBinding(ctx, active)
		if err := b.store.DeleteTelegramBinding(active.ThreadID); err != nil {
			log.Printf("telegram: unpublish session %s: %v", active.ThreadID, err)
		} else {
			released++
		}
	}

	if err := b.store.DeleteTelegramProjectBinding(project.ProjectID); err != nil {
		log.Printf("telegram: unpublish project %s: %v", project.ProjectID, err)
		b.reply(ctx, m.Chat.ID, m.MessageThreadID, "gagal melepas publikasi")
		return
	}
	b.reply(ctx, m.Chat.ID, m.MessageThreadID,
		"project ini sudah tidak terhubung ke topic ini ("+plural(released, "sesi")+" dilepas). Sesinya tetap ada di DevDeck.")
}

// replyProjectStatus reports what this chat is wired to. Its real job is
// naming the agent that new sessions will use, which is otherwise invisible.
func (b *Bridge) replyProjectStatus(ctx context.Context, m *Message, project domain.TelegramProjectBinding) {
	name := project.ProjectID
	if p, err := b.store.ProjectByID(project.ProjectID); err == nil && p.Name != "" {
		name = p.Name
	}
	text := "📦 " + name + "\nagent sesi berikutnya: " + b.agentLabel(project.Agent)
	if active, ok := b.activeSession(project); ok {
		text += "\nsesi aktif: " + active.ThreadID
	} else {
		text += "\nbelum ada sesi aktif — kirim pesan biasa untuk memulai"
	}
	if recent := b.recentSessions(project, resumeListSize); len(recent) > 0 {
		text += "\n" + plural(len(recent), "sesi") + " bisa di-/resume"
	}
	b.reply(ctx, m.Chat.ID, m.MessageThreadID, text)
}

// replyAndPinProject sends the project's confirmation and pins it, the same
// bookmark role the per-session /init confirmation has.
func (b *Bridge) replyAndPinProject(ctx context.Context, project domain.Project, chatID, topicID int64) {
	text := "📦 project `" + escapeMarkdownV2Code(project.ID) + "` — *" + EscapeMarkdownV2(project.Name) + "*\n" +
		EscapeMarkdownV2("project ini cuma aktif di topic ini. Kirim pesan biasa untuk memulai sesi; sesi itu dipakai sampai /new.") + "\n" +
		EscapeMarkdownV2("/new sesi baru · /resume kembali ke sesi lama · /agents pilih agent") + "\n" +
		EscapeMarkdownV2("/permissions atur konfirmasi · /model · /status · /unpublish.")

	var msg Message
	if err := b.callWithRetry(ctx, func() error {
		m, err := b.client.SendMessage(ctx, SendOptions{ChatID: chatID, TopicID: topicID, Text: text})
		if err != nil {
			return err
		}
		msg = m
		return nil
	}); err != nil {
		log.Printf("telegram: reply chat %d: %v", chatID, err)
		return
	}
	if msg.MessageID == 0 {
		return
	}
	if err := b.client.PinChatMessage(ctx, chatID, msg.MessageID); err != nil {
		log.Printf("telegram: pin chat %d message %d: %v", chatID, msg.MessageID, err)
		b.warnCannotPin(ctx, chatID, topicID, err)
		return
	}
	if err := b.store.SetTelegramProjectBindingPin(project.ID, msg.MessageID); err != nil {
		log.Printf("telegram: record project pin %s: %v", project.ID, err)
	}
}

func (b *Bridge) unpinProject(ctx context.Context, project domain.TelegramProjectBinding) {
	if project.PinnedMessageID == 0 {
		return
	}
	if err := b.client.UnpinChatMessage(ctx, project.ChatID, project.PinnedMessageID); err != nil {
		log.Printf("telegram: unpin chat %d message %d: %v", project.ChatID, project.PinnedMessageID, err)
	}
}

// projectElsewhereInChat reports a project published in this chat but in a
// DIFFERENT topic from the one a message arrived in.
//
// It exists because the alternative — staying silent — produced the worst
// failure this feature has had: the operator publishes a project, types, and
// nothing happens anywhere, with no reply and no log line. Being told which
// topic to type in is the whole fix.
func (b *Bridge) projectElsewhereInChat(chatID, topicID int64) (domain.TelegramProjectBinding, bool) {
	projects, err := b.store.TelegramProjectBindings()
	if err != nil {
		log.Printf("telegram: list project bindings: %v", err)
		return domain.TelegramProjectBinding{}, false
	}
	for _, project := range projects {
		if project.ChatID == chatID && project.TopicID != topicID {
			return project, true
		}
	}
	return domain.TelegramProjectBinding{}, false
}

// wrongTopicHint names the project and where it actually lives. The topic id
// is included because Telegram gives an operator no other way to identify a
// topic from the outside, and "the other topic" is not an instruction.
func (b *Bridge) wrongTopicHint(project domain.TelegramProjectBinding) string {
	name := project.ProjectID
	if p, err := b.store.ProjectByID(project.ProjectID); err == nil && p.Name != "" {
		name = p.Name
	}
	if project.TopicID == 0 {
		return "project " + name + " terhubung di topic General, bukan di sini. Ketik di sana, atau /init " + project.ProjectID + " untuk memindahkannya ke topic ini."
	}
	return "project " + name + " terhubung di topic lain (id " + strconv.FormatInt(project.TopicID, 10) + "), bukan di sini. Ketik di sana, atau /init " + project.ProjectID + " untuk memindahkannya ke topic ini."
}

// projectBindingForDestination is the project-level counterpart to
// bindingForChat, and matches the SAME (chat, topic) pair it does.
//
// Matching on chat alone — which this used to do — is what made a published
// project answer in every topic of a group at once. Scoped to the
// destination, an unrelated topic in the same group stays unrelated, and one
// forum can hold several projects.
func (b *Bridge) projectBindingForDestination(chatID, topicID int64) (domain.TelegramProjectBinding, bool) {
	projects, err := b.store.TelegramProjectBindings()
	if err != nil {
		log.Printf("telegram: list project bindings: %v", err)
		return domain.TelegramProjectBinding{}, false
	}
	for _, project := range projects {
		if project.ChatID == chatID && project.TopicID == topicID {
			return project, true
		}
	}
	return domain.TelegramProjectBinding{}, false
}

// plural renders a count with its Indonesian noun. Indonesian has no plural
// inflection, so this is only ever "<n> <noun>" — it exists so the call sites
// read as sentences rather than as concatenation with a strconv in the middle.
func plural(n int, noun string) string {
	return strconv.Itoa(n) + " " + noun
}

// handleAgentSelection records the tapped agent as the project's choice for
// new sessions. It deliberately does NOT touch the session the operator is
// looking at: that thread's agent was fixed at thread.create and there is no
// command to re-point it, so the honest options are "apply to the next
// session" or "destroy this conversation to make the label true".
//
// The one thing it does clear is the destination's /model pick, and only when
// the agent genuinely changed: a model id is meaningful inside exactly one
// agent's catalog (see carryModel).
func (b *Bridge) handleAgentSelection(ctx context.Context, cq *CallbackQuery, target callbackTarget) {
	var err error
	// Whether this tap actually CHANGES the agent, read before the write.
	// Re-tapping the already-ticked entry is an ordinary thing to do (the
	// picker marks it with a ✅, which invites confirmation) and must not have
	// the side effect below.
	changed := false
	if target.ProjectID != "" {
		prev, perr := b.store.TelegramProjectBindingByID(target.ProjectID)
		changed = perr == nil && prev.Agent != target.Agent
		err = b.store.SetTelegramProjectBindingAgent(target.ProjectID, target.Agent)
	} else {
		prev, berr := b.store.TelegramBindingByThread(target.ThreadID)
		changed = berr == nil && prev.Agent != target.Agent
		err = b.store.SetTelegramBindingAgent(target.ThreadID, target.Agent)
	}
	if err != nil {
		log.Printf("telegram: set agent (project=%q thread=%q): %v", target.ProjectID, target.ThreadID, err)
		b.answerCallback(ctx, cq.ID, "gagal menyimpan pilihan agent")
		return
	}
	b.forgetCallback(cq.Data)
	b.answerCallback(ctx, cq.ID, "")

	// Telegram omits the message on a callback whose card is older than 48
	// hours, and on an inline-mode callback there is never one at all. The
	// choice above is already saved and the tap already answered; what is
	// missing is the card to edit and the (chat, topic) the session below is
	// resolved from. Dereferencing it anyway took down the poll goroutine —
	// and with it the entire bridge, since handleUpdate runs on it.
	if cq.Message == nil {
		log.Printf("telegram: agent %q recorded, but the callback carried no message to edit", target.Agent)
		return
	}

	label := b.agentLabel(target.Agent)
	// Whether a session is already running here decides what the operator
	// needs to be told — "it is set" versus "it is set, but not for this
	// conversation" — and getting that wrong is how a picker looks broken.
	session, running := b.bindingForChat(cq.Message.Chat.ID, cq.Message.MessageThreadID)
	if changed && running && session.Model != "" {
		// A model id belongs to the catalog it came from: "claude-opus-5" means
		// nothing to Codex, and Pi's mid-session set_model silently no-ops on an
		// id it cannot split into provider + model. Carrying the old pick into
		// the new agent's session is how "I switched agents and nothing
		// changed" happens — clear it so the new agent starts on its own
		// default and /model offers ITS catalog.
		if err := b.store.SetTelegramBindingModel(session.ThreadID, ""); err != nil {
			log.Printf("telegram: clear model for thread %s: %v", session.ThreadID, err)
		}
	}
	if running {
		b.editCallbackMessage(ctx, cq.Message,
			EscapeMarkdownV2("agent: "+label+" — berlaku untuk sesi berikutnya. /new untuk mulai sekarang."))
		return
	}
	b.editCallbackMessage(ctx, cq.Message,
		EscapeMarkdownV2("agent: "+label+" — kirim pesan untuk memulai sesi dengan agent ini."))
}
