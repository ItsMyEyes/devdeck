package telegram

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"runtime/debug"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"devdeck/backend/internal/agentcore/event"
	"devdeck/backend/internal/agentcore/orchestration"
	"devdeck/backend/internal/agentcore/provider"
	"devdeck/backend/internal/domain"
	"devdeck/backend/internal/port"
)

// telegramClient is the narrow slice of *Client the bridge actually calls.
// Client (client.go) is a concrete struct, not an interface — Task 2 fixed
// its shape and this package must not touch that file — so the bridge
// declares its own consumer-side interface instead, the same trick
// orchestration.EventStore uses over *store.Store. *Client satisfies this
// implicitly (see the assertion below), so production code that builds
// Deps.Client as &telegram.Client{Token: token} sees no difference; a test
// substitutes a fake transport instead.
type telegramClient interface {
	GetUpdates(ctx context.Context, offset int64, timeoutSec int) ([]Update, error)
	GetWebhookInfo(ctx context.Context) (WebhookInfo, error)
	SendMessage(ctx context.Context, o SendOptions) (Message, error)
	EditMessageText(ctx context.Context, chatID, messageID int64, text string, kb InlineKeyboard) error
	DeleteMessage(ctx context.Context, chatID, messageID int64) error
	AnswerCallbackQuery(ctx context.Context, id, text string) error
	CreateForumTopic(ctx context.Context, chatID int64, name string) (int64, error)
	PinChatMessage(ctx context.Context, chatID, messageID int64) error
	UnpinChatMessage(ctx context.Context, chatID, messageID int64) error
	SendChatAction(ctx context.Context, chatID, topicID int64, action string) error
}

var _ telegramClient = (*Client)(nil)

// Deps wires the bridge to one process's engine, store and bot. Only NewID,
// ListSkills and Models are closures rather than direct dependencies: NewID
// mirrors how every other client (agent_ws.go, the REST handlers) mints
// command ids, and ListSkills/Models exist so this package never has to
// import internal/service — the bridge talks to the orchestration layer and
// the Bot API only, nothing provider- or filesystem-specific.
type Deps struct {
	Store  port.Store
	Engine *orchestration.Engine
	// Client is normally a *Client built from the stored bot token (nil here
	// means "build one"). Typed as telegramClient, not *Client, purely so a
	// test can hand in a fake transport — see telegramClient's doc comment.
	Client     telegramClient
	Pairing    *Pairing
	NewID      func() string
	ListSkills func() ([]string, error)
	// Models lists the model ids ONE agent offers. Keyed by agent rather than
	// by thread because which agent a destination runs is a question this
	// package answers (agentForModelPicker) and the wiring closure cannot: the
	// /agents choice lives on a Telegram binding, which nothing outside this
	// package reads.
	Models func(agentID string) ([]string, error)
	// ListAgents backs /agents. Optional, like ListSkills: a process wired
	// without it answers "not available here" rather than crashing.
	ListAgents func() ([]domain.AgentSummary, error)
	Now        func() time.Time
	// Health, when non-nil, is where this bridge publishes whether it is
	// actually receiving anything — the settings panel reads the same pointer.
	// Optional: New allocates a private one when it is nil, so every write
	// below is unconditional and a caller that does not care about the state
	// (every existing test) needs no change.
	Health *Health
}

// callbackKind says which of the three intents a minted token carries. It is
// an EXPLICIT field rather than something inferred from which other fields
// happen to be non-empty: routing on emptiness silently reclassifies a
// legitimate-but-empty value — a question whose text is "" (possible:
// claude's normalizeUserInputQuestions falls back to a synthetic "q-N" id
// exactly because the question text can be missing) would be routed to the
// APPROVAL path and dispatch CmdThreadApprovalRespond with an empty decision
// against a real pending request. On a thread that runs shell commands on a
// production server, a tap that means "answer a question" must never become
// a tap that means "decide an approval".
type callbackKind uint8

const (
	cbApproval callbackKind = iota + 1
	cbUserInput
	cbModel
	// cbResume re-points a destination at one of its project's earlier
	// sessions. Thread-scoped like the first three, but it changes which
	// thread the destination IS wired to rather than acting on that thread.
	cbResume
	// cbPermission changes a running thread's runtime mode — the permission
	// policy the composer's "Approval required" control sets in the app.
	cbPermission
	// cbAgent picks which agent NEW sessions in a published project start
	// on. Deliberately not a thread-scoped kind like the three above: a live
	// thread's agent is fixed at thread.create and no command changes it, so
	// this choice can only ever apply to the next session.
	cbAgent
)

// noopCallback is the callback_data for a button that exists to be READ, not
// tapped — an agent whose binary is not installed on that machine. Telegram
// requires every inline button to carry callback_data, and an unrecognized
// token already resolves to "this button is stale"; this constant just makes
// the intent explicit at the call site.
const noopCallback = "cb:noop"

// callbackTarget is what an opaque "cb:<8 hex>" token in a tapped inline
// button actually means. Telegram caps callback_data at 64 bytes — far too
// small for a full question's text (§0.5) — so every button this bridge
// sends carries a minted token instead, and the real intent lives here,
// behind resolveCallback's mutex-guarded map.
//
// Three shapes share this one struct because they share one lookup path
// (resolveCallback) and one "stale token" failure mode
// (TestStaleCallbackTokenIsRejectedNotGuessed):
//   - cbApproval: RequestID + Decision set.
//   - cbUserInput (§5a): RequestID + Question + Answer set. Question is the
//     FULL text of the question being answered — the exact key
//     orchestration.UserInputRespondPayload.Answers is built with. Deriving
//     it any other way risks not matching that key, which — per that
//     payload's own doc comment — "reaches the agent as no answer at all".
//   - cbModel: Model set. Not in Task 5's original sketch of this struct, but
//     it is the same mint-a-token/look-it-up-later mechanism, so it is folded
//     in here rather than given a second map.
//
// MintedAt bounds the token's life in both senses: a token older than
// callbackTokenTTL no longer resolves, and pruning by it is what keeps the
// map from growing forever in a process that runs for months (most cards are
// never tapped at all — the operator usually answers from the browser).
type callbackTarget struct {
	Kind      callbackKind
	ThreadID  string
	RequestID string
	Decision  event.Decision
	Question  string
	Answer    string
	// QuestionIndex is the answered question's position in the request. It is
	// what the accumulator is keyed by, because two questions in one request can
	// share a text — see pendingUserInput.
	QuestionIndex int
	// MultiSelect is the answered question's own multiSelect flag, carried on
	// the token because the question list is long gone by the time the tap
	// arrives. It decides the SHAPE of the stored answer, nothing else — see
	// handleUserInputAnswer.
	MultiSelect bool
	Model       string
	ProjectID   string
	Agent       string
	Mode        provider.RuntimeMode
	MintedAt    time.Time
}

// chatState is the live-message bookkeeping for one bound thread (§0.4).
//
// liveText is the text the live message CURRENTLY shows, and it has to be
// kept here rather than rebuilt per sweep: each sweep only reads the events
// after the persisted cursor, so a sweep's own render output is a fragment of
// the turn, not the whole of it. Editing the live message with just that
// fragment would replace — not extend — everything already delivered, which
// is transcript loss, the one thing §0.3 exists to prevent.
//
// chatID/topicID record where liveMessageID lives. A binding repointed to
// another chat or topic leaves the old message id dangling: editing it in the
// new chat fails with "message to edit not found", forever, which would wedge
// this thread's cursor permanently.
type chatState struct {
	mu sync.Mutex
	// sendFailures counts consecutive failed sweeps for this binding. Not
	// used for backoff — the cursor already refuses to advance, so the sweep
	// retries by construction — but for LOGGING. A destination that has become
	// permanently unwritable (the bot was removed from the group, the topic
	// was deleted) otherwise fails silently forever: the transcript simply
	// stops appearing in Telegram, the cursor never moves, and nothing is
	// written anywhere to say why.
	sendFailures int
	// lastFlush is when this binding last put prose on the wire, zero before
	// the first one. It is what makes the time half of the progressive flush
	// work — see streamFlushInterval.
	lastFlush time.Time
	// lastTyping is when the "…is typing" hint was last refreshed, same shape
	// as lastFlush and for the same reason — see keepTyping. Zero means "never",
	// which is due immediately.
	lastTyping time.Time
	// cards maps a requestId to the message ids of every card sent for it, so
	// those cards can be retired the moment the request is decided ANYWHERE —
	// the desktop app, another device, a timeout — and not just when the
	// decision was tapped here. An approval is one request but a multi-question
	// AskUserQuestion prompt is one card per question, hence a slice.
	//
	// In memory only, and deliberately so: it is the same lifetime as the
	// callback tokens in b.cb, which a restart also drops. A card whose ids
	// were lost simply stays where it is — its tokens are gone too, so it can
	// no longer dispatch anything.
	//
	// Guarded by cs.mu like every other field here. pumpBinding holds that lock
	// for its whole run, which is why the helpers it calls (sendApprovalCard,
	// sendUserInputCards, retireCards) take the chatState and must NOT lock it
	// again.
	cards map[string][]int64
}

// rememberCard records a card's message id against its request. Caller holds
// cs.mu (see chatState.cards).
func (cs *chatState) rememberCard(requestID string, messageID int64) {
	if requestID == "" || messageID == 0 {
		return
	}
	if cs.cards == nil {
		cs.cards = make(map[string][]int64)
	}
	cs.cards[requestID] = append(cs.cards[requestID], messageID)
}

// typingHintInterval is how often the typing hint is refreshed. Telegram clears
// it after ~5 seconds, so this only has to be under that; everything faster is
// pure API traffic. See keepTyping for why that mattered.
const typingHintInterval = 4 * time.Second

// streamFlushChars is how much buffered prose forces a message out mid-turn.
//
// Prose used to be held until the turn ENDED (flushPending ran only behind a
// notice, a card, or the terminal session-set), which meant a turn that runs
// for minutes without a tool call showed nothing in Telegram for all of it and
// then arrived at once. Publishing during a run — the case this whole surface
// exists for — therefore looked like it had not worked.
//
// Sized in characters rather than events because the durable log is one event
// per TOKEN: an event count would fire every second on a fast model and never
// on a slow one. ~1200 is a healthy paragraph or two, well under Telegram's
// 4096 cap, so a flush is one message rather than a split.
const streamFlushChars = 1200

// sweepMessageBudget is how many messages ONE sweep of one binding may put on
// the wire before it stops at the current event boundary and lets the next tick
// continue.
//
// Without it the two features above compose into a flood: /init rewinds to the
// start of a turn that may have been running for minutes, and the char
// threshold then turns that backlog into one sendMessage per ~1200 characters,
// sent back to back with nothing between them. Telegram answers a burst like
// that with 429, and callWithRetry sleeps out the retry_after while holding this
// binding's lock — so publishing a long run is punished by the mirror stalling.
//
// Eight is a couple of screens of chat every 2 seconds: fast enough that a
// catch-up feels immediate, slow enough to stay inside Telegram's per-chat
// limits. Nothing is dropped — the cursor stops at the last DELIVERED event, so
// the next sweep resumes exactly where this one stopped.
const sweepMessageBudget = 8

// streamFlushInterval is the other half: a turn that trickles a little text
// over a long time never reaches streamFlushChars, and holding 200 characters
// for six minutes is the same silence by a different route. Long enough that a
// fast turn still coalesces into whole paragraphs rather than one message per
// sweep.
const streamFlushInterval = 25 * time.Second

// pendingUserInput accumulates answers to one multi-question AskUserQuestion
// request (§5a) as callback taps arrive, one per question. The request is
// complete, and dispatchable, exactly when every question has an answer.
//
// answers is keyed by the question's INDEX in the request, never by its text.
// One prompt can ask the same question twice — "Lanjut?" about two different
// files is ordinary — and a text-keyed accumulator silently collapses those:
// the second tap overwrites the first, the count never reaches the number of
// questions asked, and the request can never be completed from Telegram at all.
// The OUTGOING map is still text-keyed, because that is what
// UserInputRespondPayload requires; it is built from questions at dispatch time.
//
// createdAt exists for the same reason callbackTarget.MintedAt does: a prompt
// answered in the browser instead of Telegram leaves its accumulator behind
// with nothing to ever collect it, so old ones are pruned.
type pendingUserInput struct {
	mu      sync.Mutex
	answers map[int]any
	// questions is the answer KEY of each question, in the request's own order.
	// Its length is how many answers completion needs.
	questions []string
	createdAt time.Time
}

func pendingInputKey(threadID, requestID string) string { return threadID + "|" + requestID }

// answerKeyFor is the key one question's answer takes in
// orchestration.UserInputRespondPayload.Answers: the FULL QUESTION TEXT, per
// that payload's doc comment ("re-keying this map reaches the agent as no
// answer at all"). The id fallback covers the single case where that text is
// unusable — a question that carries none — which is exactly when claude's
// normalizeUserInputQuestions substitutes a synthetic "q-N" id, and is the
// key the browser panel sends for it too (pendingUserInput.ts keys by
// question.id, which IS the question text whenever there is one).
func answerKeyFor(q userInputQuestion) string {
	if q.Question != "" {
		return q.Question
	}
	return q.ID
}

// maxOwnEchoes bounds the suppressed-echo set. Entries live for one sweep
// (~2s) in the normal case; the cap only matters for one stranded between a
// dispatch and a binding that was deleted before the pump got to it.
const maxOwnEchoes = 1024

// resumeListSize is how many recent sessions /resume offers. Five is what an
// operator can scan on a phone without scrolling, and going back further than
// the last few is a job for the app, which shows the whole list.
const resumeListSize = 5

// messageSplitAt is the budget for one outbound message, in the UTF-16 code
// units Telegram counts (see telegramMessageLimit) — NOT runes. Its hard cap is
// 4096 and it rejects anything longer outright; the headroom absorbs the
// backslashes MarkdownV2 escaping adds after the split decision has already
// been made.
const messageSplitAt = 3500

// callbackTokenTTL is how long a minted cb: token stays tappable, and
// therefore how long it stays in memory. Cards routinely go unanswered on
// Telegram (the operator approves in the browser instead), so without an
// upper bound the token map is a pure leak in a process that runs for months.
// A day is far longer than any live request survives and short enough that an
// ancient card cannot be resurrected.
const callbackTokenTTL = 24 * time.Hour

// maxCallbackTokens is the hard ceiling the TTL cannot enforce on its own: a
// burst of thousands of unanswered cards inside one TTL window would still
// grow without limit. On overflow the OLDEST quarter is dropped — the tokens
// least likely to still be waiting for a tap.
const maxCallbackTokens = 4096

