package orchestration

import (
	"encoding/json"
	"strings"

	"devdeck/backend/internal/agentcore/event"
)

// ---------------------------------------------------------------------------
// Replay coalescing
// ---------------------------------------------------------------------------
//
// A streamed turn is durably logged one event per TOKEN. That is the right
// shape for a live socket — it is what makes text appear as the model produces
// it — and completely the wrong shape for replay, because the envelope dwarfs
// the payload:
//
//	{"turnId":"ae-4217c3…","itemId":"1#0","stream":"reasoning","text":"The","sequence":1}
//
// 110 bytes of JSON to carry 3 bytes of text, and that is before the outer
// Event wrapper adds seq/eventId/threadId/type/commandId/createdAt on top. One
// real thread in the field logged 274,851 of these carrying 1.03 MB of actual
// text in 28.2 MB of payload — a 27x amplification, ~55 MB of rows, and close
// to 70 MB once marshalled as a JSON array of Event. Every fresh page load
// replayed all of it, in ONE WebSocket frame, because the client's thread view
// is deliberately not persisted (see `agentThreads` in useDevDeckStore.ts) and
// so always says sinceSeq: 0.
//
// CoalesceReplay is the transport-side answer: merge each CONSECUTIVE run of
// same-item deltas into one event carrying the run's concatenated text. The
// same 274,851 events become 938 — the number of runs the thread actually has
// — and 28.2 MB becomes ~1.1 MB, with not one character of text lost.
//
// This is a transport concern only. The durable log is untouched, live events
// are never coalesced (they must stay per-token or streaming stops streaming),
// and the client reducer needs no special case: `applyDelta` concatenates
// `text` onto the item either way, so one merged delta and the run of small
// ones it replaces fold to exactly the same ChatItem.

// coalescedRunMinimum is how many consecutive same-item deltas a run needs
// before merging is worth an extra marshal. A run of one is already minimal,
// and re-marshalling it would only risk perturbing a payload that is
// round-tripping fine as raw bytes.
const coalescedRunMinimum = 2

// CoalescedDeltaPayload is AssistantDeltaPayload plus the two facts a MERGED
// run carries that a single delta does not. Both are omitempty, so a payload
// that was never merged is byte-identical to what it always was and an older
// client sees exactly the shape it has always seen.
//
// The merged event itself takes the run's LAST Seq, EventID and CreatedAt.
// Seq must be the last or the contract behind `sinceSeq` breaks: the client
// stores the highest applied Seq and asks for everything after it, so an event
// that carried the run's FIRST Seq while delivering the whole run's text would
// have the tail of that run replayed and CONCATENATED A SECOND TIME on the
// next reconnect. CreatedAt follows for the same reason `updatedAt` does —
// which is precisely why the run's start has to be carried separately.
type CoalescedDeltaPayload struct {
	AssistantDeltaPayload

	// FirstSequence is the run's first `sequence`, so the client's gap check
	// stays exact. It compares the incoming sequence against the item's
	// `lastSequence + 1`; handed only the run's LAST sequence it would read a
	// perfectly contiguous 100-token run as a 99-token hole and raise "Some
	// updates may be missing from this thread" on a thread that is complete.
	FirstSequence uint64 `json:"firstSequence,omitempty"`

	// StartedAt is the run's first event CreatedAt (epoch ms), so an item
	// created by a merged delta is stamped with when the agent STARTED
	// producing it rather than when it finished. Turn stamps and the
	// "Worked for 11s" reasoning duration are both derived from the gap
	// between an item's createdAt and its updatedAt; without this they would
	// collapse to zero on every replayed turn.
	StartedAt int64 `json:"startedAt,omitempty"`
}

