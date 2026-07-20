# Hub/Runtime Catalog Split — Phase 4 (Hub-Signed SSO Token) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator who is already authenticated on the hub reach any runtime's UI with one click — no second password, no pasted key — while the existing key-based sign-in keeps working as the fallback when the hub is unreachable.

**Architecture:** The hub holds an Ed25519 keypair (mirroring the existing AES `auth.key` file). A runtime learns the hub's public key and its own hub-assigned machine ID for free, riding the self-registration response it already calls every 30s — no new endpoint for that leg. A logged-in operator, from the runtime's own sign-in page, is sent to a new hub route (`/handover`) that mints a 60-second, machine-scoped token (`POST /api/machines/{id}/token`) and redirects the browser back to `https://runtime/?t=<token>`. The runtime's auth middleware verifies the signature and the audience claim itself, mints a normal session cookie, and redirects to a clean URL. If the hub is down, or the pubkey/machine-id pair was never learned, or the token fails to verify for any reason, the runtime's sign-in page still offers the key field — this phase adds a path, it never removes the one from Phase 1.

**Tech Stack:** Go 1.22+ stdlib `crypto/ed25519` (no new dependency), React 19 + TanStack Router.

**Spec:** `docs/superpowers/specs/2026-07-19-hub-runtime-catalog-split-design.md` — "Runtime UI authentication" section in full (signing key distribution, token claims, the `SameSite=Lax` requirement already shipped in Phase 1, the middleware table, the sign-in page).

**Builds on:** Phases 1–3, already merged. In particular: `handler.RequireRuntimeAuth` (`backend/internal/handler/runtimeauth.go`), `service.AuthService.KeySession` (`backend/internal/service/auth.go:365-395`), `handler.setAuthCookie` (already takes a `sameSite` parameter, `backend/internal/handler/auth.go:50-60`), `frontend/src/features/auth/RuntimeSignIn.tsx` (its own doc comment already names this phase as the reason its "Sign in via hub" option is absent), and `machineclient.RunSelfRegisterLoop` (`backend/internal/machineclient/selfregister.go`).

## Global Constraints

- Module path is `devdeck/backend`; internal packages under `devdeck/backend/internal/`.
- All API errors use the `{"error":"message"}` envelope. Never change this shape.
- Store errors map to HTTP via `handleStoreErr(w, err)`. Never leak raw SQL errors.
- Domain types in `backend/internal/domain/models.go` and `frontend/src/store/types.ts` must stay in sync.
- Frontend imports use the `@/*` alias — never relative paths into `src/`.
- `verbatimModuleSyntax` is on — use `import type` for type-only imports.
- Never hand-edit `frontend/src/routeTree.gen.ts` (generated).
- **Do not modify `frontend/src/lib/machineClient.ts`.**
- **The hub's own session cookie stays `SameSite=Strict` — never weaken it.** Only the runtime's cookie is `Lax` (already true since Phase 1; this phase must not touch that asymmetry).
- Run `go vet ./...` and `npm run typecheck` before every commit.
- These tasks touch convergence files (`main.go`, `domain/models.go`, `types.ts`) repeatedly — per `CLAUDE.md` they must be edited serially, one task at a time.

## Why the token can't just be a JWT from an off-the-shelf library

There's no JWT dependency in `backend/go.mod` today, and pulling one in for three claims and one algorithm (Ed25519) is more surface area than this needs. Task 1 builds a minimal, purpose-built signed-token format instead: `base64url(payload-json) + "." + base64url(signature)`, verified with `ed25519.Verify`. It is not a JWT and doesn't claim to be — it has exactly the three fields the spec calls for and nothing else.

## Why the runtime needs to learn its own machine ID, not just the hub's public key

Verifying the token's `aud` claim means comparing it against *this runtime's own* hub-assigned machine ID. Today no runtime process knows that value — `machineclient.SelfRegister` discards the hub's response entirely (`selfregister.go:60-65` calls `createHubMachine`/`patchHubMachine`, both of which only check the HTTP status code, never decode the body). Task 5 changes that: the runtime now captures both the public key *and* its own machine ID from the very same self-registration response it already makes every 30 seconds. No new endpoint, no new round trip — exactly what the spec's "no bootstrap ordering problem" reasoning already assumes is happening.

## Why "Sign in via hub" can't be a same-page fetch from the runtime

The hub's session cookie is `SameSite=Strict` by design (Phase 1's decision, unchanged here). Strict cookies are withheld on *any* cross-site request — including a top-level navigation, not just a background `fetch()`. So a button on the runtime's page cannot silently call the hub's token endpoint using an existing hub session; the browser will not attach that cookie to a cross-origin request no matter how it's made. The spec's own flow diagram already reflects this: it shows an explicit `Browser --login password+TOTP--> Hub` step as *part of* the handover, not a shortcut around it. Task 8's `/handover` route is a full top-level navigation to the hub; if a session already exists there (e.g., the operator has the hub open in another tab issued from the hub's own origin), TanStack Router's normal auth guard already treats that as logged-in and skips straight to minting the token — this plan does not need to build that optimization, it falls out of the existing login check for free.

## File Structure

| File | Responsibility |
|---|---|
| `backend/internal/handovertoken/token.go` (create) | `Issue`/`Verify` — the signed-token format |
| `backend/cmd/server/main.go` (modify) | `loadOrCreateSigningKey`; wires the signing key and self-registration's new return value everywhere |
| `backend/internal/domain/models.go` (modify) | `Machine.SigningPublicKey` |
| `frontend/src/store/types.ts` (modify) | `Machine.signingPublicKey` |
| `backend/internal/handler/machine.go` (modify) | enrich every `Machine` response; new `PostToken` handler |
| `backend/internal/machineclient/selfregister.go` (modify) | `SelfRegister`/`RunSelfRegisterLoop` return the learned identity |
| `backend/internal/handler/runtimeauth.go` (modify) | `SetRuntimeIdentity`; the `?t=` verification branch |
| `backend/internal/handler/health.go` (modify) | `whoami` gains `hubUrl`/`machineId` |
| `frontend/src/routes/handover.tsx` (create) | the hub-side redirect handshake |
| `frontend/src/routes/login.tsx` (modify) | honors an optional `?next=` to complete the handshake after login |
| `frontend/src/routes/runtime-sign-in.tsx` (create) | first-ever render site for `RuntimeSignIn` — see Task 9 |
| `frontend/src/routes/__root.tsx` (modify) | role-aware redirect: `/login` vs `/runtime-sign-in` |
| `frontend/src/features/auth/RuntimeSignIn.tsx` (modify) | the "Sign in via hub" button |

---

### Task 1: The signed handover-token format

**Files:**
- Create: `backend/internal/handovertoken/token.go`
- Test: `backend/internal/handovertoken/token_test.go`

**Interfaces:**
- Produces: `handovertoken.Claims{Sub, Aud string; Exp int64}`, `handovertoken.Issue(priv ed25519.PrivateKey, sub, aud string, now time.Time) (string, error)`, `handovertoken.Verify(pub ed25519.PublicKey, token, wantAud string, now time.Time) (Claims, error)` — used by Task 4 (mint) and Task 6 (verify).

- [ ] **Step 1: Write the failing tests**

Create `backend/internal/handovertoken/token_test.go`:

```go
package handovertoken

import (
	"crypto/ed25519"
	"strings"
	"testing"
	"time"
)

func TestIssueThenVerifyRoundTrips(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(nil)
	now := time.Unix(1_700_000_000, 0)

	tok, err := Issue(priv, "user-1", "m-abc", now)
	if err != nil {
		t.Fatal(err)
	}
	claims, err := Verify(pub, tok, "m-abc", now)
	if err != nil {
		t.Fatal(err)
	}
	if claims.Sub != "user-1" || claims.Aud != "m-abc" {
		t.Errorf("claims = %+v, want sub=user-1 aud=m-abc", claims)
	}
}

func TestVerifyRejectsWrongAudience(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(nil)
	now := time.Unix(1_700_000_000, 0)
	tok, _ := Issue(priv, "user-1", "m-abc", now)

	if _, err := Verify(pub, tok, "m-different", now); err == nil {
		t.Fatal("Verify succeeded for a token issued to a different machine, want error")
	}
}

func TestVerifyRejectsExpiredToken(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(nil)
	issuedAt := time.Unix(1_700_000_000, 0)
	tok, _ := Issue(priv, "user-1", "m-abc", issuedAt)

	// 60s TTL + 30s skew tolerance = 90s grace. 91s later must fail.
	tooLate := issuedAt.Add(91 * time.Second)
	if _, err := Verify(pub, tok, "m-abc", tooLate); err == nil {
		t.Fatal("Verify succeeded 91s after issuance, want expired error")
	}
}

func TestVerifyToleratesThirtySecondsOfClockSkew(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(nil)
	issuedAt := time.Unix(1_700_000_000, 0)
	tok, _ := Issue(priv, "user-1", "m-abc", issuedAt)

	// 60s TTL + 29s into the skew-tolerance window: must still succeed.
	stillOk := issuedAt.Add(89 * time.Second)
	if _, err := Verify(pub, tok, "m-abc", stillOk); err != nil {
		t.Errorf("Verify failed 89s after issuance (within the 30s skew tolerance): %v", err)
	}
}

func TestVerifyRejectsTamperedSignature(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(nil)
	now := time.Unix(1_700_000_000, 0)
	tok, _ := Issue(priv, "user-1", "m-abc", now)

	parts := strings.SplitN(tok, ".", 2)
	tampered := parts[0] + ".not-a-real-signature"
	if _, err := Verify(pub, tampered, "m-abc", now); err == nil {
		t.Fatal("Verify succeeded with a tampered signature, want error")
	}
}

func TestVerifyRejectsWrongSigningKey(t *testing.T) {
	_, priv, _ := ed25519.GenerateKey(nil)
	otherPub, _, _ := ed25519.GenerateKey(nil) // a different keypair entirely
	now := time.Unix(1_700_000_000, 0)
	tok, _ := Issue(priv, "user-1", "m-abc", now)

	if _, err := Verify(otherPub, tok, "m-abc", now); err == nil {
		t.Fatal("Verify succeeded against the wrong public key, want error")
	}
}

func TestVerifyRejectsMalformedToken(t *testing.T) {
	pub, _, _ := ed25519.GenerateKey(nil)
	for _, bad := range []string{"", "no-dot-in-here", "one.two.three", "!!!.###"} {
		if _, err := Verify(pub, bad, "m-abc", time.Now()); err == nil {
			t.Errorf("Verify(%q) succeeded, want error", bad)
		}
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd backend && go test ./internal/handovertoken/... -v
```