// pendingUserInputTTL bounds pendingUserInput the same way, for the same
// reason: a prompt answered from the browser never comes back through
// handleUserInputAnswer to have its accumulator deleted.
const pendingUserInputTTL = 24 * time.Hour

// Bridge is one process's Telegram long-poll loop and outbound pump, wired
// straight to that process's orchestration.Engine — no HTTP, no WebSocket,
// no cross-process plumbing (§0.1). It is the same kind of client
// AgentWSHandler (agent_ws.go) is, over a different transport: it dispatches
// commands through the same Engine.Dispatch, gated by the same
// orchestration.ClientDispatchable allowlist, and it replays from the
// durable log rather than trusting the engine's subscription for the same
// reason the WebSocket handler's reconnect path does (§0.3).
type Bridge struct {
	store      port.Store
	engine     *orchestration.Engine
	client     telegramClient
	pairing    *Pairing
	newID      func() string
	listSkills func() ([]string, error)
	models     func(agentID string) ([]string, error)
	listAgents func() ([]domain.AgentSummary, error)
	now        func() time.Time
	health     *Health // never nil; New allocates one when Deps.Health is not set

	cbMu sync.Mutex
	cb   map[string]callbackTarget

	chatsMu sync.Mutex
	chats   map[string]*chatState

	uiMu      sync.Mutex
	userInput map[string]*pendingUserInput

	// ownEchoes holds the Seq of every thread.message-sent this bridge itself
	// caused, so the pump can skip mirroring the operator's message back into
	// the chat they just typed it in. Keyed by Seq rather than by text: the
	// engine hands the committed events straight back from Dispatch, so the
	// exact rows are known, and two identical prompts can never be confused
	// for one another.
	echoMu    sync.Mutex
	ownEchoes map[uint64]struct{}

	// toolNames remembers a tool call's NAME from item.started so the line
	// emitted at item.completed can say what ran. Keyed by thread+itemId; see
	// ToolCallParts for why the two halves arrive on different events.
	toolMu    sync.Mutex
	toolNames map[string]string
}

// New builds a Bridge. It does not start anything — call Run for that.
func New(d Deps) *Bridge {
	now := d.Now
	if now == nil {
		now = time.Now
	}
	newID := d.NewID
	if newID == nil {
		newID = func() string { return "tg-" + randomHex(4) }
	}
	client := d.Client
	if client == nil {
		// "nil = built from the stored token" (Task 5's Deps contract): the
		// bot token never rides along on the config struct (see
		// domain.TelegramConfig's doc comment), so the only way to get it is
		// this dedicated accessor, same precedent as SignInPINHash.
		token, err := d.Store.TelegramBotToken()
		if err != nil {
			log.Printf("telegram: read bot token: %v", err)
		}
		client = &Client{Token: token}
	}
	health := d.Health
	if health == nil {
		health = &Health{}
	}
	return &Bridge{
		store: d.Store, engine: d.Engine, client: client, pairing: d.Pairing,
		newID: newID, listSkills: d.ListSkills, models: d.Models, listAgents: d.ListAgents, now: now,
		health:    health,
		cb:        make(map[string]callbackTarget),
		chats:     make(map[string]*chatState),
		userInput: make(map[string]*pendingUserInput),
		ownEchoes: make(map[uint64]struct{}),
		toolNames: make(map[string]string),
	}
}

// Run starts the inbound long-poll loop and the outbound pump and blocks
// until ctx is done — the same shape as Engine.Run and AgentWSHandler's pair
// of goroutines (writeLoop/readLoop).
func (b *Bridge) Run(ctx context.Context) {
	// One line that answers "is this thing on, and what state is it in?".
	// Worth its space: the bridge's two most confusing states are both
	// invisible from the outside. An EMPTY allowlist means the next sender is
	// auto-enrolled; a non-empty one means unlisted senders are dropped in
	// silence. Zero bindings means nothing will ever be mirrored no matter how
	// healthy the connection is. Diagnosing that by observing Telegram alone is
	// impossible — every one of those states looks like "the bot is dead".
	users, uerr := b.store.TelegramUsers()
	bindings, berr := b.store.TelegramBindings()
	if uerr != nil || berr != nil {
		log.Printf("telegram: bridge starting; could not read state: users=%v bindings=%v", uerr, berr)
	} else if len(users) == 0 {
		log.Printf("telegram: bridge starting; allowlist EMPTY (the next sender is auto-enrolled as owner), %d published thread(s)", len(bindings))
	} else {
		log.Printf("telegram: bridge starting; %d allowed user(s), %d published thread(s)", len(users), len(bindings))
	}

	b.health.Set(HealthConnecting, "")
	go b.probeWebhook(ctx)

	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); b.pollLoop(ctx) }()
	go func() { defer wg.Done(); b.pumpLoop(ctx) }()
	wg.Wait()
}

// probeWebhook asks, once at startup, whether a webhook holds this token.
//
// The poll loop's own 409 already reports THAT a webhook is registered, but
// only getWebhookInfo reports WHICH — and the URL is the single fact that
// turns "something else has this token" into a problem an operator can go and
// fix, instead of a mystery they have to bisect by killing processes.
//
// In its own goroutine and never a precondition for polling, for the same
// reason main.go's getMe is not: an unreachable Telegram must not delay the
// bridge, and a probe that fails costs nothing — the poll loop reports the
// same conflict a second later anyway, just without the URL.
func (b *Bridge) probeWebhook(ctx context.Context) {
	info, err := b.client.GetWebhookInfo(ctx)
	if err != nil || info.URL == "" {
		return
	}
	// Deliberately not repaired automatically: a webhook this process did not
	// set belongs to whoever did, and deleting it to make DevDeck work would
	// silently take down their integration.
	log.Printf("telegram: a webhook is registered at %s — Telegram refuses getUpdates while one is set, so this bridge will receive NOTHING; use a separate bot for DevDeck or delete the webhook (%d update(s) queued to it)",
		info.URL, info.PendingUpdateCount)
	b.health.Set(HealthError, WebhookConflictDetail(info))
}

// ---------------------------------------------------------------------------
// (a) Inbound loop
// ---------------------------------------------------------------------------

// pollLoop long-polls getUpdates and hands each update to handleUpdate in
// order. A 409 means another process is holding this bot token's exclusive
// getUpdates lease (§0.1) — almost certainly a misconfiguration (two
// processes sharing one token) rather than something retrying will fix, but
// there is no seam here to fail the process over, so it logs loudly and
// keeps backing off rather than spinning hot against Telegram.
func (b *Bridge) pollLoop(ctx context.Context) {
	var offset int64
	for {
		if ctx.Err() != nil {
			return
		}
		updates, err := b.client.GetUpdates(ctx, offset, 30)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			wait := 5 * time.Second
			var apiErr *APIError
			if errors.As(err, &apiErr) {
				if apiErr.RetryAfter > 0 {
					wait = apiErr.RetryAfter
				}
			}
			// Telegram's own description, verbatim — never this package's
			// guess at what a code means. A 409 has two unrelated causes and
			// assuming the wrong one (as the log here used to) sends the
			// operator hunting for a duplicate process that does not exist.
			// See PollErrorDetail.
			detail := PollErrorDetail(err)
			log.Printf("telegram: getUpdates failed, retrying in %s: %s", wait, detail)
			b.health.Set(HealthError, detail)
			select {
			case <-time.After(wait):
			case <-ctx.Done():
				return
			}
			continue
		}
		// Reached Telegram and got an answer: inbound is genuinely working,
		// whether or not this particular poll carried any updates.
		b.health.Set(HealthOK, "")
		for _, u := range updates {
			offset = u.UpdateID + 1
			if u.CallbackQuery != nil {
				// Button taps get their own goroutine; messages stay in order
				// on this one.
				//
				// A callback query races a HARD deadline: Telegram shows a
				// spinner on the tapped button and keeps it there until
				// answerCallbackQuery arrives, then invalidates the query
				// ("query is too old and response timeout expired") a few
				// seconds later. Handled in line, ONE slow tap spends that
				// budget for every tap behind it — the observed failure was a
				// single approval parked ~53s inside a Telegram call while
				// three more taps sat in this loop, all four expiring
				// unanswered, which reads to the operator as "the buttons do
				// nothing but spin".
				//
				// Concurrency is safe here in a way it would not be for
				// messages: every mutable thing a callback touches (b.cb,
				// b.userInput, the store) is already mutex-guarded, each tap
				// is an independent decision with no ordering relationship to
				// the next, and the engine serializes the commands they
				// dispatch anyway. Messages keep the in-order path because
				// two prompts typed in sequence must start turns in that
				// sequence.
				go b.handleUpdateSafely(ctx, u)
				continue
			}
			b.handleUpdateSafely(ctx, u)
		}
	}
}

// handleUpdateSafely is pollLoop's guard rail around one update.
//
// Every inbound update is handled on the single poll goroutine, so a panic
// anywhere below it — a field Telegram legitimately omitted, a payload no
// renderer expected — does not cost one update: it ends the ONLY thing reading
// from Telegram, and the bridge goes silent forever with nothing to say why.
// From the operator's side that is indistinguishable from a dead bot, which is
// the exact failure mode this whole surface has been fighting.
//
// The stack goes to the log because a bug that reaches here is one nobody has
// seen yet, and the update id is what ties it to what was being processed.
func (b *Bridge) handleUpdateSafely(ctx context.Context, u Update) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("telegram: panic handling update %d, dropping it: %v\n%s", u.UpdateID, r, debug.Stack())
		}
	}()
	b.handleUpdate(ctx, u)
}

func (b *Bridge) handleUpdate(ctx context.Context, u Update) {
	switch {
	case u.CallbackQuery != nil:
		b.handleCallback(ctx, u.CallbackQuery)
	case u.Message != nil:
		b.handleMessage(ctx, u.Message)
	}
}

// handleMessage is the inbound routing table from Task 5 Step 3(a), extended
// by the trust-on-first-use change (see authorizeSender):
//  1. /pair is handled before anything else — it is the one command an
//     unlisted sender may run. It stays useful after Change 1 for enrolling a
//     SECOND device; it is simply no longer the only way in.
//  2. Every other update goes through authorizeSender. While the allowlist is
//     EMPTY, the first sender to reach here is enrolled automatically and
//     told so. Once it is non-empty, the original rule is unchanged: a
//     sender not on it is dropped with no reply at all
//     (TestUnknownSenderIsIgnoredSilently).
//  3. The (chat, topic) pair is looked up against the binding table — the
//     bridge holds no "active thread" state (§0.2), so this lookup alone
//     decides which thread, if any, the message is for. An authorized sender
//     landing on an unbound chat is never met with silence either (Change
//     2): a command gets the original reply, and non-empty plain text gets
//     one naming /init — the operator's only way to learn that command
//     exists in the first place.
//  4. A recognized slash command goes to handleCommand; anything else starts
//     a turn on the bound thread.
func (b *Bridge) handleMessage(ctx context.Context, m *Message) {
	if m == nil || m.From == nil {
		return
	}
	if pc, isCmd := ParseCommand(m.Text); isCmd && pc.Name == "pair" {
		b.handlePair(ctx, m, pc)
		return
	}
	authorized, justEnrolled := b.authorizeSender(ctx, m)
	if !authorized {
		return
	}
	if justEnrolled {
		// The first feedback this bot has EVER given this operator — before
		// this, an empty allowlist meant every message vanished with no
		// explanation (the bug this whole change fixes).
		b.reply(ctx, m.Chat.ID, m.MessageThreadID, "✅ terhubung — kamu terdaftar otomatis sebagai pemilik bot ini. gunakan /pair untuk menambah perangkat lain.")
	}

	// /init is handled here, unconditionally, BEFORE the bindingForChat
	// lookup below — not after. The whole point of /init (unlike /pair) is
	// that its target destination is by definition NOT bound yet: the
	// operator sends it into the exact chat/topic they want a thread mirrored
	// to, precisely so they never have to know a raw chatId/topicId. If this
	// check came after the lookup, an unbound destination would fall into
	// the "chat ini belum terhubung ke thread manapun" branch below and
	// silently swallow the command. Unlike /pair, /init is NOT a pre-auth
	// command — it binds a destination to a thread whose agent can run shell
	// commands on production servers — so it still sits behind the
	// isAllowed check just above.
	if pc, isCmd := ParseCommand(m.Text); isCmd && pc.Name == "init" {
		b.cmdInit(ctx, m, pc)
		return
	}

	binding, bound := b.bindingForChat(m.Chat.ID, m.MessageThreadID)
	if !bound {
		// A published project's General topic has no session binding of its
		// own — every session lives in its own topic — so a message here is
		// aimed at the PROJECT and must be answered before the "not connected
		// to anything" copy below, which would be simply false.
		if project, isProject := b.projectBindingForDestination(m.Chat.ID, m.MessageThreadID); isProject {
			b.handleProjectMessage(ctx, m, project)
			return
		}
		if _, isCmd := ParseCommand(m.Text); isCmd {
			b.reply(ctx, m.Chat.ID, m.MessageThreadID, "chat ini belum terhubung ke thread manapun")
			return
		}
		// Change 2: an authorized sender must never hit total silence — that
		// is the exact dead end an operator with an unbound chat and no idea
		// /init exists just hit. A command already gets a reply above; plain
		// text needs the same courtesy, telling them what to do about it.
		// Guarded by the same textless check as the bound-chat path just
		// below it, so a sticker/photo/voice note landing on an unbound chat
		// still gets no reply — there is nothing to say about it, and every
		// one of those would otherwise trip this into replying to every
		// non-text update.
		if strings.TrimSpace(m.Text) != "" {
			// A message in a chat that publishes a project from a DIFFERENT
			// topic is the single most confusing state this feature has: the
			// operator published something, typed, and got nothing back —
			// no reply, and (before this) not even a log line to explain it.
			// Naming the topic the project actually lives in is the one
			// piece of information that resolves it.
			if elsewhere, hosted := b.projectElsewhereInChat(m.Chat.ID, m.MessageThreadID); hosted {
				// Logged either way: a drop that leaves no trace anywhere is
				// what made "I published it and nothing happens" impossible
				// to diagnose.
				log.Printf("telegram: message in chat %d topic %d, but its project is bound to topic %d",
					m.Chat.ID, m.MessageThreadID, elsewhere.TopicID)
				// Answered only in General. That is where an operator whose
				// bot seems dead goes looking, so it is worth a reply; the
				// group's OTHER topics are ordinary human conversation, and
				// answering every message in them turns the bot into a
				// heckler. Both failure modes are real — this splits them by
				// the one signal that tells them apart.
				if m.MessageThreadID == 0 {
					b.reply(ctx, m.Chat.ID, m.MessageThreadID, b.wrongTopicHint(elsewhere))
				}
				return
			}
			b.reply(ctx, m.Chat.ID, m.MessageThreadID, "chat ini belum terhubung ke thread manapun. publish thread dari DevDeck, lalu kirim /init <threadId> di sini.")
		}
		return
	}

	if pc, isCmd := ParseCommand(m.Text); isCmd {
		b.handleCommand(ctx, m, binding, pc)
		return
	}
	// A photo, sticker or voice note in a bound chat arrives with no text at
	// all. Starting a turn on it would run the agent — on the SSH threads
	// this bridge exists for, a shell-capable agent — with no instruction.
	if strings.TrimSpace(m.Text) == "" {
		return
	}
	b.startTurn(ctx, m, binding, m.Text)
}

