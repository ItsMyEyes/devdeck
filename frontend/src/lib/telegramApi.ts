// Typed client for one process's Telegram bridge — config, pairing,
// allowlist, and thread bindings. Each DevDeck process runs its own
// Telegram bot with its own token (Telegram's getUpdates is exclusive per
// token, so two processes cannot share one), so this settings surface is
// per-process exactly like published SOCKS5, and carries the same two
// addressing branches: same-origin for the process serving this page
// (api.ts's fetchLocalPublishedSocks) and machineRequest for a registered
// runtime (machineApi.ts's fetchPublishedSocks). See `TelegramTarget` below
// for why the first branch is mandatory rather than a shortcut, and
// docs/superpowers/plans/2026-08-18-telegram-remote-chat.md §0.1/§0.6 for
// the one-bot-per-process rule underneath all of it.
//
// The React Query hooks below are co-located with the raw fetch wrappers
// (rather than living in `src/features/data/queries.ts`, where every other
// hook in the app lives) because Task 7's file list scopes this feature to
// files it alone owns; `queries.ts` is a convergence file shared with other
// concurrent work. Consumers (`TelegramSection.tsx`,
// `TelegramPublishButton.tsx`) import the hooks from here instead.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { request } from '@/lib/api'
import { machineRequest } from '@/lib/machineClient'
import type { Machine, TelegramBinding, TelegramConfig, TelegramUser } from '@/store/types'

export interface PutTelegramConfigBody {
  enabled: boolean
  /** Empty string means "keep the stored token" — the backend never
   *  overwrites a real token with a blank one (see Task 6's
   *  `PUT /api/telegram/config`). */
  token: string
}

export interface TelegramPairingCode {
  code: string
  expiresAt: string
}

export interface PutTelegramBindingBody {
  chatId: number
  topicId?: number
}

/**
 * Which process's bridge a call is aimed at: a registered runtime, or `null`
 * for the process serving this page.
 *
 * `null` is not a convenience — it is the only way to reach a `--role hub`.
 * The machine registry holds *remote* runtimes only (a hub never
 * self-registers; see `fetchLocalPublishedSocks`'s comment in `api.ts`), so
 * the hub has no `Machine` record to address, and the hub is exactly the
 * process that owns the `ssh:*` threads this feature was built for. Same
 * split, and the same reason, as published SOCKS5's
 * `fetchLocalPublishedSocks` / `fetchPublishedSocks` pair.
 */
export type TelegramTarget = Machine | null

/** One seam for both branches: same-origin `request` for this process,
 *  `machineRequest`'s direct-or-proxy resolution for a registered runtime.
 *  The path is identical either way — the routes are registered on every
 *  role (`main.go`, outside any `if !isRuntime`). */
function telegramRequest<T>(
  target: TelegramTarget,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  return target === null ? request<T>(method, path, body) : machineRequest<T>(target, method, path, body)
}

// ---- Raw fetch wrappers — one per Task 6 route. ----

export function getTelegramConfig(target: TelegramTarget): Promise<TelegramConfig> {
  return telegramRequest<TelegramConfig>(target, 'GET', '/telegram/config')
}

export function putTelegramConfig(target: TelegramTarget, body: PutTelegramConfigBody): Promise<TelegramConfig> {
  return telegramRequest<TelegramConfig>(target, 'PUT', '/telegram/config', body)
}

export function createPairingCode(target: TelegramTarget): Promise<TelegramPairingCode> {
  return telegramRequest<TelegramPairingCode>(target, 'POST', '/telegram/pair')
}

export function listTelegramUsers(target: TelegramTarget): Promise<TelegramUser[]> {
  return telegramRequest<TelegramUser[]>(target, 'GET', '/telegram/users')
}

export function deleteTelegramUser(target: TelegramTarget, userId: number): Promise<void> {
  return telegramRequest<void>(target, 'DELETE', `/telegram/users/${userId}`)
}

export function listTelegramBindings(target: TelegramTarget): Promise<TelegramBinding[]> {
  return telegramRequest<TelegramBinding[]>(target, 'GET', '/telegram/bindings')
}