Expected: FAIL to build — `no Go files in .../internal/handovertoken` (the package doesn't exist yet).

- [ ] **Step 3: Implement**

Create `backend/internal/handovertoken/token.go`:

```go
// Package handovertoken implements the hub's short-lived, machine-scoped
// handover token: proof that a browser holding a valid hub session may open
// one specific runtime's UI without re-entering credentials. See
// docs/superpowers/specs/2026-07-19-hub-runtime-catalog-split-design.md,
// "Runtime UI authentication" -> "Token claims".
//
// This is deliberately not a JWT: three fixed claims and one algorithm
// (Ed25519) don't justify a dependency. The wire format is
// base64url(payload-json) + "." + base64url(signature), where the signature
// covers the base64url-encoded payload string exactly as transmitted.
package handovertoken

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// ttl is how long a token is valid from issuance, before skew tolerance.
// A handover token is exchanged for a session cookie within seconds of
// being minted; it is not a session itself, so it stays short.
const ttl = 60 * time.Second

// skewTolerance absorbs clock drift between the hub (which stamps exp) and
// the runtime (which checks it) without weakening the token's core purpose:
// a verifier is never asked to trust a token more than ttl+skewTolerance
// old, and the token still can't be replayed indefinitely.
const skewTolerance = 30 * time.Second

// Claims is the token's entire payload. Minimal by design — see the spec
// section this package implements.
type Claims struct {
	Sub string `json:"sub"` // the hub user id that authenticated
	Aud string `json:"aud"` // the one machine id this token is valid for
	Exp int64  `json:"exp"` // unix seconds
}

var errMalformed = errors.New("malformed handover token")

// Issue mints a token good for ttl from now, scoped to aud.
func Issue(priv ed25519.PrivateKey, sub, aud string, now time.Time) (string, error) {
	payload, err := json.Marshal(Claims{Sub: sub, Aud: aud, Exp: now.Add(ttl).Unix()})
	if err != nil {
		return "", err
	}
	encodedPayload := base64.RawURLEncoding.EncodeToString(payload)
	sig := ed25519.Sign(priv, []byte(encodedPayload))
	return encodedPayload + "." + base64.RawURLEncoding.EncodeToString(sig), nil
}

// Verify checks the signature, the audience, and the expiry (with
// skewTolerance grace), in that order. wantAud is normally this runtime's
// own hub-assigned machine id.
func Verify(pub ed25519.PublicKey, token, wantAud string, now time.Time) (Claims, error) {
	encodedPayload, encodedSig, ok := strings.Cut(token, ".")
	if !ok || encodedPayload == "" || encodedSig == "" {
		return Claims{}, errMalformed
	}
	sig, err := base64.RawURLEncoding.DecodeString(encodedSig)
	if err != nil {
		return Claims{}, errMalformed
	}
	if !ed25519.Verify(pub, []byte(encodedPayload), sig) {
		return Claims{}, errors.New("invalid signature")
	}
	payload, err := base64.RawURLEncoding.DecodeString(encodedPayload)
	if err != nil {
		return Claims{}, errMalformed
	}
	var claims Claims
	if err := json.Unmarshal(payload, &claims); err != nil {
		return Claims{}, errMalformed
	}
	if claims.Aud != wantAud {
		return Claims{}, errors.New("token is not valid for this machine")
	}
	if now.Unix() > claims.Exp+int64(skewTolerance.Seconds()) {
		return Claims{}, errors.New("token expired")
	}
	return claims, nil
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd backend && go test ./internal/handovertoken/... -v && go vet ./...
```

Expected: all seven tests PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/handovertoken/
git commit -m "feat(hub): add the Ed25519 handover-token issue/verify format"
```

---

### Task 2: The hub's signing key

**Files:**
- Modify: `backend/cmd/server/main.go`

**Interfaces:**
- Produces: `loadOrCreateSigningKey(dbPath string) (ed25519.PrivateKey, error)` — used by Task 4 (mint) and passed through construction in this same task.

- [ ] **Step 1: Read the exact sibling function first**

`backend/cmd/server/main.go:734-758` is `loadOrCreateAuthKey`. Read it in full — Task 2 mirrors its exact shape (env var override, file-next-to-db persistence, 0600 permissions), adjusted for Ed25519's key size.

- [ ] **Step 2: Implement**

Add directly below `loadOrCreateAuthKey` in `backend/cmd/server/main.go`:

```go
// loadOrCreateSigningKey returns the hub's Ed25519 keypair, used to sign
// short-lived handover tokens (see internal/handovertoken). Persisted the
// same way as loadOrCreateAuthKey: an env var override, then a file next to
// the database, then generated fresh on first run. The private key format
// (ed25519.PrivateKey) is 64 bytes and already contains the public key in
// its second half.
func loadOrCreateSigningKey(dbPath string) (ed25519.PrivateKey, error) {
	if envKey := os.Getenv("DEVDECK_SIGNING_KEY"); envKey != "" {
		key, err := base64.StdEncoding.DecodeString(envKey)
		if err != nil || len(key) != ed25519.PrivateKeySize {
			return nil, fmt.Errorf("DEVDECK_SIGNING_KEY must be a base64-encoded %d-byte Ed25519 private key", ed25519.PrivateKeySize)
		}
		return ed25519.PrivateKey(key), nil
	}
	keyPath := filepath.Join(filepath.Dir(dbPath), "signing.key")
	if data, err := os.ReadFile(keyPath); err == nil {
		key, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(data)))
		if err != nil || len(key) != ed25519.PrivateKeySize {
			return nil, fmt.Errorf("corrupt signing key file %s", keyPath)
		}
		return ed25519.PrivateKey(key), nil
	}
	_, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(keyPath, []byte(base64.StdEncoding.EncodeToString(priv)), 0o600); err != nil {
		return nil, err
	}
	return priv, nil
}
```

Add `"crypto/ed25519"` to the file's import block (check it isn't already there before adding — it shouldn't be yet).

- [ ] **Step 3: Wire it in, right next to the AES key**

Find `authKey, err := loadOrCreateAuthKey(*dbPath)` in `main.go` (around line 190, immediately before `authSvc := service.NewAuthService(st, authKey)`). Add directly after it:

```go
	signingKey, err := loadOrCreateSigningKey(*dbPath)
	if err != nil {
		log.Fatalf("signing key: %v", err)
	}
```

`signingKey` is unused until Task 4 wires it into `MachineHandler` — that's expected; the build will fail on an unused variable only if nothing ever references it, and Task 4 lands next, so leave it as-is (Go does report unused *local* variables as a compile error — if this step alone leaves it unreferenced, temporarily reference it with `_ = signingKey` and remove that line in Task 4 when the real reference is added).

- [ ] **Step 4: Verify it compiles and doesn't break anything**

```bash
cd backend && go build ./... && go vet ./...
```

Expected: clean. If step 3 left `signingKey` unused, you'll see `declared and not used: signingKey` — add the temporary `_ = signingKey` line mentioned above, rebuild, confirm clean.

- [ ] **Step 5: Commit**

```bash
git add backend/cmd/server/main.go
git commit -m "feat(hub): generate and persist an Ed25519 signing key"
```

---

### Task 3: `Machine.SigningPublicKey`

**Files:**
- Modify: `backend/internal/domain/models.go`
- Modify: `frontend/src/store/types.ts`
- Modify: `backend/internal/handler/machine.go`
- Test: `backend/internal/handler/machine_test.go`

**Interfaces:**
- Consumes: nothing new from earlier tasks (uses the `ed25519.PrivateKey` type, already imported by Task 2's file, but this task's own files need their own import).
- Produces: `domain.Machine.SigningPublicKey string` (base64), always populated by every `MachineHandler` response — used by Task 5's runtime-side decoding.

- [ ] **Step 1: Add the domain field**

In `backend/internal/domain/models.go`, find `type Machine struct` (~line 220) and add a field after `IsLocal`:

```go
	// SigningPublicKey is the HUB's Ed25519 public key (base64), the same
	// value on every Machine this hub ever returns — it is a property of
	// the hub, not of any individual machine. It rides here rather than a
	// dedicated endpoint because every registered runtime already fetches
	// its own Machine record via the exact POST/PATCH /api/machines call it
	// makes to self-register (see machineclient.SelfRegister), so this is
	// "free": no new round trip, no bootstrap-ordering problem. Runtimes
	// use it to verify hub-signed handover tokens (internal/handovertoken).
	SigningPublicKey string `json:"signingPublicKey"`
```

- [ ] **Step 2: Mirror it in the frontend type**

In `frontend/src/store/types.ts`, find `interface Machine` (~line 144) and add:

```ts
  /** The hub's Ed25519 public key (base64) — the same value on every machine; unused by the UI, present only to mirror the backend type. */
  signingPublicKey: string
