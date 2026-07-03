export type ClientMessage =
  | { type: 'start'; cwd: string }
  | { type: 'attach'; sessionId: string }
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number };

export type ServerControlMessage =
  | { type: 'started'; sessionId: string }
  | { type: 'not_found' }
  | { type: 'error'; message: string }
  | { type: 'exit'; code: number };
