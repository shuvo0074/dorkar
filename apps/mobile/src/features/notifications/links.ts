import { CommonActions, type NavigationProp, type ParamListBase } from '@react-navigation/native';
import type { RootParams, RouteName } from '../../nav/routes';

/** A page of the app, ready to be navigated to. */
export type NavTarget = { [N in RouteName]: { name: N; params?: RootParams[N] } }[RouteName];

/** Goes to a target of any page, from any navigator. */
export function goTo(
  nav: { dispatch: NavigationProp<ParamListBase>['dispatch'] },
  target: NavTarget,
) {
  nav.dispatch(CommonActions.navigate(target));
}

/**
 * The page of the app behind one of the web's paths (notifications and reports name them). An
 * empty id means the payload lacked it: the list above is the nearest honest place.
 */
export function routeForPath(path: string): NavTarget | null {
  const [head, id] = path.split('?')[0]!.split('/').filter(Boolean);
  switch (head) {
    case 'needs':
      return id ? { name: 'Need', params: { id } } : { name: 'Needs' };
    case 'offers':
      return id ? { name: 'Offer', params: { id } } : { name: 'MyOffers' };
    case 'deals':
      return id ? { name: 'Deal', params: { id } } : { name: 'Deals' };
    case 'users':
      return id ? { name: 'User', params: { id } } : null;
    case 'listings':
      return id ? { name: 'Listing', params: { id } } : { name: 'Listings' };
    case 'lend':
      return id ? { name: 'LendItem', params: { id } } : { name: 'LendItems' };
    case 'auctions':
      return id ? { name: 'Auction', params: { id } } : { name: 'Auctions' };
    case 'bookings':
      return id ? { name: 'Booking', params: { id } } : { name: 'Bookings' };
    case 'loans':
      return id ? { name: 'Loan', params: { id } } : { name: 'Loans' };
    case 'disputes':
      return id ? { name: 'Dispute', params: { id } } : { name: 'Disputes' };
    case 'messages':
      return id ? { name: 'Conversation', params: { id } } : { name: 'Messages' };
    case 'account':
      if (id === 'profile') return { name: 'ProfileSettings' };
      if (id === 'notifications') return { name: 'NotificationSettings' };
      return { name: 'Tabs', params: { screen: 'Account' } };
    default:
      return null;
  }
}
