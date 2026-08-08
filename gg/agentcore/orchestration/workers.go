package orchestration

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"

	"example.com/agentcore/approval"
	"example.com/agentcore/event"
	"example.com/agentcore/provider"
)

// Dua worker menghubungkan engine dengan provider, dan arahnya BERLAWANAN.
// Memisahkannya adalah yang mencegah siklus: kalau satu komponen memanggil
// provider sekaligus mengonsumsi outputnya, kamu akan menulis deadlock.
//
//	Ingestion : stream provider  --> command  --> engine   (masuk)
//	Reactor   : event engine     --> panggilan provider    (keluar)

// ---------------------------------------------------------------------------
// Ingestion: canonical event -> command
// ---------------------------------------------------------------------------

// Ingestion mengonsumsi Adapter.Events() dan menerjemahkannya jadi command
// internal. Ini satu-satunya jalan masuk output agent ke state.
//
// Padanan t3code: ProviderRuntimeIngestion.ts
type Ingestion struct {
	Engine *Engine
	Broker *approval.Broker
	NewID  func() string
	Log    *slog.Logger

	// Delivery mengatur buffering teks assistant. Lihat catatan di bawah.
	Delivery DeliveryPolicy

	mu      sync.Mutex
	buffers map[string]*assistantBuffer // key: threadID|turnID|itemID
}

// DeliveryPolicy: mode buffered mengakumulasi delta ketimbang meneruskan satu
// per satu. t3code memakai ini untuk klien mobile — 500 event/detik akan
// membunuh baterai dan render loop.
//
// Yang penting: buffer TIDAK ditahan sampai turn selesai. Dia di-flush saat
//  1. melebihi MaxChars (t3code: 24_000), dan
//  2. batas interaksi — begitu approval/input dibuka.
//
// Poin kedua itu krusial. Kalau agent bertanya "boleh saya hapus file ini?",
// user harus bisa membaca alasan yang mendahuluinya. Tanpa flush di sini,
// prompt muncul tanpa konteks apa pun.
type DeliveryPolicy struct {
	Buffered bool
	MaxChars int
}

type assistantBuffer struct {
	threadID string
	turnID   string
	itemID   string
	text     []byte
	seq      uint64
}

func NewIngestion(e *Engine, b *approval.Broker, newID func() string, log *slog.Logger) *Ingestion {
	return &Ingestion{
		Engine: e, Broker: b, NewID: newID, Log: log,
		Delivery: DeliveryPolicy{Buffered: false, MaxChars: 24_000},
		buffers:  make(map[string]*assistantBuffer),
	}
}

// Consume menjalankan loop untuk satu adapter. Jalankan satu goroutine per
// instance provider.
func (in *Ingestion) Consume(ctx context.Context, a provider.Adapter) {
	events := a.Events()
	for {
		select {
		case <-ctx.Done():
			return
		case ev, ok := <-events:
			if !ok {
				// Channel tertutup = adapter mati. Batalkan semua approval
				// yang menggantung, kalau tidak UI akan menampilkan prompt
				// hantu selamanya.
				in.Log.Warn("adapter event channel closed", "instance", a.InstanceID())
				return
			}
			if err := in.handle(ctx, ev); err != nil {
				in.Log.Error("ingest gagal", "type", ev.Type, "err", err)
			}
		}
	}
}

