import { useIsFocused } from '@react-navigation/native';
import { useEffect, useRef, type ReactNode } from 'react';
import { space } from '../../design/tokens';
import { useNav } from '../../nav/routes';
import { Loading, Screen } from '../../ui/Layout';
import { useSession } from '../auth/session';

/** The top padding of a tab page, under the design's header. */
export const useTabTop = () => space.gutter;

/**
 * SignedInOnly for a tab. Tabs stay mounted behind the others, so only the visible one may send
 * the member to sign in: signing out from Account must land on Home, not on the sign-in page.
 * Backing out of sign-in returns Home, since a tab has nothing to show a signed-out visitor.
 */
export function TabSignedIn({ children }: { children: ReactNode }) {
  const { status, account } = useSession();
  const nav = useNav();
  const focused = useIsFocused();
  const asked = useRef(false);
  useEffect(() => {
    if (status !== 'signedOut') {
      asked.current = false;
      return;
    }
    if (!focused) return;
    if (asked.current) {
      asked.current = false;
      nav.navigate('Tabs', { screen: 'Home' });
    } else {
      asked.current = true;
      nav.navigate('SignIn');
    }
  }, [status, focused, nav]);
  if (status !== 'signedIn' || !account) {
    return (
      <Screen bottomInset={false}>
        <Loading />
      </Screen>
    );
  }
  return <>{children}</>;
}
