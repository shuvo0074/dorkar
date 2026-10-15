import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { clearAccessToken } from '../src/lib/http';
import { fakeApi } from './fake-api';
import {
  catalogRoutes,
  deal,
  DEAL,
  listing,
  LISTING,
  mediaRoutes,
  signedIn,
  signedOut,
} from './fixtures';
import { renderApp } from './render';

afterEach(() => clearAccessToken());

describe('browsing listings', () => {
  it('shows listings with their photo and filters through the URL', async () => {
    const { calls } = fakeApi({
      ...signedOut,
      ...catalogRoutes,
      ...mediaRoutes,
      'GET /api/v1/listings': () => ({ body: { data: [listing()], page: { nextCursor: null } } }),
    });
    const { router } = renderApp('/listings');
    const user = userEvent.setup();
    const card = await screen.findByRole('link', { name: /iPhone 13, 128GB, blue/ });
    expect(card).toHaveAttribute('href', `/listings/${LISTING}`);
    expect(await screen.findByText(/৳52,000 · Dhaka/)).toBeInTheDocument();
    await waitFor(() =>
      expect(card.querySelector('img')).toHaveAttribute('src', '/files/thumb.webp'),
    );
    await user.click(screen.getByRole('radio', { name: 'Service' }));
    await user.selectOptions(screen.getByLabelText('Order'), 'price_asc');
    await user.click(screen.getByRole('button', { name: 'Show listings' }));
    await waitFor(() => expect(router.state.location.search).toBe('?kind=SERVICE&sort=price_asc'));
    await waitFor(() =>
      expect(
        calls.some((c) => c.key.includes('/api/v1/listings?kind=SERVICE&sort=price_asc')),
      ).toBe(true),
    );
  });
});

describe('a listing', () => {
  it('lets a member buy it now and lands on the new deal', async () => {
    const { calls } = fakeApi({
      ...signedIn(),
      ...catalogRoutes,
      ...mediaRoutes,
      [`GET /api/v1/listings/${LISTING}`]: () => ({ body: { data: listing() } }),
      'POST /api/v1/transactions': () => ({
        status: 201,
        body: {
          data: deal({
            sourceType: 'LISTING',
            sourceId: LISTING,
            listingId: LISTING,
            needId: null,
            terms: { title: 'iPhone 13, 128GB, blue' },
          }),
        },
      }),
      [`GET /api/v1/transactions/${DEAL}`]: () => ({ body: { data: deal() } }),
    });
    const { router } = renderApp(`/listings/${LISTING}`);
    const user = userEvent.setup();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'iPhone 13, 128GB, blue' }),
    ).toBeVisible();
    expect(screen.getByText('Total ৳52,000, cash on handover')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Buy now' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/deals/${DEAL}`));
    const post = calls.find((c) => c.key === 'POST /api/v1/transactions')!;
    expect(post.body).toEqual({ listingId: LISTING, quantity: 1 });
    expect(post.headers['idempotency-key']).toBeTruthy();
  });

  it('explains a refused purchase in the shopper’s words', async () => {
    fakeApi({
      ...signedIn(),
      ...catalogRoutes,
      ...mediaRoutes,
      [`GET /api/v1/listings/${LISTING}`]: () => ({ body: { data: listing() } }),
      'POST /api/v1/transactions': () => ({
        status: 422,
        body: {
          error: {
            code: 'BUSINESS_RULE_VIOLATION',
            message: 'x',
            details: { rule: 'LISTING_UNAVAILABLE' },
          },
        },
      }),
    });
    renderApp(`/listings/${LISTING}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Buy now' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This listing just stopped being available.',
    );
  });
});
