import type { ComponentType } from 'react';
import type { RouteName } from './routes';

/** Loaded on first visit, so a cold start only pays for the home page. */
type Lazy = () => ComponentType<any>;

export const tabScreens: Record<'Inbox' | 'Dashboard' | 'Account', Lazy> = {
  Inbox: () => require('../screens/InboxScreen').default,
  Dashboard: () => require('../screens/DashboardScreen').default,
  Account: () => require('../screens/AccountScreen').default,
};

export const screens: Array<{ name: RouteName; get: Lazy }> = [
  { name: 'SignIn', get: () => require('../screens/SignInScreen').default },
  { name: 'Needs', get: () => require('../screens/NeedsScreen').default },
  { name: 'NeedForm', get: () => require('../screens/NeedFormScreen').default },
  { name: 'Need', get: () => require('../screens/NeedScreen').default },
  { name: 'OfferForm', get: () => require('../screens/OfferFormScreen').default },
  { name: 'Offer', get: () => require('../screens/OfferScreen').default },
  { name: 'MyNeeds', get: () => require('../screens/MyNeedsScreen').default },
  { name: 'MyOffers', get: () => require('../screens/MyOffersScreen').default },
  { name: 'Deals', get: () => require('../screens/DealsScreen').default },
  { name: 'Deal', get: () => require('../screens/DealScreen').default },
  { name: 'User', get: () => require('../screens/UserScreen').default },
  { name: 'Listings', get: () => require('../screens/ListingsScreen').default },
  { name: 'Listing', get: () => require('../screens/ListingScreen').default },
  { name: 'ListingForm', get: () => require('../screens/ListingFormScreen').default },
  { name: 'MyListings', get: () => require('../screens/MyListingsScreen').default },
  { name: 'RentalSettings', get: () => require('../screens/RentalSettingsScreen').default },
  {
    name: 'NotificationSettings',
    get: () => require('../screens/NotificationSettingsScreen').default,
  },
  { name: 'ProfileSettings', get: () => require('../screens/ProfileSettingsScreen').default },
  { name: 'Messages', get: () => require('../screens/MessagesScreen').default },
  { name: 'Conversation', get: () => require('../screens/ConversationScreen').default },
  { name: 'Disputes', get: () => require('../screens/DisputesScreen').default },
  { name: 'Dispute', get: () => require('../screens/DisputeScreen').default },
  { name: 'Bookings', get: () => require('../screens/BookingsScreen').default },
  { name: 'Booking', get: () => require('../screens/BookingScreen').default },
  { name: 'LendItems', get: () => require('../screens/LendItemsScreen').default },
  { name: 'LendItem', get: () => require('../screens/LendItemScreen').default },
  { name: 'LendForm', get: () => require('../screens/LendFormScreen').default },
  { name: 'Loans', get: () => require('../screens/LoansScreen').default },
  { name: 'Loan', get: () => require('../screens/LoanScreen').default },
  { name: 'Auctions', get: () => require('../screens/AuctionsScreen').default },
  { name: 'Auction', get: () => require('../screens/AuctionScreen').default },
  { name: 'AuctionForm', get: () => require('../screens/AuctionFormScreen').default },
  { name: 'MyAuctions', get: () => require('../screens/MyAuctionsScreen').default },
];
