package telegram

import (
	"context"
	"strings"
	"testing"
	"time"

	"devdeck/backend/internal/agentcore/orchestration"
	"devdeck/backend/internal/domain"
	"devdeck/backend/internal/store"
)

// seedProject builds a project with a root worktree — the anchor a Telegram
// session runs in — plus any extra branches, and returns the project id.
func seedProject(t *testing.T, st *store.Store, name string, extraBranches ...string) string {
	t.Helper()
	ws, err := st.CreateWorkspace("acme")
	if err != nil {
		t.Fatalf("workspace: %v", err)
	}
	project, err := st.CreateProject(ws.ID, name, "/tmp/"+name, "", "")
	if err != nil {
		t.Fatalf("project: %v", err)
	}
	if _, err := st.CreateWorktree(project.ID, "root", "main", "main", "", "", "", "/tmp/"+name); err != nil {
		t.Fatalf("root worktree: %v", err)
	}
	for _, branch := range extraBranches {
		if _, err := st.CreateWorktree(project.ID, "branch", branch, "main", "", "", "", "/tmp/"+name+"-"+branch); err != nil {
			t.Fatalf("worktree %s: %v", branch, err)
		}
	}
	return project.ID
}

func dm(chatID int64, text string) Update {
	return Update{Message: &Message{
		MessageID: 1, From: &User{ID: 42}, Chat: Chat{ID: chatID}, Text: text,
	}}
}

func forumMsg(chatID, topicID int64, text string) Update {
	return Update{Message: &Message{
		MessageID: 1, From: &User{ID: 42},
		Chat: Chat{ID: chatID, IsForum: true}, MessageThreadID: topicID, Text: text,
	}}
}

// The core of the feature: publishing a project does not mirror anything, and
// the first message is what brings a session into existence.
func TestFirstMessageCreatesASessionAndRunsIt(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	mustAllow(t, st, 42)
	projectID := seedProject(t, st, "devdeck")

	b.handleUpdate(context.Background(), dm(100, "/init "+projectID))

	// Nothing yet — the destination is empty until it is used.
	if bindings, _ := st.TelegramBindings(); len(bindings) != 0 {
		t.Fatalf("publishing a project pre-created sessions: %+v", bindings)
	}

	b.handleUpdate(context.Background(), dm(100, "kenapa build gagal?"))

	bindings, err := st.TelegramBindings()
	if err != nil {
		t.Fatalf("bindings: %v", err)
	}
	if len(bindings) != 1 {
		t.Fatalf("want exactly one session, got %+v", bindings)
	}
	if bindings[0].ChatID != 100 || bindings[0].TopicID != 0 {
		t.Fatalf("session bound to the wrong destination: %+v", bindings[0])
	}
	// And the message that created it is its first turn, not a message that
	// vanished into the act of setting up.
	th, ok := engine.State().Thread(bindings[0].ThreadID)
	if !ok {
		t.Fatalf("session thread %s does not exist", bindings[0].ThreadID)
	}
	if th.Status != orchestration.ThreadRunning {
		t.Fatalf("the first message did not start a turn: status=%v", th.Status)
	}
}

// The session is sticky: a follow-up continues the conversation instead of
// spawning a second session, which is what "sampai /new" means.
func TestFollowUpMessageStaysInTheSameSession(t *testing.T) {
	transport := &fakeTransport{}
	b, _, st := newTestBridge(t, transport)
	mustAllow(t, st, 42)
	projectID := seedProject(t, st, "devdeck")

	b.handleUpdate(context.Background(), dm(100, "/init "+projectID))
	b.handleUpdate(context.Background(), dm(100, "pertama"))
	first, _ := st.TelegramBindings()

	b.handleUpdate(context.Background(), dm(100, "lanjut"))
	second, _ := st.TelegramBindings()

	if len(second) != 1 {
		t.Fatalf("a follow-up created a second session: %+v", second)
	}
	if second[0].ThreadID != first[0].ThreadID {
		t.Fatalf("the follow-up moved to a different session: %s -> %s", first[0].ThreadID, second[0].ThreadID)
	}
}

// A DM has no topics, and that is fine: one destination, one session at a
// time. Refusing here would block the way an operator actually reaches this
// from their phone.
func TestProjectCanBePublishedToADM(t *testing.T) {
	transport := &fakeTransport{}
	b, _, st := newTestBridge(t, transport)
	mustAllow(t, st, 42)
	projectID := seedProject(t, st, "devdeck")

	b.handleUpdate(context.Background(), dm(100, "/init "+projectID))

	binding, err := st.TelegramProjectBindingByID(projectID)
	if err != nil {
		t.Fatalf("a DM was refused: %v", err)
	}
	if binding.ChatID != 100 {
		t.Fatalf("binding = %+v", binding)
	}
}

