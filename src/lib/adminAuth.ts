/**
 * Admin session handling.
 *
 * The dashboard PIN used to be a constant in this bundle ('0000') and the API
 * trusted any caller, so the PIN only hid the UI - it protected nothing. The
 * PIN is now verified by the server, which returns a short-lived session token;
 * every privileged request carries that token and the server rejects the rest.
 *
 * The token lives in sessionStorage, so it is dropped when the tab closes and is
 * never shared between browser profiles.
 */

const TOKEN_KEY = 'vox_admin_token';

export function getAdminToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

export function setAdminToken(token: string): void {
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* storage unavailable (private mode) - the session simply won't persist */
  }
}

export function clearAdminToken(): void {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

export function hasAdminSession(): boolean {
  return !!getAdminToken();
}

/** Exchange the PIN for a session token. Returns false if the PIN is wrong. */
export async function adminLogin(pin: string): Promise<boolean> {
  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin }),
    });
    if (!res.ok) return false;
    const data = await res.json().catch(() => null);
    const token = String(data?.token || '');
    if (!token) return false;
    setAdminToken(token);
    return true;
  } catch {
    return false;
  }
}

export async function adminLogout(): Promise<void> {
  const token = getAdminToken();
  clearAdminToken();
  if (!token) return;
  try {
    await fetch('/api/admin/logout', { method: 'POST', headers: { 'x-admin-token': token } });
  } catch {
    /* the local token is already gone, which is what matters */
  }
}

/**
 * fetch() for privileged endpoints. Attaches the admin session token and drops
 * the local session if the server says it is no longer valid.
 */
export async function adminFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers || {});
  const token = getAdminToken();
  if (token) headers.set('x-admin-token', token);

  const res = await fetch(input, { ...init, headers });
  if (res.status === 401) clearAdminToken();
  return res;
}
