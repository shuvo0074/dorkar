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

describe('notification settings', () => {
  it('saves every type with the channels chosen', async () => {
    const { calls } = fakeApi({
      ...signedIn(),
      'GET /api/v1/me/notifications/preferences': () => ({
        body: {
          data: [
            { type: 'OFFER_RECEIVED', inApp: true, sms: true, push: false },
            { type: 'NEW_MESSAGE', inApp: true, sms: false, push: false },
          ],
        },
      }),
      'PUT /api/v1/me/notifications/preferences': (body) => ({
        body: { data: (body as { items: unknown[] }).items },
      }),
    });
    renderApp('/account/notifications');
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('checkbox', { name: 'An offer arrives on my need: SMS' }),
    );
    await user.click(screen.getByRole('checkbox', { name: 'A new message: Phone alert' }));
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByText('Settings saved.')).toBeInTheDocument();
    expect(calls.find((c) => c.key === 'PUT /api/v1/me/notifications/preferences')?.body).toEqual({
      items: [
        { type: 'OFFER_RECEIVED', inApp: true, sms: false, push: false },
        { type: 'NEW_MESSAGE', inApp: true, sms: false, push: true },
      ],
    });
  });
});
