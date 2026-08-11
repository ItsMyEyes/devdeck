/// <reference types="vite/client" />

/** Augments vite/client's own ImportMetaEnv — `import.meta.env.VITE_*` is
 *  otherwise only reachable through its `[key: string]: any` index signature. */
interface ImportMetaEnv {
  /** Build-time gate for the agent-chat feature — see
   *  `@/features/agent-chat/enabled`. '1'/'on' forces it visible, '0'/'off'
   *  forces it hidden; unset means "hidden in production builds only". */
  readonly VITE_AGENT_CHAT?: string
}
