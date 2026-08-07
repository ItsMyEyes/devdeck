/** Mirrors backend/internal/agentcore/orchestration.Event. `threadKey` on the
 *  frontend IS `threadId` on the backend — one name per side, no mapping. */
export interface AgentEvent {
  seq: number
  eventId: string
  type: string
  threadId: string
  commandId: string
  createdAt: number
  payload?: unknown
}

export type ChatItemKind = 'user' | 'assistant' | 'reasoning' | 'tool' | 'error'

export interface ChatItem {
  id: string
  kind: ChatItemKind
  text: string
  /** Tool rows only; read-only in this spec — Allow/Deny arrives with approvals. */
  toolName?: string
  status?: 'running' | 'done' | 'failed'
  /** Highest delta sequence folded into this item, per stream. */
  lastSequence: number
}

export interface AgentThreadView {
  items: ChatItem[]
  status: 'idle' | 'running' | 'waiting' | 'stopped'
  /** Highest Seq applied. Sent as `sinceSeq` when reconnecting. */
  lastSeq: number
  /** True when a delta arrived with a sequence gap — the UI shows a subtle
   *  marker rather than pretending the text is complete. */
  hasGap: boolean
  error: string | null
}