export function putTelegramBinding(
  target: TelegramTarget,
  threadId: string,
  body: PutTelegramBindingBody,
): Promise<TelegramBinding> {
  return telegramRequest<TelegramBinding>(target, 'PUT', `/telegram/bindings/${encodeURIComponent(threadId)}`, body)
}

export function deleteTelegramBinding(target: TelegramTarget, threadId: string): Promise<void> {
  return telegramRequest<void>(target, 'DELETE', `/telegram/bindings/${encodeURIComponent(threadId)}`)
}

// ---- Query keys ----

/** Cache identity for one target. Prefixed rather than bare, so the local
 *  process and a registered machine can never land on the same key however
 *  a machine id is generated — including the empty id carried by the
 *  `HUB_MACHINE` placeholder (`SSHAgentChatPanel.tsx`). */
export function telegramTargetKey(target: TelegramTarget): string {
  return target === null ? 'self' : `machine:${target.id}`
}

const telegramKeys = {
  config: (target: TelegramTarget) => ['telegram', 'config', telegramTargetKey(target)] as const,
  users: (target: TelegramTarget) => ['telegram', 'users', telegramTargetKey(target)] as const,
  bindings: (target: TelegramTarget) => ['telegram', 'bindings', telegramTargetKey(target)] as const,
}

// ---- Hooks ----

export function useTelegramConfig(target: TelegramTarget, enabled: boolean) {
  return useQuery({
    queryKey: telegramKeys.config(target),
    queryFn: () => getTelegramConfig(target),
    enabled,
    staleTime: 5_000,
  })
}

export function useSetTelegramConfig(target: TelegramTarget) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: PutTelegramConfigBody) => putTelegramConfig(target, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: telegramKeys.config(target) }),
  })
}

export function useCreatePairingCode(target: TelegramTarget) {
  return useMutation({
    mutationFn: () => createPairingCode(target),
  })
}

/**
 * `refetchIntervalMs` exists because enrolment does not happen in this app:
 * the operator types `/pair <code>` into Telegram, and the allowlist row is
 * written by the bridge, on the other side of a network the browser is not
 * watching. No mutation here can invalidate that, so while a code is live the
 * caller polls — otherwise the panel keeps saying "No paired users yet" after
 * a pairing that in fact succeeded. Omit it (the default) for no polling.
 */
export function useTelegramUsers(target: TelegramTarget, enabled: boolean, refetchIntervalMs?: number) {
  return useQuery({
    queryKey: telegramKeys.users(target),
    queryFn: () => listTelegramUsers(target),
    enabled,
    staleTime: 5_000,
    refetchInterval: refetchIntervalMs ?? false,
  })
}

export function useDeleteTelegramUser(target: TelegramTarget) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (userId: number) => deleteTelegramUser(target, userId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: telegramKeys.users(target) }),
  })
}

/**
 * `refetchIntervalMs` mirrors `useTelegramUsers`'s pattern for the same
 * reason: a binding is written by the bridge from the Telegram side (see
 * `/init <threadId>`, docs/superpowers/plans/2026-08-18-telegram-remote-chat.md
 * §2a), not by a mutation this app can invalidate on. While
 * `TelegramPublishButton`'s dialog is open and this thread is not yet bound,
 * the caller polls so the confirmed state appears without a manual refresh.
 * Omit it (the default) for no polling.
 */
export function useTelegramBindings(target: TelegramTarget, enabled: boolean, refetchIntervalMs?: number) {
  return useQuery({
    queryKey: telegramKeys.bindings(target),
    queryFn: () => listTelegramBindings(target),
    enabled,
    staleTime: 5_000,
    refetchInterval: refetchIntervalMs ?? false,
  })
}

export function useSetTelegramBinding(target: TelegramTarget) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ threadId, body }: { threadId: string; body: PutTelegramBindingBody }) =>
      putTelegramBinding(target, threadId, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: telegramKeys.bindings(target) }),
  })
}

export function useDeleteTelegramBinding(target: TelegramTarget) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (threadId: string) => deleteTelegramBinding(target, threadId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: telegramKeys.bindings(target) }),
  })
}
