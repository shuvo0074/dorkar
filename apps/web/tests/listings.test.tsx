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
  ME,
  MEDIA,
  mediaRoutes,
  PHONES,
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

describe('selling', () => {
  it('creates a listing with category attributes and publishes it', async () => {
    const { calls } = fakeApi({
      ...signedIn(),
      ...catalogRoutes,
      ...mediaRoutes,
      'POST /api/v1/listings': (body) => ({
        status: 201,
        body: { data: listing({ ...(body as object), status: 'DRAFT', sellerId: ME }) },
      }),
      [`POST /api/v1/listings/${LISTING}/publish`]: () => ({
        body: { data: listing({ sellerId: ME }) },
      }),
      [`GET /api/v1/listings/${LISTING}`]: () => ({ body: { data: listing({ sellerId: ME }) } }),
    });
    const { router } = renderApp('/listings/new');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Title'), 'iPhone 13, 128GB, blue');
    await user.selectOptions(await screen.findByLabelText('Category'), PHONES);
    await user.click(screen.getByRole('button', { name: 'Save and publish' }));
    // Brand is required by the category, price and district by the API.
    expect(await screen.findByText('Fix the marked fields, then try again.')).toBeInTheDocument();
    await user.type(screen.getByLabelText(/^Brand/), 'Apple');
    await user.type(screen.getByLabelText(/^Price$/), '52000');
    await user.selectOptions(screen.getByLabelText('District'), 'dhaka');
    await user.click(screen.getByRole('checkbox', { name: 'Buyer picks up' }));
    await user.click(screen.getByRole('button', { name: 'Save and publish' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/listings/${LISTING}`));
    expect(calls.find((c) => c.key === 'POST /api/v1/listings')?.body).toMatchObject({
      kind: 'PRODUCT',
      categoryId: PHONES,
      title: 'iPhone 13, 128GB, blue',
      price: { amount: 5_200_000, currency: 'BDT' },
      priceUnit: 'TOTAL',
      quantityAvailable: 1,
      attributes: { brand: 'Apple' },
      district: 'dhaka',
      deliveryModes: ['BUYER_PICKUP'],
    });
    expect(calls.some((c) => c.key === `POST /api/v1/listings/${LISTING}/publish`)).toBe(true);
    expect(await screen.findByText('This is your listing')).toBeInTheDocument();
  });

  it('uploads a photo through a signed slot', async () => {
    const { calls } = fakeApi({
      ...signedIn(),
      ...catalogRoutes,
      ...mediaRoutes,
      'POST /api/v1/media/uploads': () => ({
        status: 201,
        body: {
          data: {
            mediaId: MEDIA,
            upload: {
              method: 'PUT',
              url: 'http://localhost:4000/api/v1/media/uploads/x/content?sig=1',
              headers: { 'content-type': 'image/png' },
            },
            expiresAt: '2026-10-15T10:15:00.000Z',
          },
        },
      }),
      'PUT /api/v1/media/uploads/x/content?sig=1': () => ({ status: 204 }),
      [`POST /api/v1/media/${MEDIA}/complete`]: () => ({
        body: { data: { id: MEDIA, status: 'READY', urls: {} } },
      }),
    });
    renderApp('/listings/new');
    const user = userEvent.setup();
    const file = new File([new Uint8Array(10)], 'phone.png', { type: 'image/png' });
    await user.upload(await screen.findByLabelText('Add photos'), file);
    expect(await screen.findByRole('button', { name: 'Remove photo 1' })).toBeVisible();
    expect(calls.find((c) => c.key === 'POST /api/v1/media/uploads')?.body).toEqual({
      purpose: 'LISTING',
      contentType: 'image/png',
      sizeBytes: 10,
    });
    expect(calls.some((c) => c.key.startsWith('PUT /api/v1/media/uploads/x/content'))).toBe(true);
  });
});