// /new replaces the destination's active session. It does NOT open a topic:
// that needed the bot to be an admin with can_manage_topics — which it
// usually is not, turning an everyday command into "gagal membuat topic
// baru" — and with one project per topic there is nowhere for a second
// session to live anyway. The old thread is released, not deleted.
func TestNewReplacesTheActiveSession(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	mustAllow(t, st, 42)
	projectID := seedProject(t, st, "devdeck")

	b.handleUpdate(context.Background(), dm(100, "/init "+projectID))
	b.handleUpdate(context.Background(), dm(100, "sesi pertama"))
	before, _ := st.TelegramBindings()

	b.handleUpdate(context.Background(), dm(100, "/new"))
	after, _ := st.TelegramBindings()

	if len(after) != 1 {
		t.Fatalf("the destination ended up with more than one session: %+v", after)
	}
	if after[0].ThreadID == before[0].ThreadID {
		t.Fatalf("/new reused the old session: %s", after[0].ThreadID)
	}
	if _, stillThere := engine.State().Thread(before[0].ThreadID); !stillThere {
		t.Fatal("/new destroyed the previous conversation instead of releasing it")
	}
}

// /agents chooses for the NEXT session, because a live thread's agent is
// fixed at thread.create. Silently swapping it would be a lie; destroying the
// conversation to make it true would be worse.
func TestAgentsChoiceAppliesToTheNextSession(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	mustAllow(t, st, 42)
	projectID := seedProject(t, st, "devdeck")

	b.handleUpdate(context.Background(), dm(100, "/init "+projectID))
	b.handleUpdate(context.Background(), dm(100, "/agents"))

	// The picker is a keyboard, and the uninstalled agent must be visible.
	last := transport.sent[len(transport.sent)-1]
	var labels, tokens []string
	for _, row := range last.Keyboard {
		labels = append(labels, row[0].Text)
		tokens = append(tokens, row[0].CallbackData)
	}
	joined := strings.Join(labels, "|")
	if !strings.Contains(joined, "Claude") || !strings.Contains(joined, "Codex") {
		t.Fatalf("picker is missing installed agents: %v", labels)
	}
	if !strings.Contains(joined, "OpenCode") {
		t.Fatalf("an uninstalled agent was hidden rather than marked: %v", labels)
	}

	// Tap Codex.
	var codexToken string
	for i, label := range labels {
		if strings.Contains(label, "Codex") {
			codexToken = tokens[i]
		}
	}
	if codexToken == "" {
		t.Fatal("no tappable token for Codex")
	}
	b.handleUpdate(context.Background(), Update{CallbackQuery: &CallbackQuery{
		ID: "cb1", From: &User{ID: 42}, Data: codexToken,
		Message: &Message{MessageID: 9, Chat: Chat{ID: 100}},
	}})

	project, err := st.TelegramProjectBindingByID(projectID)
	if err != nil {
		t.Fatalf("project binding: %v", err)
	}
	if project.Agent != "codex" {
		t.Fatalf("agent = %q, want codex", project.Agent)
	}

	// The next session actually starts on it.
	b.handleUpdate(context.Background(), dm(100, "halo"))
	bindings, _ := st.TelegramBindings()
	th, ok := engine.State().Thread(bindings[0].ThreadID)
	if !ok {
		t.Fatalf("no thread for %s", bindings[0].ThreadID)
	}
	if !strings.HasPrefix(string(th.InstanceID), "codex:") {
		t.Fatalf("new session ran on %q, want the picked codex", th.InstanceID)
	}
}

// An uninstalled agent is readable but not selectable — picking it would
// produce a session that fails every turn.
func TestUninstalledAgentIsNotSelectable(t *testing.T) {
	transport := &fakeTransport{}
	b, _, st := newTestBridge(t, transport)
	mustAllow(t, st, 42)
	projectID := seedProject(t, st, "devdeck")

	b.handleUpdate(context.Background(), dm(100, "/init "+projectID))
	b.handleUpdate(context.Background(), dm(100, "/agents"))

	last := transport.sent[len(transport.sent)-1]
	for _, row := range last.Keyboard {
		if strings.Contains(row[0].Text, "OpenCode") && row[0].CallbackData != noopCallback {
			t.Fatalf("uninstalled agent is tappable: %+v", row[0])
		}
	}
}

