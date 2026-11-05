import { useRoute } from '@react-navigation/native';
import { useEffect, type ReactNode } from 'react';
import { useSession } from '../features/auth/session';
import { Loading, Screen } from '../ui/Layout';
import { useNav, type RootParams } from './routes';

/** Renders children only for a signed-in session; otherwise off to sign in, and back here after. */
export function SignedInOnly({ children }: { children: ReactNode }) {
  const session = useSession();
  const nav = useNav();
  const route = useRoute();
  useEffect(() => {
    if (session.status === 'signedOut') {
      nav.navigate('SignIn', {
        from: {
          name: route.name as keyof RootParams,
          ...(route.params ? { params: route.params } : {}),
        },
      });
    }
  }, [session.status, nav, route]);
  if (session.status !== 'signedIn' || !session.account) {
    return (
      <Screen>
        <Loading />
      </Screen>
    );
  }
  return <>{children}</>;
}
