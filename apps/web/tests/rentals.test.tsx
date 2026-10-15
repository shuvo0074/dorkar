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
  signedIn,
} from './fixtures';
import { renderApp } from './render';

afterEach(() => clearAccessToken());

const BOOKING = '0192f0c4-0000-7000-8000-0000000bb001';
const terms = {
  listingId: LISTING,
  instantBook: false,
  minDurationHours: 4,
  maxDurationDays: 7,
  deposit: money(2_000),
  advanceNoticeHours: 12,
  bufferHours: 2,
  cancellationNote: 'Free until a day before',
  updatedAt: '2026-10-01T00:00:00.000Z',
};
const booking = (over: Record<string, unknown> = {}) => ({
  id: BOOKING,
  listingId: LISTING,
  ownerId: OTHER,
  renterId: ME,
  status: 'PENDING_APPROVAL',
  startAt: '2026-10-20T03:00:00.000Z',
  endAt: '2026-10-22T03:00:00.000Z',
  holdExpiresAt: null,
  amount: money(3_000),
  deposit: money(2_000),
  terms: { listingTitle: 'Microbus, 12 seats' },
  transactionId: null,
  disputed: false,
  createdAt: '2026-10-15T09:00:00.000Z',
  updatedAt: '2026-10-15T09:00:00.000Z',
  version: 1,
  note: null,
  declineReason: null,
  cancelReason: null,
  overdueNotifiedAt: null,
  viewerRole: 'RENTER',
  actions: ['cancel'],
  transitions: [],
  ...over,
});
const rental = listing({
  kind: 'RENTAL',
  title: 'Microbus, 12 seats',
  priceUnit: 'PER_DAY',
  price: money(1_500),
});

describe('renting', () => {
  it('shows terms and busy times, then requests a booking', async () => {
    const { calls } = fakeApi({
      ...signedIn(),
      ...catalogRoutes,
      ...mediaRoutes,
      [`GET /api/v1/listings/${LISTING}`]: () => ({ body: { data: rental } }),
      [`GET /api/v1/listings/${LISTING}/rental-terms`]: () => ({ body: { data: terms } }),
      [`GET /api/v1/listings/${LISTING}/availability`]: () => ({
        body: {
          data: {
            listingId: LISTING,
            from: '',
            to: '',
            busy: [{ startAt: '2026-10-25T03:00:00.000Z', endAt: '2026-10-26T03:00:00.000Z' }],
          },
        },
      }),
      'POST /api/v1/bookings': () => ({ status: 201, body: { data: booking() } }),
      [`GET /api/v1/bookings/${BOOKING}`]: () => ({ body: { data: booking() } }),
    });
    const { router } = renderApp(`/listings/${LISTING}`);
    const user = userEvent.setup();
    expect(await screen.findByText('The owner approves each request.')).toBeInTheDocument();
    expect(screen.getByText('Deposit ৳2,000, returned with the item.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('From'), '2026-10-20T09:00');
    await user.type(screen.getByLabelText('Until'), '2026-10-22T09:00');
    await user.click(screen.getByRole('button', { name: 'Request booking' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/bookings/${BOOKING}`));
    const post = calls.find((c) => c.key === 'POST /api/v1/bookings')!;
    expect(post.body).toMatchObject({ listingId: LISTING });
    expect(post.headers['idempotency-key']).toBeTruthy();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Microbus, 12 seats' }),
    ).toBeVisible();
  });

  it('lets the owner approve a request', async () => {
    const { calls } = fakeApi({
      ...signedIn(),
      ...catalogRoutes,
      [`GET /api/v1/listings/${LISTING}`]: () => ({ body: { data: rental } }),
      [`GET /api/v1/bookings/${BOOKING}`]: () => ({
        body: {
          data: booking({
            ownerId: ME,
            renterId: OTHER,
            viewerRole: 'OWNER',
            actions: ['approve', 'decline'],
          }),
        },
      }),
      [`POST /api/v1/bookings/${BOOKING}/approve`]: () => ({
        body: { data: booking({ status: 'CONFIRMED', viewerRole: 'OWNER', actions: [] }) },
      }),
    });
    renderApp(`/bookings/${BOOKING}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Approve request' }));
    await waitFor(() =>
      expect(calls.some((c) => c.key === `POST /api/v1/bookings/${BOOKING}/approve`)).toBe(true),
    );
    expect(await screen.findByText('Confirmed')).toBeInTheDocument();
  });

  it('saves the owner’s rental terms', async () => {
    const { calls } = fakeApi({
      ...signedIn(),
      ...catalogRoutes,
      [`GET /api/v1/listings/${LISTING}`]: () => ({ body: { data: { ...rental, sellerId: ME } } }),
      [`GET /api/v1/listings/${LISTING}/rental-terms`]: () => ({ body: { data: terms } }),
      [`GET /api/v1/listings/${LISTING}/availability/blocks`]: () => ({ body: { data: [] } }),
      [`PUT /api/v1/listings/${LISTING}/rental-terms`]: (body) => ({
        body: { data: { ...terms, ...(body as object) } },
      }),
    });
    renderApp(`/listings/${LISTING}/rental`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('checkbox', { name: /book instantly/ }));
    await user.click(screen.getByRole('button', { name: 'Save rental terms' }));
    expect(await screen.findByText('Rental terms saved.')).toBeInTheDocument();
    expect(
      calls.find((c) => c.key === `PUT /api/v1/listings/${LISTING}/rental-terms`)?.body,
    ).toEqual({
      instantBook: true,
      minDurationHours: 4,
      maxDurationDays: 7,
      deposit: money(2_000),
      advanceNoticeHours: 12,
      bufferHours: 2,
      cancellationNote: 'Free until a day before',
    });
  });
});