// A project with nowhere to run is refused up front, rather than accepted and
// then failing on the first message with something unrecognisable.
func TestInitProjectWithoutAWorktreeIsRefusedWithAReason(t *testing.T) {
	transport := &fakeTransport{}
	b, _, st := newTestBridge(t, transport)
	mustAllow(t, st, 42)
	ws, err := st.CreateWorkspace("acme")
	if err != nil {
		t.Fatalf("workspace: %v", err)
	}
	empty, err := st.CreateProject(ws.ID, "kosong", "/tmp/kosong", "", "")
	if err != nil {
		t.Fatalf("project: %v", err)
	}

	b.handleUpdate(context.Background(), dm(100, "/init "+empty.ID))

	if _, err := st.TelegramProjectBindingByID(empty.ID); err == nil {
		t.Fatal("a project with no worktree was published anyway")
	}
	if len(transport.sent) != 1 || !strings.Contains(transport.sent[0].Text, "worktree") {
		t.Fatalf("the reason was not explained: %+v", transport.sent)
	}
}

// A sticker or voice note carries no instruction. Creating a session for one
// would leave an empty conversation behind and burn a topic.
func TestTextlessMessageDoesNotCreateASession(t *testing.T) {
	transport := &fakeTransport{}
	b, _, st := newTestBridge(t, transport)
	mustAllow(t, st, 42)
	projectID := seedProject(t, st, "devdeck")

	b.handleUpdate(context.Background(), dm(100, "/init "+projectID))
	b.handleUpdate(context.Background(), dm(100, "   "))

	if bindings, _ := st.TelegramBindings(); len(bindings) != 0 {
		t.Fatalf("a textless message created a session: %+v", bindings)
	}
}

// /unpublish releases the project and every session bound in its chat, or the
// chat keeps receiving from sessions the operator believes they disconnected.
func TestUnpublishReleasesTheProjectAndItsSessions(t *testing.T) {
	transport := &fakeTransport{}
	b, _, st := newTestBridge(t, transport)
	mustAllow(t, st, 42)
	projectID := seedProject(t, st, "devdeck")

	b.handleUpdate(context.Background(), dm(100, "/init "+projectID))
	b.handleUpdate(context.Background(), dm(100, "sesi pertama"))

	b.handleUpdate(context.Background(), dm(100, "/unpublish"))

	if _, err := st.TelegramProjectBindingByID(projectID); err == nil {
		t.Fatal("the project binding survived /unpublish")
	}
	if bindings, _ := st.TelegramBindings(); len(bindings) != 0 {
		t.Fatalf("sessions still publish to a chat the operator disconnected: %+v", bindings)
	}
}

// Publishing a project must not break publishing one session — both ids are
// things an operator copies out of the UI.
func TestInitStillBindsASingleSessionWhenGivenAThreadID(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	mustAllow(t, st, 42)
	seedProject(t, st, "devdeck")
	seedThread(t, engine, "w-standalone")

	b.handleUpdate(context.Background(), dm(100, "/init w-standalone"))

	binding, err := st.TelegramBindingByThread("w-standalone")
	if err != nil {
		t.Fatalf("single-session /init broke: %v", err)
	}
	if binding.ChatID != 100 || binding.TopicID != 0 {
		t.Fatalf("binding = %+v, want the DM it was sent from", binding)
	}
}

// /status is where the agent choice becomes visible — it is otherwise a
// setting with no surface anywhere.
func TestProjectStatusNamesTheAgentForNewSessions(t *testing.T) {
	transport := &fakeTransport{}
	b, _, st := newTestBridge(t, transport)
	mustAllow(t, st, 42)
	projectID := seedProject(t, st, "devdeck")

	b.handleUpdate(context.Background(), dm(100, "/init "+projectID))
	if err := st.SetTelegramProjectBindingAgent(projectID, "codex"); err != nil {
		t.Fatalf("set agent: %v", err)
	}
	before := len(transport.sent)

	b.handleUpdate(context.Background(), dm(100, "/status"))

	sent := transport.sent[before:]
	if len(sent) == 0 || !strings.Contains(sent[0].Text, "Codex") {
		t.Fatalf("/status did not name the agent for new sessions: %+v", sent)
	}
}

