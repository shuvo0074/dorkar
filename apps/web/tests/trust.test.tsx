import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { clearAccessToken } from '../src/lib/http';
import { fakeApi } from './fake-api';
import { catalogRoutes, OTHER, PHONES, signedOut } from './fixtures';
import { renderApp } from './render';

afterEach(() => clearAccessToken());

export const profile = {
  id: OTHER,
  displayName: 'Rahim Telecom',
  userType: 'BUSINESS',
  bio: 'Used phones with warranty, Mirpur 10.',
  district: 'dhaka',
  memberSince: '2026-01-10T00:00:00.000Z',
  badges: ['PHONE_VERIFIED', 'NID_VERIFIED'],
  reputation: {
    ratingAverage: 4.62,
    ratingCount: 13,
    completedCount: 21,
    cancelledCount: 1,
    disputedCount: 0,
  },
  seller: {
    roles: ['SELLER'],
    categoryIds: [PHONES],
    serviceDistricts: ['dhaka', 'gazipur'],
    deliveryModes: ['SELLER_DELIVERY'],
  },
};

describe('public profile', () => {
  it('shows badges, track record, what they sell and reviews', async () => {
    fakeApi({
      ...signedOut,
      ...catalogRoutes,
      [`GET /api/v1/users/${OTHER}`]: () => ({ body: { data: profile } }),
      [`GET /api/v1/users/${OTHER}/reviews`]: () => ({
        body: {
          data: [
            {
              id: 'r1',
              authorId: 'x',
              authorRole: 'BUYER',
              rating: 5,
              comment: 'Exactly as described',
              createdAt: '2026-10-01T00:00:00.000Z',
            },
          ],
          page: { nextCursor: null },
          summary: {
            ratingAverage: 4.62,
            ratingCount: 13,
            completedCount: 21,
            cancelledCount: 1,
            disputedCount: 0,
            distinctCounterparties: 17,
          },
        },
      }),
    });
    renderApp(`/users/${OTHER}`);
    expect(await screen.findByRole('heading', { level: 1, name: 'Rahim Telecom' })).toBeVisible();
    expect(screen.getByText('NID verified')).toBeInTheDocument();
    expect(screen.getByText('Business')).toBeInTheDocument();
    expect(screen.getByText('4.6')).toBeInTheDocument();
    expect(await screen.findByText('Phones')).toBeInTheDocument();
    expect(screen.getByText('Dhaka, Gazipur')).toBeInTheDocument();
    expect(await screen.findByText('Exactly as described')).toBeInTheDocument();
    expect(screen.getByText(/4\.6 out of 5 · 13 reviews/)).toBeInTheDocument();
  });
});