// CoalesceReplay returns `events` with each consecutive run of same-item
// assistant deltas merged into a single event. Order is preserved exactly and
// every non-delta event passes through untouched.
//
// A run continues only while the next event is a delta for the same item and
// stream, from the same turn, AND its `sequence` is exactly one past the
// previous one. Requiring contiguity is what keeps a genuine hole in the log
// visible: a jump inside what would otherwise be one run ends the run there,
// so the gap survives as the boundary between two merged events and the client
// still detects it via FirstSequence.
//
// Deliberately NOT merging across a non-delta event (a tool call landing
// mid-stream) or across two interleaved items: both would reorder the
// transcript. In the field thread that motivated this, 36 of 902 items resume
// after another item's deltas, and hoisting their tails back to the item's
// first appearance would move text that was written after a tool call to
// before it.
func CoalesceReplay(events []Event) []Event {
	// Nothing to merge in a run of one, and the scan is pure overhead there.
	if len(events) < coalescedRunMinimum {
		return events
	}

	out := make([]Event, 0, len(events))

	// The open run, as a half-open index range into `events` plus the decoded
	// head it is accumulating onto. Holding indices rather than copies means
	// abandoning a run costs nothing: the originals are re-appended verbatim.
	runFrom := -1
	runTo := -1
	var runHead AssistantDeltaPayload
	var runLastSeq uint64
	var runText strings.Builder

	flush := func() {
		if runFrom < 0 {
			return
		}
		from, to := runFrom, runTo
		runFrom, runTo = -1, -1

		if to-from+1 < coalescedRunMinimum {
			out = append(out, events[from:to+1]...)
			return
		}

		merged := CoalescedDeltaPayload{
			AssistantDeltaPayload: AssistantDeltaPayload{
				TurnID:   runHead.TurnID,
				ItemID:   runHead.ItemID,
				Stream:   runHead.Stream,
				Text:     runText.String(),
				Sequence: runLastSeq,
			},
			FirstSequence: runHead.Sequence,
			StartedAt:     events[from].CreatedAt,
		}
		raw, err := json.Marshal(merged)
		if err != nil {
			// Unreachable for a struct of strings and integers, but a replay
			// that silently dropped a turn's text would be far worse than one
			// that is merely large — so fall back to the events as logged.
			out = append(out, events[from:to+1]...)
			return
		}

		// The run's LAST event is the carrier — see CoalescedDeltaPayload's
		// doc comment for why Seq and CreatedAt have to be the tail's.
		carrier := events[to]
		carrier.Payload = raw
		out = append(out, carrier)
	}

	for i := range events {
		ev := events[i]
		d, ok := decodeAssistantDelta(ev)
		if !ok {
			flush()
			out = append(out, ev)
			continue
		}

		continues := runFrom >= 0 &&
			d.ItemID == runHead.ItemID &&
			d.Stream == runHead.Stream &&
			d.TurnID == runHead.TurnID &&
			d.Sequence == runLastSeq+1
		if continues {
			runTo = i
			runLastSeq = d.Sequence
			runText.WriteString(d.Text)
			continue
		}

		flush()
		runFrom, runTo = i, i
		runHead = d
		runLastSeq = d.Sequence
		runText.Reset()
		runText.WriteString(d.Text)
	}
	flush()

	return out
}

// decodeAssistantDelta reports whether `ev` is a streamed assistant/reasoning
// delta, and decodes it if so.
//
// The test has to be STRUCTURAL, not by event type. EvtThreadActivityAppended
// carries two unrelated shapes — a delta, or a whole forwarded provider event
// that Ingestion had no more specific command for (see telegram/render.go's
// renderActivityAppended) — and only the first may be merged. Pointer fields
// are what make the check a presence check: decoding a forwarded event into a
// plain AssistantDeltaPayload succeeds with every field left at its zero
// value, which would quietly merge tool calls into a text stream.
//
// The four required fields mirror eventReducer.ts's isActivityAppendedPayload
// exactly. That correspondence is the correctness criterion: an event this
// merges must be one the client would have folded with applyDelta, and an
// event the client treats as something else must pass through untouched.
func decodeAssistantDelta(ev Event) (AssistantDeltaPayload, bool) {
	if ev.Type != EvtThreadActivityAppended || len(ev.Payload) == 0 {
		return AssistantDeltaPayload{}, false
	}
	var probe struct {
		TurnID   string  `json:"turnId"`
		ItemID   *string `json:"itemId"`
		Stream   *string `json:"stream"`
		Text     *string `json:"text"`
		Sequence *uint64 `json:"sequence"`
	}
	if err := json.Unmarshal(ev.Payload, &probe); err != nil {
		return AssistantDeltaPayload{}, false
	}
	if probe.ItemID == nil || probe.Stream == nil || probe.Text == nil || probe.Sequence == nil {
		return AssistantDeltaPayload{}, false
	}
	return AssistantDeltaPayload{
		TurnID:   probe.TurnID,
		ItemID:   *probe.ItemID,
		Stream:   event.StreamKind(*probe.Stream),
		Text:     *probe.Text,
		Sequence: *probe.Sequence,
	}, true
}