func (b *Bridge) handlePair(ctx context.Context, m *Message, pc ParsedCommand) {
	if len(pc.Args) == 0 {
		b.reply(ctx, m.Chat.ID, m.MessageThreadID, "gunakan /pair <kode>")
		return
	}
	if !b.pairing.Redeem(pc.Args[0]) {
		b.reply(ctx, m.Chat.ID, m.MessageThreadID, "kode tidak berlaku")
		return
	}
	label := "@" + m.From.Username
	if m.From.Username == "" {
		label = strconv.FormatInt(m.From.ID, 10)
	}
	if err := b.store.AddTelegramUser(domain.TelegramUser{
		UserID: m.From.ID, Label: label, AddedAt: b.now().UnixMilli(),
	}); err != nil {
		log.Printf("telegram: add user %d: %v", m.From.ID, err)
		b.reply(ctx, m.Chat.ID, m.MessageThreadID, "gagal menyimpan, coba lagi")
		return
	}
	b.reply(ctx, m.Chat.ID, m.MessageThreadID, "✅ terhubung")
}

// isAllowed re-reads the allowlist on every update rather than caching it —
// the list is small (an operator's own devices), reads are cheap next to a
// network round trip to Telegram, and a cache would be one more thing that
// could serve a stale "allowed" answer after a DeleteTelegramUser. Used on
// the callback path (handleCallback), which never auto-enrols: a tappable
// card only ever reaches a chat this bridge already sent to, so by the time
// a callback exists the allowlist is guaranteed non-empty.
func (b *Bridge) isAllowed(userID int64) bool {
	users, err := b.store.TelegramUsers()
	if err != nil {
		log.Printf("telegram: list users: %v", err)
		return false
	}
	for _, u := range users {
		if u.UserID == userID {
			return true
		}
	}
	return false
}

// authorizeSender is isAllowed's counterpart on the message path, extended
// with trust-on-first-use (Change 1 of the operator's 2026-08-18 decision to
// drop mandatory pairing). It reads the allowlist itself, rather than
// delegating the membership check to isAllowed, because it also needs to
// know whether the list is EMPTY — the one state that makes this sender
// eligible for auto-enrolment.
//
// Rationale for trusting the first sender at all, preserved here because it
// is the one non-obvious call in this whole change: the bot TOKEN is the
// actual secret, not the allowlist. A brand-new bot has no @username anyone
// else knows yet, so the window in which a stranger could win a race to be
// "first contact" is vanishingly small — in practice the operator sets the
// token in Settings and messages the bot within seconds. That is a
// materially different risk from leaving the bot open to anyone who ever
// discovers it, which is exactly why this only fires while the allowlist is
// EMPTY (never again once it holds even one entry) — trust on FIRST use, not
// no allowlist at all.
func (b *Bridge) authorizeSender(ctx context.Context, m *Message) (authorized, justEnrolled bool) {
	users, err := b.store.TelegramUsers()
	if err != nil {
		log.Printf("telegram: list users: %v", err)
		return false, false
	}
	for _, u := range users {
		if u.UserID == m.From.ID {
			return true, false
		}
	}
	if len(users) > 0 {
		// Non-empty allowlist, sender not on it: unchanged from before this
		// change — dropped in total silence, no reply, no toast
		// (TestUnknownSenderIsIgnoredSilently).
		//
		// Silent to TELEGRAM, but never silent to the operator's log. A drop
		// that leaves no trace anywhere is what made the empty-allowlist bug
		// undiagnosable: the bot was healthy, connected, and receiving, and
		// there was no way to tell that from a dead one. Whoever is looking at
		// this log is already on the machine and entitled to know a message was
		// refused, and from whom.
		log.Printf("telegram: ignoring message from unlisted user %d (@%s); add them with /pair or in Settings",
			m.From.ID, m.From.Username)
		return false, false
	}

	label := "@" + m.From.Username
	if m.From.Username == "" {
		label = strconv.FormatInt(m.From.ID, 10)
	}
	if err := b.store.AddTelegramUser(domain.TelegramUser{
		UserID: m.From.ID, Label: label, AddedAt: b.now().UnixMilli(),
	}); err != nil {
		// Fail closed: a write that did not durably land must not authorize
		// the message that triggered it, or a transient store error would
		// grant access nothing on disk actually records.
		log.Printf("telegram: auto-enrol user %d: %v", m.From.ID, err)
		b.reply(ctx, m.Chat.ID, m.MessageThreadID, "gagal menyimpan, coba lagi")
		return false, false
	}
	return true, true
}

// bindingForChat is the pure (chat.id, message_thread_id) -> threadID lookup
// §0.2 describes. There is no dedicated store index for the reverse
// direction (Task 1 only provides TelegramBindingByThread), so this scans
// TelegramBindings() — the list is bounded by how many threads one operator
// has opted to publish, never large enough for the scan to matter.
func (b *Bridge) bindingForChat(chatID, topicID int64) (domain.TelegramBinding, bool) {
	bindings, err := b.store.TelegramBindings()
	if err != nil {
		log.Printf("telegram: list bindings: %v", err)
		return domain.TelegramBinding{}, false
	}
	for _, bnd := range bindings {
		if bnd.ChatID == chatID && bnd.TopicID == topicID {
			return bnd, true
		}
	}
	return domain.TelegramBinding{}, false
}

// ---------------------------------------------------------------------------
// (b) Commands
// ---------------------------------------------------------------------------

func (b *Bridge) handleCommand(ctx context.Context, m *Message, binding domain.TelegramBinding, pc ParsedCommand) {
	switch pc.Name {
	case "init":
		// In practice unreachable today: handleMessage returns out of an
		// /init before ever reaching the bindingForChat lookup that decides
		// whether handleCommand gets called at all (see the comment there).
		// It is listed here anyway, per the same requirement that added
		// "init" to this package's recognized-name doc comment, so that a
		// /init sent into an already-bound chat — re-pointing a thread, or
		// binding a second thread to a different topic — keeps working even
		// if that early-return ordering ever changes. cmdInit's own
		// uniqueness and idempotency rules do not depend on `binding` (the
		// CURRENT occupant of this chat/topic, if any) at all, so routing
		// through here is exactly as correct as the early path.
		b.cmdInit(ctx, m, pc)
	case "new":
		// In a published project /new means "another session of THIS
		// project", which is a different thing from cmdNew's "another chat
		// pane on this thread" — and it is the one the operator asked for by
		// publishing a project in the first place.
		if project, isProject := b.projectBindingForDestination(m.Chat.ID, m.MessageThreadID); isProject {
			b.cmdNewProjectSession(ctx, m, project)
			return
		}
		b.cmdNew(ctx, m, binding)
	case "resume":
		if project, isProject := b.projectBindingForDestination(m.Chat.ID, m.MessageThreadID); isProject {
			b.cmdResume(ctx, m, project)
			return
		}
		b.reply(ctx, m.Chat.ID, m.MessageThreadID,
			"/resume cuma berlaku di topic yang publish satu project.")
	case "agents":
		// The agent belongs to the project, not to this session: a live
		// thread's agent is fixed at creation. Outside a published project
		// there is nowhere to record a choice, so say that rather than
		// offering a picker that could not do anything.
		if project, isProject := b.projectBindingForDestination(m.Chat.ID, m.MessageThreadID); isProject {
			b.cmdAgentsForProject(ctx, m, project)
			return
		}
		// A destination publishing ONE thread — an SSH connection, typically.
		// It gets the same picker; the choice is remembered on the binding and
		// spent by /new, because a live thread's agent cannot be changed.
		b.cmdAgentsForThread(ctx, m, binding)
	case "permissions":
		b.cmdPermissions(ctx, m, binding)
	case "model":
		b.cmdModel(ctx, m, binding)
	case "skills":
		b.cmdSkills(ctx, m, binding)
	case "compact":
		b.cmdCompact(ctx, m, binding)
	case "stop":
		b.cmdStop(ctx, m, binding)
	case "status":
		b.cmdStatus(ctx, m, binding)
	case "unpublish":
		b.cmdUnpublish(ctx, m, binding)
	default:
		b.reply(ctx, m.Chat.ID, m.MessageThreadID, "perintah tidak dikenal")
	}
}

// cmdInit is "the destination identifies itself": the operator clicks
// Publish in the web UI, is shown a command like "/init ssh:c-a1b2", and
// sends that exact message into whichever chat or forum topic they want the
// thread mirrored to. The bridge reads chat.id and message_thread_id off
// THIS message and writes the binding — there is no dialog anywhere asking
// for a raw chatId/topicId, because nobody can read those off the Telegram
// UI.
//
// Two rules mirror handler/telegram.go's PutBinding exactly, because the
// hazard is the same one either entry point can create: these threads run
// shell commands on production servers, so a destination bound to the wrong
// thread is a "y" answered at the wrong machine.
//  1. Destination uniqueness: if (m.Chat.ID, m.MessageThreadID) already
//     belongs to a DIFFERENT thread, refuse and write nothing. Re-sending
//     /init for the SAME thread at the SAME destination is deliberately not
//     an error — the operator may just be re-confirming, or the message
//     history scrolled away — so that case falls through to the same
//     SetTelegramBinding upsert as a genuinely new bind.
//  2. A brand-new binding starts mirroring at the thread's current head
//     sequence, never 0. LastSeq: 0 was fine for the old settings-dialog
//     flow (Known follow-ups #2 in the plan), where the operator was already
//     staring at a fresh or nearly-fresh thread. /init can be pointed at a
//     long-running SSH thread with thousands of historical events; dumping
//     all of them into Telegram at bind time would blow straight into 429
//     backoff. "/init" means "mirror from here on", so headSeq is computed
//     BEFORE the row exists (TelegramBindingByThread returning sql.ErrNoRows
//     is what "genuinely new" means here) and only used on that path.
//     SetTelegramBinding's own upsert already refuses to move LastSeq on a
//     re-point (see its doc comment) — this function must not defeat that by
//     always passing a fresh LastSeq in.
func (b *Bridge) cmdInit(ctx context.Context, m *Message, pc ParsedCommand) {
	// A thread id may itself contain ":" and "::" (ssh:c-a1b2::chat-2), so
	// the whole first argument is taken verbatim — splitting on ":" here
	// would truncate exactly the ids /new mints.
	if len(pc.Args) == 0 || strings.TrimSpace(pc.Args[0]) == "" {
		b.reply(ctx, m.Chat.ID, m.MessageThreadID, "gunakan /init <threadId>")
		return
	}
	threadID := pc.Args[0]

	// A project id and a thread id are both just ids on the wire, and the
	// operator copies whichever one the UI gave them. Resolving it decides
	// which of the two very different bindings this is — per-session (this
	// function) or whole-project (cmdInitProject). Looked up rather than
	// pattern-matched on the "p-" prefix: a thread id is free-form enough
	// (ssh:c-a1b2, w-x::chat-2) that a prefix rule would be a guess, and the
	// store already answers the question definitively.
	if project, err := b.store.ProjectByID(threadID); err == nil && project.ID != "" {
		b.cmdInitProject(ctx, m, project)
		return
	}

	if existing, bound := b.bindingForChat(m.Chat.ID, m.MessageThreadID); bound && existing.ThreadID != threadID {
		b.reply(ctx, m.Chat.ID, m.MessageThreadID, "tempat ini sudah terhubung ke thread "+existing.ThreadID+" — /unpublish di sana dulu")
		return
	}

	prev, err := b.store.TelegramBindingByThread(threadID)
	switch {
	case err == nil:
		// A row already exists for this exact threadID — this is either the
		// same-destination idempotent re-send, or a re-point to a new
		// destination. Either way it is NOT "genuinely new", so LastSeq is
		// left at its zero value here: SetTelegramBinding's ON CONFLICT path
		// never touches the last_seq column, so this value is simply unused.
		//
		// A re-point leaves a pin in the OLD chat naming a thread that chat
		// is about to stop receiving. Drop it before pinning the replacement.
		// Same-destination re-sends unpin too, because the confirmation about
		// to be sent is a NEW message and the old pin would otherwise linger
		// alongside it.
		b.UnpinBinding(ctx, prev)
	case errors.Is(err, sql.ErrNoRows):
		head, herr := b.headSeq(threadID)
		if herr != nil {
			log.Printf("telegram: init head seq thread %s: %v", threadID, herr)
			b.reply(ctx, m.Chat.ID, m.MessageThreadID, "gagal menyimpan binding")
			return
		}
		if err := b.store.SetTelegramBinding(domain.TelegramBinding{
			ThreadID: threadID, ChatID: m.Chat.ID, TopicID: m.MessageThreadID, LastSeq: head,
		}); err != nil {
			log.Printf("telegram: init bind thread %s: %v", threadID, err)
			b.reply(ctx, m.Chat.ID, m.MessageThreadID, "gagal menyimpan binding")
			return
		}
		b.replyAndPin(ctx, threadID, m.Chat.ID, m.MessageThreadID, b.initConfirmation(threadID))
		return
	default:
		log.Printf("telegram: init lookup thread %s: %v", threadID, err)
		b.reply(ctx, m.Chat.ID, m.MessageThreadID, "gagal menyimpan binding")
		return
	}

	if err := b.store.SetTelegramBinding(domain.TelegramBinding{
		ThreadID: threadID, ChatID: m.Chat.ID, TopicID: m.MessageThreadID,
	}); err != nil {
		log.Printf("telegram: init bind thread %s: %v", threadID, err)
		b.reply(ctx, m.Chat.ID, m.MessageThreadID, "gagal menyimpan binding")
		return
	}
	b.replyAndPin(ctx, threadID, m.Chat.ID, m.MessageThreadID, b.initConfirmation(threadID))
}

