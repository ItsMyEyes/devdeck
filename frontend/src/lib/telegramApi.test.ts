/**
 * The REST contract in Task 6's route table
 * (docs/superpowers/plans/2026-08-18-telegram-remote-chat.md) pinned from the
 * client side.
 *
 * `TelegramSection.test.tsx` and `TelegramPublishButton.test.tsx` both mock
 * `@/lib/telegramApi` wholesale, so between them they cover every component
 * behaviour and *nothing at all* about the wire: a wrong verb, a typo'd path,
 * or a renamed body field would leave both suites green and the feature dead.
 * This file is the other half — it mocks one layer lower (`machineRequest`,
 * the seam every per-machine call goes through, see `machineClient.ts`) and
 * asserts what actually gets sent.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Machine } from '@/store/types'

const machineRequest = vi.fn()
const request = vi.fn()

vi.mock('@/lib/machineClient', () => ({
  machineRequest: (...args: unknown[]) => machineRequest(...args),
}))

// The other half of the target split: `null` means the process serving this
// page, which is reached same-origin through `api.ts`'s `request` because it
// usually has no Machine record to address (a --role hub never
// self-registers). See `TelegramTarget`.
vi.mock('@/lib/api', () => ({
  request: (...args: unknown[]) => request(...args),
}))

const api = await import('@/lib/telegramApi')

const machine: Machine = {
  id: 'm1',
  name: 'prod-runtime',
  url: 'http://runtime:9199',
  key: 'k',
  isLocal: false,
  signingPublicKey: '',
}

afterEach(() => {
  vi.clearAllMocks()
})

/** `[method, path, body]` of the single per-machine call the wrapper made. */
function sent(): [string, string, unknown] {
  expect(machineRequest).toHaveBeenCalledTimes(1)
  expect(request).not.toHaveBeenCalled()
  const [, method, path, body] = machineRequest.mock.calls[0] as [Machine, string, string, unknown]
  return [method, path, body]
}

/** `[method, path, body]` of the single same-origin call the wrapper made. */
function sentLocal(): [string, string, unknown] {
  expect(request).toHaveBeenCalledTimes(1)
  // The whole point of the null branch: it must NOT go through
  // machineRequest, which has no machine to resolve and would send an empty
  // bearer key at a hub that authenticates by session cookie.
  expect(machineRequest).not.toHaveBeenCalled()
  return request.mock.calls[0] as [string, string, unknown]
}

describe('telegramApi wire contract', () => {
  it('addresses every call at the machine it was given', async () => {
    machineRequest.mockResolvedValue({})
    await api.getTelegramConfig(machine)
    expect(machineRequest.mock.calls[0][0]).toBe(machine)
  })

  it('GETs /telegram/config', async () => {
    machineRequest.mockResolvedValue({ enabled: true, hasToken: true, botUsername: 'devdeck_bot' })
    await api.getTelegramConfig(machine)
    expect(sent()).toEqual(['GET', '/telegram/config', undefined])
  })

  it('PUTs /telegram/config with { enabled, token }', async () => {
    machineRequest.mockResolvedValue({})
    await api.putTelegramConfig(machine, { enabled: true, token: '123456:AAH' })
    expect(sent()).toEqual(['PUT', '/telegram/config', { enabled: true, token: '123456:AAH' }])
  })

  it('sends an empty token verbatim — the backend reads "" as "keep the stored one"', async () => {
    machineRequest.mockResolvedValue({})
    await api.putTelegramConfig(machine, { enabled: false, token: '' })
    const [, , body] = sent()
    // Not dropped, not omitted: the key has to be present and empty. An
    // absent `token` decodes to "" server-side too, but relying on that would
    // make the contract depend on Go's zero value rather than on this body.
    expect(body).toEqual({ enabled: false, token: '' })
  })

  it('POSTs /telegram/pair', async () => {
    machineRequest.mockResolvedValue({ code: '482913', expiresAt: '2026-08-18T10:00:00Z' })
    const result = await api.createPairingCode(machine)
    expect(sent()).toEqual(['POST', '/telegram/pair', undefined])
    expect(result.code).toBe('482913')
  })

  it('GETs /telegram/users', async () => {
    machineRequest.mockResolvedValue([])
    await api.listTelegramUsers(machine)
    expect(sent()).toEqual(['GET', '/telegram/users', undefined])
  })

  it('DELETEs /telegram/users/{userId}', async () => {
    machineRequest.mockResolvedValue(undefined)
    await api.deleteTelegramUser(machine, 587442310)
    expect(sent()).toEqual(['DELETE', '/telegram/users/587442310', undefined])
  })

  it('GETs /telegram/bindings', async () => {
    machineRequest.mockResolvedValue([])
    await api.listTelegramBindings(machine)
    expect(sent()).toEqual(['GET', '/telegram/bindings', undefined])
  })

  it('PUTs /telegram/bindings/{threadId} with { chatId, topicId }', async () => {
    machineRequest.mockResolvedValue({})
    await api.putTelegramBinding(machine, 'w-9f3c', { chatId: 587442310 })
    expect(sent()).toEqual(['PUT', '/telegram/bindings/w-9f3c', { chatId: 587442310 }])
  })

  // Thread ids are `ssh:<connectionId>` and `<id>::chat-N` (design spec §3.1 /
  // paneTree.ts). Unescaped, those colons land in the URL raw and Go's
  // ServeMux hands the handler a different string than the one bound.
  it('percent-encodes a thread id into the binding path', async () => {
    machineRequest.mockResolvedValue({})
    await api.putTelegramBinding(machine, 'ssh:c-a1b2::chat-2', { chatId: -100234, topicId: 17 })
    expect(sent()).toEqual([
      'PUT',
      '/telegram/bindings/ssh%3Ac-a1b2%3A%3Achat-2',
      { chatId: -100234, topicId: 17 },
    ])
  })

  it('DELETEs /telegram/bindings/{threadId}, encoded the same way', async () => {
    machineRequest.mockResolvedValue(undefined)
    await api.deleteTelegramBinding(machine, 'ssh:c-a1b2')
    expect(sent()).toEqual(['DELETE', '/telegram/bindings/ssh%3Ac-a1b2', undefined])
  })
})

