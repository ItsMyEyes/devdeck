# Context Handoff — Agent Harness ala t3code, di Go

Dokumen ini untuk engineer atau coding agent yang akan membangun lapisan harness
agent di aplikasi Go. Isinya: keputusan arsitektur yang perlu kamu tiru dari
[pingdotgg/t3code](https://github.com/pingdotgg/t3code), alasannya, dan urutan
membangunnya.

Skeleton kode ada di repo yang sama dengan dokumen ini (`event/`, `provider/`,
`approval/`, `orchestration/`). Semuanya kompilasi dan lolos `go test -race`,
tapi adapter Claude sengaja tidak lengkap — dia contoh bentuk, bukan produk.

**Scope yang disepakati:** Driver + Adapter + canonical events, orchestration
event-sourced, approval/permission flow. Provider-agnostic dulu, implementasi
konkret belakangan.

---

## 1. Satu kalimat yang menjelaskan seluruh desain

> Lapisan di atas provider tidak boleh tahu provider mana yang ada di bawahnya.

Setiap keputusan di bawah ini turunan dari kalimat itu. Kalau kamu menemukan
`if provider == "claude"` di luar package adapter, ada yang salah.

---

## 2. Empat lapisan, dan arah datanya

```
┌──────────────────────────────────────────────┐
│ Client (web/mobile)                          │
│   kirim Command · subscribe Event            │
└───────────────┬──────────────────────────────┘
                │ WebSocket / gRPC stream
┌───────────────▼──────────────────────────────┐
│ orchestration/  — event-sourced engine       │
│   Command → Decide → Event → Apply → State   │
└──────┬──────────────────────────▲────────────┘
       │ Reactor (keluar)         │ Ingestion (masuk)
┌──────▼──────────────────────────┴────────────┐
│ provider/  — Driver + Adapter                │
│   canonical event ⟷ protokol native          │
└───────────────┬──────────────────────────────┘
                │ stdio JSON-RPC / NDJSON / HTTP
┌───────────────▼──────────────────────────────┐
│ Agent CLI: claude, codex, cursor-agent, ...  │
└──────────────────────────────────────────────┘
```

Yang sering salah: menggabungkan Reactor dan Ingestion jadi satu komponen.
Arahnya berlawanan — satu memanggil provider, satu mengonsumsi outputnya. Kalau
digabung, kamu akan menulis deadlock: engine menunggu provider yang menunggu
engine.

---

## 3. Canonical event — mulai dari sini, bukan dari adapter

Godaan terbesar adalah menulis adapter Claude dulu lalu "nanti digeneralisasi".
Jangan. Bentuk event kanonik yang lahir dari satu provider akan tercetak
selamanya dengan asumsi provider itu.

t3code punya ~49 tipe event (`packages/contracts/src/providerRuntime.ts`).
Skeleton di `event/event.go` menyalin taksonominya dan menandai yang CORE.
Mulailah dengan ~15 event CORE.

Yang perlu kamu pahami dari desainnya:

**Amplop terpisah dari payload.** Semua event punya field yang sama
(`EventID`, `ThreadID`, `TurnID`, `ItemID`, `RequestID`, `CreatedAt`), payload
yang berbeda. Di Go ini artinya `Payload` bertipe interface plus registry untuk
decode — sedikit boilerplate, tapi type-safe.

**`Refs` memisahkan ID-mu dari ID provider.** ID native (session UUID Claude,
thread ID Codex) hidup di `Refs` dan hanya dipakai adapter. Orchestration pakai
ID-mu sendiri. Tanpa pemisahan ini kamu tidak bisa ganti provider di tengah
thread, dan resume jadi mimpi buruk.

**`Raw` untuk debugging, tidak untuk logic.** Simpan pesan native asli. Kamu
akan sangat membutuhkannya saat provider merilis versi baru dan parser-mu diam-
diam salah. Tapi jangan pernah ada `if raw.Payload["x"]` di kode produksi.

**`Sequence` pada delta wajib.** Monoton per (ItemID, Stream). Client memakainya
untuk mendeteksi delta hilang atau datang terbalik. Tanpa ini kamu akan
menghabiskan berhari-hari mengejar bug "teks kadang berantakan".

**Pisahkan stream text dari reasoning.** `StreamKind` ada supaya reasoning bisa
dirender terpisah (collapsible) dari jawaban akhir. Menggabungnya di awal berarti
migrasi data belakangan.

---

## 4. Driver vs Adapter — kenapa dua, bukan satu

| | Driver | Adapter |
|---|---|---|
| Sifat | nilai deklaratif | proses hidup |
| Umur | selamanya | seumur instance |
| Tahu tentang | config, binary, versi | sesi, turn, stream |
| Contoh operasi | `Probe`, `DecodeConfig` | `SendTurn`, `StartSession` |

Alasan pemisahan: kamu perlu menampilkan "Claude v2.1.219, sudah login, model
tersedia: ..." di halaman settings **tanpa** menjalankan sesi apa pun. Kalau
Driver dan Adapter satu objek, membuka settings akan men-spawn proses agent.

`Probe` mengembalikan `(Snapshot, error)` di mana **provider tidak tersedia
bukan error**. Binary belum diinstall adalah status yang normal dan harus
ditampilkan ke user, bukan dilempar sebagai kegagalan.

### InstanceID, bukan Kind

Ini yang t3code pelajari dengan mahal — di kode mereka masih ada komentar
migrasi:

```
// Optional during the driver/instance migration... Once every emitter
// populates it (post-slice-4), routing flips to instance-id-only.
```

Mereka awalnya merutekan pakai `Kind` ("claude"), lalu sadar user bisa punya
dua instance Claude dengan akun berbeda. Migrasinya menyakitkan. **Pakai
`InstanceID` sejak commit pertama**, meski awalnya cuma ada satu instance.

Konsekuensi turunan: state per-instance harus terisolasi. t3code membuat cache
key dari `(binary path + resolved HOME)` supaya dua instance tidak saling
menimpa kredensial. Di skeleton, `Config.HomeDir` ada untuk alasan yang sama.

---

## 5. Event-sourcing: yang benar-benar penting

Skeleton di `orchestration/engine.go`. Empat hal yang tidak boleh dikompromikan:

### a. Command imperatif, Event lampau

```
thread.turn.start          (command — niat)
thread.turn-start-requested (event  — fakta)
```

Konvensi t3code, dan patuhi dengan disiplin. Sekali kamu campur, membaca log
jadi menebak-nebak: ini rencana atau kejadian?

### b. Decider harus murni

`Decide(state, cmd, now, newID) ([]Event, error)` — tanpa I/O, tanpa
`time.Now()`, tanpa random. Makanya `now` dan `newID` dioper sebagai parameter.

Ini bukan idealisme fungsional. Ini yang membuat seluruh aturan bisnismu bisa
diuji dengan tabel input/output tanpa database dan tanpa proses agent. Lihat
`engine_test.go` — empat skenario penuh, nol mock.

### c. Satu goroutine untuk seluruh command

`Engine.Run` memproses envelope satu per satu. Kelihatan seperti bottleneck,
tapi bukan: decider murni dan cepat; yang lambat (panggilan provider) terjadi
di Reactor, di luar loop.

Serialisasi total inilah yang membuat decider boleh menganggap state stabil
selama menghitung. Tanpa itu kamu butuh lock per-thread dan setiap invariant
jadi rapuh.

### d. Commit atomik, swap sesudahnya

```go
committed, err := store.Commit(ctx, cmd.CommandID, evts)  // append + projeksi + receipt, 1 transaksi
if err != nil { return nil, err }
e.state = Apply(e.state, committed)                        // baru swap
e.publish(committed)                                       // baru publish
```

Urutan ini penting. Kalau kamu swap dulu lalu commit gagal, read model in-memory
memuat fakta yang tidak pernah ada di log — dan tidak ada cara mendeteksinya.

`TestReplayDeterministik` menjaga invariant ini: replay dari event 0 wajib
menghasilkan state byte-identik.

### e. CommandID = idempotensi

`SeenCommand` dicek sebelum decide. Retry dengan CommandID sama mengembalikan
event yang sama, tidak membuat yang baru. Ini yang menyelamatkanmu saat
WebSocket putus lalu client mengirim ulang — dan itu akan sering terjadi kalau
kamu punya klien mobile.

---

## 6. Approval flow — bagian tersulit

Bentuk masalahnya asimetris: agent memanggil dan **menunggu**, jawabannya datang
dari arah lain sama sekali (HTTP request user), mungkin beberapa menit kemudian,
mungkin dari device berbeda.

`approval/broker.go` adalah jembatannya — padanan `Deferred` + map
`pendingApprovals` di `ClaudeAdapter.ts`.

**Urutan yang wajib dipatuhi adapter:**

1. emit `RequestOpened` — UI menampilkan prompt
2. `broker.Await(ctx, ...)` — goroutine adapter memblokir
3. user menjawab → `broker.Resolve(requestID, decision)`
4. kirim keputusan ke provider (RPC balasan atau return value callback)
5. emit `RequestResolved`

Lewatkan langkah 1 dan agent menggantung selamanya tanpa UI apa pun.

**Empat jebakan yang sudah ditemukan t3code:**

*Abort harus membatalkan approval.* `Await` mengembalikan `DecisionCancel` saat
ctx mati. t3code memasang listener pada `AbortSignal` untuk hal yang sama. Tanpa
ini, interrupt di tengah approval akan menggantung — karena interrupt menunggu
turn yang sedang menunggu user.

*Sesi mati harus membersihkan approval.* `Ingestion` memanggil
`Broker.CancelThread` saat `SessionExited`. Kalau tidak, UI menampilkan prompt
hantu yang tidak akan pernah selesai.

*Double-tap dari dua device.* Decider menolak approval untuk request yang tidak
lagi menggantung (`TestApprovalDoubleTapDitolak`). Dicek di decider, bukan di
broker, supaya penolakannya tercatat dan bisa dijelaskan ke user.

*Dua gaya provider butuh dua jalur.* Reactor memanggil **keduanya**:

```go
r.Broker.Resolve(...)              // gaya callback (Claude canUseTool)
r.Provider.RespondToRequest(...)   // gaya JSON-RPC (Codex, ACP)
```

Adapter yang tidak memakai salah satunya cukup no-op. Ini lebih sederhana
daripada mendeklarasikan gaya approval per provider.

### RuntimeMode vs InteractionMode

Dua sumbu terpisah, dan menggabungnya adalah kesalahan desain yang mahal:

- **RuntimeMode** — kebijakan izin: `approval-required` → `auto-accept-edits`
  → `auto` → `full-access`
- **InteractionMode** — gaya kolaborasi: `default` | `plan`

Plan mode tetap butuh runtime mode (agent yang menyusun rencana tetap membaca
file). Kalau kamu jadikan satu enum, kamu akan terjebak begitu ada mode ketiga.

Pemetaan ke flag provider hanya boleh ada **satu tempat** per adapter — lihat
`buildArgs` di `provider/claude/adapter.go`.

---

## 7. Buffered delivery — kecil tapi menentukan UX mobile

`DeliveryPolicy` di `orchestration/workers.go`. Mode buffered mengakumulasi
delta ketimbang meneruskan satu per satu; 500 event/detik akan membunuh baterai
dan render loop klien mobile.

Yang mudah salah: buffer **tidak** ditahan sampai turn selesai. Dua pemicu flush:

1. melebihi `MaxChars` (t3code: 24.000) — dan yang ditumpahkan adalah **seluruh
   akumulasi**, bukan potongan yang melebihi batas. Kalau cuma potongannya,
   client kehilangan awal pesan.
2. **batas interaksi** — begitu approval atau input request dibuka.

Pemicu kedua krusial. Kalau agent bertanya "boleh saya hapus file ini?", user
harus bisa membaca alasan yang mendahuluinya. Tanpa flush di sini, prompt muncul
tanpa konteks sama sekali.

---

## 8. Catatan transport per provider

Kamu bilang mau arsitektur dulu, jadi ini referensi untuk nanti. Semua
memakai binary CLI yang sudah terinstall dan ter-autentikasi di mesin user —
tidak ada API key sendiri.

| Provider | Transport | Catatan untuk Go |
|---|---|---|
| Claude | npm SDK di t3code | Tidak ada SDK Go. Pakai `claude --print --output-format stream-json --input-format stream-json --include-partial-messages`. Approval lewat control request di stream yang sama, bukan callback. |
| Codex | `codex app-server`, JSON-RPC stdio | Paling ramah Go. Schema di t3code di-generate; kamu bisa tulis tangan subsetnya. |
| Cursor | `cursor-agent acp` | ACP = Agent Client Protocol, JSON-RPC stdio. |
| Grok | `grok agent stdio` | ACP juga — runtime yang sama dipakai ulang. |
| OpenCode | `opencode server` + HTTP/SSE | Deteksi ready dari stdout `"opencode server listening"`. |

**Rekomendasi urutan:** ACP dulu (Cursor + Grok sekaligus dari satu runtime),
lalu Codex, Claude terakhir. Claude paling populer tapi paling tidak nyaman dari
Go karena jalur yang didukung penuh adalah SDK TypeScript-nya; format
`stream-json` masih berubah antar versi, jadi verifikasi terhadap versi CLI
yang kamu target sebelum menulis parser.

Satu detail Windows yang akan menggigit: npm shim `claude.cmd` tidak bisa
di-spawn tanpa shell (`spawn EINVAL` sejak Node 20.12). t3code punya file khusus
untuk ini (`ClaudeExecutable.ts`) yang mengikuti shim ke `bin/claude.exe` atau
`cli.js`. Di Go, `exec.LookPath` menangani PATHEXT tapi tetap perlu logika
follow-shim kalau kamu men-support Windows.

---

## 9. Urutan implementasi

Setiap langkah menghasilkan sesuatu yang jalan. Jangan lompat.

**1. Canonical event (`event/`)** — ~15 tipe CORE, plus `Refs`, `Raw`,
`Sequence`. Tulis test round-trip JSON.

**2. Engine tanpa provider (`orchestration/`)** — decider, projector, engine,
store in-memory. Uji dengan command palsu. Di titik ini kamu punya sistem yang
teruji penuh tanpa satu pun proses agent.

**3. Store persisten** — ganti `memStore` dengan SQL. Yang wajib: `Commit`
harus satu transaksi. `TestReplayDeterministik` jadi regression guard.

**4. Satu adapter (`provider/<x>/`)** — pilih ACP atau Codex, bukan Claude.
Target: `StartSession` + `SendTurn` + delta streaming. Belum ada approval.

**5. Ingestion + Reactor** — sambungkan. Sekarang kamu punya sistem yang
benar-benar menjalankan agent.

**6. Approval** — broker, mode mapping, empat jebakan di bagian 6.

**7. Adapter kedua** — di sinilah abstraksimu diuji. Kalau `event/` atau
`provider/` perlu diubah untuk mengakomodasi provider kedua, catat perubahannya:
itu memberitahu kamu asumsi apa yang tanpa sadar kamu impor dari provider
pertama.

**8. Sisanya** — checkpointing, diff, remote access, MCP bawaan.

---

## 10. Yang sengaja tidak ada di skeleton

Supaya kamu tidak mengira sudah lengkap:

- **Transport ke client.** WebSocket/gRPC, otorisasi per-method, subscribe
  per-thread. `Engine.Subscribe` sengaja mem-*drop* untuk subscriber lambat —
  subscriber yang butuh jaminan harus membaca ulang lewat
  `Store.EventsSince(seq)` memakai Seq terakhir yang dia lihat.
- **Checkpointing.** t3code menjepit tiap turn dengan snapshot workspace lewat
  hidden Git ref, sehingga diff dan revert eksak. Kontraknya `VcsCheckpointOps`.
- **Persistensi thread & sesi.** Skeleton hanya punya read model in-memory.
- **`ThreadDirectory`.** Interface-nya ada di `provider/provider.go`,
  implementasinya belum.
- **Resume lintas restart.** `ResumeCursor` disimpan tapi belum dipakai untuk
  menghidupkan ulang sesi setelah server restart.
- **MCP server bawaan.** Kalau nanti kamu mau meniru pola `preview_*` t3code:
  host MCP HTTP sendiri, terbitkan bearer token per-thread dengan TTL yang
  di-*touch* tiap turn, suntikkan endpoint-nya lewat `SessionStartInput.MCPEndpoint`.

---

## 11. Referensi file t3code

Kalau perlu melihat implementasi aslinya:

| Konsep | File |
|---|---|
| Canonical event | `packages/contracts/src/providerRuntime.ts` |
| Command & event orchestration | `packages/contracts/src/orchestration.ts` |
| Kontrak Adapter | `apps/server/src/provider/Services/ProviderAdapter.ts` |
| Kontrak Driver | `apps/server/src/provider/ProviderDriver.ts` |
| Daftar driver | `apps/server/src/provider/builtInDrivers.ts` |
| Engine event-sourced | `apps/server/src/orchestration/Layers/OrchestrationEngine.ts` |
| Decider (murni) | `apps/server/src/orchestration/decider.ts` |
| Projector | `apps/server/src/orchestration/projector.ts` |
| Ingestion + buffering | `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts` |
| Reactor | `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts` |
| Approval (canUseTool) | `apps/server/src/provider/Layers/ClaudeAdapter.ts` (~baris 3870–4025) |
| Runtime ACP bersama | `apps/server/src/provider/acp/AcpSessionRuntime.ts` |
| MCP bawaan | `apps/server/src/mcp/` |
| Dokumen arsitektur | `docs/internals/overview.md`, `docs/internals/providers.md` |

Dua dokumen terakhir pendek dan padat. Baca keduanya sebelum menulis kode.