// headSeq is where a NEW binding starts mirroring from: the thread's current
// head sequence, so /init means "mirror from here on" and a long thread's
// history is not dumped into Telegram at bind time.
//
// With ONE exception, which is the whole reason this is not a one-line
// accessor: a thread that is RUNNING right now starts at the beginning of the
// turn in flight instead. Publishing mid-run is not a hypothetical — it is the
// common case, because a turn that is going to take minutes is exactly what an
// operator wants on their phone. Starting at head there put the cursor in the
// middle of a turn whose question, tool calls and prose so far were all
// already behind it, so the chat showed nothing for that turn at all and the
// first thing to ever arrive was the NEXT one. "From here on" has to mean
// "including what is happening right now", or publishing during a run answers
// the one question it was opened to answer with silence.
//
// The rewind is bounded by one turn, never the whole log, so the 429-storm
// this function's head-not-zero rule exists to prevent is still prevented.
//
// There is no dedicated port.Store accessor for any of this (deliberately not
// added — see cmdInit's doc comment): AgentEventsSince(threadID, 0) is the
// existing replay path every pump sweep already uses, so this is one O(n) scan
// at bind time only, not a new code path to keep correct.
func (b *Bridge) headSeq(threadID string) (uint64, error) {
	events, err := b.store.AgentEventsSince(threadID, 0)
	if err != nil {
		return 0, err
	}
	if len(events) == 0 {
		return 0, nil
	}
	head := events[len(events)-1].Seq
	if start, ok := b.runningTurnStart(threadID, events); ok {
		return start, nil
	}
	return head, nil
}

// runningTurnStart returns the cursor that replays the in-flight turn from its
// beginning — the Seq immediately BEFORE the turn's first event — and whether
// the thread has one at all.
//
// Gated on the engine's own status rather than on "the log ends without a
// terminal session-set", because the log is not conclusive: a thread whose
// process died mid-turn has exactly the same tail as one still streaming, and
// replaying a dead turn's whole transcript is the history dump /init must not
// do. Thread.Status is what the rest of this bridge already trusts for the
// same question (see keepTyping).
//
// WAITING counts as in-flight here, unlike in keepTyping. A turn parked on an
// approval or an AskUserQuestion is exactly what an operator publishes to
// their phone for — the tap is the thing they came to make — and the engine
// records that state as ThreadWaiting (pendingRequestAdd), not
// ThreadRunning. Gating on "running" alone bound at head, leaving the pending
// card behind the cursor, so the chat showed nothing whatsoever and the
// request sat unanswered.
//
// The anchor is the turn's `thread.message-sent` when there is one — the
// operator's own question, without which the replayed answer arrives with
// nothing to answer — and its `thread.turn-start-requested` otherwise.
func (b *Bridge) runningTurnStart(threadID string, events []orchestration.Event) (uint64, bool) {
	thread, ok := b.engine.State().Thread(threadID)
	if !ok || (thread.Status != orchestration.ThreadRunning && thread.Status != orchestration.ThreadWaiting) {
		return 0, false
	}
	for i := len(events) - 1; i >= 0; i-- {
		if events[i].Type != orchestration.EvtThreadTurnStartRequested {
			continue
		}
		anchor := i
		if i > 0 && events[i-1].Type == orchestration.EvtThreadMessageSent {
			anchor = i - 1
		}
		// Seq is globally monotonic, so "everything after Seq-1" is exactly
		// "this event and everything after it" for this thread — the store
		// filters by thread_id before the seq comparison.
		return events[anchor].Seq - 1, true
	}
	return 0, false
}

// cmdNew allocates a fresh thread id (NextChatSuffix, mirroring the
// frontend's client-side pane numbering), creates it in the engine — reusing
// the base thread's InstanceID, the same "InstanceID resolves the agent"
// contract agent_ws.go's autoCreateThread relies on — and, for a forum
// chat, opens a matching topic and binds it. A non-forum chat has nowhere to
// put a second destination (§0.2: a binding names one chat, optionally one
// topic inside it), so it is told plainly rather than silently rebinding the
// current chat out from under itself.
func (b *Bridge) cmdNew(ctx context.Context, m *Message, binding domain.TelegramBinding) {
	base := binding.ThreadID
	if i := strings.Index(base, "::"); i >= 0 {
		base = base[:i]
	}
	// Store AND engine — see knownThreadIDs. The engine's view alone can
	// re-issue an id a previous conversation already owns.
	newThreadID := NextChatSuffix(b.knownThreadIDs(base), base)

	// The destination's /agents choice wins when there is one; otherwise the
	// base thread's own agent carries over.
	//
	// Via instanceIDFor, never a bare lookup: a base thread the engine has
	// never seen used to leave this empty, and an empty InstanceID matches no
	// driver — the new chat would be created successfully and then fail every
	// turn with "thread is not bound to an instance".
	instanceID := b.instanceIDFor(base)
	if binding.Agent != "" {
		instanceID = orchestration.InstanceIDForAgent(binding.Agent)
	}
	createPayload, err := json.Marshal(struct {
		InstanceID string `json:"instanceId"`
	}{InstanceID: string(instanceID)})
	if err != nil {
		log.Printf("telegram: marshal thread create %s: %v", newThreadID, err)
		b.reply(ctx, m.Chat.ID, m.MessageThreadID, "gagal membuat thread baru")
		return
	}
	if _, err := b.dispatch(ctx, orchestration.Command{
		Type: orchestration.CmdThreadCreate, ThreadID: newThreadID, Payload: createPayload,
	}); err != nil {
		log.Printf("telegram: create thread %s: %v", newThreadID, err)
		b.reply(ctx, m.Chat.ID, m.MessageThreadID, "gagal membuat thread baru")
		return
	}

	if !m.Chat.IsForum {
		b.reply(ctx, m.Chat.ID, m.MessageThreadID, "chat baru butuh forum topic — grup ini bukan forum")
		return
	}
	topicID, err := b.client.CreateForumTopic(ctx, m.Chat.ID, newThreadID)
	if err != nil {
		log.Printf("telegram: create forum topic for %s: %v", newThreadID, err)
		// Named, not generic: this fails almost exclusively because the bot
		// is not an admin, and "gagal membuat topic baru" on its own sends
		// the operator looking for a bug that is not there.
		if isMissingRights(err) {
			b.reply(ctx, m.Chat.ID, m.MessageThreadID,
				"gagal membuat topic baru: bot belum admin di sini. Buka info grup → Administrators → tambahkan bot ini, aktifkan Manage Topics.")
			return
		}
		b.reply(ctx, m.Chat.ID, m.MessageThreadID, "gagal membuat topic baru")
		return
	}
	if err := b.store.SetTelegramBinding(domain.TelegramBinding{
		ThreadID: newThreadID, ChatID: m.Chat.ID, TopicID: topicID,
		// Carried forward, or the choice would last exactly one /new. The model
		// only while the agent is unchanged — see carryModel.
		Agent: binding.Agent, Model: b.carryModel(binding.ThreadID, instanceID, binding.Model),
	}); err != nil {
		log.Printf("telegram: bind new thread %s: %v", newThreadID, err)
		b.reply(ctx, m.Chat.ID, m.MessageThreadID, "gagal menyimpan binding")
		return
	}
	b.reply(ctx, m.Chat.ID, topicID, "✅ thread baru: "+newThreadID)
}

// cmdModel offers one button per model; the callback (handleModelSelection)
// writes binding.Model, which every later startTurn carries as
// provider.ModelSelection.Model.
func (b *Bridge) cmdModel(ctx context.Context, m *Message, binding domain.TelegramBinding) {
	models, err := b.models(b.agentForModelPicker(m, binding))
	if err != nil || len(models) == 0 {
		b.reply(ctx, m.Chat.ID, m.MessageThreadID, "tidak ada model tersedia")
		return
	}
	kb := make(InlineKeyboard, 0, len(models))
	for _, model := range models {
		token := b.mintCallback(callbackTarget{Kind: cbModel, ThreadID: binding.ThreadID, Model: model})
		kb = append(kb, []InlineButton{{Text: model, CallbackData: token}})
	}
	// Said out loud, because the alternative is the silent drop this whole
	// change exists to remove: these ids belong to the agent running RIGHT
	// NOW, and an /agents pick still waiting for its /new will discard whatever
	// is chosen here (carryModel). An operator who follows /agents' own
	// "/new untuk mulai sekarang" never sees this line.
	text := "pilih model:"
	if pending := b.pendingAgentSwitch(m, binding); pending != "" {
		text = "pilih model untuk sesi ini. /agents sudah memilih " + b.agentLabel(pending) +
			" — jalankan /new dulu kalau mau pilih model buat agent itu."
	}
	if err := b.callWithRetry(ctx, func() error {
		_, err := b.client.SendMessage(ctx, SendOptions{
			ChatID: m.Chat.ID, TopicID: m.MessageThreadID, Text: EscapeMarkdownV2(text), Keyboard: kb,
		})
		return err
	}); err != nil {
		log.Printf("telegram: send model picker thread %s: %v", binding.ThreadID, err)
	}
}

// pendingAgentSwitch names the agent this destination has chosen with /agents
// but not yet spent with /new, "" when the live session is already running it.
func (b *Bridge) pendingAgentSwitch(m *Message, binding domain.TelegramBinding) string {
	want := binding.Agent
	if project, isProject := b.projectBindingForDestination(m.Chat.ID, m.MessageThreadID); isProject {
		want = project.Agent
	}
	if want == "" || orchestration.InstanceIDForAgent(want) == b.instanceOfThread(binding.ThreadID) {
		return ""
	}
	return want
}

// agentForModelPicker names the agent whose catalog /model must offer: the one
// that will actually run the next turn in this destination.
//
// The LIVE session wins. A thread's agent is fixed at thread.create and no
// command re-points it, so an /agents pick still waiting to be spent by /new
// must not redirect the list to a catalog this session cannot switch to — the
// operator would tap an id the running CLI has never heard of, and (for Pi,
// whose set_model needs "provider/id") get a silent no-op rather than an error.
//
// Only when the engine has never seen the thread does the destination's own
// choice decide. That is not an edge case: /init writes a binding and nothing
// else, so a connection published from the web UI and first typed into from a
// phone has no engine thread until ensureThread creates one — and answering
// with the global default agent's models there is what made /agents look like
// it did nothing.
func (b *Bridge) agentForModelPicker(m *Message, binding domain.TelegramBinding) string {
	if th, ok := b.engine.State().Thread(binding.ThreadID); ok {
		if agent := agentOf(th.InstanceID); agent != "" {
			return agent
		}
	}
	if binding.Agent != "" {
		return binding.Agent
	}
	if project, isProject := b.projectBindingForDestination(m.Chat.ID, m.MessageThreadID); isProject && project.Agent != "" {
		return project.Agent
	}
	return orchestration.DefaultAgent
}

// agentOf extracts the agent id from an InstanceID ("claude:default" ->
// "claude"), "" when there is none to extract.
func agentOf(id provider.InstanceID) string {
	if i := strings.IndexByte(string(id), ':'); i > 0 {
		return string(id)[:i]
	}
	return ""
}

// instanceOfThread is the instance a thread is ACTUALLY running, as opposed to
// instanceIDFor's "what a new thread here should be created against". Never
// empty, for the same reason instanceIDFor is not.
func (b *Bridge) instanceOfThread(threadID string) provider.InstanceID {
	if th, ok := b.engine.State().Thread(threadID); ok && th.InstanceID != "" {
		return th.InstanceID
	}
	return orchestration.InstanceIDForAgent("")
}

// carryModel is the model a replacement session should start on: the outgoing
// session's pick, but ONLY while the agent is unchanged.
//
// A model id is meaningful inside exactly one agent's catalog. /model acts on
// the LIVE session, so in the "/agents codex, then /model, then /new" order —
// the one /agents' own confirmation invites — the id the operator picked came
// from the OUTGOING agent's list. Carrying it into the new session hands Codex
// a Claude id, or hands Pi one its set_model cannot split into provider and
// model, which it answers by silently staying on the model it already had.
// That silence is the whole reported bug, so this drops the model instead and
// lets the new agent start on its own default.
func (b *Bridge) carryModel(fromThreadID string, to provider.InstanceID, model string) string {
	if model == "" || b.instanceOfThread(fromThreadID) != to {
		return ""
	}
	return model
}

func (b *Bridge) cmdSkills(ctx context.Context, m *Message, _ domain.TelegramBinding) {
	names, err := b.listSkills()
	if err != nil {
		b.reply(ctx, m.Chat.ID, m.MessageThreadID, "gagal memuat daftar skill")
		return
	}
	text := strings.Join(names, "\n")
	if text == "" {
		text = "(tidak ada skill terpasang)"
	}
	text = truncateForTelegram(text, 4000)
	b.reply(ctx, m.Chat.ID, m.MessageThreadID, text)
}

// cmdCompact has no real adapter seam to call (§0.8: provider.Adapter has no
// Compact method). Dispatching a normal turn whose text is the literal
// string "/compact" is honest about that limitation and cannot crash
// anything — a provider that does not interpret it simply answers as if
// asked about compaction.
func (b *Bridge) cmdCompact(ctx context.Context, m *Message, binding domain.TelegramBinding) {
	payload, err := json.Marshal(orchestration.TurnStartPayload{
		Text: "/compact", Model: provider.ModelSelection{Model: binding.Model},
	})
	if err != nil {
		log.Printf("telegram: marshal /compact thread %s: %v", binding.ThreadID, err)
		b.reply(ctx, m.Chat.ID, m.MessageThreadID, "gagal mengirim /compact")
		return
	}
	if _, err := b.dispatch(ctx, orchestration.Command{
		Type: orchestration.CmdThreadTurnStart, ThreadID: binding.ThreadID, Payload: payload,
	}); err != nil {
		log.Printf("telegram: /compact thread %s: %v", binding.ThreadID, err)
		b.reply(ctx, m.Chat.ID, m.MessageThreadID, "gagal mengirim /compact")
		return
	}
	b.reply(ctx, m.Chat.ID, m.MessageThreadID, "diteruskan ke agent — dukungan tergantung provider")
}

func (b *Bridge) cmdStop(ctx context.Context, m *Message, binding domain.TelegramBinding) {
	if _, err := b.dispatch(ctx, orchestration.Command{
		Type: orchestration.CmdThreadSessionStop, ThreadID: binding.ThreadID,
	}); err != nil {
		log.Printf("telegram: stop thread %s: %v", binding.ThreadID, err)
		b.reply(ctx, m.Chat.ID, m.MessageThreadID, "gagal menghentikan sesi")
		return
	}
	b.reply(ctx, m.Chat.ID, m.MessageThreadID, "sesi dihentikan")
}

