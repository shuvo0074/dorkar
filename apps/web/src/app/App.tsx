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