// A project owns exactly one destination, so /unpublish sent from it is
// unambiguous: stop publishing.
func TestUnpublishFromTheProjectsTopicReleasesIt(t *testing.T) {
	transport := &fakeTransport{}
	b, _, st := newTestBridge(t, transport)
	mustAllow(t, st, 42)
	projectID := seedProject(t, st, "devdeck")

	b.handleUpdate(context.Background(), forumMsg(-100234, 7, "/init "+projectID))
	b.handleUpdate(context.Background(), forumMsg(-100234, 7, "sesi di topic 7"))

	b.handleUpdate(context.Background(), forumMsg(-100234, 7, "/unpublish"))

	if _, err := st.TelegramProjectBindingByID(projectID); err == nil {
		t.Fatal("the project binding survived /unpublish")
	}
	if bindings, _ := st.TelegramBindings(); len(bindings) != 0 {
		t.Fatalf("the session was not released: %+v", bindings)
	}
}

// The regression this scoping fixes: a project bound in one topic used to
// answer in EVERY topic of the group, so an unrelated topic suddenly carried
// another project's transcript.
func TestProjectOnlyRespondsInTheTopicItWasInitedIn(t *testing.T) {
	transport := &fakeTransport{}
	b, _, st := newTestBridge(t, transport)
	mustAllow(t, st, 42)
	projectID := seedProject(t, st, "devdeck")

	b.handleUpdate(context.Background(), forumMsg(-100234, 7, "/init "+projectID))
	before := len(transport.sent)

	// A message in a DIFFERENT topic of the same group.
	b.handleUpdate(context.Background(), forumMsg(-100234, 9, "ini topic lain, jangan diapa-apakan"))

	if bindings, _ := st.TelegramBindings(); len(bindings) != 0 {
		t.Fatalf("a message in an unrelated topic created a session: %+v", bindings)
	}
	// And it stays quiet there: an unbound topic in a group that publishes a
	// project elsewhere is ordinary human conversation, not somebody waiting
	// to be told how to publish. (General is the exception — see
	// TestMessageInGeneralSaysWhereTheProjectLives.)
	for _, sent := range transport.sent[before:] {
		if sent.TopicID == 9 {
			t.Fatalf("the bridge answered in an unrelated topic: %+v", sent)
		}
	}
}

// The flip side of scoping: one forum can hold several projects, one topic
// each, which is the arrangement that makes this manageable.
func TestTwoProjectsCanShareOneForum(t *testing.T) {
	transport := &fakeTransport{}
	b, _, st := newTestBridge(t, transport)
	mustAllow(t, st, 42)
	first := seedProject(t, st, "alpha")
	second := seedProject(t, st, "beta")

	b.handleUpdate(context.Background(), forumMsg(-100234, 7, "/init "+first))
	b.handleUpdate(context.Background(), forumMsg(-100234, 9, "/init "+second))

	a, err := st.TelegramProjectBindingByID(first)
	if err != nil || a.TopicID != 7 {
		t.Fatalf("first project = %+v, %v", a, err)
	}
	bnd, err := st.TelegramProjectBindingByID(second)
	if err != nil || bnd.TopicID != 9 {
		t.Fatalf("second project = %+v, %v", bnd, err)
	}

	// And each topic's messages go to its own project's session.
	b.handleUpdate(context.Background(), forumMsg(-100234, 9, "halo beta"))
	bindings, _ := st.TelegramBindings()
	if len(bindings) != 1 || bindings[0].TopicID != 9 {
		t.Fatalf("the session landed on the wrong topic: %+v", bindings)
	}
}

// /resume is what makes /new safe: the replaced conversation is one tap away.
func TestResumeSwitchesBackToAnEarlierSession(t *testing.T) {
	transport := &fakeTransport{}
	b, _, st := newTestBridge(t, transport)
	mustAllow(t, st, 42)
	projectID := seedProject(t, st, "devdeck")

	b.handleUpdate(context.Background(), dm(100, "/init "+projectID))
	b.handleUpdate(context.Background(), dm(100, "sesi pertama"))
	firstBindings, _ := st.TelegramBindings()
	firstThread := firstBindings[0].ThreadID

	b.handleUpdate(context.Background(), dm(100, "/new"))
	b.handleUpdate(context.Background(), dm(100, "/resume"))

	last := transport.sent[len(transport.sent)-1]
	var token string
	for _, row := range last.Keyboard {
		if row[0].CallbackData != noopCallback {
			token = row[0].CallbackData
		}
	}
	if token == "" {
		t.Fatalf("no resumable session offered: %+v", last.Keyboard)
	}

	b.handleUpdate(context.Background(), Update{CallbackQuery: &CallbackQuery{
		ID: "cb1", From: &User{ID: 42}, Data: token,
		Message: &Message{MessageID: 9, Chat: Chat{ID: 100}},
	}})

	after, _ := st.TelegramBindings()
	if len(after) != 1 {
		t.Fatalf("resuming left more than one session bound: %+v", after)
	}
	if after[0].ThreadID != firstThread {
		t.Fatalf("resumed %s, want the earlier session %s", after[0].ThreadID, firstThread)
	}
}

