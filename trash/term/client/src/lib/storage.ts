const SESSION_ID_KEY = 'ccwc:sessionId';
const LAST_CWD_KEY = 'ccwc:lastCwd';

export function getStoredSessionId(): string | null {
  return window.localStorage.getItem(SESSION_ID_KEY);
}

export function setStoredSessionId(sessionId: string): void {
  window.localStorage.setItem(SESSION_ID_KEY, sessionId);
}

export function clearStoredSessionId(): void {
  window.localStorage.removeItem(SESSION_ID_KEY);
}

export function getLastCwd(): string {
  return window.localStorage.getItem(LAST_CWD_KEY) ?? '';
}

export function setLastCwd(cwd: string): void {
  window.localStorage.setItem(LAST_CWD_KEY, cwd);
}