```

- [ ] **Step 3: Write the failing handler test**

Create `backend/internal/handler/machine_test.go` (or append if it already exists — check first with `ls backend/internal/handler/machine_test.go`):

```go
func TestGetMachinesIncludesTheHubSigningPublicKey(t *testing.T) {
	st := store.NewTestStore(t)
	st.CreateMachine("builder", "https://a.ts.net", "key-a", false)
	_, priv, _ := ed25519.GenerateKey(nil)

	h := NewMachineHandler(st, service.NewMachineHealthCache(), nil, priv)
	req := httptest.NewRequest(http.MethodGet, "/api/machines", nil)
	rec := httptest.NewRecorder()
	h.GetMachines(rec, req)

	var got []domain.Machine
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].SigningPublicKey == "" {
		t.Fatalf("GetMachines() = %+v, want one machine with a non-empty SigningPublicKey", got)
	}
	wantPub := base64.StdEncoding.EncodeToString(priv.Public().(ed25519.PublicKey))
	if got[0].SigningPublicKey != wantPub {
		t.Errorf("SigningPublicKey = %q, want %q (base64 of priv.Public())", got[0].SigningPublicKey, wantPub)
	}
}
```

Add whatever imports that file needs (`crypto/ed25519`, `encoding/base64`, `encoding/json`, `net/http`, `net/http/httptest`, `testing`, `devdeck/backend/internal/domain`, `devdeck/backend/internal/service`, `devdeck/backend/internal/store`) — check the file's current imports first if it already exists, and only add what's missing.

- [ ] **Step 4: Run it to verify it fails**

```bash
cd backend && go test ./internal/handler/ -run TestGetMachinesIncludesTheHubSigningPublicKey
```

Expected: FAIL to build — `too many arguments in call to NewMachineHandler` (it currently takes two arguments).

- [ ] **Step 5: Implement**

In `backend/internal/handler/machine.go`, change the struct and constructor:

```go
// MachineHandler handles the hub's runtime-machine registry.
type MachineHandler struct {
	st            *store.Store
	healthCache   *service.MachineHealthCache
	authSvc       *service.AuthService  // nil-safe: only PostToken (Task 4) uses it
	signingPriv   ed25519.PrivateKey
}

func NewMachineHandler(st *store.Store, healthCache *service.MachineHealthCache, authSvc *service.AuthService, signingPriv ed25519.PrivateKey) *MachineHandler {
	return &MachineHandler{st: st, healthCache: healthCache, authSvc: authSvc, signingPriv: signingPriv}
}

// withSigningKey stamps every Machine in the slice with this hub's Ed25519
// public key before it's serialized — see domain.Machine.SigningPublicKey.
func (h *MachineHandler) withSigningKey(machines []domain.Machine) []domain.Machine {
	pub := base64.StdEncoding.EncodeToString(h.signingPriv.Public().(ed25519.PublicKey))
	for i := range machines {
		machines[i].SigningPublicKey = pub
	}
	return machines
}

func (h *MachineHandler) withSigningKeyOne(m domain.Machine) domain.Machine {
	m.SigningPublicKey = base64.StdEncoding.EncodeToString(h.signingPriv.Public().(ed25519.PublicKey))
	return m
}
```

Add `"crypto/ed25519"`, `"encoding/base64"`, and `"devdeck/backend/internal/domain"` to the file's imports.

Update the three existing handlers that return `Machine`/`[]Machine` to call these helpers right before `writeJSON`:

```go
func (h *MachineHandler) GetMachines(w http.ResponseWriter, r *http.Request) {
	list, err := h.st.Machines()
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, h.withSigningKey(list))
}
```

```go
func (h *MachineHandler) PostMachine(w http.ResponseWriter, r *http.Request) {
	// ... existing body decode/validation unchanged ...
	m, err := h.st.CreateMachine(name, url, key, isLocal) // match whatever the existing variable names are
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, h.withSigningKeyOne(m))
}
```

```go
func (h *MachineHandler) PatchMachine(w http.ResponseWriter, r *http.Request) {
	var p port.MachinePatch
	if _, err := decodeBody(r, &p); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if p.URL != nil && !validMachineURL(*p.URL) {
		writeErr(w, http.StatusBadRequest, "url must be an absolute http(s) URL")
		return
	}
	m, err := h.st.UpdateMachine(r.PathValue("id"), p)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, h.withSigningKeyOne(m))
}
```

For `PostMachine`, read the current file first (`grep -n "func (h \*MachineHandler) PostMachine" -A 20 backend/internal/handler/machine.go`) and adapt only its final two lines (the `handleStoreErr`/`writeJSON` pair) to match this shape — do not rewrite its body decoding logic, which this task doesn't touch.

- [ ] **Step 6: Update the one production call site**

In `backend/cmd/server/main.go`, change `machineH := handler.NewMachineHandler(st, healthCache)` (line 258) to:

```go
	machineH := handler.NewMachineHandler(st, healthCache, authSvc, signingKey)
```

This also removes the need for the `_ = signingKey` placeholder from Task 2 Step 3, if you added one — delete that line now.

- [ ] **Step 7: Run the test to verify it passes**

```bash
cd backend && go test ./internal/handler/ -run TestGetMachinesIncludesTheHubSigningPublicKey -v
cd backend && go build ./... && go test ./internal/... && go vet ./...
cd frontend && npm run typecheck
```

Expected: PASS; full suite green.

- [ ] **Step 8: Commit**

```bash
git add backend/internal/domain/models.go frontend/src/store/types.ts \
        backend/internal/handler/machine.go backend/internal/handler/machine_test.go \
        backend/cmd/server/main.go
git commit -m "feat(hub): stamp every Machine response with the hub's signing public key"
```

---

### Task 4: `POST /api/machines/{id}/token`

**Files:**
- Modify: `backend/internal/handler/machine.go`
- Modify: `backend/cmd/server/main.go`
- Test: `backend/internal/handler/machine_test.go`

**Interfaces:**
- Consumes: `handovertoken.Issue` (Task 1), `MachineHandler.authSvc`/`.signingPriv` (Task 3).
- Produces: `MachineHandler.PostToken`, mounted at `POST /api/machines/{id}/token` — used by Task 8's frontend handshake.

- [ ] **Step 1: Write the failing test**

Append to `backend/internal/handler/machine_test.go`:

```go
func TestPostTokenMintsAHandoverTokenForTheAuthenticatedUser(t *testing.T) {
	st := store.NewTestStore(t)
	m, _ := st.CreateMachine("builder", "https://a.ts.net", "key-a", false)
	_, priv, _ := ed25519.GenerateKey(nil)
	authKey := make([]byte, 32)
	authSvc := service.NewAuthService(st, authKey)

	// KeySession's underlying mechanism creates/reuses the single operator
	// account and issues a real session — reused here purely to get a
	// valid (userID, sessionToken) pair to authenticate the request with,
	// the same way any other authenticated hub handler test would.
	sessionToken, user, err := authSvc.KeySession()
	if err != nil {
		t.Fatal(err)
	}

	h := NewMachineHandler(st, service.NewMachineHealthCache(), authSvc, priv)
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/machines/{id}/token", h.PostToken)

	req := httptest.NewRequest(http.MethodPost, "/api/machines/"+m.ID+"/token", nil)
	req.AddCookie(&http.Cookie{Name: "devdeck_session", Value: sessionToken})
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s, want 200", rec.Code, rec.Body.String())
	}
	var body struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	pub := priv.Public().(ed25519.PublicKey)
	claims, err := handovertoken.Verify(pub, body.Token, m.ID, time.Now())
	if err != nil {
		t.Fatalf("minted token failed to verify: %v", err)
	}
	if claims.Sub != user.ID {
		t.Errorf("claims.Sub = %q, want %q", claims.Sub, user.ID)
	}

	// A request for a machine id that doesn't exist must 404, not silently
	// mint a token for nothing.
	req2 := httptest.NewRequest(http.MethodPost, "/api/machines/m-does-not-exist/token", nil)
	req2.AddCookie(&http.Cookie{Name: "devdeck_session", Value: sessionToken})
	rec2 := httptest.NewRecorder()
	mux.ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusNotFound {
		t.Errorf("status for unknown machine = %d, want 404", rec2.Code)
	}
}
```

Add `"devdeck/backend/internal/handovertoken"` and `"time"` to the file's imports if not already present. Confirm the session cookie's real name constant (`sessionCookieName`, defined in `auth.go`) — use the literal string `"devdeck_session"` only if that's what it currently resolves to; check with `grep -n "sessionCookieName =" backend/internal/handler/auth.go` first and match exactly.

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && go test ./internal/handler/ -run TestPostTokenMintsAHandoverTokenForTheAuthenticatedUser
```

Expected: FAIL to build — `h.PostToken undefined`.

- [ ] **Step 3: Implement**

Add to `backend/internal/handler/machine.go`:

```go
// PostToken handles POST /api/machines/{id}/token. The caller must already
// hold a valid hub session (this route is hub-only, gated by the normal
// RequireAuth cookie check — no new auth path here). It mints a 60-second
// token scoped to this one machine, which the browser then uses to sign
// into that runtime's own UI without re-entering credentials.
func (h *MachineHandler) PostToken(w http.ResponseWriter, r *http.Request) {
	user, err := h.authSvc.CurrentUser(cookieValue(r, sessionCookieName))
	if handleStoreErr(w, err) {
		return
	}
	m, err := h.st.MachineByID(r.PathValue("id"))
	if handleStoreErr(w, err) {
		return
	}
	tok, err := handovertoken.Issue(h.signingPriv, user.ID, m.ID, time.Now())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"token": tok})
}
```

Add `"devdeck/backend/internal/handovertoken"` and `"time"` to `machine.go`'s imports.

- [ ] **Step 4: Mount the route**

In `backend/cmd/server/main.go`, add right after the existing machine routes (~line 450, alongside `GET /api/machines/{id}/health`):

```go
		mux.HandleFunc("POST /api/machines/{id}/token", machineH.PostToken)
```

