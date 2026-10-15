import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { clearAccessToken } from '../src/lib/http';
import { fakeApi } from './fake-api';
import { catalogRoutes, ME, need, NEED, offer, OFFER, OTHER, signedIn } from './fixtures';
import { renderApp } from './render';

afterEach(() => clearAccessToken());

describe('making an offer', () => {
  it('sends price, delivery and terms once, with an idempotency key', async () => {
    const { calls } = fakeApi({
      ...signedIn(),
      ...catalogRoutes,
      [`GET /api/v1/needs/${NEED}`]: () => ({ body: { data: need({ requesterId: OTHER }) } }),
      [`POST /api/v1/needs/${NEED}/offers`]: () => ({
        status: 201,
        body: { data: offer({ buyerId: OTHER, sellerId: ME, actions: ['WITHDRAW'] }) },
      }),
      [`GET /api/v1/offers/${OFFER}`]: () => ({
        body: { data: offer({ buyerId: OTHER, sellerId: ME, actions: ['WITHDRAW'] }) },
      }),
    });
    const { router } = renderApp(`/needs/${NEED}/offer`);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/Your total price/), '78000');
    await user.type(screen.getByLabelText(/Delivery fee/), '200');
    await user.type(screen.getByLabelText(/Warranty/), '3');
    await user.click(screen.getByRole('button', { name: 'Send offer' }));

    await waitFor(() => expect(router.state.location.pathname).toBe(`/offers/${OFFER}`));
    const post = calls.find((c) => c.key === `POST /api/v1/needs/${NEED}/offers`)!;
    expect(post.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(post.body).toMatchObject({
      price: { amount: 7_800_000, currency: 'BDT' },
      quantity: 1,
      condition: 'USED',
      deliveryTerms: { method: 'SELLER_DELIVERY', feeAmount: 20_000 },
      modeTerms: { warrantyMonths: 3 },
      expiresInHours: 72,
    });
    expect(await screen.findByText(/Offer sent/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Withdraw offer' })).toBeInTheDocument();
  });

  it('does not let the owner offer on their own need', async () => {
    fakeApi({
      ...signedIn(),
      ...catalogRoutes,
      [`GET /api/v1/needs/${NEED}`]: () => ({ body: { data: need() } }),
    });
    renderApp(`/needs/${NEED}/offer`);
    expect(await screen.findByText(/This is your own need/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send offer' })).not.toBeInTheDocument();
  });
});

describe('negotiating', () => {
  const routes = (o = offer()) => ({
    ...signedIn(),
    ...catalogRoutes,
    [`GET /api/v1/needs/${NEED}`]: () => ({ body: { data: need() } }),
    [`GET /api/v1/offers/${OFFER}`]: () => ({ body: { data: o } }),
  });

  it('accepts after confirming, as the buyer whose turn it is', async () => {
    const { calls } = fakeApi({
      ...routes(),
      [`POST /api/v1/offers/${OFFER}/accept`]: () => ({
        body: { data: offer({ status: 'ACCEPTED', awaiting: null, actions: [] }) },
      }),
    });
    renderApp(`/offers/${OFFER}`);
    const user = userEvent.setup();
    expect(await screen.findByRole('heading', { level: 1, name: /৳78,000/ })).toBeVisible();
    expect(await screen.findByText('Your turn')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Accept offer' }));
    expect(screen.getByText(/Accept ৳78,000 for 1\?/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Yes, accept' }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.key === `POST /api/v1/offers/${OFFER}/accept`)?.headers[
          'idempotency-key'
        ],
      ).toBeTruthy(),
    );
    expect(await screen.findByText(/Your deal is being set up/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept offer' })).not.toBeInTheDocument();
  });

  it('sends a counter-offer with a new price', async () => {
    const { calls } = fakeApi({
      ...routes(),
      [`POST /api/v1/offers/${OFFER}/counter`]: () => ({
        body: {
          data: offer({ status: 'COUNTERED_BY_BUYER', awaiting: 'SELLER', actions: [] }),
        },
      }),
    });
    renderApp(`/offers/${OFFER}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Counter' }));
    const price = screen.getByLabelText(/^Price/);
    await user.clear(price);
    await user.type(price, '72000');
    await user.type(screen.getByLabelText(/Message/), 'Can you do 72?');
    await user.click(screen.getByRole('button', { name: 'Send counter' }));
    await waitFor(() =>
      expect(calls.find((c) => c.key === `POST /api/v1/offers/${OFFER}/counter`)?.body).toEqual({
        price: { amount: 7_200_000, currency: 'BDT' },
        quantity: 1,
        message: 'Can you do 72?',
      }),
    );
    expect(await screen.findByText('Waiting for them')).toBeInTheDocument();
  });
});
