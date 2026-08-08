# agentcore

Skeleton harness agent multi-provider di Go, diturunkan dari arsitektur
[pingdotgg/t3code](https://github.com/pingdotgg/t3code).

Baca **HANDOFF.md** dulu — itu dokumen utamanya. Kode di sini ilustrasi
dari dokumen tersebut.

```
event/              canonical runtime event  (mulai dari sini)
provider/           Driver + Adapter + Registry + Service
provider/claude/    contoh adapter — SENGAJA TIDAK LENGKAP
approval/           broker untuk request yang memblokir agent
orchestration/      engine event-sourced + Ingestion + Reactor
```

```sh
go vet ./... && go test ./... -race
```

Status: kompilasi bersih, 4 test lolos (lifecycle, idempotensi, double-tap,
replay determinism). Belum ada transport ke client, persistensi, atau
checkpointing — lihat bagian 10 di HANDOFF.md.