This route is already inside the `if !isRuntime {` block that the other `/api/machines/*` routes live in — hub-only, matching the spec ("Hub only... POST /api/machines/{id}/token"). Confirm this by reading the surrounding `if` block before adding the line — do not add it outside that block.

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd backend && go test ./internal/handler/ -run TestPostTokenMintsAHandoverTokenForTheAuthenticatedUser -v
cd backend && go build ./... && go test ./internal/... && go vet ./...
```

Expected: PASS; full suite green.

- [ ] **Step 6: Commit**

```bash
git add backend/internal/handler/machine.go backend/internal/handler/machine_test.go backend/cmd/server/main.go
git commit -m "feat(hub): add POST /api/machines/{id}/token to mint handover tokens"
```

---

### Task 5: The runtime learns its own machine ID and the hub's public key

**Files:**
- Modify: `backend/internal/machineclient/selfregister.go`
- Modify: `backend/cmd/server/main.go`
- Test: `backend/internal/machineclient/selfregister_test.go`

**Interfaces:**
- Produces: `SelfRegister(ctx, cfg) (hubMachine, error)`, `RunSelfRegisterLoop(ctx, cfg, retryEvery) (hubMachine, bool)` (the bool is false only if ctx was cancelled before success) — consumed by this same task's `main.go` wiring, which hands the result to Task 6's `handler.SetRuntimeIdentity`.

- [ ] **Step 1: Write the failing test**

Check whether `backend/internal/machineclient/selfregister_test.go` already exists (`ls`); if it does, append to it, otherwise create it:

```go
func TestSelfRegisterReturnsTheHubMachineIncludingSigningKey(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/machines":
			_, _ = w.Write([]byte(`[]`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/machines":
			_, _ = w.Write([]byte(`{"id":"m-new","name":"builder","url":"http://runtime","key":"rt-key","isLocal":false,"signingPublicKey":"cHVia2V5"}`))
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
	}))
	defer srv.Close()

	got, err := SelfRegister(context.Background(), SelfRegisterConfig{
		HubURL: srv.URL, HubKey: "hubkey", PublicURL: "http://runtime", Name: "builder", Key: "rt-key",
	})
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != "m-new" {
		t.Errorf("ID = %q, want m-new", got.ID)
	}
	if got.SigningPublicKey != "cHVia2V5" {
		t.Errorf("SigningPublicKey = %q, want cHVia2V5", got.SigningPublicKey)
	}
}
```

Add `"context"`, `"net/http"`, `"net/http/httptest"`, `"testing"` to the file's imports if creating it fresh.

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && go test ./internal/machineclient/ -run TestSelfRegisterReturnsTheHubMachineIncludingSigningKey
```

Expected: FAIL — either a build error (`assignment mismatch: 2 variables but SelfRegister returns 1 value`) or, if you haven't changed the signature yet, a straightforward failure since `SigningPublicKey` doesn't exist on `hubMachine` yet.

- [ ] **Step 3: Implement**

In `backend/internal/machineclient/selfregister.go`:

Add the field to `hubMachine`:

```go
type hubMachine struct {
	ID               string `json:"id"`
	Name             string `json:"name"`
	URL              string `json:"url"`
	Key              string `json:"key"`
	IsLocal          bool   `json:"isLocal"`
	SigningPublicKey string `json:"signingPublicKey"`
}
```

Change `SelfRegister` to return the matched or created/patched machine:

```go
// SelfRegister upserts this runtime's entry in the hub's machine registry
// by URL: an existing entry whose url matches cfg.PublicURL is PATCHed if
// its name/key differ (a no-op if already correct); no match creates a new
// entry. It reuses the hub's existing GET/POST/PATCH /api/machines
// endpoints — no hub-side change was needed for this. The returned
// hubMachine carries this runtime's own hub-assigned id and the hub's
// signing public key, both needed to verify handover tokens
// (internal/handovertoken) — this is the only place a runtime ever learns
// either value.
func SelfRegister(ctx context.Context, cfg SelfRegisterConfig) (hubMachine, error) {
	machines, err := listHubMachines(ctx, cfg)
	if err != nil {
		return hubMachine{}, fmt.Errorf("list hub machines: %w", err)
	}

	for _, m := range machines {
		if m.URL != cfg.PublicURL {
			continue
		}
		if m.Name == cfg.Name && m.Key == cfg.Key && m.IsLocal == cfg.IsLocal {
			return m, nil
		}
		return patchHubMachine(ctx, cfg, m.ID)
	}
	return createHubMachine(ctx, cfg)
}
```

Change `RunSelfRegisterLoop` to return the result:

```go
// RunSelfRegisterLoop retries SelfRegister on retryEvery until it succeeds
// once, then returns the registered machine (including this runtime's own
// hub-assigned id and the hub's signing public key). A failure is logged,
// never fatal — the caller (the runtime's main goroutine) keeps serving
// regardless of registration status. Returns (zero value, false) early if
// ctx is cancelled before success.
func RunSelfRegisterLoop(ctx context.Context, cfg SelfRegisterConfig, retryEvery time.Duration) (hubMachine, bool) {
	for {
		m, err := SelfRegister(ctx, cfg)
		if err != nil {
			log.Printf("self-register: %v; retrying in %s", err, retryEvery)
		} else {
			log.Printf("self-register: registered with hub as %q (%s)", cfg.Name, cfg.PublicURL)
			return m, true
		}
		select {
		case <-ctx.Done():
			return hubMachine{}, false
		case <-time.After(retryEvery):
		}
	}
}
```

Change `createHubMachine`/`patchHubMachine`/`doHubMachineRequest` to decode and return the machine instead of discarding the body:

```go
func createHubMachine(ctx context.Context, cfg SelfRegisterConfig) (hubMachine, error) {
	body, err := json.Marshal(struct {
		Name    string `json:"name"`
		URL     string `json:"url"`
		Key     string `json:"key"`
		IsLocal bool   `json:"isLocal,omitempty"`
	}{Name: cfg.Name, URL: cfg.PublicURL, Key: cfg.Key, IsLocal: cfg.IsLocal})
	if err != nil {
		return hubMachine{}, err
	}
	return doHubMachineRequest(ctx, cfg, http.MethodPost, strings.TrimRight(cfg.HubURL, "/")+"/api/machines", body)
}

func patchHubMachine(ctx context.Context, cfg SelfRegisterConfig, id string) (hubMachine, error) {
	body, err := json.Marshal(struct {
		Name    string `json:"name"`
		Key     string `json:"key"`
		IsLocal bool   `json:"isLocal,omitempty"`
	}{Name: cfg.Name, Key: cfg.Key, IsLocal: cfg.IsLocal})
	if err != nil {
		return hubMachine{}, err
	}
	return doHubMachineRequest(ctx, cfg, http.MethodPatch, strings.TrimRight(cfg.HubURL, "/")+"/api/machines/"+id, body)
}

func doHubMachineRequest(ctx context.Context, cfg SelfRegisterConfig, method, url string, body []byte) (hubMachine, error) {
	ctx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, url, bytes.NewReader(body))
	if err != nil {
		return hubMachine{}, err
	}
	req.Header.Set("Authorization", "Bearer "+cfg.HubKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return hubMachine{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return hubMachine{}, fmt.Errorf("hub returned status %d for %s %s", resp.StatusCode, method, url)
	}
	var m hubMachine
	if err := json.NewDecoder(resp.Body).Decode(&m); err != nil {
		return hubMachine{}, fmt.Errorf("decode machine: %w", err)
	}
	return m, nil
}
```

- [ ] **Step 4: Run the test to verify it passes, then check for other callers**

```bash
cd backend && go test ./internal/machineclient/ -run TestSelfRegisterReturnsTheHubMachineIncludingSigningKey -v
cd backend && go build ./... 2>&1 | head -30
```

The build will fail at every existing call site of `RunSelfRegisterLoop`/`SelfRegister` that doesn't yet handle the new return values — that's expected and fixed in Step 5.

- [ ] **Step 5: Update the one production call site**

In `backend/cmd/server/main.go`, find the `go func() { machineclient.RunSelfRegisterLoop(...)` block (~line 592). Change:

```go
			machineclient.RunSelfRegisterLoop(context.Background(), machineclient.SelfRegisterConfig{
				HubURL:    *hubURL,
				HubKey:    *hubKey,
				PublicURL: *publicURL,
				Name:      *machineName,
				Key:       *apiKey,
				IsLocal:   isBoth,
			}, 30*time.Second)
```

to:

```go
			self, registered := machineclient.RunSelfRegisterLoop(context.Background(), machineclient.SelfRegisterConfig{
				HubURL:    *hubURL,
				HubKey:    *hubKey,
				PublicURL: *publicURL,
				Name:      *machineName,
				Key:       *apiKey,
				IsLocal:   isBoth,
			}, 30*time.Second)
			if registered {
				if pub, err := base64.StdEncoding.DecodeString(self.SigningPublicKey); err == nil && len(pub) == ed25519.PublicKeySize {
					handler.SetRuntimeIdentity(self.ID, ed25519.PublicKey(pub))
				} else {
					log.Printf("self-register: hub did not return a usable signing public key; SSO handover tokens will fail verification until this runtime re-registers")
				}
			}
```

`handler.SetRuntimeIdentity` doesn't exist yet — that's Task 6. This step will not compile on its own; that's expected for a plan this tightly sequenced. Move directly to Task 6 rather than trying to verify Task 5 in isolation past this point (there is nothing meaningful to test about this specific wiring without Task 6's function existing).

Add `"crypto/ed25519"` and `"encoding/base64"` to `main.go`'s imports if not already present (they will be, from Task 2).

- [ ] **Step 6: Commit once Task 6 exists to make this compile**

Do not commit yet — Task 6's step 5 will include committing this file alongside `runtimeauth.go`. Leave `main.go` as modified and move to Task 6 immediately.

---

### Task 6: Runtime middleware verifies the `?t=` token

**Files:**
- Modify: `backend/internal/handler/runtimeauth.go`
- Test: `backend/internal/handler/runtimeauth_test.go`