func (b *Bridge) cmdStatus(ctx context.Context, m *Message, binding domain.TelegramBinding) {
	th, ok := b.engine.State().Thread(binding.ThreadID)
	if !ok {
		b.reply(ctx, m.Chat.ID, m.MessageThreadID, "thread belum ada di engine")
		return
	}
	model := binding.Model
	if model == "" {
		model = "(default)"
	}
	text := fmt.Sprintf("status: %s\nmodel: %s\npending: %d", th.Status, model, len(th.PendingRequests))
	b.reply(ctx, m.Chat.ID, m.MessageThreadID, text)
}

func (b *Bridge) cmdUnpublish(ctx context.Context, m *Message, binding domain.TelegramBinding) {
	// A project owns exactly one destination now, so /unpublish sent from it
	// is unambiguous: stop publishing the project. Ending the conversation
	// and starting another is what /new is for.
	if project, isProject := b.projectBindingForDestination(m.Chat.ID, m.MessageThreadID); isProject {
		b.unpublishProject(ctx, m, project)
		return
	}

	// Before the delete, while the row still names which message to unpin.
	// A pin left behind would keep advertising a thread this chat no longer
	// receives anything from.
	b.UnpinBinding(ctx, binding)
	if err := b.store.DeleteTelegramBinding(binding.ThreadID); err != nil {
		log.Printf("telegram: unpublish thread %s: %v", binding.ThreadID, err)
		b.reply(ctx, m.Chat.ID, m.MessageThreadID, "gagal melepas publikasi")
		return
	}
	b.reply(ctx, m.Chat.ID, m.MessageThreadID, "thread ini sudah tidak terhubung ke Telegram")
}

// instanceIDFor resolves which provider instance a thread should be created
// against. Mirrors agent_ws.go:resolveInstanceID: an extra chat inherits its
// base thread's instance, and anything else — an SSH thread has no worktree
// and therefore no per-thread agent choice — takes the default agent's.
//
// Never returns the empty string. An empty InstanceID matches no driver, and
// every turn on such a thread then fails with "thread is not bound to an
// instance" — silently, from Telegram's point of view.
func (b *Bridge) instanceIDFor(threadID string) provider.InstanceID {
	base := threadID
	if i := strings.Index(base, "::"); i >= 0 {
		base = base[:i]
	}
	if baseThread, ok := b.engine.State().Thread(base); ok && baseThread.InstanceID != "" {
		return baseThread.InstanceID
	}
	return orchestration.InstanceIDForAgent("")
}

// ensureThread creates threadID in the engine if it has never been seen.
//
// A thread exists in the engine only once something creates it, and for the
// browser that is agent_ws.go's autoCreateThread, fired by the WebSocket
// hello. `/init` writes a BINDING and nothing else — so publishing a
// connection whose chat has never been opened in a browser leaves the engine
// with no such thread, and the decider rejects the very first turn with
// "thread ... does not exist" (engine.go:130).
//
// Before this, that error reached only the log and the operator got silence:
// the same dead end that made an empty allowlist undiagnosable, reappearing
// one step further along the happy path. Publishing a connection and then
// typing into it from a phone, without ever opening it on a desktop, is a
// completely ordinary thing to do.
func (b *Bridge) ensureThread(ctx context.Context, threadID string) error {
	if _, ok := b.engine.State().Thread(threadID); ok {
		return nil
	}
	payload, err := json.Marshal(struct {
		InstanceID string `json:"instanceId"`
	}{InstanceID: string(b.instanceIDFor(threadID))})
	if err != nil {
		return err
	}
	_, err = b.dispatch(ctx, orchestration.Command{
		Type: orchestration.CmdThreadCreate, ThreadID: threadID, Payload: payload,
	})
	return err
}

func (b *Bridge) startTurn(ctx context.Context, m *Message, binding domain.TelegramBinding, text string) {
	if err := b.ensureThread(ctx, binding.ThreadID); err != nil {
		log.Printf("telegram: ensure thread %s: %v", binding.ThreadID, err)
		b.reply(ctx, m.Chat.ID, m.MessageThreadID, "gagal menyiapkan thread ini, coba lagi")
		return
	}
	payload, err := json.Marshal(orchestration.TurnStartPayload{
		Text: text, Model: provider.ModelSelection{Model: binding.Model},
	})
	if err != nil {
		log.Printf("telegram: marshal turn start thread %s: %v", binding.ThreadID, err)
		b.reply(ctx, m.Chat.ID, m.MessageThreadID, "gagal mengirim pesan ini, coba lagi")
		return
	}
	// A dispatch failure must reach the OPERATOR, not just the log. A prompt
	// that vanishes with no acknowledgement is indistinguishable from a dead
	// bot, and that ambiguity is what this whole change set exists to remove.
	events, err := b.dispatch(ctx, orchestration.Command{
		Type: orchestration.CmdThreadTurnStart, ThreadID: binding.ThreadID, Payload: payload,
	})
	if err != nil {
		log.Printf("telegram: turn start thread %s: %v", binding.ThreadID, err)
		b.reply(ctx, m.Chat.ID, m.MessageThreadID, "gagal mengirim pesan ini ke agent: "+err.Error())
		return
	}
	// Dispatch hands back the rows it just committed, so the echo this prompt
	// is about to produce is identified by Seq — no text matching, no guess.
	// The pump will drop exactly these, and only these.
	b.markOwnEchoes(events)
}

// markOwnEchoes records the message-sent events a Telegram-originated turn
// just produced, so pumpBinding does not mirror the operator's own message
// back into the chat they typed it in.
func (b *Bridge) markOwnEchoes(events []orchestration.Event) {
	b.echoMu.Lock()
	defer b.echoMu.Unlock()
	for _, ev := range events {
		if ev.Type != orchestration.EvtThreadMessageSent {
			continue
		}
		// Bounded. Entries are normally consumed by the next sweep, ~2s
		// later, but a binding deleted between the dispatch and that sweep
		// would strand one forever. Dropping arbitrary entries on overflow
		// costs at worst a re-echoed prompt, which is cosmetic; an unbounded
		// map in a process that runs for months is not.
		if len(b.ownEchoes) >= maxOwnEchoes {
			for seq := range b.ownEchoes {
				delete(b.ownEchoes, seq)
				if len(b.ownEchoes) < maxOwnEchoes/2 {
					break
				}
			}
		}
		b.ownEchoes[ev.Seq] = struct{}{}
	}
}

// consumeOwnEcho reports whether this event is the echo of a prompt this
// bridge sent, removing it either way — an echo is skipped exactly once.
func (b *Bridge) consumeOwnEcho(seq uint64) bool {
	b.echoMu.Lock()
	defer b.echoMu.Unlock()
	if _, ok := b.ownEchoes[seq]; !ok {
		return false
	}
	delete(b.ownEchoes, seq)
	return true
}

// dispatch is the ONE path every command this bridge sends the engine goes
// through: it stamps CommandID from Deps.NewID (never left for the caller to
// forget) and checks orchestration.ClientDispatchable first — the exact gate
// agent_ws.go:224 applies to WebSocket commands, because a client (this
// bridge included) must never be able to forge a server-only fact
// (assistant output, session state) by dispatching the command that
// produces it.
func (b *Bridge) dispatch(ctx context.Context, cmd orchestration.Command) ([]orchestration.Event, error) {
	if !orchestration.ClientDispatchable[cmd.Type] {
		return nil, fmt.Errorf("telegram: command %s is not client-dispatchable", cmd.Type)
	}
	cmd.CommandID = b.newID()
	return b.engine.Dispatch(ctx, cmd)
}

// ---------------------------------------------------------------------------
// Callbacks
// ---------------------------------------------------------------------------

func (b *Bridge) handleCallback(ctx context.Context, cq *CallbackQuery) {
	if cq == nil || cq.From == nil {
		return
	}
	// The allowlist rule applies to callbacks exactly as it does to
	// messages: a stranger tapping a button they somehow obtained gets no
	// reply either, not even a toast.
	if !b.isAllowed(cq.From.ID) {
		return
	}
	if cq.Data == noopCallback {
		// A read-only button (an agent that is not installed). Answered so
		// the tap's spinner clears, but with the reason rather than the
		// "expired" copy an unrecognized token would get.
		b.answerCallback(ctx, cq.ID, "agent ini belum terpasang di mesin itu")
		return
	}
	target, ok := b.resolveCallback(cq.Data)
	if !ok {
		b.answerCallback(ctx, cq.ID, "permintaan ini sudah kedaluwarsa")
		return
	}
	switch target.Kind {
	case cbModel:
		b.handleModelSelection(ctx, cq, target)
	case cbUserInput:
		b.handleUserInputAnswer(ctx, cq, target)
	case cbApproval:
		b.handleApprovalAnswer(ctx, cq, target)
	case cbAgent:
		b.handleAgentSelection(ctx, cq, target)
	case cbResume:
		b.handleResumeSelection(ctx, cq, target)
	case cbPermission:
		b.handlePermissionSelection(ctx, cq, target)
	default:
		// A token with no kind was never minted by any path here; treating it
		// as an approval is exactly the guess TestStaleCallbackTokenIsRejected
		// forbids.
		b.forgetCallback(cq.Data)
		b.answerCallback(ctx, cq.ID, "permintaan ini sudah kedaluwarsa")
	}
}

func (b *Bridge) handleApprovalAnswer(ctx context.Context, cq *CallbackQuery, target callbackTarget) {
	b.forgetCallback(cq.Data)
	payload, err := json.Marshal(orchestration.ApprovalRespondPayload{
		RequestID: target.RequestID, Decision: target.Decision,
	})
	if err != nil {
		log.Printf("telegram: marshal approval thread %s: %v", target.ThreadID, err)
		return
	}
	// Answered BEFORE the dispatch, not after. Engine.Dispatch is a round trip
	// through a single serialized command queue and waits on ctx, which here is
	// the bridge's process-lifetime context — so it has no bound of its own on
	// how long it can take. Telegram's callback query does: a few seconds, then
	// the query is dead and the button spins forever. Clearing the spinner
	// first costs nothing (the decision is already captured in `payload`) and
	// removes the entire class of "the tap did nothing" from this path.
	//
	// The outcome is reported by editing the card below rather than by a toast,
	// which is both more durable (it survives in the scrollback) and the only
	// option left once the query has been answered — Telegram accepts exactly
	// one answer per query.
	b.answerCallback(ctx, cq.ID, "")

	if _, err := b.dispatch(ctx, orchestration.Command{
		Type: orchestration.CmdThreadApprovalRespond, ThreadID: target.ThreadID, Payload: payload,
	}); err != nil {
		log.Printf("telegram: approval respond thread %s: %v", target.ThreadID, err)
		b.editCallbackMessage(ctx, cq.Message, EscapeMarkdownV2("⚠️ gagal mengirim jawaban — permintaan ini mungkin sudah dijawab di tempat lain"))
		return
	}
	// Escaped, like every other edit here: the edit carries parse_mode
	// MarkdownV2, and "✅ Terima (sesi ini)" has parentheses in it — reserved
	// characters that make editMessageText 400 "can't parse entities". The edit
	// is then dropped and the card KEEPS its buttons, so a decided request still
	// looks answerable and a second tap answers a request that no longer exists.
	b.editCallbackMessage(ctx, cq.Message, EscapeMarkdownV2(decisionLabel(target.Decision)))
}

// handleUserInputAnswer implements §5a. It NEVER dispatches with a partial
// Answers map: pu.total is fixed to the number of questions the prompt
// actually asked, and dispatch only happens once len(answers) reaches it.
// If pu is missing — the request was already fully answered and its
// accumulator removed, or (after a real process restart) the in-memory
// token map was reset along with it, so this callback could not have
// resolved in the first place — this answers with a toast and dispatches
// nothing, which is the safe side of the ambiguity: a stray or replayed tap
// must never risk sending a HALF-complete answers map, since that "reaches
// the agent as no answer at all" per UserInputRespondPayload's own doc
// comment.
func (b *Bridge) handleUserInputAnswer(ctx context.Context, cq *CallbackQuery, target callbackTarget) {
	key := pendingInputKey(target.ThreadID, target.RequestID)
	b.uiMu.Lock()
	pu, exists := b.userInput[key]
	b.uiMu.Unlock()
	if !exists {
		b.forgetCallback(cq.Data)
		b.answerCallback(ctx, cq.ID, "pertanyaan ini sudah tidak aktif")
		return
	}

	// A multiSelect question expects a LIST, not a string: that is what the
	// CLI's AskUserQuestion tool takes and what the browser panel sends
	// (resolvePendingUserInputAnswer's string[]). A scalar in its place is a
	// type error at the far end — the same "reaches the agent as no answer at
	// all" outcome a mis-keyed map produces.
	//
	// One element, because Telegram sends one card per question with one button
	// per option and a tap picks exactly one. A real multi-toggle card (tap
	// several, then "selesai") is a UI this bridge does not have; the shape is
	// what has to be right first.
	var answer any = target.Answer
	if target.MultiSelect {
		answer = []string{target.Answer}
	}

	pu.mu.Lock()
	pu.answers[target.QuestionIndex] = answer
	complete := len(pu.answers) >= len(pu.questions)
	var answersCopy map[string]any
	if complete {
		// Index-keyed inside, text-keyed on the wire — see pendingUserInput.
		answersCopy = make(map[string]any, len(pu.answers))
		for i, v := range pu.answers {
			if i < len(pu.questions) {
				answersCopy[pu.questions[i]] = v
			}
		}
	}
	pu.mu.Unlock()

	b.forgetCallback(cq.Data)
	b.answerCallback(ctx, cq.ID, "")
	b.editCallbackMessage(ctx, cq.Message, "❓ "+EscapeMarkdownV2(target.Question)+"\n✅ "+EscapeMarkdownV2(target.Answer))

	if !complete {
		return
	}

	b.uiMu.Lock()
	delete(b.userInput, key)
	b.uiMu.Unlock()

	payload, err := json.Marshal(orchestration.UserInputRespondPayload{
		RequestID: target.RequestID, Answers: answersCopy,
	})
	if err != nil {
		log.Printf("telegram: marshal user-input answers thread %s: %v", target.ThreadID, err)
		return
	}
	if _, err := b.dispatch(ctx, orchestration.Command{
		Type: orchestration.CmdThreadUserInputRespond, ThreadID: target.ThreadID, Payload: payload,
	}); err != nil {
		log.Printf("telegram: user-input respond thread %s: %v", target.ThreadID, err)
	}
}

