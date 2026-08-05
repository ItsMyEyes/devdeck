# Published SOCKS5 Proxy

**Date:** 2026-08-06
**Status:** design approved, pending implementation plan

## Problem

DevDeck already contains a working, authenticated SOCKS5 server
(`backend/internal/netproxy/socks5.go`), but there is no way for an operator to
turn it on. It binds only when `--socks5-addr` is passed at process start
(`proxy.socks5_addr` in `devdeck.yaml`, `DEVDECK_SOCKS5_ADDR` in the
environment), which means:

- Enabling or disabling it costs a full server restart.
- It is invisible from the UI — nothing tells you whether a machine is
  publishing a proxy, on what port, or with what credential.
- It is per-process configuration, so pointing an external tool at a *specific*
  runtime's network means editing that machine's config file and restarting it,
  by hand, over SSH.

The one code path that does start a proxy on demand,
`service.ProxyService`, cannot be reused for this. It binds ephemeral ports
(`:0`), dies with the process, and is unauthenticated by necessity: it exists so
a Tauri webview's `proxy_url` can dial out, and neither macOS
(`nw_proxy_config_create_socksv5`) nor Windows (WebView2 `--proxy-server`) proxy
plumbing carries credentials — the URL's userinfo is dropped before it reaches
the OS. See the comment at `backend/internal/service/proxy.go:44-53`.

## Goal

Any registered machine — the hub, or any runtime — can publish a persistent,
key-authenticated SOCKS5 proxy that other tools reuse: a browser, `curl`, `k9s`,
anything that speaks SOCKS5. Toggling it takes effect immediately, with no
restart, from a Settings section that lists every machine with its own toggle,
port, and copy-ready connection string.

## Non-goals

- **The `--socks5-addr` / `--http-proxy-addr` / `--proxy-key` boot flags are
  unchanged.** Headless deployments that configure a proxy through
  `devdeck.yaml` keep working exactly as they do today, on the existing
  `startForwardProxies` path. This spec adds a second, independent activation
  route; it does not replace or refactor the first.
- **`service.ProxyService` is untouched.** The ephemeral desktop-webview proxy
  pair keeps its current lifecycle, bind, and no-auth model. The two services
  coexist without interacting.
- **No publish toggle for the HTTP forward proxy.** Only SOCKS5.
- No proxy chaining, no per-client ACLs, no traffic accounting.

## Architecture

The listener lives on the machine that serves the traffic. All state and
lifecycle are machine-local; the hub only reads and commands it over the machine
transport that already exists. Three pieces:

### 1. `service.PublishedSOCKSService` (new, machine-local)

Owns one long-lived, authenticated SOCKS5 listener.

```go
type PublishedSOCKSStatus struct {
    Enabled   bool   `json:"enabled"`
    Port      int    `json:"port"`
    Running   bool   `json:"running"`
    BoundAddr string `json:"boundAddr"`
    URL       string `json:"url"`
    Key       string `json:"key"`
}

// PublishedSOCKSStore is the narrow slice of port.Store this service needs,
// following the sshmgr.ConnStore precedent rather than taking the whole
// interface.
type PublishedSOCKSStore interface {
    PublishedSOCKS() (domain.PublishedSOCKSConfig, error)
    SetPublishedSOCKS(cfg domain.PublishedSOCKSConfig) error
}

func NewPublishedSOCKSService(store PublishedSOCKSStore, advertiseHost string) *PublishedSOCKSService
func (s *PublishedSOCKSService) Status() (PublishedSOCKSStatus, error)
func (s *PublishedSOCKSService) Apply(enabled bool, port int, rotateKey bool) (PublishedSOCKSStatus, error)
func (s *PublishedSOCKSService) StartIfEnabled() error   // boot path
func (s *PublishedSOCKSService) Stop() error
```

Guarded by a mutex, exactly like `ProxyService`. `Apply` is the single mutation
point: it resolves the desired state, stops the current listener if the port or
key changed, binds the new one, and persists — in that order, so a failed bind
never leaves the DB claiming a listener exists.

It serves via the existing `netproxy.NewSOCKS5Server(key).Serve(ln)`. No changes
to `internal/netproxy` are required: `SOCKS5Server` already implements RFC 1929
username/password negotiation against a single `authKey` (any username is
accepted), which is precisely the credential model this needs.

`advertiseHost` comes from `advertiseURL.Hostname()`, the same source
`ProxyService` uses, for the same reason: the listener binds all interfaces, but
the *advertised* address must be the machine's tailnet-reachable hostname, since
whoever dials this proxy is usually on a different machine.

### 2. Persistence — the `settings` singleton

Three columns added to the existing per-machine `settings` row (every process,
hub or runtime, has its own store and its own singleton):

| Column | Type | Meaning |
|---|---|---|
| `socks_publish_enabled` | `INTEGER NOT NULL DEFAULT 0` | operator intent, not liveness |
| `socks_publish_port` | `INTEGER NOT NULL DEFAULT 1080` | fixed listen port |
| `socks_publish_key` | `TEXT NOT NULL DEFAULT ''` | the SOCKS5 password |

Two methods on `port.Store`, following the shape `SignInPINHash` /
`SetSignInPINHash` already established for settings-row fields that must not
ride along in `domain.Settings`:

```go
PublishedSOCKS() (domain.PublishedSOCKSConfig, error)
SetPublishedSOCKS(cfg domain.PublishedSOCKSConfig) error
```

These stay off `domain.Settings` so the key can never leak through
`GET /api/settings`. It is served only from the authenticated
`/api/proxy/publish` routes below.