func (in *Ingestion) handle(ctx context.Context, ev event.Event) error {
	switch ev.Type {

	case event.ContentDelta:
		p, ok := ev.Payload.(*event.ContentDeltaPayload)
		if !ok {
			return nil
		}
		if in.Delivery.Buffered && p.Stream == event.StreamText {
			return in.appendBuffered(ctx, ev, p)
		}
		return in.emitDelta(ctx, ev, p.Text, p.Stream, p.Sequence)

	case event.RequestOpened, event.UserInputRequested:
		// Flush dulu, baru catat request. Urutannya menentukan apa yang
		// dilihat user.
		if err := in.flushThread(ctx, ev.ThreadID); err != nil {
			return err
		}
		return in.dispatch(ctx, Command{
			Type:     CmdThreadSessionSet,
			ThreadID: ev.ThreadID,
			Payload: mustJSON(map[string]any{
				"status":            string(ThreadWaiting),
				"pendingRequestAdd": ev.RequestID,
			}),
		})

	case event.SessionStarted:
		p, _ := ev.Payload.(*event.SessionStartedPayload)
		payload := map[string]any{"status": string(ThreadRunning)}
		if p != nil && len(p.Resume) > 0 {
			// Simpan cursor resume apa adanya. Jangan pernah menafsirkannya —
			// bentuknya beda tiap provider dan berubah antar versi.
			payload["resumeCursor"] = p.Resume
		}
		return in.dispatch(ctx, Command{
			Type: CmdThreadSessionSet, ThreadID: ev.ThreadID, Payload: mustJSON(payload),
		})

	case event.TurnCompleted, event.TurnAborted:
		if err := in.flushThread(ctx, ev.ThreadID); err != nil {
			return err
		}
		return in.dispatch(ctx, Command{
			Type: CmdThreadSessionSet, ThreadID: ev.ThreadID,
			Payload: mustJSON(map[string]any{"status": string(ThreadIdle)}),
		})

	case event.SessionExited:
		// Sesi mati: bersihkan approval menggantung, jangan tunggu timeout.
		in.Broker.CancelThread(ev.ThreadID)
		return in.dispatch(ctx, Command{
			Type: CmdThreadSessionSet, ThreadID: ev.ThreadID,
			Payload: mustJSON(map[string]any{"status": string(ThreadStopped)}),
		})

	default:
		// Sisanya jadi activity generik. Lebih baik menyimpan event tak
		// dikenal sebagai activity ketimbang membuangnya — kamu akan
		// membutuhkannya saat debugging provider baru.
		return in.dispatch(ctx, Command{
			Type: CmdThreadActivityAppend, ThreadID: ev.ThreadID,
			Payload: mustJSON(ev),
		})
	}
}

func (in *Ingestion) appendBuffered(ctx context.Context, ev event.Event, p *event.ContentDeltaPayload) error {
	key := ev.ThreadID + "|" + ev.TurnID + "|" + ev.ItemID
	in.mu.Lock()
	buf := in.buffers[key]
	if buf == nil {
		buf = &assistantBuffer{threadID: ev.ThreadID, turnID: ev.TurnID, itemID: ev.ItemID}
		in.buffers[key] = buf
	}
	overflow := len(buf.text)+len(p.Text) > in.Delivery.MaxChars
	buf.text = append(buf.text, p.Text...)
	buf.seq = p.Sequence
	var spill []byte
	if overflow {
		spill = buf.text
		delete(in.buffers, key)
	}
	in.mu.Unlock()

	if spill == nil {
		return nil
	}
	// Tumpahkan seluruh akumulasi sebagai SATU delta. Bukan potongan yang
	// melebihi batas saja — kalau kamu kirim potongannya saja, client
	// kehilangan awal pesan.
	return in.emitDelta(ctx, ev, string(spill), event.StreamText, buf.seq)
}

func (in *Ingestion) flushThread(ctx context.Context, threadID string) error {
	in.mu.Lock()
	var pending []*assistantBuffer
	for k, b := range in.buffers {
		if b.threadID == threadID {
			pending = append(pending, b)
			delete(in.buffers, k)
		}
	}
	in.mu.Unlock()

	for _, b := range pending {
		ev := event.Event{ThreadID: b.threadID, TurnID: b.turnID, ItemID: b.itemID}
		if err := in.emitDelta(ctx, ev, string(b.text), event.StreamText, b.seq); err != nil {
			return err
		}
	}
	return nil
}

func (in *Ingestion) emitDelta(ctx context.Context, ev event.Event, text string, s event.StreamKind, seq uint64) error {
	if text == "" {
		return nil
	}
	return in.dispatch(ctx, Command{
		Type:     CmdThreadAssistantDelta,
		ThreadID: ev.ThreadID,
		Payload: mustJSON(AssistantDeltaPayload{
			TurnID: ev.TurnID, ItemID: ev.ItemID, Stream: s, Text: text, Sequence: seq,
		}),
	})
}

