import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { clearAccessToken } from '../src/lib/http';
import { fakeApi } from './fake-api';
import { catalogRoutes, ME, money, OTHER, PHONES, signedIn, signedOut } from './fixtures';
import { renderApp } from './render';

afterEach(() => clearAccessToken());

const ITEM = '0192f0c4-0000-7000-8000-0000000ee001';
const LOAN = '0192f0c4-0000-7000-8000-0000000ee101';
const item = (over: Record<string, unknown> = {}) => ({
  id: ITEM,
  lenderId: OTHER,
  categoryId: PHONES,
  title: 'Aluminium ladder, 12 ft',
  description: 'Light and steady.',
  condition: 'USED',
  district: 'dhaka',
  mediaIds: [],
  deposit: money(500),
  maxLoanDays: 3,
  requirements: { nidVerified: false, minCompletedDeals: 1, minRating: null },
  active: true,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  lenderStats: { completedLoans: 4, onTimeReturnRate: 0.75 },
  viewerIsOwner: false,
  ...over,
});
const loan = (over: Record<string, unknown> = {}) => ({
  id: LOAN,
  itemId: ITEM,
  itemTitle: 'Aluminium ladder, 12 ft',
  lenderId: OTHER,
  borrowerId: ME,
  startAt: '2026-10-18T03:00:00.000Z',
  returnBy: '2026-10-20T03:00:00.000Z',
  message: null,
  deposit: money(500),
  status: 'REQUESTED',
  transactionId: null,
  declineReason: null,
  returnedAt: null,
  overdue: false,
  createdAt: '2026-10-15T00:00:00.000Z',
  updatedAt: '2026-10-15T00:00:00.000Z',
  version: 1,
  viewerRole: 'BORROWER',
  actions: ['cancel'],
  transitions: [],
  ...over,
});

describe('borrowing', () => {
  it('lists things to borrow', async () => {
    fakeApi({
      ...signedOut,
      ...catalogRoutes,
      'GET /api/v1/lend-items': () => ({ body: { data: [item()], page: { nextCursor: null } } }),
    });
    renderApp('/lend');
    expect(await screen.findByRole('link', { name: /Aluminium ladder/ })).toHaveAttribute(
      'href',
      `/lend/${ITEM}`,
    );
  });

  it('shows who can borrow and sends a request', async () => {
    const { calls } = fakeApi({
      ...signedIn(),
      ...catalogRoutes,
      [`GET /api/v1/lend-items/${ITEM}`]: () => ({ body: { data: item() } }),
      'POST /api/v1/loans': () => ({ status: 201, body: { data: loan() } }),
      [`GET /api/v1/loans/${LOAN}`]: () => ({ body: { data: loan() } }),
    });
    const { router } = renderApp(`/lend/${ITEM}`);
    const user = userEvent.setup();
    expect(await screen.findByText('At least 1 completed deals')).toBeInTheDocument();
    expect(screen.getByText('75% returned on time')).toBeInTheDocument();
    await user.type(screen.getByLabelText('From'), '2026-10-18T09:00');
    await user.type(screen.getByLabelText('Return by'), '2026-10-20T09:00');
    await user.click(screen.getByRole('button', { name: 'Send request' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/loans/${LOAN}`));
    expect(calls.find((c) => c.key === 'POST /api/v1/loans')?.body).toMatchObject({ itemId: ITEM });
  });

  it('explains when the lender’s requirements aren’t met', async () => {
    fakeApi({
      ...signedIn(),
      ...catalogRoutes,
      [`GET /api/v1/lend-items/${ITEM}`]: () => ({ body: { data: item() } }),
      'POST /api/v1/loans': () => ({
        status: 422,
        body: {
          error: {
            code: 'BUSINESS_RULE_VIOLATION',
            message: 'x',
            details: { rule: 'BORROWER_NOT_ELIGIBLE' },
          },
        },
      }),
    });
    renderApp(`/lend/${ITEM}`);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('From'), '2026-10-18T09:00');
    await user.type(screen.getByLabelText('Return by'), '2026-10-20T09:00');
    await user.click(screen.getByRole('button', { name: 'Send request' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/asks for more history/);
  });

  it('lets the lender approve', async () => {
    const { calls } = fakeApi({
      ...signedIn(),
      [`GET /api/v1/loans/${LOAN}`]: () => ({
        body: {
          data: loan({
            lenderId: ME,
            borrowerId: OTHER,
            viewerRole: 'LENDER',
            actions: ['approve', 'decline'],
          }),
        },
      }),
      [`POST /api/v1/loans/${LOAN}/approve`]: () => ({
        body: { data: loan({ status: 'APPROVED', viewerRole: 'LENDER', actions: [] }) },
      }),
    });
    renderApp(`/loans/${LOAN}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(calls.some((c) => c.key === `POST /api/v1/loans/${LOAN}/approve`)).toBe(true),
    );
    expect(
      await screen.findByText(/Hand-over and return are tracked on the deal/),
    ).toBeInTheDocument();
  });
});