// The active session is shown but not tappable — resuming what is already
// open would re-point the binding at itself and read as a broken button.
func TestResumeMarksTheActiveSessionUntappable(t *testing.T) {
	transport := &fakeTransport{}
	b, _, st := newTestBridge(t, transport)
	mustAllow(t, st, 42)
	projectID := seedProject(t, st, "devdeck")

	b.handleUpdate(context.Background(), dm(100, "/init "+projectID))
	b.handleUpdate(context.Background(), dm(100, "sesi aktif"))
	b.handleUpdate(context.Background(), dm(100, "/resume"))

	last := transport.sent[len(transport.sent)-1]
	var sawActive bool
	for _, row := range last.Keyboard {
		if strings.Contains(row[0].Text, "aktif") {
			sawActive = true
			if row[0].CallbackData != noopCallback {
				t.Fatalf("the active session is tappable: %+v", row[0])
			}
		}
	}
	if !sawActive {
		t.Fatalf("the active session was not marked: %+v", last.Keyboard)
	}
}

// The exact sequence from the 2026-08-19 report, which failed on a build that
// predated topic scoping: with one project already bound to General, /init
// for a SECOND project inside a topic was refused ("chat ini sudah dipakai
// project lain") because the conflict check matched on chat id alone.
func TestInitInATopicIsNotBlockedByAProjectInGeneral(t *testing.T) {
	transport := &fakeTransport{}
	b, _, st := newTestBridge(t, transport)
	mustAllow(t, st, 42)
	inGeneral := seedProject(t, st, "bali")
	inTopic := seedProject(t, st, "bypass")

	b.handleUpdate(context.Background(), forumMsg(-100234, 0, "/init "+inGeneral))
	b.handleUpdate(context.Background(), forumMsg(-100234, 7, "/init "+inTopic))

	binding, err := st.TelegramProjectBindingByID(inTopic)
	if err != nil {
		t.Fatalf("a topic /init was refused because of a project in General: %v", err)
	}
	if binding.TopicID != 7 {
		t.Fatalf("binding = %+v, want topic 7", binding)
	}
}

// The other half of that report: the confirmation was posted to General
// instead of the topic the /init came from, because the send carried no
// message_thread_id.
func TestInitConfirmationIsPostedInTheTopicItCameFrom(t *testing.T) {
	transport := &fakeTransport{}
	b, _, st := newTestBridge(t, transport)
	mustAllow(t, st, 42)
	projectID := seedProject(t, st, "bypass")

	b.handleUpdate(context.Background(), forumMsg(-100234, 7, "/init "+projectID))

	if len(transport.sent) != 1 {
		t.Fatalf("want one confirmation, got %+v", transport.sent)
	}
	if transport.sent[0].TopicID != 7 {
		t.Fatalf("confirmation went to topic %d, want the topic the /init was sent from (7)",
			transport.sent[0].TopicID)
	}
	// And it is pinned there, not somewhere else in the group.
	if len(transport.pins) != 1 || transport.pins[0].ChatID != -100234 {
		t.Fatalf("confirmation not pinned: %+v", transport.pins)
	}
}

// And the third: a plain message in the project's topic with no session yet
// must CREATE one and answer, rather than telling the operator to go and find
// a topic — which is what the pre-fix build did.
func TestMessageInAProjectTopicWithNoSessionCreatesOne(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	mustAllow(t, st, 42)
	projectID := seedProject(t, st, "bypass")

	b.handleUpdate(context.Background(), forumMsg(-100234, 7, "/init "+projectID))
	b.handleUpdate(context.Background(), forumMsg(-100234, 7, "hi"))

	bindings, err := st.TelegramBindings()
	if err != nil {
		t.Fatalf("bindings: %v", err)
	}
	if len(bindings) != 1 {
		t.Fatalf("no session was created for the first message: %+v", bindings)
	}
	if bindings[0].TopicID != 7 {
		t.Fatalf("session bound to topic %d, want 7", bindings[0].TopicID)
	}
	th, ok := engine.State().Thread(bindings[0].ThreadID)
	if !ok || th.Status != orchestration.ThreadRunning {
		t.Fatalf("the first message did not run as a turn: %+v", th)
	}
}