func (b *Bridge) handleModelSelection(ctx context.Context, cq *CallbackQuery, target callbackTarget) {
	b.forgetCallback(cq.Data)
	// The lookup is only to answer "is this thread still published?" — the
	// write below is the NARROW setter, never a read-modify-write through
	// SetTelegramBinding. That upsert rewrites chat_id and topic_id too, so a
	// destination re-pointed between this read and that write (an /init
	// elsewhere, the Settings publish toggle, both on other goroutines) would be
	// silently written back to where it used to be, and the mirror would resume
	// in the chat the operator had just left. It is the exact hazard
	// SetTelegramBindingModel's own doc comment exists for.
	if _, err := b.store.TelegramBindingByThread(target.ThreadID); err != nil {
		log.Printf("telegram: model selection lookup thread %s: %v", target.ThreadID, err)
		b.answerCallback(ctx, cq.ID, "binding tidak ditemukan")
		return
	}
	if err := b.store.SetTelegramBindingModel(target.ThreadID, target.Model); err != nil {
		log.Printf("telegram: model selection save thread %s: %v", target.ThreadID, err)
		b.answerCallback(ctx, cq.ID, "gagal menyimpan model")
		return
	}
	b.answerCallback(ctx, cq.ID, "")
	b.editCallbackMessage(ctx, cq.Message, "model: "+EscapeMarkdownV2(target.Model))
}

// replyAndPin sends text and pins it. Used for the ONE message per
// destination that is worth keeping in reach: the /init confirmation naming
// which thread this chat is wired to. A chat accumulates hundreds of
// transcript messages, and "which thread am I even talking to" is the
// question the pin answers without scrolling to the top.
//
// A failed pin is logged and swallowed on purpose: in a group the bot needs
// can_pin_messages and usually is not an admin, and the binding — the thing
// the operator actually asked for — is already saved and confirmed.
func (b *Bridge) replyAndPin(ctx context.Context, threadID string, chatID, topicID int64, text string) {
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
		log.Printf("telegram: pin chat %d message %d (bot may lack can_pin_messages): %v", chatID, msg.MessageID, err)
		b.warnCannotPin(ctx, chatID, topicID, err)
		return
	}
	// Recorded only after Telegram actually accepted the pin. Storing an id
	// for a pin that never happened would make the eventual /unpublish try to
	// unpin a message that is not pinned — harmless, but it would also mean
	// the row claims a pin exists when none does.
	if err := b.store.SetTelegramBindingPin(threadID, msg.MessageID); err != nil {
		log.Printf("telegram: record pin for thread %s: %v", threadID, err)
	}
}

// warnCannotPin tells the operator, IN TELEGRAM, that the bookmark they were
// promised is not there and what to do about it.
//
// It exists because the alternative is a log line nobody reads: the pin
// silently not happening looks identical to a pin that worked until you go
// looking for it. Only a rights failure is worth a message — a transient
// network error is not the operator's problem and will not repeat.
func (b *Bridge) warnCannotPin(ctx context.Context, chatID, topicID int64, cause error) {
	if !isMissingRights(cause) {
		return
	}
	b.reply(ctx, chatID, topicID,
		"ℹ️ pesan ini tidak bisa di-pin: bot belum admin di sini. Buka info grup → Administrators → tambahkan bot ini, aktifkan Pin Messages (dan Manage Topics kalau mau /new bikin topic). Semua fitur lain tetap jalan.")
}

// isMissingRights picks out Telegram's permission refusals from every other
// 400. Matched on the description because the Bot API gives them all the same
// error_code, and the distinction decides whether the operator can act on it.
func isMissingRights(err error) bool {
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		return false
	}
	desc := strings.ToLower(apiErr.Desc)
	return strings.Contains(desc, "not enough rights") || strings.Contains(desc, "chat_admin_required")
}

// UnpinBinding removes the pinned /init confirmation for a binding that is
// going away, and is a no-op for a binding that never had one (every binding
// written before pinning existed, and every chat where the bot lacked
// can_pin_messages).
//
// Exported because unpublishing happens from TWO places — /unpublish in
// Telegram and the publish toggle in Settings — and only one of them runs
// inside this package. A stale pin left behind after unpublishing is worse
// than no pin at all: it points at a thread the chat is no longer wired to.
func (b *Bridge) UnpinBinding(ctx context.Context, binding domain.TelegramBinding) {
	if binding.PinnedMessageID == 0 {
		return
	}
	if err := b.client.UnpinChatMessage(ctx, binding.ChatID, binding.PinnedMessageID); err != nil {
		// Cosmetic: the operator asked to stop publishing, and that has
		// already happened (or is about to). Losing the unpin must not fail it.
		log.Printf("telegram: unpin chat %d message %d: %v", binding.ChatID, binding.PinnedMessageID, err)
	}
}

// threadLabel is the human name for a thread id, for the /init confirmation.
// A bare "w-20840bf5" says nothing about which project an operator just wired
// a shell-capable agent to — and getting that wrong is how a command lands on
// the wrong machine.
//
// Best-effort by design: an id this process cannot resolve (a thread on
// another machine, a row since deleted) returns "", and the caller shows the
// id alone rather than refusing to bind.
func (b *Bridge) threadLabel(threadID string) string {
	// Extra chat panes are "<base>::chat-N" (see NextChatSuffix); the base is
	// what the catalog knows about.
	base, _, _ := strings.Cut(threadID, "::")

	if connID, ok := strings.CutPrefix(base, "ssh:"); ok {
		conn, err := b.store.SSHConnectionByID(connID)
		if err != nil {
			return ""
		}
		if conn.Host != "" {
			return conn.Name + " (" + conn.Host + ")"
		}
		return conn.Name
	}

	wt, err := b.store.WorktreeByID(base)
	if err != nil {
		return ""
	}
	project, err := b.store.ProjectByID(wt.ProjectID)
	if err != nil {
		return wt.Branch
	}
	if wt.Branch == "" {
		return project.Name
	}
	return project.Name + " · " + wt.Branch
}

// initConfirmation is the pinned message /init leaves behind. Built here
// rather than inline so both of cmdInit's success paths (a fresh bind and a
// re-point) produce the identical text.
func (b *Bridge) initConfirmation(threadID string) string {
	text := "🔗 terhubung ke thread `" + escapeMarkdownV2Code(threadID) + "`"
	if label := b.threadLabel(threadID); label != "" {
		text += " — *" + EscapeMarkdownV2(label) + "*"
	}
	return text + "\n" +
		EscapeMarkdownV2("/agents pilih agent · /model pilih model · /permissions atur konfirmasi") + "\n" +
		EscapeMarkdownV2("/new sesi baru · /unpublish berhenti.")
}

func (b *Bridge) reply(ctx context.Context, chatID, topicID int64, text string) {
	if err := b.callWithRetry(ctx, func() error {
		_, err := b.client.SendMessage(ctx, SendOptions{ChatID: chatID, TopicID: topicID, Text: EscapeMarkdownV2(text)})
		return err
	}); err != nil {
		log.Printf("telegram: reply chat %d: %v", chatID, err)
	}
}

// answerCallbackTimeout bounds the ONE call that clears a tapped button's
// spinner. Telegram invalidates a callback query within seconds of the tap, so
// an attempt still in flight after this has already lost — and every second
// spent waiting is a second the tap keeps spinning.
const answerCallbackTimeout = 5 * time.Second

// answerCallback clears the spinner on a tapped inline button.
//
// Deliberately NOT routed through callWithRetry, unlike every other outbound
// call here. callWithRetry's contract is "never drop what was about to be
// sent", which is right for transcript content and exactly wrong for this: a
// 429's retry_after is tens of seconds, Telegram kills the query long before
// that, and the retry therefore cannot succeed — it can only park the caller
// for the whole wait and then fail anyway. That is the shape of the reported
// bug: a 53-second sleep in here answered a query that had expired 40 seconds
// earlier, and logged "query is too old and response timeout expired".
//
// One attempt, on its own short deadline, so a slow or rate-limited Telegram
// costs at most answerCallbackTimeout instead of an unbounded stall.
func (b *Bridge) answerCallback(ctx context.Context, id, text string) {
	ctx, cancel := context.WithTimeout(ctx, answerCallbackTimeout)
	defer cancel()
	if err := b.client.AnswerCallbackQuery(ctx, id, text); err != nil {
		log.Printf("telegram: answer callback %s: %v", id, err)
	}
}

func (b *Bridge) editCallbackMessage(ctx context.Context, msg *Message, text string) {
	if msg == nil {
		return
	}
	if err := b.callWithRetry(ctx, func() error {
		return b.client.EditMessageText(ctx, msg.Chat.ID, msg.MessageID, text, nil)
	}); err != nil {
		log.Printf("telegram: edit card message %d: %v", msg.MessageID, err)
	}
}

func (b *Bridge) mintCallback(target callbackTarget) string {
	b.cbMu.Lock()
	defer b.cbMu.Unlock()
	now := b.now()
	b.pruneCallbacksLocked(now)
	target.MintedAt = now
	var token string
	for {
		token = "cb:" + randomHex(4)
		if _, exists := b.cb[token]; !exists {
			break
		}
	}
	b.cb[token] = target
	return token
}

// pruneCallbacksLocked drops expired tokens and, if the map is still at its
// ceiling, the oldest quarter of what is left. Called on every mint, which is
// the only operation that can grow the map, so the bound holds without a
// background goroutine.
func (b *Bridge) pruneCallbacksLocked(now time.Time) {
	for token, t := range b.cb {
		if now.Sub(t.MintedAt) > callbackTokenTTL {
			delete(b.cb, token)
		}
	}
	if len(b.cb) < maxCallbackTokens {
		return
	}
	tokens := make([]string, 0, len(b.cb))
	for token := range b.cb {
		tokens = append(tokens, token)
	}
	sort.Slice(tokens, func(i, j int) bool {
		return b.cb[tokens[i]].MintedAt.Before(b.cb[tokens[j]].MintedAt)
	})
	for _, token := range tokens[:len(tokens)/4+1] {
		delete(b.cb, token)
	}
}

// resolveCallback looks a tapped token up. An expired token resolves as
// unknown — the caller then answers with the same "sudah kedaluwarsa" toast a
// never-minted token gets, and dispatches nothing.
func (b *Bridge) resolveCallback(token string) (callbackTarget, bool) {
	b.cbMu.Lock()
	defer b.cbMu.Unlock()
	t, ok := b.cb[token]
	if !ok {
		return callbackTarget{}, false
	}
	if b.now().Sub(t.MintedAt) > callbackTokenTTL {
		delete(b.cb, token)
		return callbackTarget{}, false
	}
	return t, true
}

func (b *Bridge) forgetCallback(token string) {
	b.cbMu.Lock()
	defer b.cbMu.Unlock()
	delete(b.cb, token)
}

// forgetCallbacksForRequest drops every token minted for one request — the
// whole keyboard at once, rather than the single button that was tapped.
//
// forgetCallback alone is not enough once a request is decided: a card offers
// four buttons and only one of them is ever tapped, so the other three stay
// live in b.cb for the full 24h TTL. Each is a capability to answer a request
// that no longer exists, which the decider rejects — but only after the tap
// has already been dispatched, and only as an error the operator has to read.
func (b *Bridge) forgetCallbacksForRequest(threadID, requestID string) {
	if requestID == "" {
		return
	}
	b.cbMu.Lock()
	defer b.cbMu.Unlock()
	for token, target := range b.cb {
		if target.ThreadID == threadID && target.RequestID == requestID {
			delete(b.cb, token)
		}
	}
}

// ---------------------------------------------------------------------------
// (c) Outbound pump
// ---------------------------------------------------------------------------

// pumpLoop wakes on either the engine's subscription (a doorbell, per §0.3 —
// never a data source) or a 2s backstop ticker, and sweeps every published
// binding either way. The backstop exists because Engine.publish drops
// batches for a slow subscriber by design; without it, a dropped wakeup
// would leave a thread's transcript stalled until the NEXT unrelated commit
// happened to fire the channel again.
func (b *Bridge) pumpLoop(ctx context.Context) {
	sub, unsub := b.engine.Subscribe(256)
	defer unsub()
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case _, ok := <-sub:
			if !ok {
				return
			}
			b.sweep(ctx)
		case <-ticker.C:
			b.sweep(ctx)
		}
	}
}

func (b *Bridge) sweep(ctx context.Context) {
	bindings, err := b.store.TelegramBindings()
	if err != nil {
		log.Printf("telegram: list bindings: %v", err)
		return
	}
	for _, binding := range bindings {
		b.pumpBinding(ctx, binding)
		b.keepTyping(ctx, binding)
	}
	// Drop the live-message bookkeeping of anything no longer published. An
	// unpublish/republish cycle otherwise resumes with the OLD message id and
	// the OLD accumulated text, and would edit a message belonging to a
	// binding the operator has already thrown away.
	published := make(map[string]struct{}, len(bindings))
	for _, binding := range bindings {
		published[binding.ThreadID] = struct{}{}
	}
	b.chatsMu.Lock()
	for threadID := range b.chats {
		if _, ok := published[threadID]; !ok {
			delete(b.chats, threadID)
		}
	}
	b.chatsMu.Unlock()
}

