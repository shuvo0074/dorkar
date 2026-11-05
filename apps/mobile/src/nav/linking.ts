import type { LinkingOptions } from '@react-navigation/native';
import { brand } from '../design/brand';
import type { RootParams } from './routes';

/** dorkar-*://needs/ID and so on, the same paths as the website. */
export const linking: LinkingOptions<RootParams> = {
  prefixes: [`${brand.scheme}://`],
  config: {
    screens: {
      Tabs: { screens: { Home: '', Inbox: 'inbox', Dashboard: 'dashboard', Account: 'account' } },
      SignIn: 'sign-in',
      Needs: 'needs',
      NeedForm: { path: 'needs/new' },
      Need: 'needs/:id',
      OfferForm: 'needs/:needId/offer',
      Offer: 'offers/:id',
      MyNeeds: 'my/needs',
      MyOffers: 'my/offers',
      Deals: 'deals',
      Deal: 'deals/:id',
      User: 'users/:id',
      Listings: 'listings',
      Listing: 'listings/:id',
      ListingForm: 'listings/new',
      MyListings: 'my/listings',
      RentalSettings: 'listings/:id/rental',
      NotificationSettings: 'account/notifications',
      ProfileSettings: 'account/profile',
      Messages: 'messages',
      Conversation: 'messages/:id',
      Disputes: 'disputes',
      Dispute: 'disputes/:id',
      Bookings: 'bookings',
      Booking: 'bookings/:id',
      LendItems: 'lend',
      LendItem: 'lend/:id',
      LendForm: 'lend/new',
      Loans: 'loans',
      Loan: 'loans/:id',
      Auctions: 'auctions',
      Auction: 'auctions/:id',
      AuctionForm: 'auctions/new',
      MyAuctions: 'my/auctions',
    },
  },
};