// A `--role hub` never self-registers, so the process serving this page has
// no Machine record — and on a hub that is precisely the process holding the
// `ssh:*` threads. Every route therefore has to be reachable with no machine
// at all, or the feature's primary use case has no client.
describe('telegramApi same-origin target (machine === null)', () => {
  it('GETs /telegram/config on the current origin', async () => {
    request.mockResolvedValue({ enabled: false, hasToken: false, botUsername: '' })
    await api.getTelegramConfig(null)
    expect(sentLocal()).toEqual(['GET', '/telegram/config', undefined])
  })

  it('PUTs /telegram/config on the current origin', async () => {
    request.mockResolvedValue({})
    await api.putTelegramConfig(null, { enabled: true, token: '' })
    expect(sentLocal()).toEqual(['PUT', '/telegram/config', { enabled: true, token: '' }])
  })

  it('POSTs /telegram/pair on the current origin', async () => {
    request.mockResolvedValue({ code: '482913', expiresAt: '2026-08-18T10:00:00Z' })
    await api.createPairingCode(null)
    expect(sentLocal()).toEqual(['POST', '/telegram/pair', undefined])
  })

  it('GETs and DELETEs allowlist users on the current origin', async () => {
    request.mockResolvedValue([])
    await api.listTelegramUsers(null)
    expect(sentLocal()).toEqual(['GET', '/telegram/users', undefined])

    request.mockClear()
    request.mockResolvedValue(undefined)
    await api.deleteTelegramUser(null, 587442310)
    expect(sentLocal()).toEqual(['DELETE', '/telegram/users/587442310', undefined])
  })

  it('lists, publishes and unpublishes bindings on the current origin', async () => {
    request.mockResolvedValue([])
    await api.listTelegramBindings(null)
    expect(sentLocal()).toEqual(['GET', '/telegram/bindings', undefined])

    request.mockClear()
    request.mockResolvedValue({})
    await api.putTelegramBinding(null, 'ssh:c-a1b2', { chatId: -100234, topicId: 17 })
    expect(sentLocal()).toEqual(['PUT', '/telegram/bindings/ssh%3Ac-a1b2', { chatId: -100234, topicId: 17 }])

    request.mockClear()
    request.mockResolvedValue(undefined)
    await api.deleteTelegramBinding(null, 'ssh:c-a1b2')
    expect(sentLocal()).toEqual(['DELETE', '/telegram/bindings/ssh%3Ac-a1b2', undefined])
  })

  it('keys the local cache apart from every machine cache', () => {
    // Two targets sharing a key would cross-contaminate: the hub's bindings
    // rendered as a runtime's, and an invalidation on one silently refetching
    // the other. The empty id is the real hazard — `HUB_MACHINE`
    // (`SSHAgentChatPanel.tsx`) is a Machine whose id is `''`.
    const empty: Machine = { ...machine, id: '' }
    expect(api.telegramTargetKey(null)).not.toBe(api.telegramTargetKey(machine))
    expect(api.telegramTargetKey(null)).not.toBe(api.telegramTargetKey(empty))
    expect(api.telegramTargetKey(machine)).not.toBe(api.telegramTargetKey(empty))
  })
})