// pumpBinding is the replay-and-render step from Task 5 Step 3(c): read
// everything since the persisted cursor, render and send it, and persist a new
// cursor at the last EVENT BOUNDARY whose output actually reached Telegram.
//
// That boundary rule is the whole contract, in both directions:
//   - It never advances past an event whose output is still buffered or whose
//     send failed, so a failure (or a crash) re-reads that content rather than
//     losing it. TestLastSeqAdvancesOnlyAfterASuccessfulSend pins that half.
//   - It DOES advance over everything already delivered, including on a sweep
//     that then failed. The original rule was all-or-nothing per tick, which
//     was equivalent back when one sweep sent at most one message; with the
//     progressive mid-turn flush a sweep sends many, and discarding the earned
//     boundary re-sent every one of them next tick — forever, if the failure was
//     permanent. See persistSeq.
//
// Retrying can still duplicate the ONE message a failure interrupted; it can
// never lose content.
func (b *Bridge) pumpBinding(ctx context.Context, binding domain.TelegramBinding) {
	events, err := b.store.AgentEventsSince(binding.ThreadID, binding.LastSeq)
	if err != nil {
		log.Printf("telegram: replay thread %s: %v", binding.ThreadID, err)
		return
	}
	if len(events) == 0 {
		return
	}

	cs := b.chatStateFor(binding.ThreadID)
	cs.mu.Lock()
	defer cs.mu.Unlock()

	// Buffers for the turn's prose. LOCAL to this sweep, not carried on
	// chatState, and that is what makes the whole design restart-safe: the
	// cursor below is only ever advanced past events whose output has
	// actually been sent, so anything still sitting in these buffers is
	// re-read and re-buffered from SQLite on the next sweep — or by the next
	// process, if this one dies mid-turn. Nothing lives only in memory.
	var pendingText, pendingReasoning strings.Builder
	// Fence parity for each buffer, so the size- and time-based flushes below
	// never cut a code block in half — see fenceTracker.
	var textFence, reasoningFence fenceTracker
	// emittedSeq is the cursor this sweep has EARNED: the seq of the last
	// event after which nothing was left buffered. Deltas that have only been
	// buffered do not move it.
	emittedSeq := binding.LastSeq
	ok := true
	var sendErr error
	// sent counts the messages this sweep has actually put on the wire, and
	// budgetSpent records that it stopped early because of them — see
	// sweepMessageBudget. budgetSpent is a separate flag rather than a
	// comparison repeated later because the post-loop flush below advances the
	// cursor to the LAST event read, which is only sound when the loop
	// consumed all of them.
	sent := 0
	budgetSpent := false

	// send is the one place an outbound transcript message is counted. Every
	// send inside this sweep goes through it or through the two card helpers,
	// which return their own count for the same reason.
	send := func(text string) error {
		n, err := b.sendChatMessage(ctx, binding, text)
		sent += n
		return err
	}

	// flushPending sends whatever prose has accumulated, reasoning first.
	// Called before every standalone message so the chat keeps the order
	// things happened in, and at the end of a turn.
	flushPending := func() error {
		if pendingReasoning.Len() > 0 {
			text := strings.TrimSpace(pendingReasoning.String())
			pendingReasoning.Reset()
			reasoningFence.reset()
			if text != "" {
				if err := send("💭 " + ToMarkdownV2(text)); err != nil {
					return err
				}
				cs.lastFlush = b.now()
			}
		}
		if pendingText.Len() > 0 {
			text := strings.TrimSpace(pendingText.String())
			pendingText.Reset()
			textFence.reset()
			if text != "" {
				if err := send(ToMarkdownV2(text)); err != nil {
					return err
				}
				cs.lastFlush = b.now()
			}
		}
		return nil
	}

	// dueForStreamFlush answers "has this turn gone quiet in Telegram for long
	// enough that the operator would think it had stopped?" — the time half of
	// the progressive flush.
	dueForStreamFlush := func() bool {
		return b.now().Sub(cs.lastFlush) >= streamFlushInterval
	}

	// mayFlushMidTurn gates BOTH progressive flushes. A mid-turn cut is only
	// ever a convenience; splitting a fenced code block is a corruption (see
	// fenceTracker), so an open fence holds the buffer until the fence closes or
	// the turn ends — flushPending at the end of a turn splits with
	// splitForTelegram, which is a different, deliberate cut.
	mayFlushMidTurn := func() bool {
		return !textFence.endsInsideFence(pendingText.String()) &&
			!reasoningFence.endsInsideFence(pendingReasoning.String())
	}

	for _, ev := range events {
		// A request that has just been decided retires its card(s), wherever
		// the decision came from. Handled before Render because Render is pure
		// and renders none of these event types — the whole effect is the side
		// effect, and it has to run on the replay path (rather than only when
		// a tap arrives here) precisely because the common case is the
		// operator answering in the desktop app instead.
		if requestID, resolved := resolvedRequestID(ev); resolved {
			b.retireCards(ctx, cs, binding, requestID)
			// Not a message, so it does not touch `sent`: the sweep budget
			// counts what this bridge PUTS in the chat, and this takes
			// something out of it.
		}
		// A multi-question AskUserQuestion prompt needs every question, not
		// just the first (§5a) — Render() deliberately only renders the
		// first, since it is a pure function with nowhere to hold the
		// per-request "which questions are still open" state this needs.
		// So this event type is intercepted here, before Render, rather than
		// routed through the generic Card handling below.
		if ev.Type == orchestration.EvtThreadActivityAppended {
			if inner, isForwarded := decodeForwardedEvent(ev.Payload); isForwarded && inner.Type == event.UserInputRequested {
				if err := flushPending(); err != nil {
					ok, sendErr = false, err
					break
				}
				n, err := b.sendUserInputCards(ctx, cs, binding, inner)
				sent += n
				if err != nil {
					ok, sendErr = false, err
					break
				}
				emittedSeq = ev.Seq
				if sent >= sweepMessageBudget {
					budgetSpent = true
					break
				}
				continue
			}
		}

		r := Render(ev)
		// Tool calls are stitched together here rather than in Render,
		// which is pure and sees one event at a time.
		if ev.Type == orchestration.EvtThreadActivityAppended {
			if inner, isForwarded := decodeForwardedEvent(ev.Payload); isForwarded {
				if notice, emit := b.toolCallNotice(binding.ThreadID, inner); emit {
					r.Notices = append(r.Notices, notice)
				}
			}
		}
		// The operator's own message, typed into this very chat, must not be
		// sent back to them. Only a turn started somewhere else — the browser
		// — keeps its echo, because there it is Telegram's only record of
		// what was asked. See Rendered.Echo.
		if r.Echo != "" && !b.consumeOwnEcho(ev.Seq) {
			r.Notices = append([]string{r.Echo}, r.Notices...)
		}
		// Anything standalone flushes the prose ahead of it first, so a tool
		// call never jumps in front of the sentence that introduced it.
		if len(r.Notices) > 0 || r.Card != nil {
			if err := flushPending(); err != nil {
				ok, sendErr = false, err
				break
			}
		}
		for _, notice := range r.Notices {
			if err := send(notice); err != nil {
				ok, sendErr = false, err
				break
			}
		}
		if !ok {
			break
		}
		if r.Card != nil {
			sent++
			if err := b.sendApprovalCard(ctx, cs, binding, *r.Card); err != nil {
				ok, sendErr = false, err
				break
			}
		}
		pendingText.WriteString(r.Text)
		pendingReasoning.WriteString(r.Reasoning)
		// Mid-turn progress. Without this the only things that ever emptied
		// these buffers were a tool call, an approval card, or the end of the
		// turn — so a long answer with no tool calls was invisible in Telegram
		// until it was finished. Flushing at an EVENT boundary (rather than
		// slicing the buffer) is what keeps the cursor rule below exact:
		// everything up to and including this event has now been delivered.
		if pendingText.Len()+pendingReasoning.Len() >= streamFlushChars && mayFlushMidTurn() {
			if err := flushPending(); err != nil {
				ok, sendErr = false, err
				break
			}
		}
		if r.EndTurn {
			if err := flushPending(); err != nil {
				ok, sendErr = false, err
				break
			}
		}
		// Only now, with nothing held back, has this event been fully
		// delivered. An event that merely added to a buffer leaves the cursor
		// where it was, so a crash re-reads it rather than losing it.
		if pendingText.Len() == 0 && pendingReasoning.Len() == 0 {
			emittedSeq = ev.Seq
			// Stop here once the budget is spent — and ONLY here, at a boundary
			// the cursor has just moved to. Breaking with prose still buffered
			// would leave the cursor behind messages this sweep already sent,
			// and the next sweep would send them a second time. See
			// sweepMessageBudget.
			if sent >= sweepMessageBudget {
				budgetSpent = true
				break
			}
		}
	}
	// The time half of the progressive flush, applied once per sweep at the
	// last event's boundary — so a turn that produces a trickle of text over
	// several minutes still shows up while it is happening, rather than only
	// once streamFlushChars has accumulated.
	//
	// Skipped when the budget stopped the loop early: the cursor jump below is
	// to the LAST event READ, which is only "everything is delivered" when every
	// one of them was actually processed.
	if ok && !budgetSpent && pendingText.Len()+pendingReasoning.Len() > 0 && dueForStreamFlush() && mayFlushMidTurn() {
		if err := flushPending(); err != nil {
			ok, sendErr = false, err
		} else {
			// Everything read this sweep is now delivered, so the cursor may
			// pass all of it — the same rule the per-event branch above uses.
			emittedSeq = events[len(events)-1].Seq
		}
	}
	if !ok {
		// The cursor stays put so nothing is lost and the next sweep retries.
		// But say so, or a destination that can never be written again (the
		// bot removed from the group, the topic deleted) stops the mirror dead
		// with no explanation anywhere. Logged on the first failure and then
		// roughly once a minute — the sweep runs every 2s, and a wall of
		// identical lines is its own kind of silence.
		cs.sendFailures++
		if cs.sendFailures == 1 || cs.sendFailures%30 == 0 {
			log.Printf("telegram: cannot deliver thread %s to chat %d (attempt %d): %v",
				binding.ThreadID, binding.ChatID, cs.sendFailures, sendErr)
		}
		// The cursor stays put for everything this sweep could NOT deliver —
		// but not for what it already did. emittedSeq means "everything up to
		// here is on Telegram", and since the progressive mid-turn flush one
		// sweep can put many messages out before a later one fails; dropping
		// emittedSeq re-sends every one of them next sweep, forever if the
		// failure is permanent. Persist what was earned, retry only the rest.
		b.persistSeq(binding, emittedSeq)
		return
	}
	if cs.sendFailures > 0 {
		log.Printf("telegram: delivery to chat %d recovered after %d failed attempt(s)", binding.ChatID, cs.sendFailures)
		cs.sendFailures = 0
	}

	// emittedSeq, NOT the last event's seq. A turn still streaming has its
	// prose buffered in memory and nothing on Telegram yet; advancing past
	// those events would drop the answer entirely if this process restarted
	// before the turn ended. Holding the cursor costs one re-read of the same
	// deltas next sweep and cannot lose anything.
	b.persistSeq(binding, emittedSeq)
}

// persistSeq moves a binding's replay cursor to seq, a no-op when this sweep
// delivered nothing new. Every exit from pumpBinding goes through it — the
// FAILED one included, which is the whole point: seq is only ever the boundary
// of something already on Telegram, so re-reading past it is safe and
// re-sending it is not.
func (b *Bridge) persistSeq(binding domain.TelegramBinding, seq uint64) {
	if seq == binding.LastSeq {
		return
	}
	if err := b.store.SetTelegramBindingSeq(binding.ThreadID, seq); err != nil {
		log.Printf("telegram: persist seq thread %s: %v", binding.ThreadID, err)
	}
}

// toolCallNotice turns a pair of tool-call events into at most ONE line.
//
// item.started only records the name; the line is emitted at item.completed,
// when the call is finished and its arguments are known — which is also what
// the app's transcript shows (a checked row per completed call). Emitting on
// both events is what sent two messages per tool call, the second of them a
// wall of JSON headed "Tool".
//
// The pi shape is handled by the same path: its arguments arrive on
// item.started, so the summary is remembered alongside the name and used when
// the completion lands with only a result.
func (b *Bridge) toolCallNotice(threadID string, inner event.Event) (string, bool) {
	name, summary, isToolCall := ToolCallParts(inner)
	if !isToolCall {
		return "", false
	}
	key := threadID + "|" + inner.ItemID

	b.toolMu.Lock()
	defer b.toolMu.Unlock()

	if inner.Type == event.ItemStarted {
		// Remembered, not sent: a "starting…" line for every call is the
		// spam this exists to remove, and the completion is moments away.
		remembered := name
		if summary != "" {
			remembered += "\x00" + summary
		}
		if len(b.toolNames) >= maxToolNames {
			// A turn abandoned mid-call never sends its completion, so
			// entries can strand. Dropping arbitrary ones costs a tool line
			// its name, which is cosmetic; an unbounded map is not.
			for k := range b.toolNames {
				delete(b.toolNames, k)
				if len(b.toolNames) < maxToolNames/2 {
					break
				}
			}
		}
		b.toolNames[key] = remembered
		return "", false
	}

	rememberedName, rememberedSummary := name, ""
	if stored, ok := b.toolNames[key]; ok {
		delete(b.toolNames, key)
		if i := strings.IndexByte(stored, 0); i >= 0 {
			rememberedName, rememberedSummary = stored[:i], stored[i+1:]
		} else {
			rememberedName = stored
		}
	}
	if summary == "" {
		summary = rememberedSummary
	}
	return FormatToolCall(rememberedName, summary), true
}

// maxToolNames bounds the in-flight tool-call names. A turn runs a handful of
// calls at a time; this only matters for entries stranded by an abandoned turn.
const maxToolNames = 512

// keepTyping shows Telegram's "…is typing" hint while a turn is actually
// running, so a long tool call is visibly work rather than a chat that went
// quiet after "memproses…".
//
// Re-sent because Telegram clears the hint after ~5 seconds — but on a CLOCK
// of its own, not once per sweep. pumpLoop sweeps on every engine publish, and
// the durable log holds one event per streamed token, so "once per sweep" meant
// a sendChatAction per token: hundreds of calls per turn per published thread,
// competing with the messages that actually matter for the same rate limit.
//
// sendChatAction is the ONLY progress primitive the Bot API offers — there is no
// streaming, and the alternative (rewriting a message with editMessageText as
// tokens arrive) is the edit-in-place behaviour this bridge deliberately
// dropped.
//
// Failures are ignored entirely, not even logged: this is decoration, and a log
// line per refresh per thread would bury everything that matters.
func (b *Bridge) keepTyping(ctx context.Context, binding domain.TelegramBinding) {
	thread, ok := b.engine.State().Thread(binding.ThreadID)
	if !ok || thread.Status != orchestration.ThreadRunning {
		// Only "running". A thread WAITING on an approval is not working —
		// it is blocked on the operator, and telling them the bot is typing
		// while it waits for their tap is a lie that hides the ask.
		return
	}
	cs := b.chatStateFor(binding.ThreadID)
	cs.mu.Lock()
	now := b.now()
	due := now.Sub(cs.lastTyping) >= typingHintInterval
	if due {
		// Stamped before the call, not after: the send is fire-and-forget, and
		// a failure that reset the clock would just retry at token rate again.
		cs.lastTyping = now
	}
	cs.mu.Unlock()
	if !due {
		return
	}
	_ = b.client.SendChatAction(ctx, binding.ChatID, binding.TopicID, "typing")
}

