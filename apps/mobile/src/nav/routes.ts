import type { NavigatorScreenParams, NavigationProp, RouteProp } from '@react-navigation/native';
import { useNavigation, useRoute } from '@react-navigation/native';

/** The bottom tabs; Post sits between them but is an action, not a tab. */
export type TabParams = {
  Home: { focusComposer?: number } | undefined;
  Inbox: undefined;
  Dashboard: undefined;
  Account: undefined;
};

/**
 * Every page of the app, mirroring the web's route table so a need link means the same on both.
 * The `path` of each is in linking.ts.
 */
export type RootParams = {
  Tabs: NavigatorScreenParams<TabParams> | undefined;
  SignIn: { from?: { name: keyof RootParams; params?: object } } | undefined;
  Needs:
    | { mode?: string; q?: string; district?: string; categoryId?: string; budget?: string }
    | undefined;
  NeedForm: { id?: string } | undefined;
  Need: { id: string; notice?: 'posted' | 'draft' };
  OfferForm: { needId: string };
  Offer: { id: string; notice?: 'sent' };
  MyNeeds: undefined;
  MyOffers: undefined;
  Deals: undefined;
  Deal: { id: string };
  User: { id: string };
  Listings:
    | {
        kind?: string;
        q?: string;
        district?: string;
        categoryId?: string;
        condition?: string;
        min?: string;
        max?: string;
        sort?: string;
      }
    | undefined;
  Listing: { id: string; notice?: 'created' | 'saved' };
  ListingForm: { id?: string } | undefined;
  MyListings: undefined;
  RentalSettings: { id: string };
  NotificationSettings: undefined;
  ProfileSettings: undefined;
  Messages: undefined;
  Conversation: { id: string };
  Disputes: undefined;
  Dispute: { id: string };
  Bookings: undefined;
  Booking: { id: string };
  LendItems: { q?: string; categoryId?: string; district?: string } | undefined;
  LendItem: { id: string };
  LendForm: { id?: string } | undefined;
  Loans: undefined;
  Loan: { id: string };
  Auctions: { kind?: string } | undefined;
  Auction: { id: string };
  AuctionForm: { listingId?: string; needId?: string; kind?: string } | undefined;
  MyAuctions: { kind?: string } | undefined;
};

export type RouteName = keyof RootParams;

/** Navigation for any page. Tabs are reached through `Tabs`, e.g. nav.navigate('Tabs', { screen: 'Inbox' }). */
export const useNav = () => useNavigation<NavigationProp<RootParams>>();
export const useParams = <N extends RouteName>() => useRoute<RouteProp<RootParams, N>>().params;