**Interfaces:**
- Consumes: `handovertoken.Verify` (Task 1), the `(machineID, pubkey)` pair set via Task 5's `main.go` change.
- Produces: `handler.SetRuntimeIdentity(machineID string, hubPub ed25519.PublicKey)` — called once by `main.go` (Task 5); the `?t=` branch inside `RequireRuntimeAuth`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/internal/handler/runtimeauth_test.go`:

```go
func TestRequireRuntimeAuthAcceptsAValidHandoverToken(t *testing.T) {
	st := store.NewTestStore(t)
	authKey := make([]byte, 32)
	authSvc := service.NewAuthService(st, authKey)

	pub, priv, _ := ed25519.GenerateKey(nil)
	SetRuntimeIdentity("m-this-runtime", pub)
	defer SetRuntimeIdentity("", nil) // don't leak state into other tests

	tok, err := handovertoken.Issue(priv, "user-1", "m-this-runtime", time.Now())
	if err != nil {
		t.Fatal(err)
	}

	var hit bool
	mw := RequireRuntimeAuth(authSvc, "rt-key")
	req := httptest.NewRequest(http.MethodGet, "/?t="+tok, nil)
	rec := httptest.NewRecorder()
	mw(okHandler(&hit)).ServeHTTP(rec, req)

	if rec.Code != http.StatusFound && rec.Code != http.StatusTemporaryRedirect {
		t.Fatalf("status = %d, want a redirect (302/307) to a clean URL after minting a cookie", rec.Code)
	}
	loc := rec.Header().Get("Location")
	if strings.Contains(loc, "t=") {
		t.Errorf("redirect Location = %q, still carries the token — it must be scrubbed", loc)
	}
	setCookie := rec.Header().Get("Set-Cookie")
	if !strings.Contains(setCookie, "devdeck_session=") || !strings.Contains(setCookie, "SameSite=Lax") {
		t.Errorf("Set-Cookie = %q, want a devdeck_session cookie with SameSite=Lax", setCookie)
	}
}

func TestRequireRuntimeAuthRejectsATokenForADifferentMachine(t *testing.T) {
	st := store.NewTestStore(t)
	authKey := make([]byte, 32)
	authSvc := service.NewAuthService(st, authKey)

	pub, priv, _ := ed25519.GenerateKey(nil)
	SetRuntimeIdentity("m-this-runtime", pub)
	defer SetRuntimeIdentity("", nil)

	tok, _ := handovertoken.Issue(priv, "user-1", "m-a-different-runtime", time.Now())

	var hit bool
	mw := RequireRuntimeAuth(authSvc, "rt-key")
	req := httptest.NewRequest(http.MethodGet, "/?t="+tok, nil)
	rec := httptest.NewRecorder()
	mw(okHandler(&hit)).ServeHTTP(rec, req)

	// A bad token must fall through to the normal unauthenticated path
	// (the sign-in page), not silently grant access.
	if hit || rec.Code == http.StatusFound {
		t.Errorf("a token for a different machine was accepted: code=%d hit=%v", rec.Code, hit)
	}
}

func TestRequireRuntimeAuthFallsThroughWhenIdentityIsUnknown(t *testing.T) {
	SetRuntimeIdentity("", nil) // simulates a runtime that hasn't registered yet
	_, priv, _ := ed25519.GenerateKey(nil)
	tok, _ := handovertoken.Issue(priv, "user-1", "m-whatever", time.Now())

	var hit bool
	mw := RequireRuntimeAuth(nil, "rt-key")
	req := httptest.NewRequest(http.MethodGet, "/?t="+tok, nil)
	rec := httptest.NewRecorder()
	mw(okHandler(&hit)).ServeHTTP(rec, req)

	if hit || rec.Code == http.StatusFound {
		t.Errorf("token was accepted despite no known runtime identity: code=%d hit=%v", rec.Code, hit)
	}
}

func TestRequireRuntimeAuthStillAcceptsBearerKeyAlongsideTokenSupport(t *testing.T) {
	// Regression guard: adding ?t= handling must not disturb the existing
	// paths frontend/src/lib/machineClient.ts depends on.
	var hit bool
	mw := RequireRuntimeAuth(nil, "rt-key")
	req := httptest.NewRequest(http.MethodGet, "/api/worktrees", nil)
	req.Header.Set("Authorization", "Bearer rt-key")
	rec := httptest.NewRecorder()
	mw(okHandler(&hit)).ServeHTTP(rec, req)
	if !hit || rec.Code != http.StatusOK {
		t.Errorf("bearer key rejected: code=%d hit=%v", rec.Code, hit)
	}
}
```

Add `"crypto/ed25519"`, `"devdeck/backend/internal/handovertoken"`, `"devdeck/backend/internal/service"`, `"devdeck/backend/internal/store"`, `"strings"`, `"time"` to the file's imports as needed (check what's already there first — `okHandler` is defined earlier in this same file from Phase 1).

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd backend && go test ./internal/handler/ -run "TestRequireRuntimeAuthAcceptsAValidHandoverToken|TestRequireRuntimeAuthRejectsATokenForADifferentMachine|TestRequireRuntimeAuthFallsThroughWhenIdentityIsUnknown"
```

Expected: FAIL to build — `undefined: SetRuntimeIdentity`.

- [ ] **Step 3: Implement**

Replace `backend/internal/handler/runtimeauth.go` in full:

```go
package handler

import (
	"crypto/ed25519"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"devdeck/backend/internal/handovertoken"
	"devdeck/backend/internal/service"
)

type runtimeIdentity struct {
	machineID string
	hubPub    ed25519.PublicKey
}

var identity atomic.Pointer[runtimeIdentity]

// SetRuntimeIdentity records this runtime's own hub-assigned machine id and
// the hub's Ed25519 public key, learned via self-registration
// (machineclient.SelfRegister). Both are required together to verify a
// handover token: the key to check the signature, the id to check the
// audience claim. Called from a background goroutine after the server has
// already started accepting connections, so — unlike SetSecureCookies,
// which is set once before serving begins — this uses atomic storage for a
// safe concurrent read from request-handling goroutines.
//
// Call with ("", nil) to clear (used by tests to avoid leaking state
// between them); a real runtime never does this once registered.
func SetRuntimeIdentity(machineID string, hubPub ed25519.PublicKey) {
	if machineID == "" && hubPub == nil {
		identity.Store(nil)
		return
	}
	identity.Store(&runtimeIdentity{machineID: machineID, hubPub: hubPub})
}

// RequireRuntimeAuth returns middleware for the runtime role. It is additive
// over RequireKey: the bearer-key and ?key= paths that frontend/src/lib/
// machineClient.ts already depends on keep working unchanged, and a session
// cookie is accepted as well so the runtime can serve its own web UI.
//
// svc may be nil when the runtime has no UI session support wired; the
// cookie and ?t= branches are then simply never taken.
func RequireRuntimeAuth(svc *service.AuthService, key string) func(http.Handler) http.Handler {
	publicPaths := map[string]bool{
		"/api/health":           true,
		"/api/auth/key-session": true,
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if publicPaths[r.URL.Path] {
				next.ServeHTTP(w, r)
				return
			}
			// Static SPA assets stay public, mirroring RequireAuth's rule
			// (middleware.go:105-108) so the UI shell can load and then
			// authenticate itself.
			if !strings.HasPrefix(r.URL.Path, "/api") && !strings.HasPrefix(r.URL.Path, "/ws/") {
				if svc != nil && tryHandoverToken(w, r, svc) {
					return
				}
				next.ServeHTTP(w, r)
				return
			}
			if keyMatches(keyFromRequest(r), key) {
				next.ServeHTTP(w, r)
				return
			}
			if svc != nil {
				if cookie, err := r.Cookie(sessionCookieName); err == nil {
					if _, err := svc.CurrentUser(cookie.Value); err == nil {
						next.ServeHTTP(w, r)
						return
					}
				}
			}
			writeErr(w, http.StatusUnauthorized, "unauthorized")
		})
	}
}

// tryHandoverToken checks for a ?t= query param, verifies it against this
// runtime's known identity, and on success mints a session cookie and
// redirects to a clean URL (the token must never linger in browser
// history). Returns false — meaning "did nothing, keep going" — whenever
// there's no token, the identity isn't known yet, or verification fails for
// any reason; the caller then falls through to the normal unauthenticated
// path (the sign-in page, which still offers the key field). This must
// never hard-fail with 401 on its own: a missing/invalid token here is not
// an error, just "this path didn't apply".
func tryHandoverToken(w http.ResponseWriter, r *http.Request, svc *service.AuthService) bool {
	tok := r.URL.Query().Get("t")
	if tok == "" {
		return false
	}
	id := identity.Load()
	if id == nil {
		return false
	}
	if _, err := handovertoken.Verify(id.hubPub, tok, id.machineID, time.Now()); err != nil {
		return false
	}
	sessionToken, _, err := svc.KeySession()
	if err != nil {
		return false
	}
	setAuthCookie(w, sessionCookieName, sessionToken, 12*time.Hour, http.SameSiteLaxMode)

	clean := *r.URL
	q := clean.Query()
	q.Del("t")
	clean.RawQuery = q.Encode()
	http.Redirect(w, r, clean.RequestURI(), http.StatusFound)
	return true
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd backend && go test ./internal/handler/ -run "TestRequireRuntimeAuth" -v
cd backend && go build ./... && go test ./internal/... && go vet ./...
```

Expected: all `TestRequireRuntimeAuth*` tests PASS (both the four from this task and every pre-existing one from Phase 1, none of which should have changed behavior); full suite green.

- [ ] **Step 5: Commit Task 5 and Task 6 together**

Task 5 left `main.go` in a state that only compiles once this task's `SetRuntimeIdentity` exists — commit both now:

```bash
git add backend/internal/machineclient/selfregister.go backend/internal/machineclient/selfregister_test.go \
        backend/internal/handler/runtimeauth.go backend/internal/handler/runtimeauth_test.go \
        backend/cmd/server/main.go
git commit -m "feat(runtime): verify hub-signed handover tokens via ?t="
```

---

### Task 7: `/api/whoami` exposes `hubUrl` and `machineId`

**Files:**
- Modify: `backend/internal/handler/health.go`
- Modify: `backend/cmd/server/main.go`
- Modify: `frontend/src/store/types.ts`
- Test: `backend/internal/handler/health_test.go`

**Interfaces:**
- Produces: `Whoami{..., hubUrl?: string, machineId?: string}` on the wire — consumed by Task 9's routing decision and Task 10's frontend button.

- [ ] **Step 1: Write the failing test**