// sendChatMessage posts one finished, already-MarkdownV2 message, splitting
// it when it exceeds what Telegram accepts. Every outbound transcript message
// goes through here — there is no edit path any more: a chat is a sequence of
// messages, and rewriting one in place destroys the order things happened in
// (and, on a long turn, showed a wall of text arriving a character at a time).
//
// It returns how many messages actually reached Telegram — the split means
// "one flush" is not "one message", and the sweep's budget has to count what
// went on the wire, not what it asked for.
func (b *Bridge) sendChatMessage(ctx context.Context, binding domain.TelegramBinding, text string) (int, error) {
	n := 0
	for _, part := range splitForTelegram(text) {
		if err := b.callWithRetry(ctx, func() error {
			_, err := b.client.SendMessage(ctx, SendOptions{
				ChatID: binding.ChatID, TopicID: binding.TopicID, Text: part,
			})
			return err
		}); err != nil {
			return n, err
		}
		n++
	}
	return n, nil
}

// splitForTelegram cuts text into messages Telegram will accept. Its hard cap
// is 4096 and it rejects anything longer outright — a rejection the pump cannot
// retry its way out of, since the cursor never advances past a message that
// would not send.
//
// The BUDGET is counted in UTF-16 code units, because that is what Telegram
// counts (telegramMessageLimit): budgeting in runes let 3500 astral emoji —
// 7000 units — through as "one message", which comes straight back as "message
// is too long" and freezes that thread's mirror.
//
// The CUT is chosen in runes, never bytes: a byte-offset cut can land inside a
// multi-byte character, and worse, inside a MarkdownV2 "\x" escape pair —
// leaving a trailing backslash that makes the whole message unparseable.
// Splitting prefers a paragraph break, then a line break, then a hard cut.
func splitForTelegram(text string) []string {
	r := []rune(text)
	if utf16Len(r) <= messageSplitAt {
		return []string{text}
	}
	var parts []string
	for utf16Len(r) > messageSplitAt {
		cut := runesWithinUTF16(r, messageSplitAt)
		if i := lastIndexRunes(r[:cut], "\n\n"); i > cut/2 {
			cut = i
		} else if i := lastIndexRune(r[:cut], '\n'); i > cut/2 {
			cut = i
		}
		// Never end a part on a lone backslash: it would be read as escaping
		// the (absent) next character and 400 the message.
		for cut > 1 && r[cut-1] == '\\' {
			cut--
		}
		parts = append(parts, strings.TrimSpace(string(r[:cut])))
		r = r[cut:]
	}
	if rest := strings.TrimSpace(string(r)); rest != "" {
		parts = append(parts, rest)
	}
	return parts
}

// telegramMessageLimit is the Bot API's hard cap on one message, in the units
// Telegram actually counts: UTF-16 code units, not runes and not bytes. An
// emoji outside the BMP (🙂, and every skin-toned or flag sequence) is TWO of
// them, so a message of 3000 emoji is 6000 by Telegram's arithmetic and is
// rejected outright while looking half the size from Go.
const telegramMessageLimit = 4096

// utf16Len counts r the way Telegram does — see telegramMessageLimit.
func utf16Len(r []rune) int {
	n := 0
	for _, c := range r {
		n++
		if c > 0xFFFF {
			n++
		}
	}
	return n
}

// runesWithinUTF16 is the length, IN RUNES, of the longest prefix of r that
// fits in budget UTF-16 units. Returned in runes because every cut this package
// makes has to land on a rune boundary (and never inside a MarkdownV2 escape
// pair), which a UTF-16 offset cannot express.
func runesWithinUTF16(r []rune, budget int) int {
	n := 0
	for i, c := range r {
		w := 1
		if c > 0xFFFF {
			w = 2
		}
		if n+w > budget {
			return i
		}
		n += w
	}
	return len(r)
}

func lastIndexRune(r []rune, want rune) int {
	for i := len(r) - 1; i >= 0; i-- {
		if r[i] == want {
			return i
		}
	}
	return -1
}

func lastIndexRunes(r []rune, seq string) int {
	s := []rune(seq)
	for i := len(r) - len(s); i >= 0; i-- {
		match := true
		for j := range s {
			if r[i+j] != s[j] {
				match = false
				break
			}
		}
		if match {
			return i
		}
	}
	return -1
}

func (b *Bridge) chatStateFor(threadID string) *chatState {
	b.chatsMu.Lock()
	defer b.chatsMu.Unlock()
	cs, ok := b.chats[threadID]
	if !ok {
		// lastFlush starts at "now", not zero: the interval means "prose has
		// been buffered this long with nothing sent", and a zero value would
		// make the very first sweep due and send one message per sweep — the
		// per-token dribble the paragraph coalescing exists to avoid.
		cs = &chatState{lastFlush: b.now()}
		b.chats[threadID] = cs
	}
	return cs
}

// sendApprovalCard mints one callback token per decision button and sends
// the card as its own message — never folded into the live message, which
// is rewritten too often for an inline keyboard to survive on it (§0.4).
func (b *Bridge) sendApprovalCard(ctx context.Context, cs *chatState, binding domain.TelegramBinding, card Card) error {
	kb := make(InlineKeyboard, 0, len(card.Buttons))
	for _, btn := range card.Buttons {
		token := b.mintCallback(callbackTarget{
			Kind:     cbApproval,
			ThreadID: binding.ThreadID, RequestID: card.RequestID, Decision: event.Decision(btn.Action),
		})
		kb = append(kb, []InlineButton{{Text: btn.Label, CallbackData: token}})
	}
	// The returned Message is kept, not discarded: its id is the only handle
	// on this card, and without it a request decided in the app leaves the
	// card sitting here forever with live-looking buttons. See retireCards.
	return b.callWithRetry(ctx, func() error {
		msg, err := b.client.SendMessage(ctx, SendOptions{
			ChatID: binding.ChatID, TopicID: binding.TopicID, Text: card.Text, Keyboard: kb,
		})
		if err != nil {
			return err
		}
		cs.rememberCard(card.RequestID, msg.MessageID)
		return nil
	})
}

// resolvedRequestID reports whether ev means "this request can no longer be
// answered", and for which request.
//
// It has to match on TWO unrelated shapes, because the orchestration layer
// closes a request differently depending on who closed it:
//
//   - The DECIDED path — someone chose, in the desktop app, in Telegram, or on
//     another device — arrives as the engine's own
//     thread.approval-response-requested / thread.user-input-response-requested.
//     This is the case the operator actually hits: approve in the app, and the
//     card here has to go. The reactor's RequestResolved branch explicitly does
//     NOT cover it ("the clicked path never comes through here"), so matching
//     only the forwarded provider event would have left the common case broken.
//
//   - The UNANSWERED path — a timeout, or an interrupt where the approval gate
//     declines on the operator's behalf — arrives as a forwarded provider
//     event.RequestResolved / event.UserInputResolved inside a
//     thread.activity-appended.
//
// Anything else is not a resolution and returns false.
func resolvedRequestID(ev orchestration.Event) (string, bool) {
	switch ev.Type {
	case orchestration.EvtThreadApprovalResponseRequested:
		var p orchestration.ApprovalRespondPayload
		if err := json.Unmarshal(ev.Payload, &p); err != nil {
			return "", false
		}
		return p.RequestID, p.RequestID != ""

	case orchestration.EvtThreadUserInputResponseRequested:
		var p orchestration.UserInputRespondPayload
		if err := json.Unmarshal(ev.Payload, &p); err != nil {
			return "", false
		}
		return p.RequestID, p.RequestID != ""

	case orchestration.EvtThreadActivityAppended:
		inner, isForwarded := decodeForwardedEvent(ev.Payload)
		if !isForwarded {
			return "", false
		}
		switch inner.Type {
		case event.RequestResolved, event.UserInputResolved:
			return inner.RequestID, inner.RequestID != ""
		}
	}
	return "", false
}

// retireCards removes every card sent for requestID — called the moment the
// request stops being answerable, whichever surface decided it.
//
// Deleted rather than edited. The operator's complaint is volume: a busy agent
// asks for approval constantly, and a chat where every one of them leaves a
// four-button card behind is unreadable. The transcript still records what
// happened (the "✓ WebFetch: …" line the tool call itself emits), so nothing
// is lost by taking the card away once it is spent.
//
// The edit is the fallback, not the intent: Telegram only lets a bot delete
// its own message for 48 hours, and a card older than that can still have its
// buttons stripped, which is the part that actually matters — a decided
// request must never keep offering an answer.
//
// Caller holds cs.mu (see chatState.cards).
func (b *Bridge) retireCards(ctx context.Context, cs *chatState, binding domain.TelegramBinding, requestID string) {
	if requestID == "" {
		return
	}
	messageIDs := cs.cards[requestID]
	delete(cs.cards, requestID)
	// Whether or not any card is still on screen, the tokens must go: they are
	// a live capability to answer a request that is already decided, and a
	// restart is the only other thing that clears them.
	b.forgetCallbacksForRequest(binding.ThreadID, requestID)
	for _, messageID := range messageIDs {
		if err := b.client.DeleteMessage(ctx, binding.ChatID, messageID); err == nil {
			continue
		} else {
			log.Printf("telegram: delete spent card %d in chat %d: %v — falling back to stripping its buttons",
				messageID, binding.ChatID, err)
		}
		if err := b.client.EditMessageText(ctx, binding.ChatID, messageID,
			EscapeMarkdownV2("🔐 sudah dijawab"), nil); err != nil {
			log.Printf("telegram: strip buttons off card %d in chat %d: %v", messageID, binding.ChatID, err)
		}
	}
}

// sendUserInputCards implements §5a's "one card per question": it decodes
// the full question list itself (Render only ever sees the first one) and
// sends a card for every question that does not already have an answer in
// this request's accumulator — so a card already answered before a restart
// or a retried batch is not re-sent alongside the ones still open.
// Returns how many cards were sent, for the sweep's message budget.
func (b *Bridge) sendUserInputCards(ctx context.Context, cs *chatState, binding domain.TelegramBinding, inner event.Event) (int, error) {
	p, ok := inner.Payload.(*event.UserInputRequestedPayload)
	if !ok || p == nil {
		return 0, nil
	}
	var questions []userInputQuestion
	if err := json.Unmarshal(p.Questions, &questions); err != nil || len(questions) == 0 {
		return 0, nil
	}

	key := pendingInputKey(binding.ThreadID, inner.RequestID)
	now := b.now()
	b.uiMu.Lock()
	for k, other := range b.userInput {
		if now.Sub(other.createdAt) > pendingUserInputTTL {
			delete(b.userInput, k)
		}
	}
	pu, exists := b.userInput[key]
	if !exists {
		keys := make([]string, len(questions))
		for i, q := range questions {
			keys[i] = answerKeyFor(q)
		}
		pu = &pendingUserInput{answers: map[int]any{}, questions: keys, createdAt: now}
		b.userInput[key] = pu
	}
	b.uiMu.Unlock()

	sent := 0
	for i, q := range questions {
		answerKey := answerKeyFor(q)
		pu.mu.Lock()
		_, answered := pu.answers[i]
		pu.mu.Unlock()
		if answered {
			continue
		}

		kb := make(InlineKeyboard, 0, len(q.Options))
		for _, opt := range q.Options {
			token := b.mintCallback(callbackTarget{
				Kind:     cbUserInput,
				ThreadID: binding.ThreadID, RequestID: inner.RequestID, Question: answerKey, Answer: opt.Label,
				QuestionIndex: i, MultiSelect: q.MultiSelect,
			})
			kb = append(kb, []InlineButton{{Text: opt.Label, CallbackData: token}})
		}
		text := "❓ " + EscapeMarkdownV2(truncateForTelegram(q.Question, cardTextLimit))
		if err := b.callWithRetry(ctx, func() error {
			msg, err := b.client.SendMessage(ctx, SendOptions{
				ChatID: binding.ChatID, TopicID: binding.TopicID, Text: text, Keyboard: kb,
			})
			if err != nil {
				return err
			}
			// One request, many cards — every one of them is retired together
			// when the prompt is answered. See retireCards.
			cs.rememberCard(inner.RequestID, msg.MessageID)
			return nil
		}); err != nil {
			return sent, err
		}
		sent++
	}
	return sent, nil
}

// callWithRetry is the ONE place a 429 is handled: on an *APIError carrying
// a non-zero RetryAfter, sleep exactly that long and retry the same call —
// never drop what was about to be sent. Any other error (including an
// *APIError with no RetryAfter) is returned immediately; the caller's own
// failure handling (pumpBinding's ok flag) is what keeps that content from
// being lost, by not advancing LastSeq past it.
// maxRetryWait caps the TOTAL time one call may spend asleep waiting out 429s
// before giving up and letting the caller's own failure handling take over.
//
// Uncapped, a bot that has tripped Telegram's per-chat flood limit (a busy
// agent mirroring a whole transcript reaches it easily) can be handed
// retry_after values indefinitely, and the goroutine sits in here for as long
// as that lasts. For the pump that only delays the transcript; the cursor
// refuses to advance, so nothing is lost and the next sweep retries. Giving up
// and reporting is strictly better than an invisible unbounded park.
const maxRetryWait = 90 * time.Second

func (b *Bridge) callWithRetry(ctx context.Context, fn func() error) error {
	var slept time.Duration
	for {
		err := fn()
		if err == nil {
			return nil
		}
		var apiErr *APIError
		if errors.As(err, &apiErr) && apiErr.RetryAfter > 0 {
			// Logged, always. A silent sleep in here is what made the original
			// bug so hard to see: 53 seconds passed with no line in the log at
			// all, so the stall looked like the bridge had simply stopped
			// receiving. A rate limit is a real operational fact — the mirror
			// is producing more traffic than Telegram will accept — and it
			// belongs in the log whether or not the retry then succeeds.
			log.Printf("telegram: rate limited, waiting %s before retrying (%s spent so far)", apiErr.RetryAfter, slept)
			if slept+apiErr.RetryAfter > maxRetryWait {
				log.Printf("telegram: giving up after %s of rate-limit backoff: %v", slept, err)
				return err
			}
			slept += apiErr.RetryAfter
			select {
			case <-time.After(apiErr.RetryAfter):
				continue
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		return err
	}
}

// randomHex draws n random bytes and hex-encodes them — used for callback
// tokens and, as a fallback, command ids. crypto/rand, not math/rand: a
// callback token is a short-lived capability (tapping it approves or
// answers something), the same reasoning pairing.go's randomSixDigits gives
// for pairing codes.
func randomHex(n int) string {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		panic("telegram: crypto/rand unavailable: " + err.Error())
	}
	return hex.EncodeToString(buf)
}
