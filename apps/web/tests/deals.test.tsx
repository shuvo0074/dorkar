import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { clearAccessToken } from '../src/lib/http';
import { fakeApi } from './fake-api';
import { catalogRoutes, deal, DEAL, need, NEED, signedIn } from './fixtures';
import { renderApp } from './render';

afterEach(() => clearAccessToken());

const base = {
  ...signedIn(),
  ...catalogRoutes,
  [`GET /api/v1/needs/${NEED}`]: () => ({ body: { data: need() } }),
};

describe('deals', () => {
  it('lists the member’s deals in progress', async () => {
    const { calls } = fakeApi({
      ...base,
      'GET /api/v1/me/transactions': () => ({
        body: {
          data: [deal(), deal({ id: '0192f0c4-0000-7000-8000-00000000d002', state: 'COMPLETED' })],
          page: { nextCursor: null },
        },
      }),
    });
    renderApp('/deals');
    const user = userEvent.setup();
    expect(await screen.findByRole('link', { name: 'Deal T-00D001' })).toHaveAttribute(
      'href',
      `/deals/${DEAL}`,
    );
    expect(screen.queryByRole('link', { name: 'Deal T-00D002' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Seller' }));
    await waitFor(() =>
      expect(calls.some((c) => c.key.includes('/me/transactions?role=seller'))).toBe(true),
    );
  });

  it('confirms a deal with the step the API allows', async () => {
    const { calls } = fakeApi({
      ...base,
      [`GET /api/v1/transactions/${DEAL}`]: () => ({ body: { data: deal() } }),
      [`POST /api/v1/transactions/${DEAL}/confirm`]: () => ({
        body: {
          data: deal({
            state: 'CONFIRMED',
            buyerConfirmedAt: '2026-10-15T11:00:00.000Z',
            actions: ['arrange-delivery', 'cancel'],
          }),
        },
      }),
    });
    renderApp(`/deals/${DEAL}`);
    const user = userEvent.setup();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Used iPhone 15 Pro, 256GB' }),
    ).toBeVisible();
    expect(screen.getByText('The other side; waiting for you')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Confirm the deal' }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.key === `POST /api/v1/transactions/${DEAL}/confirm`)?.headers[
          'idempotency-key'
        ],
      ).toBeTruthy(),
    );
    expect(await screen.findByRole('button', { name: 'Arrange delivery' })).toBeVisible();
  });

  it('opens a dispute with a category and a reason', async () => {
    const { calls } = fakeApi({
      ...base,
      [`GET /api/v1/transactions/${DEAL}`]: () => ({
        body: { data: deal({ state: 'DELIVERED', actions: ['confirm-receipt', 'dispute'] }) },
      }),
      [`POST /api/v1/transactions/${DEAL}/dispute`]: () => ({
        body: { data: deal({ state: 'DISPUTED', actions: [] }) },
      }),
    });
    renderApp(`/deals/${DEAL}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Report a problem' }));
    await user.selectOptions(screen.getByLabelText('What kind of problem'), 'NOT_AS_DESCRIBED');
    await user.type(screen.getByLabelText('Describe what happened'), 'Screen is cracked');
    await user.click(screen.getByRole('button', { name: 'Open a dispute' }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.key === `POST /api/v1/transactions/${DEAL}/dispute`)?.body,
      ).toEqual({
        reason: 'Screen is cracked',
        category: 'NOT_AS_DESCRIBED',
      }),
    );
  });
});

describe('reviews', () => {
  it('lets a party rate a completed deal', async () => {
    const { calls } = fakeApi({
      ...base,
      [`GET /api/v1/transactions/${DEAL}`]: () => ({
        body: { data: deal({ state: 'COMPLETED', actions: [] }) },
      }),
      [`GET /api/v1/transactions/${DEAL}/reviews`]: () => ({ body: { data: [] } }),
      [`POST /api/v1/transactions/${DEAL}/reviews`]: () => ({ status: 201, body: { data: {} } }),
    });
    renderApp(`/deals/${DEAL}`);
    const user = userEvent.setup();
    expect(await screen.findByText('This deal is finished.')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Post review' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Choose a rating first.');
    await user.click(screen.getByRole('radio', { name: '4' }));
    await user.type(screen.getByLabelText(/A few words/), 'Smooth handover');
    await user.click(screen.getByRole('button', { name: 'Post review' }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.key === `POST /api/v1/transactions/${DEAL}/reviews`)?.body,
      ).toEqual({
        rating: 4,
        comment: 'Smooth handover',
      }),
    );
  });
});
