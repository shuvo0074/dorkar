import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy } from 'react';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { AppShell } from '../components/layout/AppShell';
import { SessionProvider } from '../features/auth/session';
import { ApiError } from '../lib/http';
import { I18nProvider } from '../lib/i18n';
import HomeRoute from '../routes/HomeRoute';

// Home is the landing page and stays in the main bundle (LCP); the rest load on demand.
const SignInRoute = lazy(() => import('../routes/SignInRoute'));
const AccountRoute = lazy(() => import('../routes/AccountRoute'));
const DashboardRoute = lazy(() => import('../routes/DashboardRoute'));
const DeskRoute = lazy(() => import('../routes/DeskRoute'));
const ActivityRoute = lazy(() => import('../routes/ActivityRoute'));
const NotFoundRoute = lazy(() => import('../routes/NotFoundRoute'));
const NeedFormRoute = lazy(() => import('../routes/NeedFormRoute'));
const NeedRoute = lazy(() => import('../routes/NeedRoute'));
const NeedsRoute = lazy(() => import('../routes/NeedsRoute'));
const MyNeedsRoute = lazy(() => import('../routes/MyNeedsRoute'));
const OfferFormRoute = lazy(() => import('../routes/OfferFormRoute'));
const OfferRoute = lazy(() => import('../routes/OfferRoute'));
const MyOffersRoute = lazy(() => import('../routes/MyOffersRoute'));
const DealsRoute = lazy(() => import('../routes/DealsRoute'));
const DealRoute = lazy(() => import('../routes/DealRoute'));
const UserRoute = lazy(() => import('../routes/UserRoute'));
const ListingsRoute = lazy(() => import('../routes/ListingsRoute'));
const ListingRoute = lazy(() => import('../routes/ListingRoute'));
const ListingFormRoute = lazy(() => import('../routes/ListingFormRoute'));
const MyListingsRoute = lazy(() => import('../routes/MyListingsRoute'));
const InboxRoute = lazy(() => import('../routes/InboxRoute'));
const NotificationSettingsRoute = lazy(() => import('../routes/NotificationSettingsRoute'));
const ProfileSettingsRoute = lazy(() => import('../routes/ProfileSettingsRoute'));
const MessagesRoute = lazy(() => import('../routes/MessagesRoute'));
const ConversationRoute = lazy(() => import('../routes/ConversationRoute'));
const DisputesRoute = lazy(() => import('../routes/DisputesRoute'));
const DisputeRoute = lazy(() => import('../routes/DisputeRoute'));
const BookingsRoute = lazy(() => import('../routes/BookingsRoute'));
const BookingRoute = lazy(() => import('../routes/BookingRoute'));
const RentalSettingsRoute = lazy(() => import('../routes/RentalSettingsRoute'));
const LendItemsRoute = lazy(() => import('../routes/LendItemsRoute'));
const LendItemRoute = lazy(() => import('../routes/LendItemRoute'));
const LendFormRoute = lazy(() => import('../routes/LendFormRoute'));
const LoansRoute = lazy(() => import('../routes/LoansRoute'));
const LoanRoute = lazy(() => import('../routes/LoanRoute'));
const AuctionsRoute = lazy(() => import('../routes/AuctionsRoute'));
const AuctionRoute = lazy(() => import('../routes/AuctionRoute'));
const AuctionFormRoute = lazy(() => import('../routes/AuctionFormRoute'));
const MyAuctionsRoute = lazy(() => import('../routes/MyAuctionsRoute'));
const ModerationRoute = lazy(() => import('../routes/desk/ModerationRoute'));
const DisputeQueueRoute = lazy(() => import('../routes/desk/DisputeQueueRoute'));
const VerificationsRoute = lazy(() => import('../routes/desk/VerificationsRoute'));

export const routes = [
  {
    element: <AppShell />,
    children: [
      { index: true, element: <HomeRoute /> },
      { path: 'sign-in', element: <SignInRoute /> },
      { path: 'account', element: <AccountRoute /> },
      { path: 'dashboard', element: <DashboardRoute /> },
      { path: 'desk', element: <DeskRoute /> },
      { path: 'desk/activity', element: <ActivityRoute /> },
      { path: 'needs', element: <NeedsRoute /> },
      { path: 'needs/new', element: <NeedFormRoute /> },
      { path: 'needs/:id', element: <NeedRoute /> },
      { path: 'needs/:id/edit', element: <NeedFormRoute /> },
      { path: 'needs/:id/offer', element: <OfferFormRoute /> },
      { path: 'offers/:id', element: <OfferRoute /> },
      { path: 'my/needs', element: <MyNeedsRoute /> },
      { path: 'my/offers', element: <MyOffersRoute /> },
      { path: 'deals', element: <DealsRoute /> },
      { path: 'deals/:id', element: <DealRoute /> },
      { path: 'users/:id', element: <UserRoute /> },
      { path: 'listings', element: <ListingsRoute /> },
      { path: 'listings/new', element: <ListingFormRoute /> },
      { path: 'listings/:id', element: <ListingRoute /> },
      { path: 'listings/:id/edit', element: <ListingFormRoute /> },
      { path: 'my/listings', element: <MyListingsRoute /> },
      { path: 'inbox', element: <InboxRoute /> },
      { path: 'account/notifications', element: <NotificationSettingsRoute /> },
      { path: 'account/profile', element: <ProfileSettingsRoute /> },
      { path: 'messages', element: <MessagesRoute /> },
      { path: 'messages/:id', element: <ConversationRoute /> },
      { path: 'disputes', element: <DisputesRoute /> },
      { path: 'disputes/:id', element: <DisputeRoute /> },
      { path: 'bookings', element: <BookingsRoute /> },
      { path: 'bookings/:id', element: <BookingRoute /> },
      { path: 'listings/:id/rental', element: <RentalSettingsRoute /> },
      { path: 'lend', element: <LendItemsRoute /> },
      { path: 'lend/new', element: <LendFormRoute /> },
      { path: 'lend/:id', element: <LendItemRoute /> },
      { path: 'lend/:id/edit', element: <LendFormRoute /> },
      { path: 'loans', element: <LoansRoute /> },
      { path: 'loans/:id', element: <LoanRoute /> },
      { path: 'auctions', element: <AuctionsRoute /> },
      { path: 'auctions/new', element: <AuctionFormRoute /> },
      { path: 'auctions/:id', element: <AuctionRoute /> },
      { path: 'my/auctions', element: <MyAuctionsRoute /> },
      { path: 'desk/moderation', element: <ModerationRoute /> },
      { path: 'desk/moderation/:id', element: <ModerationRoute /> },
      { path: 'desk/disputes', element: <DisputeQueueRoute /> },
      { path: 'desk/verifications', element: <VerificationsRoute /> },
      { path: '*', element: <NotFoundRoute /> },
    ],
  },
];

export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        // Don't hammer the API on client errors; retry transient ones once.
        retry: (count, err) => count < 1 && !(err instanceof ApiError && err.status < 500),
      },
    },
  });
}

const queryClient = makeQueryClient();
const router = createBrowserRouter(routes);

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <SessionProvider>
          <RouterProvider router={router} />
        </SessionProvider>
      </I18nProvider>
    </QueryClientProvider>
  );
}
