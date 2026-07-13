import { useEffect, useState } from 'react';
import { AppShell } from './components/AppShell';
import { Login } from './routes/Login';
import { fetchSession } from './lib/session';
import type { Session } from './lib/session';

type AuthState = 'loading' | 'unauthenticated' | 'authenticated';

export function App() {
  const [authState, setAuthState] = useState<AuthState>('loading');
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    fetchSession().then((s) => {
      if (s) {
        setSession(s);
        setAuthState('authenticated');
      } else {
        setAuthState('unauthenticated');
      }
    });
  }, []);

  if (authState === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-basalt">
        <span className="font-mono text-xs text-ash">connecting…</span>
      </div>
    );
  }

  if (authState === 'unauthenticated') {
    return <Login />;
  }

  return <AppShell login={session?.login} />;
}
