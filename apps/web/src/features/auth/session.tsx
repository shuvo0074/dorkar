import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { clearAccessToken, onSessionChange, refreshSession, setAccessToken } from '../../lib/http';
import { authApi, type Account, type SignedIn } from './api';

type Status = 'restoring' | 'signedIn' | 'signedOut';

interface Session {
  status: Status;
  account: Account | undefined;
  /** Called by the sign-in flow once the code is verified. */
  establish: (result: SignedIn) => void;
  signOut: (scope?: 'this' | 'all') => Promise<void>;
}

const SessionContext = createContext<Session | null>(null);
export const accountKey = ['me', 'account'] as const;

/**
 * The only global client state in the app: whether we hold a session. Everything the server
 * owns (account, sessions, devices) stays in TanStack Query.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<Status>('restoring');

  useEffect(() => {
    const off = onSessionChange((signedIn) => {
      setStatus(signedIn ? 'signedIn' : 'signedOut');
      if (!signedIn) queryClient.removeQueries({ queryKey: ['me'] });
    });
    // Restore from the httpOnly refresh cookie on load.
    void refreshSession().then((ok) => setStatus(ok ? 'signedIn' : 'signedOut'));
    return off;
  }, [queryClient]);

  const account = useQuery({
    queryKey: accountKey,
    queryFn: authApi.me,
    enabled: status === 'signedIn',
    staleTime: 60_000,
  });

  const value: Session = {
    status,
    account: account.data,
    establish: (result) => {
      queryClient.setQueryData(accountKey, result.account);
      setAccessToken(result.accessToken, result.accessTokenExpiresAt);
    },
    signOut: async (scope = 'this') => {
      try {
        await (scope === 'all' ? authApi.logoutAll() : authApi.logout());
      } finally {
        clearAccessToken();
        queryClient.removeQueries({ queryKey: ['me'] });
      }
    },
  };

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession outside SessionProvider');
  return ctx;
}
