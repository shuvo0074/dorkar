import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { clearAccessToken } from '../src/lib/http';
import { fakeApi } from './fake-api';
import {
  catalogRoutes,
  listing,
  LISTING,
  ME,
  mediaRoutes,
  money,
  OTHER,
  PHONES,
  signedIn,
} from './fixtures';
import { renderApp } from './render';

afterEach(() => clearAccessToken());

const AUCTION = '0192f0c4-0000-7000-8000-0000000a0001';
const auction = (over: Record<string, unknown> = {}) => ({
  id: AUCTION,
  kind: 'FORWARD',
  ownerId: OTHER,
  subjectType: 'LISTING',
  subjectId: LISTING,
  categoryId: PHONES,
  title: 'iPhone 13, 128GB, blue',
  district: 'dhaka',
  mode: 'BUY',
  quantity: 1,
  startPrice: money(40_000),
  minIncrement: money(500),
  reservePrice: null,
  reserveMet: false,
  startsAt: '2026-10-15T00:00:00.000Z',
  endsAt: new Date(Date.now() + 86_400_000).toISOString(),
  antiSnipeSeconds: 120,
  status: 'OPEN',
  leadingAmount: money(45_000),
  bidCount: 3,
  hidden: false,
  cancelReason: null,
  closedAt: null,
  createdAt: '2026-10-15T00:00:00.000Z',
  actions: ['BID'],
  myBid: null,
  nextBid: { minimum: money(45_500), maximum: null },
  winnerId: null,
  ...over,
});

describe('auctions', () => {
  it('places a bid at or above the next minimum', async () => {
    const { calls } = fakeApi({
      ...signedIn(),
      [`GET /api/v1/auctions/${AUCTION}`]: () => ({ body: { data: auction() } }),
      [`GET /api/v1/auctions/${AUCTION}/bids`]: () => ({
        body: { data: [], page: { nextCursor: null } },
      }),
      [`POST /api/v1/auctions/${AUCTION}/bids`]: () => ({
        status: 201,
        body: {
          data: {
            bid: {
              id: 'b1',
              bidder: 'Bidder 4',
              isMine: true,
              amount: money(45_500),
              status: 'LEADING',
              placedAt: '',
            },
            auction: auction({
              leadingAmount: money(45_500),
              myBid: { id: 'b1', amount: money(45_500), status: 'LEADING', placedAt: '' },
              actions: ['BID', 'RETRACT_BID'],
            }),
          },
        },
      }),
    });
    renderApp(`/auctions/${AUCTION}`);
    const user = userEvent.setup();
    expect(await screen.findByText('৳45,000')).toBeInTheDocument();
    expect(screen.getByText('At least ৳45,500.')).toBeInTheDocument();
    expect(screen.getByLabelText('Your bid')).toHaveValue('45500');
    await user.click(screen.getByRole('button', { name: 'Place bid' }));
    await waitFor(() =>
      expect(calls.find((c) => c.key === `POST /api/v1/auctions/${AUCTION}/bids`)?.body).toEqual({
        amount: money(45_500),
      }),
    );
    expect(await screen.findByText('Your bid: ৳45,500 (leading)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retract my bid' })).toBeInTheDocument();
  });

  it('starts a forward auction from the owner’s listing', async () => {
    const { calls } = fakeApi({
      ...signedIn(),
      ...catalogRoutes,
      ...mediaRoutes,
      [`GET /api/v1/listings/${LISTING}`]: () => ({ body: { data: listing({ sellerId: ME }) } }),
      'POST /api/v1/auctions': () => ({
        status: 201,
        body: { data: auction({ ownerId: ME, actions: ['CANCEL'] }) },
      }),
      [`GET /api/v1/auctions/${AUCTION}`]: () => ({
        body: { data: auction({ ownerId: ME, actions: ['CANCEL'] }) },
      }),
      [`GET /api/v1/auctions/${AUCTION}/bids`]: () => ({
        body: { data: [], page: { nextCursor: null } },
      }),
    });
    const { router } = renderApp(`/listings/${LISTING}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('link', { name: 'Auction it' }));
    // Navigation moves focus to the new page's heading; type after that.
    const h1 = await screen.findByRole('heading', { level: 1, name: 'Auction your listing' });
    await waitFor(() => expect(h1).toHaveFocus());
    await user.type(screen.getByLabelText('Opening price'), '40000');
    await user.type(screen.getByLabelText('Smallest bid step'), '500');
    await user.type(screen.getByLabelText(/^Closes/), '2026-10-20T20:00');
    await user.click(screen.getByRole('button', { name: 'Start the auction' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/auctions/${AUCTION}`));
    expect(calls.find((c) => c.key === 'POST /api/v1/auctions')?.body).toMatchObject({
      kind: 'FORWARD',
      subjectId: LISTING,
      quantity: 1,
      startPrice: money(40_000),
      minIncrement: money(500),
      reservePrice: null,
      antiSnipeSeconds: 120,
    });
  });
});