On boot, `StartIfEnabled()` runs before `http.Serve`, so a published proxy
survives a restart. A bind failure there logs and leaves the listener down — it
must never be fatal, unlike `startForwardProxies`, because that path's config is
operator-typed at launch whereas this one is replayed automatically.

### 3. Transport — no new hub route

The frontend already reaches any machine direct-first-then-hub-proxy through
`machineRequest` / `/api/machines/{id}/proxy/{rest...}`. Two routes registered on
**every** role — deliberately not `!isRuntime`-gated, since a runtime publishing
a proxy is the primary use case — are sufficient:

```
GET /api/proxy/publish  → PublishedSOCKSStatus
PUT /api/proxy/publish  ← {enabled: bool, port?: int, rotateKey?: bool}
                        → PublishedSOCKSStatus
```

`URL` is the copy-ready `socks5://devdeck:<key>@<advertiseHost>:<port>`, empty
when not running.

## Data flow

```
Settings UI toggle
  → machineApi.setPublishedSocks(machine, {enabled, port, rotateKey})
  → PUT /api/proxy/publish            (direct, or via hub machine-proxy)
  → PublishedSOCKSService.Apply()     bind/close, then persist
  → PublishedSOCKSStatus
  → queryClient.invalidateQueries()   card re-renders with live state
```

## Key handling

The key is auto-generated on first enable by `setupui.GenerateKey()` — the same
32-byte `crypto/rand` hex generator that already mints a machine's API key. It is
**mandatory and non-empty**: `Apply` refuses to bind with an empty key and returns an error, so
there is no reachable path to an unauthenticated published listener. This is the
deliberate difference from `ProxyService`, whose no-auth model is forced by OS
webview constraints that do not apply here.

`rotateKey: true` generates a fresh key and restarts the listener. The UI masks
the key until revealed, matching the hub-key treatment already in
`DesktopSettingsDialog`'s Access section.

## Reachability

The listener binds all interfaces (`:port`). The machine is already
tailnet-scoped the same way every other DevDeck runtime endpoint is — `Machine.URL`
and `Machine.Key` follow this exact model. Combined with the mandatory key, the
published proxy is no more exposed than the runtime API that sits beside it.

## Error handling

All REST errors use the mandatory `{"error":"message"}` envelope.

| Condition | Behaviour |
|---|---|
| Port already in use | Listener stays down, `enabled` persists `false`, `400` with `port 1080 already in use`. **Never `log.Fatalf`** — an operator toggling a proxy must not be able to kill the server. |
| Port out of range | `400`, rejected before any bind is attempted. |
| Empty key on enable | Impossible via the API (auto-generated); a corrupted stored value is treated as "rotate" rather than binding open. |
| Boot-time bind failure | Logged, listener down, server continues. |
| Machine unreachable from Settings | Card renders its error state; other machines' cards are unaffected. |

## Frontend

- **`lib/machineApi.ts`** — `fetchPublishedSocks(machine)`,
  `setPublishedSocks(machine, cfg)`, following the existing `startProxy` shape.
- **`features/data/queries.ts`** — `usePublishedSocks(machine)` and a
  `useSetPublishedSocks()` mutation that invalidates on success and toasts +
  invalidates on failure, per the standing mutation convention.
- **`features/overlays/DesktopSettingsDialog.tsx`** — the existing `network`
  section gains a SOCKS5 Proxy card below the Tailscale panel. It lists every
  machine from `useMachines()`, each row carrying: status dot + bound address,
  an on/off `Switch.Root`, an editable port, a masked key with reveal/rotate,
  and a copy button for the `socks5://` URL. Loading, error, and empty
  (no machines registered) states are all rendered explicitly.

The section is extracted into its own file — `features/overlays/SocksPublishSection.tsx`
— rather than inlined. `DesktopSettingsDialog.tsx` is already 416 lines and this
card carries real per-machine state; growing the dialog file further would make
it the kind of do-too-much file that is hard to edit reliably.

## Testing

**Go**

- `PublishedSOCKSService`: enable binds and accepts a SOCKS5 CONNECT with the
  right password; disable closes the listener and the port refuses; re-applying
  the same config is idempotent; a wrong password is rejected; `Apply` errors on
  an empty key; a port conflict returns an error and does not panic or exit.
- Store: `PublishedSOCKS` / `SetPublishedSOCKS` round-trip, defaults on a fresh DB.
- Handler: `GET`/`PUT` shapes, auth required, `{"error":...}` envelope on the
  conflict path.

**Frontend**

- Settings section renders loading, error, and empty states.
- Toggle fires the mutation with the expected payload.
- Key is masked until revealed; copy writes the full `socks5://` URL.

## Build order

1. Store columns + `port.Store` methods + migration.
2. `PublishedSOCKSService` + tests.
3. Handler routes + `main.go` wiring (boot start, route registration on all roles).
4. `machineApi` + queries.
5. `SocksPublishSection` + Settings wiring.

## Related work

This is the first of three independent features requested together. The other
two get their own specs and are built after this one:

2. **Host metrics charts** — CPU / disk / memory statistics for runtime machines
   *and* SSH hosts.
3. **SSH port forwarding** — `-L` / `-R` / `-D`, already outlined as build-order
   phase 3 of `docs/superpowers/specs/2026-07-14-ssh-management-design.md`.

Note for feature 3: SSH dynamic forwarding (`-D`) also publishes a SOCKS5
listener, but tunnels through an `ssh.Client` rather than dialing directly. It
should reuse `internal/netproxy`'s SOCKS5 protocol codec, not
`PublishedSOCKSService`, whose whole job is the direct-dial lifecycle this spec
defines.