Append to `backend/internal/handler/health_test.go` (read the existing tests first — this task extends `NewWhoamiHandler`'s constructor, which earlier phases already changed twice, so confirm its exact current signature with `grep -n "func NewWhoamiHandler" backend/internal/handler/health.go` before writing this):

```go
func TestWhoamiReportsHubURLAndMachineIDOnARuntime(t *testing.T) {
	h := NewWhoamiHandler("runtime", "builder", nil, "https://hub.example.ts.net:8989", "m-abc")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/whoami", nil))

	var got map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got["hubUrl"] != "https://hub.example.ts.net:8989" {
		t.Errorf("hubUrl = %v, want the configured --hub-url", got["hubUrl"])
	}
	if got["machineId"] != "m-abc" {
		t.Errorf("machineId = %v, want m-abc", got["machineId"])
	}
}

func TestWhoamiOmitsHubURLAndMachineIDOnTheHub(t *testing.T) {
	h := NewWhoamiHandler("hub", "", nil, "", "")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/whoami", nil))

	var got map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if v, ok := got["hubUrl"]; ok && v != "" && v != nil {
		t.Errorf("hubUrl = %v on the hub, want empty/absent", v)
	}
}
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && go test ./internal/handler/ -run "TestWhoamiReportsHubURLAndMachineIDOnARuntime|TestWhoamiOmitsHubURLAndMachineIDOnTheHub"
```

Expected: FAIL — `too many arguments in call to NewWhoamiHandler`.

- [ ] **Step 3: Implement**

In `backend/internal/handler/health.go`, extend `WhoamiHandler` and its constructor (read the current file first — this must add to, not replace, the `lastSyncedAt` field Phase 2 already added):

```go
type WhoamiHandler struct {
	role        string
	machineName string
	store       port.Store
	hubURL      string // configured --hub-url; empty on the hub and on a runtime that never set it
	machineID   string // this runtime's own hub-assigned id, once self-registration succeeds; empty until then
}

// NewWhoamiHandler creates a whoami handler. hubURL and machineID are only
// ever non-empty on a --role runtime process (machineID may still be empty
// briefly, before self-registration first succeeds) — the frontend uses
// both to build the "Sign in via hub" redirect.
func NewWhoamiHandler(role, machineName string, s port.Store, hubURL, machineID string) *WhoamiHandler {
	return &WhoamiHandler{role: role, machineName: machineName, store: s, hubURL: hubURL, machineID: machineID}
}

func (h *WhoamiHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body := map[string]any{
		"status":       "ok",
		"role":         h.role,
		"machineName":  h.machineName,
		"lastSyncedAt": nil,
		"hubUrl":       h.hubURL,
		"machineId":    h.machineID,
	}
	if h.store != nil {
		if at, err := h.store.LastSyncedAt(); err == nil && at != nil {
			body["lastSyncedAt"] = at.UTC().Format(time.RFC3339)
		}
	}
	writeJSON(w, http.StatusOK, body)
}
```

- [ ] **Step 4: Wire the two new arguments in main.go**

Find `whoamiH := handler.NewWhoamiHandler(*role, *machineName, whoamiStore)` (~line 238) and change it to:

```go
	whoamiH := handler.NewWhoamiHandler(*role, *machineName, whoamiStore, *hubURL, "")
```

The machine ID starts as `""` because at this point in `main.go` self-registration hasn't run yet (it's launched later, in the goroutine Task 5 modified). This is a known, accepted gap — see Step 6.

- [ ] **Step 5: `machineId` needs to update once self-registration succeeds**

`WhoamiHandler` is constructed once at startup with `machineID=""`; Task 5's self-register goroutine learns the real id afterward. Make `machineID` mutable the same way Task 6 made the hub's pubkey mutable — add a setter:

```go
// SetMachineID updates the machine id this handler reports, once
// self-registration succeeds. Safe to call from a different goroutine than
// the one serving requests.
func (h *WhoamiHandler) SetMachineID(id string) {
	h.machineIDMu.Lock()
	h.machineID = id
	h.machineIDMu.Unlock()
}
```

This requires `machineID` to be guarded by a mutex rather than a plain field, since it's now written from the self-register goroutine and read from request-handling goroutines concurrently. Update the struct and `ServeHTTP`:

```go
type WhoamiHandler struct {
	role        string
	machineName string
	store       port.Store
	hubURL      string
	machineIDMu sync.RWMutex
	machineID   string
}
```

```go
func (h *WhoamiHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.machineIDMu.RLock()
	machineID := h.machineID
	h.machineIDMu.RUnlock()

	body := map[string]any{
		"status":       "ok",
		"role":         h.role,
		"machineName":  h.machineName,
		"lastSyncedAt": nil,
		"hubUrl":       h.hubURL,
		"machineId":    machineID,
	}
	if h.store != nil {
		if at, err := h.store.LastSyncedAt(); err == nil && at != nil {
			body["lastSyncedAt"] = at.UTC().Format(time.RFC3339)
		}
	}
	writeJSON(w, http.StatusOK, body)
}
```

Add `"sync"` to `health.go`'s imports.

In `main.go`, inside the self-register goroutine (right where Task 5 added the `handler.SetRuntimeIdentity(...)` call), add a sibling call:

```go
			if registered {
				whoamiH.SetMachineID(self.ID)
				if pub, err := base64.StdEncoding.DecodeString(self.SigningPublicKey); err == nil && len(pub) == ed25519.PublicKeySize {
					handler.SetRuntimeIdentity(self.ID, ed25519.PublicKey(pub))
				} else {
					log.Printf("self-register: hub did not return a usable signing public key; SSO handover tokens will fail verification until this runtime re-registers")
				}
			}
```

- [ ] **Step 6: Mirror the fields on the frontend type**

In `frontend/src/store/types.ts`, extend `Whoami`:

```ts
export interface Whoami {
  status: string
  role: 'hub' | 'runtime'
  machineName: string
  lastSyncedAt: string | null
  /** This runtime's configured --hub-url, empty on the hub. */
  hubUrl: string
  /** This runtime's own hub-assigned machine id, empty until self-registration first succeeds. */
  machineId: string
}
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
cd backend && go test ./internal/handler/ -run "TestWhoami" -v
cd backend && go build ./... && go test ./internal/... && go vet ./...
cd frontend && npm run typecheck
```

Expected: all `TestWhoami*` tests PASS; full suite green.

- [ ] **Step 8: Commit**

```bash
git add backend/internal/handler/health.go backend/internal/handler/health_test.go \
        backend/cmd/server/main.go frontend/src/store/types.ts
git commit -m "feat(runtime): expose hubUrl and machineId via whoami"
```

---

### Task 8: The hub-side `/handover` route

**Files:**
- Create: `frontend/src/routes/handover.tsx`
- Modify: `frontend/src/routes/login.tsx`
- Modify: `frontend/src/routes/__root.tsx` (add `/handover` to `PUBLIC_PATHS`)
- Modify: `frontend/src/features/data/queries.ts` (a mutation for `POST /api/machines/{id}/token`)

**Critical dependency found during planning:** `frontend/src/routes/__root.tsx` already runs a *global* auth guard in its own `beforeLoad`, applied to every route except a hardcoded `PUBLIC_PATHS` set (`/login`, `/register`, `/2fa-setup`, `/access-denied`):

```tsx
const PUBLIC_PATHS = new Set(['/login', '/register', '/2fa-setup', '/access-denied'])

export const Route = createRootRouteWithContext<RouterContext>()({
  beforeLoad: async ({ context, location }) => {
    if (PUBLIC_PATHS.has(location.pathname)) return
    try {
      await context.queryClient.ensureQueryData(meQueryOptions)
    } catch {
      throw redirect({ to: '/login' })
    }
  },
  ...
```

If `/handover` isn't added to `PUBLIC_PATHS`, this root guard intercepts an unauthenticated visit **before `/handover`'s own `beforeLoad` ever runs**, and redirects to `/login` with **no `next` param** — so after logging in, the operator lands on `/` and the whole handover is silently lost. `/handover`'s own `beforeLoad` (Step 3 below) is what does the *real* auth check with `next` preserved; it can only ever run once the root guard has been told to leave this path alone. Do not modify the root guard's general redirect behavior for every other route — this is scoped to adding one string to one set.

**Interfaces:**
- Consumes: `POST /api/machines/{id}/token` (Task 4).
- Produces: the `/handover` route, reached only via `?machine=<id>&return=<origin>` query params — used by Task 10's runtime-side button.

- [ ] **Step 1: Add the mutation**

In `frontend/src/features/data/queries.ts`, find where other mutations are defined (look at the existing pattern — e.g. `useLogin`) and add, following the same shape:

```ts
export function useMintHandoverToken() {
  return useMutation({
    mutationFn: (machineId: string) => request<{ token: string }>('POST', `/machines/${machineId}/token`),
  })
}
```

Check the file's existing imports for `useMutation` and `request` — both are already used elsewhere in this file.

- [ ] **Step 2: Add `?next=` support to the login route**

Read `frontend/src/routes/login.tsx` in full first — both `submitCredentials`'s `onSuccess` and `submitTotp`'s `onSuccess` currently call `navigate({ to: '/' })` unconditionally. Change both to honor an optional `next` search param:

```tsx
export const Route = createFileRoute('/login')({
  validateSearch: (search: Record<string, unknown>) => ({
    next: typeof search.next === 'string' ? search.next : undefined,
  }),
  component: LoginPage,
})

function LoginPage() {
  const navigate = useNavigate()
  const { next } = Route.useSearch()
  // ... existing hooks unchanged ...

  function goNext() {
    if (next) {
      window.location.href = next // may be a different route entirely (e.g. /handover?...); a full navigation keeps this simple and correct either way
    } else {
      navigate({ to: '/' })
    }
  }
```

Replace both `onSuccess: (data) => data.status === 'ok' ? navigate({ to: '/' }) : setStep('totp')` and `onSuccess: () => navigate({ to: '/' })` (in `submitTotp`) with calls to `goNext()` in place of the bare `navigate({ to: '/' })` — the `data.status === 'ok' ? ... : setStep('totp')` ternary in `submitCredentials` keeps its `setStep('totp')` branch unchanged, only its true-branch becomes `goNext()`.