// The collision that made a "new session" open somebody else's conversation:
// thread ids were numbered off the ENGINE's in-memory set, which can be
// missing threads the store still holds, so NextChatSuffix re-issued an id a
// previous conversation already owned.
func TestNewSessionNeverReusesAThreadTheStoreAlreadyHas(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	mustAllow(t, st, 42)
	projectID := seedProject(t, st, "core")

	anchor, ok := b.projectAnchorWorktree(projectID)
	if !ok {
		t.Fatal("no anchor worktree")
	}
	// The engine knows chat-1 and chat-2, so numbering off it alone yields
	// chat-3 — an id the STORE already owns from an earlier conversation the
	// engine never replayed. That gap is the whole bug: without the store in
	// the picture the "new session" opens someone else's transcript.
	seedThread(t, engine, anchor.ID+"::chat-1")
	seedThread(t, engine, anchor.ID+"::chat-2")
	prior := anchor.ID + "::chat-3"
	if _, err := st.CommitAgentEvents("c-prior", []orchestration.Event{{
		EventID: "e-prior", Type: orchestration.EvtThreadCreated, ThreadID: prior,
		CommandID: "c-prior", CreatedAt: 1, Payload: mustJSON(t, map[string]any{"instanceId": "claude:default"}),
	}}); err != nil {
		t.Fatalf("seed prior thread: %v", err)
	}
	if _, live := engine.State().Thread(prior); live {
		t.Fatal("setup is wrong: the engine must NOT know the prior thread")
	}

	b.handleUpdate(context.Background(), dm(100, "/init "+projectID))
	b.handleUpdate(context.Background(), dm(100, "hi"))

	bindings, err := st.TelegramBindings()
	if err != nil {
		t.Fatalf("bindings: %v", err)
	}
	if len(bindings) != 1 {
		t.Fatalf("want one session, got %+v", bindings)
	}
	if bindings[0].ThreadID == prior {
		t.Fatalf("the new session reused %s — a conversation that already existed", prior)
	}
}

// The silent drop: a message in the right chat but the wrong topic produced
// no reply and no log, so "I published it and nothing happens" had no
// explanation anywhere.
func TestMessageInGeneralSaysWhereTheProjectLives(t *testing.T) {
	transport := &fakeTransport{}
	b, _, st := newTestBridge(t, transport)
	mustAllow(t, st, 42)
	projectID := seedProject(t, st, "core")

	b.handleUpdate(context.Background(), forumMsg(-100234, 4, "/init "+projectID))
	before := len(transport.sent)

	// Typed in General, while the project lives in topic 4.
	b.handleUpdate(context.Background(), forumMsg(-100234, 0, "hi"))

	sent := transport.sent[before:]
	if len(sent) == 0 {
		t.Fatal("the message was dropped with no reply at all — the exact reported failure")
	}
	if !strings.Contains(sent[0].Text, "core") {
		t.Fatalf("the reply does not name the project: %q", sent[0].Text)
	}
	if !strings.Contains(sent[0].Text, "4") {
		t.Fatalf("the reply does not say which topic to use: %q", sent[0].Text)
	}
	// And it must not have quietly started a session in the wrong place.
	if bindings, _ := st.TelegramBindings(); len(bindings) != 0 {
		t.Fatalf("a session was created in the wrong topic: %+v", bindings)
	}
}

// A pin that silently does not happen looks exactly like one that worked,
// until the operator goes looking for the bookmark. The bot is usually NOT an
// admin, so this is the common case, not an edge one.
func TestFailedPinTellsTheOperatorHowToFixIt(t *testing.T) {
	transport := &fakeTransport{
		pinErr: &APIError{Code: 400, Desc: "Bad Request: not enough rights to manage pinned messages in the chat"},
	}
	b, _, st := newTestBridge(t, transport)
	mustAllow(t, st, 42)
	projectID := seedProject(t, st, "core")

	b.handleUpdate(context.Background(), forumMsg(-100234, 4, "/init "+projectID))

	var warned bool
	for _, sent := range transport.sent {
		if strings.Contains(sent.Text, "belum admin") && strings.Contains(sent.Text, "Pin Messages") {
			warned = true
			if sent.TopicID != 4 {
				t.Fatalf("the warning went to topic %d, want the project's topic 4", sent.TopicID)
			}
		}
	}
	if !warned {
		t.Fatalf("a failed pin said nothing in Telegram: %+v", transport.sent)
	}
	// The binding still stands — pinning is a bookmark, not a precondition.
	if _, err := st.TelegramProjectBindingByID(projectID); err != nil {
		t.Fatalf("a failed pin lost the binding: %v", err)
	}
}

