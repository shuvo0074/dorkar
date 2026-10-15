import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { clearAccessToken } from '../src/lib/http';
import { fakeApi } from './fake-api';
import { catalogRoutes, ME, need, NEED, offer, OFFER, OTHER, signedIn } from './fixtures';
import { renderApp } from './render';

afterEach(() => clearAccessToken());

const CONVO = '0192f0c4-0000-7000-8000-0000000cc001';
const conversation = {
  id: CONVO,
  context: { type: 'OFFER', id: OFFER },
  otherParticipantId: OTHER,
  unreadCount: 1,
  lastReadMessageId: null,
  lastMessage: {
    id: 'm1',
    senderId: OTHER,
    preview: 'Still available?',
    removed: false,
    createdAt: '2026-10-15T09:00:00.000Z',
  },
  lastMessageAt: '2026-10-15T09:00:00.000Z',
  createdAt: '2026-10-15T08:00:00.000Z',
};
const message = (id: string, senderId: string, body: string, at: string) => ({
  id,
  conversationId: CONVO,
  senderId,
  clientId: `c-${id}`,
  body,
  mediaIds: [],
  removed: false,
  createdAt: at,
});
const profileOf = {
  [`GET /api/v1/users/${OTHER}`]: () => ({
    body: {
      data: {
        id: OTHER,
        displayName: 'Rahim Telecom',
        badges: [],
        reputation: null,
        seller: null,
        userType: 'BUSINESS',
        bio: null,
        district: null,
        memberSince: '2026-01-01T00:00:00.000Z',
      },
    },
  }),
};

describe('messages', () => {
  it('lists conversations with the other person and what it is about', async () => {
    fakeApi({
      ...signedIn(),
      ...profileOf,
      'GET /api/v1/conversations': () => ({
        body: { data: [conversation], page: { nextCursor: null } },
      }),
    });
    renderApp('/messages');
    expect(await screen.findByRole('link', { name: 'Rahim Telecom' })).toHaveAttribute(
      'href',
      `/messages/${CONVO}`,
    );
    expect(screen.getByText(/About an offer/)).toBeInTheDocument();
    expect(screen.getByText('1 new')).toBeInTheDocument();
  });

  it('shows the thread, marks it read and sends with a client id', async () => {
    const { calls } = fakeApi({
      ...signedIn(),
      ...profileOf,
      [`GET /api/v1/conversations/${CONVO}`]: () => ({ body: { data: conversation } }),
      [`GET /api/v1/conversations/${CONVO}/messages`]: () => ({
        body: {
          data: [message('m1', OTHER, 'Still available?', '2026-10-15T09:00:00.000Z')],
          page: { nextCursor: null },
        },
      }),
      [`POST /api/v1/conversations/${CONVO}/read`]: () => ({ body: { data: {} } }),
      [`POST /api/v1/conversations/${CONVO}/messages`]: (body) => ({
        status: 201,
        body: {
          data: {
            ...message('m2', ME, (body as { body: string }).body, '2026-10-15T09:05:00.000Z'),
            clientId: (body as { clientId: string }).clientId,
          },
        },
      }),
    });
    renderApp(`/messages/${CONVO}`);
    const user = userEvent.setup();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'With Rahim Telecom' }),
    ).toBeVisible();
    expect(await screen.findByText('Still available?')).toBeInTheDocument();
    await waitFor(() =>
      expect(calls.find((c) => c.key === `POST /api/v1/conversations/${CONVO}/read`)?.body).toEqual(
        {
          upToMessageId: 'm1',
        },
      ),
    );
    await user.type(screen.getByLabelText('Your message'), 'Yes, come by at 5.');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Yes, come by at 5.')).toBeInTheDocument();
    const sent = calls.find((c) => c.key === `POST /api/v1/conversations/${CONVO}/messages`)!;
    expect(sent.body).toMatchObject({ body: 'Yes, come by at 5.' });
    expect((sent.body as { clientId: string }).clientId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('refuses phone numbers before sending', async () => {
    const { calls } = fakeApi({
      ...signedIn(),
      ...profileOf,
      [`GET /api/v1/conversations/${CONVO}`]: () => ({ body: { data: conversation } }),
      [`GET /api/v1/conversations/${CONVO}/messages`]: () => ({
        body: { data: [], page: { nextCursor: null } },
      }),
    });
    renderApp(`/messages/${CONVO}`);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Your message'), 'call 01712345678');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Phone numbers and emails can’t be sent/,
    );
    expect(calls.some((c) => c.key === `POST /api/v1/conversations/${CONVO}/messages`)).toBe(false);
  });

  it('opens the conversation about an offer from the offer page', async () => {
    fakeApi({
      ...signedIn(),
      ...catalogRoutes,
      ...profileOf,
      [`GET /api/v1/offers/${OFFER}`]: () => ({ body: { data: offer() } }),
      [`GET /api/v1/needs/${NEED}`]: () => ({ body: { data: need() } }),
      'POST /api/v1/conversations': () => ({ status: 201, body: { data: conversation } }),
      [`GET /api/v1/conversations/${CONVO}/messages`]: () => ({
        body: { data: [], page: { nextCursor: null } },
      }),
    });
    const { router } = renderApp(`/offers/${OFFER}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Message the seller' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/messages/${CONVO}`));
  });
});