- [ ] **Step 3: Create the handover route**

Create `frontend/src/routes/handover.tsx`:

```tsx
import { useEffect, useRef } from 'react'
import { createFileRoute, redirect } from '@tanstack/react-router'
import { useMintHandoverToken } from '@/features/data/queries'
import { DataLoading } from '@/features/screens/DataLoading'
import { DataError } from '@/features/screens/DataError'
import { meQueryOptions } from '@/features/data/authQueries'

/**
 * Reached only via a top-level navigation FROM a runtime's own sign-in page
 * (RuntimeSignIn.tsx's "Sign in via hub" button) — never linked to from
 * within this app's own UI. Mints a handover token for the requested
 * machine and sends the browser back to it.
 *
 * Why this can't be a same-page fetch from the runtime: the hub's session
 * cookie is SameSite=Strict, so it is never attached to a cross-origin
 * request, including a top-level navigation initiated from a different
 * origin. This route exists specifically to be the SAME-origin leg of that
 * handshake — it only ever runs with the hub's own cookie in play.
 */
export const Route = createFileRoute('/handover')({
  validateSearch: (search: Record<string, unknown>) => ({
    machine: typeof search.machine === 'string' ? search.machine : '',
    return: typeof search.return === 'string' ? search.return : '',
  }),
  beforeLoad: async ({ context, search, location }) => {
    if (!search.machine || !search.return) {
      throw redirect({ to: '/' })
    }
    try {
      // meQueryOptions is the app's own established auth-check query,
      // exported specifically so "the root route guard's ensureQueryData
      // and useMe() behave identically" (see its doc comment in
      // authQueries.ts) — reused here rather than a bespoke check.
      await context.queryClient.ensureQueryData(meQueryOptions)
    } catch {
      throw redirect({ to: '/login', search: { next: location.href } })
    }
  },
  component: HandoverPage,
})

function HandoverPage() {
  const { machine, return: returnUrl } = Route.useSearch()
  const mint = useMintHandoverToken()
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true
    mint.mutate(machine, {
      onSuccess: ({ token }) => {
        window.location.href = `${returnUrl}?t=${encodeURIComponent(token)}`
      },
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (mint.isError) {
    return (
      <div className="flex h-screen w-full flex-col bg-devdeck-bg text-devdeck-fg">
        <DataError error={mint.error} onRetry={() => mint.mutate(machine)} />
      </div>
    )
  }
  return (
    <div className="flex h-screen w-full flex-col bg-devdeck-bg text-devdeck-fg">
      <DataLoading label="signing you in…" />
    </div>
  )
}
```

- [ ] **Step 4: Exempt `/handover` from the root route guard**

In `frontend/src/routes/__root.tsx`, change:

```tsx
const PUBLIC_PATHS = new Set(['/login', '/register', '/2fa-setup', '/access-denied'])
```

to:

```tsx
const PUBLIC_PATHS = new Set(['/login', '/register', '/2fa-setup', '/access-denied', '/handover'])
```

Without this, the root guard's own `beforeLoad` runs first for every route, catches the unauthenticated case itself, and redirects straight to `/login` with **no `next` param** — silently losing the `machine`/`return` context before `/handover`'s own `beforeLoad` (Step 3) ever gets a chance to preserve it. This is a one-line change to one `Set` literal; do not touch the root guard's redirect logic itself, which every other route still needs unchanged.

- [ ] **Step 5: Typecheck**

```bash
cd frontend && npm run typecheck
```

Expected: no errors. This step cannot be meaningfully unit-tested without a running backend + browser (Task 11 covers that); a clean typecheck is the bar for this task.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/routes/handover.tsx frontend/src/routes/login.tsx frontend/src/routes/__root.tsx frontend/src/features/data/queries.ts
git commit -m "feat(hub): add the /handover route that mints and forwards a token"
```

---

### Task 9: Wire the runtime sign-in page into the router

**Critical gap found during planning:** `frontend/src/features/auth/RuntimeSignIn.tsx` already exists (Phase 1 built it) but **is never imported or rendered anywhere in the app** — verified with `grep -rn "RuntimeSignIn" frontend/src/`, which matches only its own definition. Today, an unauthenticated visit to a runtime hits `__root.tsx`'s global guard (`beforeLoad`, checked in Task 8), which unconditionally redirects to `/login` regardless of role — but `/login` posts to `/api/auth/login`, a route Phase 1 never mounted on a runtime at all. The operator would be stuck on a form that can never succeed, with no way to reach the key field. This is a pre-existing hole from an earlier phase, not something Phase 4 introduces, but Phase 4's whole deliverable (a button that lives on `RuntimeSignIn`) is meaningless until this is fixed — so it's fixed here, before Task 10 adds anything to that component.

There's a second, related problem: the natural fix — check `role` in the root guard and branch — doesn't work today, because **`/api/whoami` itself requires authentication on a runtime**. Confirmed live: a bare `curl http://runtime/api/whoami` with no credential returns `401 {"error":"unauthorized"}`, not a role. This is a chicken-and-egg problem: there is currently no way for an unauthenticated browser to learn "this is a runtime" at all. `whoami`'s payload (`status`, `role`, `machineName`, `lastSyncedAt`, `hubUrl`, `machineId`) contains nothing secret — `machineId` and `hubUrl` are already effectively public once any authenticated client can see them, and the others are plain operational metadata — so this task makes `/api/whoami` public on the runtime, exactly like `/api/health` already is.

**Files:**
- Modify: `backend/internal/handler/runtimeauth.go` (add `/api/whoami` to `publicPaths`)
- Create: `frontend/src/routes/runtime-sign-in.tsx`
- Modify: `frontend/src/routes/__root.tsx` (role-aware redirect on auth failure)
- Test: `backend/internal/handler/runtimeauth_test.go`

**Interfaces:**
- Consumes: `RuntimeSignIn` (exists, unmodified by this task — Task 10 edits its props), `Whoami` (Task 7).
- Produces: the `/runtime-sign-in` route, reachable for the first time — Task 10's edits to `RuntimeSignIn.tsx` render there.

- [ ] **Step 1: Write the failing backend test**

Append to `backend/internal/handler/runtimeauth_test.go`:

```go
func TestRequireRuntimeAuthAllowsWhoamiWithoutACredential(t *testing.T) {
	var hit bool
	mw := RequireRuntimeAuth(nil, "rt-key")
	req := httptest.NewRequest(http.MethodGet, "/api/whoami", nil)
	rec := httptest.NewRecorder()
	mw(okHandler(&hit)).ServeHTTP(rec, req)
	if !hit || rec.Code != http.StatusOK {
		t.Errorf("unauthenticated /api/whoami: code=%d hit=%v, want 200 — the frontend must be able to learn this process's role before any credential exists", rec.Code, hit)
	}
}
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && go test ./internal/handler/ -run TestRequireRuntimeAuthAllowsWhoamiWithoutACredential -v
```

Expected: FAIL — `code=401 hit=false`.

- [ ] **Step 3: Make `/api/whoami` public on the runtime**

In `backend/internal/handler/runtimeauth.go`, change:

```go
	publicPaths := map[string]bool{
		"/api/health":           true,
		"/api/auth/key-session": true,
	}
```

to:

```go
	publicPaths := map[string]bool{
		"/api/health":           true,
		"/api/auth/key-session": true,
		// The frontend must be able to tell "this is a runtime" apart from
		// "this is a hub" BEFORE any credential exists, to decide whether an
		// unauthenticated visitor should see the runtime sign-in page or the
		// hub's password/TOTP login — see __root.tsx's beforeLoad. Nothing in
		// this payload (role, machineName, hubUrl, machineId, lastSyncedAt)
		// is secret.
		"/api/whoami": true,
	}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd backend && go test ./internal/handler/ -run TestRequireRuntimeAuthAllowsWhoamiWithoutACredential -v
cd backend && go build ./... && go test ./internal/... && go vet ./...
```

Expected: PASS; full suite green (this only widens `RequireRuntimeAuth`'s allowlist — it cannot affect `RequireAuth`, the hub's separate middleware).

- [ ] **Step 5: Create the runtime sign-in route**

Create `frontend/src/routes/runtime-sign-in.tsx`:

```tsx
import { createFileRoute } from '@tanstack/react-router'
import { useWhoami } from '@/features/data/queries'
import { RuntimeSignIn } from '@/features/auth/RuntimeSignIn'

/**
 * The landing page for an unauthenticated visitor on a --role runtime
 * process — see __root.tsx's beforeLoad, which redirects here instead of
 * /login once it learns (via the now-public /api/whoami) that this process
 * is a runtime, not a hub.
 */
export const Route = createFileRoute('/runtime-sign-in')({
  component: RuntimeSignInPage,
})

function RuntimeSignInPage() {
  const whoami = useWhoami()
  return (
    <RuntimeSignIn
      machineName={whoami.data?.machineName ?? ''}
      hubUrl={whoami.data?.hubUrl ?? ''}
      machineId={whoami.data?.machineId ?? ''}
    />
  )
}
```

This passes `hubUrl`/`machineId` props that `RuntimeSignIn` doesn't accept yet — that's Task 10, landing next in the same sequence. This file alone will not typecheck in isolation; that's expected and resolved by Task 10 Step 3, not a defect in this step.

- [ ] **Step 6: Make the root guard role-aware**

Read `frontend/src/routes/__root.tsx` in full first — Task 8 already added `/handover` to `PUBLIC_PATHS`. Add `/runtime-sign-in` to that same set, and branch the failure path:

```tsx
import { createRootRouteWithContext, Outlet, redirect } from '@tanstack/react-router'
import type { QueryClient } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import { meQueryOptions } from '@/features/data/authQueries'
import { qk } from '@/features/data/keys'
import { fetchWhoami } from '@/lib/api'
import { useViewportHeight } from '@/features/useViewportHeight'

export interface RouterContext {
  queryClient: QueryClient
}

const PUBLIC_PATHS = new Set(['/login', '/register', '/2fa-setup', '/access-denied', '/handover', '/runtime-sign-in'])

export const Route = createRootRouteWithContext<RouterContext>()({
  beforeLoad: async ({ context, location }) => {
    if (PUBLIC_PATHS.has(location.pathname)) return
    try {
      await context.queryClient.ensureQueryData(meQueryOptions)
    } catch {
      const whoami = await context.queryClient
        .fetchQuery({ queryKey: qk.whoami, queryFn: fetchWhoami })
        .catch(() => null)
      if (whoami?.role === 'runtime') {
        throw redirect({ to: '/runtime-sign-in' })
      }
      throw redirect({ to: '/login' })
    }
  },
  component: RootComponent,
})
```

Keep `RootComponent` and everything below it unchanged. Confirm the exact names `qk.whoami` and `fetchWhoami` first (`grep -n "whoami" frontend/src/features/data/keys.ts frontend/src/lib/api.ts`) — they were introduced in an earlier phase's `useWhoami()` hook, so they already exist; use them exactly as found rather than re-deriving new ones.

The inner `.catch(() => null)` on the whoami fetch matters: if the runtime is somehow unreachable for this one call (a transient blip), the guard must not throw an unhandled error out of `beforeLoad` — it falls back to the hub's `/login`, which is always the safe default (a hub visitor never reaches this branch anyway, since `role` would be `'hub'`, and a runtime visitor who hits this rare failure just sees a login form that doesn't work for them, rather than an application crash).

- [ ] **Step 7: Typecheck**

```bash
cd frontend && npm run typecheck
```

Expected: no errors (this task's own files typecheck once Task 10 supplies the matching `RuntimeSignIn` props — see Step 5's note above; if executing tasks strictly in order, run this check again after Task 10 rather than treating a failure here as this task's fault).

- [ ] **Step 8: Commit**

```bash
git add backend/internal/handler/runtimeauth.go backend/internal/handler/runtimeauth_test.go \
        frontend/src/routes/runtime-sign-in.tsx frontend/src/routes/__root.tsx
git commit -m "fix(runtime): actually render the runtime sign-in page for unauthenticated visitors"
```

---

### Task 10: "Sign in via hub" on the runtime's sign-in page

**Files:**
- Modify: `frontend/src/features/auth/RuntimeSignIn.tsx`

**Interfaces:**
- Consumes: `Whoami.hubUrl`/`.machineId` (Task 7), the `/runtime-sign-in` route (Task 9) that now renders this component with those two props.

- [ ] **Step 1: Implement**

Replace `frontend/src/features/auth/RuntimeSignIn.tsx` in full:

```tsx
import { useState } from 'react'
import type { FormEvent } from 'react'
import { toast } from 'sonner'
import { ExternalLink, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { request } from '@/lib/api'

interface RuntimeSignInProps {
  machineName: string
  /** From useWhoami(); empty when this runtime has no --hub-url configured, or hasn't self-registered yet. */
  hubUrl: string
  machineId: string
}

/**
 * Sign-in for a runtime's own web UI. Two independent paths:
 *
 * - "Sign in via hub": a full top-level navigation to the hub's /handover
 *   route, which mints a short-lived token there and sends the browser
 *   back with ?t=<token> for RequireRuntimeAuth to verify. Only offered
 *   when hubUrl and machineId are both known (see Whoami) — if this
 *   runtime never registered with a hub, or hasn't yet, there is nothing
 *   to hand off to.
 * - The static key field: always available, and the only path that works
 *   when the hub itself is unreachable.
 */
export function RuntimeSignIn({ machineName, hubUrl, machineId }: RuntimeSignInProps) {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const canSSO = hubUrl !== '' && machineId !== ''

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!key.trim()) return
    setBusy(true)
    try {
      await request('POST', '/auth/key-session', undefined, {
        headers: { Authorization: `Bearer ${key.trim()}` },
      })
      window.location.reload()
    } catch {
      toast.error('That key was not accepted')
      setBusy(false)
    }
  }

  function signInViaHub() {
    const returnUrl = window.location.origin
    const url = `${hubUrl.replace(/\/+$/, '')}/handover?machine=${encodeURIComponent(machineId)}&return=${encodeURIComponent(returnUrl)}`
    window.location.href = url
  }

  return (
    <div className="flex h-screen w-full items-center justify-center bg-devdeck-bg text-devdeck-fg">
      <div className="w-[360px]">
        <h1 className="text-lg font-medium">{machineName || 'Runtime'}</h1>
        <p className="mt-1 mb-6 text-[12px] text-devdeck-muted">Sign in to this runtime.</p>

        {canSSO && (
          <>
            <Button type="button" variant="secondary" className="mb-4 w-full" onClick={signInViaHub}>
              <ExternalLink className="h-3.5 w-3.5" />
              Sign in via hub
            </Button>
            <div className="mb-4 flex items-center gap-2 text-[11px] text-devdeck-dim">
              <div className="h-px flex-1 bg-devdeck-dim-3" />
              or
              <div className="h-px flex-1 bg-devdeck-dim-3" />
            </div>
          </>
        )}

        <form onSubmit={submit}>
          <Label>Runtime key</Label>
          <Input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="Runtime key"
            autoFocus={!canSSO}
            className="mb-5"
          />
          <Button type="submit" disabled={busy || !key.trim()} className="w-full">
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Sign in
          </Button>
        </form>
      </div>
    </div>
  )
}
```

`Button`'s `variant="secondary"` ("hairline outline — the workhorse toolbar button", per its own doc comment in `button.tsx`) and the `--devdeck-dim-3` token (`globals.css:41`) are both confirmed real and used as-is above — no substitution needed.

Task 9's `frontend/src/routes/runtime-sign-in.tsx` already renders this component with exactly the `hubUrl`/`machineId` props this task adds — there is no separate call site to update; that render site is what Task 9 just built.

- [ ] **Step 2: Typecheck**

```bash
cd frontend && npm run typecheck
```

Expected: no errors — this is the point where Task 9's `runtime-sign-in.tsx` (written against a `RuntimeSignIn` prop shape that didn't exist yet) and this task's actual component definition finally agree.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/features/auth/RuntimeSignIn.tsx
git commit -m "feat(runtime): add the Sign in via hub option to the sign-in page"
```

---

### Task 11: End-to-end verification

No new code — this proves Tasks 1–10 work together against real processes and a real browser, the way Phases 1–3's plans did.

- [ ] **Step 1: Build and run the full automated suite**

```bash
cd backend && go build -o /tmp/devdeck-server-p4 ./cmd/server && go test ./... -count=1 && go vet ./...
cd ../frontend && npm run typecheck && npm run build
```

- [ ] **Step 2: Real hub + runtime, real browser, the full SSO round trip**

Use the `verify` skill's exact recipe (temp HOMEs, isolated ports, Playwright) — see `.claude/skills/verify/SKILL.md`. Concretely:

1. Start a hub (`--role hub --key hubkey --2fa=false`) and a runtime pointed at it (`--role runtime --key rtkey --hub-url ... --hub-key hubkey`). Wait for one self-register cycle.
2. Confirm `GET /api/whoami` on the runtime now reports a non-empty `machineId` and the configured `hubUrl`.
3. Confirm `GET /api/machines` on the hub returns a `signingPublicKey` matching what `openssl` or a throwaway Go snippet derives from the hub's persisted `signing.key` file.
4. With Playwright: log into the hub UI (password + `--2fa=false` skips TOTP), navigate to the runtime's own URL with no credential — confirm the sign-in page shows **both** the "Sign in via hub" button and the key field.
5. Click "Sign in via hub" — confirm the browser lands on the hub's `/handover` (already authenticated, so no login prompt), then is redirected to the runtime's origin with `?t=`, then lands on a **clean URL** (no `t=` in the address bar) showing the authenticated runtime UI.
6. Reload the runtime page — confirm the session persists (cookie survived) without hitting `/handover` again.
7. **Negative case:** manually craft a request to the runtime with `?t=<forged-or-expired-token>` and confirm it falls through to the sign-in page rather than granting access or throwing a 500.
8. **Hub-down fallback:** kill the hub, reload the runtime's sign-in page — confirm "Sign in via hub" no longer renders (or renders and fails gracefully) and the key field still works.

Report pass/fail for each of the 8 sub-steps with real command/screenshot evidence — do not mark this task done from reasoning alone.

- [ ] **Step 3: Clean up**

Kill every spawned process, remove temp databases/binaries/logs, confirm `git status` shows nothing but this plan's own tracked changes.

## Definition of done for Phase 4

- [ ] `go test ./...` passes, `go vet ./...` silent, `npm run typecheck` and `npm run build` succeed
- [ ] An unauthenticated visit to a runtime actually lands on the runtime sign-in page (not the hub's password/TOTP login) — this was silently broken before Task 9 and is the precondition for everything else in this list
- [ ] A runtime's `/api/whoami` reports `hubUrl` and `machineId` once self-registration succeeds
- [ ] `GET /api/machines` (and POST/PATCH) on the hub always includes a `signingPublicKey`
- [ ] `POST /api/machines/{id}/token` mints a token verifiable with that same public key, scoped to that exact machine, expired outside a ~90s window
- [ ] A runtime's sign-in page offers "Sign in via hub" only when it knows both `hubUrl` and `machineId`; clicking it round-trips through the hub's `/handover` route and lands the browser back on the runtime, authenticated, on a clean URL
- [ ] A token minted for machine A is rejected by machine B
- [ ] The existing bearer-key and `?key=` paths (`machineClient.ts`) are provably unchanged
- [ ] The hub's own session cookie is still `SameSite=Strict`; only the runtime's is `Lax`
- [ ] With the hub down, the runtime's key-based sign-in still works exactly as it did before this phase

## Out of scope (later phases)

Phase 5 (SSH secrets + `host_key_fingerprint` move to the runtime), Phase 6 (route cleanup, UI role gating). Signing-key *rotation* on the hub is explicitly not handled — a running runtime process only learns the hub's public key once, at its own registration time, and does not re-fetch it periodically; this matches the spec's scope and is not a regression introduced here.