// A transient failure is not the operator's problem and must not produce
// advice they cannot act on.
func TestFailedPinForANonPermissionReasonIsQuiet(t *testing.T) {
	transport := &fakeTransport{pinErr: &APIError{Code: 500, Desc: "Internal Server Error"}}
	b, _, st := newTestBridge(t, transport)
	mustAllow(t, st, 42)
	projectID := seedProject(t, st, "core")

	b.handleUpdate(context.Background(), forumMsg(-100234, 4, "/init "+projectID))

	for _, sent := range transport.sent {
		if strings.Contains(sent.Text, "belum admin") {
			t.Fatalf("a transient pin failure produced admin advice: %q", sent.Text)
		}
	}
}

// The reported bug: the app showed a complete answer while Telegram sat on
// "memproses…" forever.
//
// The pump holds prose until a turn ends, and the only trigger it had was a
// forwarded event.TurnCompleted — which Ingestion CONSUMES, translating it
// into session-set{status:idle}. Not one turn.completed exists in a database
// with thousands of turns, so the flush could never fire and the cursor
// froze at the last event before the deltas.
func TestAnswerIsDeliveredWhenTheTurnGoesIdle(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	seedThread(t, engine, "w-abc")
	if err := st.SetTelegramBinding(domain.TelegramBinding{ThreadID: "w-abc", ChatID: 100}); err != nil {
		t.Fatalf("bind: %v", err)
	}
	b.sweep(context.Background())
	base, _ := st.TelegramBindingByThread("w-abc")

	seedDelta(t, engine, "w-abc", "d1", "Halo! Ada yang bisa saya bantu", 1)
	b.sweep(context.Background())
	if len(transport.sent) != 0 {
		t.Fatalf("prose was sent mid-turn: %+v", transport.sent)
	}

	// Exactly what Ingestion emits at the end of a turn — no turn.completed.
	if _, err := engine.Dispatch(context.Background(), orchestration.Command{
		CommandID: "idle-1", Type: orchestration.CmdThreadSessionSet, ThreadID: "w-abc",
		Payload: mustJSON(t, map[string]any{
			"status": "idle", "contextTokens": 54004, "turnTokens": 54201, "turnOutputTokens": 197,
		}),
	}); err != nil {
		t.Fatalf("session set: %v", err)
	}
	b.sweep(context.Background())

	var delivered bool
	for _, sent := range transport.sent {
		if strings.Contains(sent.Text, "Ada yang bisa saya bantu") {
			delivered = true
		}
	}
	if !delivered {
		t.Fatalf("the answer never reached Telegram: %+v", transport.sent)
	}
	// And the cursor moves past it, or every later sweep re-sends the same
	// answer forever.
	after, _ := st.TelegramBindingByThread("w-abc")
	if after.LastSeq <= base.LastSeq {
		t.Fatalf("cursor stuck at %d after delivering the answer", after.LastSeq)
	}
}

// A turn that never ends must not be flushed early, or a half-finished
// sentence goes out as if it were the answer.
func TestRunningAndWaitingDoNotEndTheTurn(t *testing.T) {
	for _, status := range []string{"running", "waiting"} {
		got := Render(orchestration.Event{
			Type:    orchestration.EvtThreadSessionSet,
			Payload: mustJSON(t, map[string]any{"status": status}),
		})
		if got.EndTurn {
			t.Fatalf("status %q ended the turn", status)
		}
	}
	// A session-set carrying no status at all (pendingRequestAdd, resumeCursor)
	// decodes to "" and must be inert too.
	got := Render(orchestration.Event{
		Type:    orchestration.EvtThreadSessionSet,
		Payload: mustJSON(t, map[string]any{"pendingRequestAdd": "req-1"}),
	})
	if got.EndTurn {
		t.Fatal("a status-less session-set ended the turn")
	}
}

