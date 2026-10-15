import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { clearAccessToken } from '../src/lib/http';
import { fakeApi } from './fake-api';
import { catalogRoutes, need, NEED, OFFER, offer, money, signedIn } from './fixtures';
import { renderApp } from './render';

afterEach(() => clearAccessToken());

const notes = [
  {
    id: 'n1',
    type: 'OFFER_RECEIVED',
    payload: { offerId: OFFER, needId: NEED, price: money(78_000) },
    read: false,
    readAt: null,
    createdAt: new Date(Date.now() - 3_600_000).toISOString(),
  },
  {
    id: 'n2',
    type: 'NEW_MESSAGE',
    payload: {
      conversationId: 'c1',
      contextType: 'OFFER',
      contextId: OFFER,
      messageId: 'm',
      count: 3,
    },
    read: true,
    readAt: '2026-10-15T08:00:00.000Z',
    createdAt: '2026-10-15T07:00:00.000Z',
  },
];

describe('inbox', () => {
  it('shows the unread count in the nav and opens a notification where it leads', async () => {
    const { calls } = fakeApi({
      ...signedIn(),
      ...catalogRoutes,
      'GET /api/v1/me/notifications/unread-count': () => ({ body: { data: { count: 1 } } }),
      'GET /api/v1/me/notifications': () => ({ body: { data: notes, page: { nextCursor: null } } }),
      'POST /api/v1/me/notifications/n1/read': () => ({
        body: { data: { ...notes[0], read: true } },
      }),
      [`GET /api/v1/offers/${OFFER}`]: () => ({ body: { data: offer() } }),
      [`GET /api/v1/needs/${NEED}`]: () => ({ body: { data: need() } }),
    });
    const { router } = renderApp('/inbox');
    const user = userEvent.setup();
    expect(
      (await screen.findAllByRole('link', { name: 'Inbox, 1 unread' })).length,
    ).toBeGreaterThan(0);
    expect(await screen.findByText('3 new messages.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /New offer of ৳78,000 on your need/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/offers/${OFFER}`));
    expect(calls.some((c) => c.key === 'POST /api/v1/me/notifications/n1/read')).toBe(true);
  });

  it('marks everything read', async () => {
    const { calls } = fakeApi({
      ...signedIn(),
      'GET /api/v1/me/notifications/unread-count': () => ({ body: { data: { count: 1 } } }),
      'GET /api/v1/me/notifications': () => ({ body: { data: notes, page: { nextCursor: null } } }),
      'POST /api/v1/me/notifications/read-all': () => ({ body: { data: { updated: 1 } } }),
    });
    renderApp('/inbox');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Mark all read' }));
    await waitFor(() =>
      expect(calls.some((c) => c.key === 'POST /api/v1/me/notifications/read-all')).toBe(true),
    );
  });
});
