/**
 * Build-time gate for the agent-chat (chat thread) feature.
 *
 * The feature is still in flight, so shipped builds hide it: `vite build`
 * sets `import.meta.env.PROD`, which turns the gate off. `npm run dev` and
 * Vitest both run non-production, so local development and the whole
 * existing agent-chat test suite keep seeing the feature exactly as before.
 *
 * `VITE_AGENT_CHAT` overrides the default in either direction and is read at
 * build time, so `VITE_AGENT_CHAT=1 npm run build` publishes a build with
 * chat visible without touching any code. When the feature is ready to ship,
 * delete this module and its three call sites (`ShellSidebar.tsx`'s Sessions
 * tab, and `ExpandedTerminal.tsx`'s `createDefaultWorktreeLayout`).
 *
 * Read through a function rather than a module-level const so tests can flip
 * it with `vi.stubEnv('VITE_AGENT_CHAT', '0')`.
 */
export function agentChatEnabled(): boolean {
  const flag = import.meta.env.VITE_AGENT_CHAT
  if (flag === '1' || flag === 'on') return true
  if (flag === '0' || flag === 'off') return false
  return !import.meta.env.PROD
}