// A callback whose message is GONE — Telegram omits it once the card is older
// than 48 hours, and it is absent entirely for an inline-mode callback — must
// not take the process down with it. handleUpdate runs on the poll goroutine,
// so a nil dereference there is not a dropped update: it is the whole bridge,
// and with it every other published thread.
func TestAgentCallbackWithNoMessageDoesNotPanic(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	mustAllow(t, st, 42)
	seedThread(t, engine, "ssh:c-a1b2")
	if err := st.SetTelegramBinding(domain.TelegramBinding{ThreadID: "ssh:c-a1b2", ChatID: 100}); err != nil {
		t.Fatalf("bind: %v", err)
	}

	b.handleUpdate(context.Background(), dm(100, "/agents"))
	last := transport.sent[len(transport.sent)-1]
	if len(last.Keyboard) == 0 {
		t.Fatalf("no agent picker was sent: %+v", transport.sent)
	}

	b.handleUpdate(context.Background(), Update{CallbackQuery: &CallbackQuery{
		ID: "cb-tap", From: &User{ID: 42}, Data: last.Keyboard[0][0].CallbackData,
	}})

	// The tap still has to be ANSWERED, or the button spins forever.
	if len(transport.answers) == 0 {
		t.Fatalf("the callback was never answered: %+v", transport.answers)
	}
}

// The same class of failure, one layer up: whatever an update handler does,
// pollLoop must survive it. Without a recover, one panicking update ends the
// only goroutine reading from Telegram and the bridge goes silent forever —
// indistinguishable, from the operator's side, from a dead bot.
func TestAPanickingUpdateDoesNotKillThePollLoop(t *testing.T) {
	transport := &fakeTransport{}
	b, _, _ := newTestBridge(t, transport)

	// now is called by every path that touches the allowlist; panicking here
	// stands in for any handler bug, without needing one to exist.
	b.now = func() time.Time { panic("boom") }

	b.handleUpdateSafely(context.Background(), dm(100, "halo"))
}

// Resuming a session that STILL has a binding row must not replay its backlog.
//
// SetTelegramBinding's ON CONFLICT deliberately never writes last_seq — a
// re-point must not rewind a cursor — so passing LastSeq: head through it is
// silently ignored for any thread that is already published somewhere. That is
// not hypothetical: a session published on its own with /init, then resumed
// into a project topic, keeps whatever cursor that other destination had, and
// the whole conversation is mirrored again into the topic. The narrow setter is
// what actually moves it.
func TestResumingAnAlreadyBoundThreadStartsFromItsHead(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	mustAllow(t, st, 42)
	projectID := seedProject(t, st, "devdeck")

	b.handleUpdate(context.Background(), dm(100, "/init "+projectID))
	b.handleUpdate(context.Background(), dm(100, "sesi pertama"))
	bindings, _ := st.TelegramBindings()
	firstThread := bindings[0].ThreadID

	b.handleUpdate(context.Background(), dm(100, "/new"))

	// The earlier session is published on its OWN destination too, so its row
	// exists again — with a cursor of its own, at the very beginning.
	if err := st.SetTelegramBinding(domain.TelegramBinding{ThreadID: firstThread, ChatID: 555}); err != nil {
		t.Fatalf("re-publish the old session: %v", err)
	}
	seedDelta(t, engine, firstThread, "old-1", "JAWABAN LAMA", 1)
	seedTurnEnd(t, engine, firstThread, "old-end")

	b.handleUpdate(context.Background(), dm(100, "/resume"))
	last := transport.sent[len(transport.sent)-1]
	var token string
	for _, row := range last.Keyboard {
		if row[0].CallbackData != noopCallback {
			token = row[0].CallbackData
		}
	}
	if token == "" {
		t.Fatalf("no resumable session offered: %+v", last.Keyboard)
	}

	head, err := b.headSeq(firstThread)
	if err != nil {
		t.Fatalf("head seq: %v", err)
	}
	b.handleUpdate(context.Background(), Update{CallbackQuery: &CallbackQuery{
		ID: "cb1", From: &User{ID: 42}, Data: token,
		Message: &Message{MessageID: 9, Chat: Chat{ID: 100}},
	}})

	binding, err := st.TelegramBindingByThread(firstThread)
	if err != nil {
		t.Fatalf("binding: %v", err)
	}
	if binding.ChatID != 100 {
		t.Fatalf("resume did not re-point the session: %+v", binding)
	}
	if binding.LastSeq != head {
		t.Fatalf("cursor at %d after resuming, want the head %d — the backlog will be replayed", binding.LastSeq, head)
	}
}
