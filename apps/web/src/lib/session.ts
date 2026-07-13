export interface Session {
  login: string;
}

export async function fetchSession(): Promise<Session | null> {
  try {
    const res = await fetch('/auth/me', { credentials: 'include' });
    if (res.status === 401) return null;
    if (!res.ok) {
      console.error('[session] Unexpected response from /auth/me:', res.status);
      return null;
    }
    return (await res.json()) as Session;
  } catch {
    console.error('[session] Network error while fetching /auth/me');
    return null;
  }
}