func (in *Ingestion) dispatch(ctx context.Context, cmd Command) error {
	cmd.CommandID = in.NewID()
	_, err := in.Engine.Dispatch(ctx, cmd)
	return err
}

// ---------------------------------------------------------------------------
// Reactor: event engine -> panggilan provider
// ---------------------------------------------------------------------------

// Reactor mendengarkan intent event yang sudah commit lalu melakukan panggilan
// provider yang sesungguhnya. Dia berjalan SETELAH commit, jadi niat user
// sudah tercatat durabel bahkan kalau panggilan providernya gagal — dan itu
// yang membuat retry aman.
//
// Padanan t3code: ProviderCommandReactor.ts
type Reactor struct {
	Engine   *Engine
	Provider *provider.Service
	Broker   *approval.Broker
	Log      *slog.Logger
}

func (r *Reactor) Run(ctx context.Context) {
	sub, unsub := r.Engine.Subscribe(256)
	defer unsub()

	for {
		select {
		case <-ctx.Done():
			return
		case batch, ok := <-sub:
			if !ok {
				return
			}
			for _, e := range batch {
				if !IntentEvents[e.Type] {
					continue
				}
				if err := r.react(ctx, e); err != nil {
					r.Log.Error("reactor gagal", "event", e.Type, "thread", e.ThreadID, "err", err)
					// TODO: dispatch command runtime.error supaya user melihat
					// kegagalannya, bukan cuma diam.
				}
			}
		}
	}
}

func (r *Reactor) react(ctx context.Context, e Event) error {
	switch e.Type {
	case EvtThreadTurnStartRequested:
		var p TurnStartPayload
		if err := json.Unmarshal(e.Payload, &p); err != nil {
			return err
		}
		st := r.Engine.State()
		t, ok := st.Thread(e.ThreadID)
		if !ok {
			return nil
		}
		_, err := r.Provider.SendTurn(ctx, provider.SendTurnInput{
			ThreadID:    e.ThreadID,
			TurnID:      e.EventID,
			Text:        p.Text,
			Attachments: p.Attachments,
			Mode:        t.Mode,
			Interact:    t.Interact,
			Model:       p.Model,
		})
		return err

	case EvtThreadApprovalResponseRequested:
		var p ApprovalRespondPayload
		if err := json.Unmarshal(e.Payload, &p); err != nil {
			return err
		}
		// Dua jalur, dan keduanya perlu:
		//  - Broker.Resolve membuka goroutine adapter yang menahan agent
		//    (untuk provider bergaya callback seperti Claude canUseTool).
		//  - Provider.RespondToRequest mengirim RPC balasan
		//    (untuk provider bergaya JSON-RPC seperti Codex/ACP).
		// Adapter yang tidak memakai salah satunya cukup no-op.
		if err := r.Broker.Resolve(p.RequestID, p.Decision); err != nil &&
			err != approval.ErrUnknownRequest {
			return err
		}
		return r.Provider.RespondToRequest(ctx, e.ThreadID, p.RequestID, p.Decision)

	case EvtThreadTurnInterruptRequested:
		st := r.Engine.State()
		t, ok := st.Thread(e.ThreadID)
		if !ok {
			return nil
		}
		// Batalkan approval menggantung DULU. Kalau tidak, interrupt akan
		// menunggu turn yang sendirinya sedang menunggu user.
		r.Broker.CancelThread(e.ThreadID)
		return r.Provider.InterruptTurn(ctx, e.ThreadID, t.CurrentTurn)

	case EvtThreadSessionStopRequested:
		r.Broker.CancelThread(e.ThreadID)
		a, err := r.Provider.Registry.Adapter(mustInstance(r.Engine, e.ThreadID))
		if err != nil {
			return err
		}
		return a.StopSession(ctx, e.ThreadID)
	}
	return nil
}

func mustInstance(e *Engine, threadID string) provider.InstanceID {
	if t, ok := e.State().Thread(threadID); ok {
		return t.InstanceID
	}
	return ""
}

func mustJSON(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		return json.RawMessage(`{}`)
	}
	return b
}
