import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { clearAccessToken } from '../src/lib/http';
import { fakeApi } from './fake-api';
import { NEED, OTHER, signedIn } from './fixtures';
import { renderApp } from './render';

afterEach(() => clearAccessToken());

const CASE = '0192f0c4-0000-7000-8000-0000000ca001';
const modCase = (over: Record<string, unknown> = {}) => ({
  id: CASE,
  targetType: 'NEED',
  targetId: NEED,
  status: 'OPEN',
  reportCount: 3,
  topReason: 'SCAM',
  priority: 7,
  assignedTo: null,
  targetHidden: false,
  openedAt: '2026-10-15T08:00:00.000Z',
  closedAt: null,
  version: 1,
  reports: [
    {
      id: 'r1',
      reporterId: OTHER,
      reason: 'SCAM',
      details: 'Asks for advance payment',
      status: 'OPEN',
      createdAt: '2026-10-15T08:00:00.000Z',
    },
  ],
  actions: [],
  ...over,
});

describe('the desk for moderators', () => {
  it('shows a moderator the desk with their tools only', async () => {
    fakeApi(signedIn(['MODERATOR']));
    renderApp('/desk');
    expect(await screen.findByRole('link', { name: 'Moderation' })).toHaveAttribute(
      'href',
      '/desk/moderation',
    );
    expect(screen.queryByRole('link', { name: 'Disputes' })).not.toBeInTheDocument();
    expect(screen.queryByText('Figures')).not.toBeInTheDocument();
  });

  it('keeps members out of staff tools', async () => {
    fakeApi(signedIn(['MEMBER']));
    renderApp('/desk/moderation');
    expect(await screen.findByRole('heading', { name: 'Staff only' })).toBeVisible();
  });

  it('lists open cases and hides the reported need with a reason', async () => {
    const { calls } = fakeApi({
      ...signedIn(['MODERATOR']),
      'GET /api/v1/admin/moderation/cases': () => ({
        body: { data: [modCase()], page: { nextCursor: null } },
      }),
      [`GET /api/v1/admin/moderation/cases/${CASE}`]: () => ({ body: { data: modCase() } }),
      [`POST /api/v1/admin/moderation/cases/${CASE}/actions`]: () => ({
        body: { data: modCase({ status: 'ACTIONED', targetHidden: true }) },
      }),
    });
    const { router } = renderApp('/desk/moderation');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('link', { name: 'Need · 3 reports' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/desk/moderation/${CASE}`));
    expect(await screen.findByText('“Asks for advance payment”')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Hide it' }));
    await user.type(screen.getByLabelText('Reason'), 'Advance-fee scam');
    await user.click(screen.getByRole('button', { name: 'Hide it' }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.key === `POST /api/v1/admin/moderation/cases/${CASE}/actions`)?.body,
      ).toEqual({
        action: 'HIDE',
        reason: 'Advance-fee scam',
      }),
    );
  });
});

describe('disputes on the desk', () => {
  it('lets an admin resolve a dispute with a note', async () => {
    const { dispute, DISPUTE } = await import('./fixtures');
    const staffInfo = {
      assignedTo: null,
      assignedAt: null,
      escalated: false,
      escalatedAt: null,
      resolvedBy: null,
      withdrawnBy: null,
    };
    const staffView = dispute({
      viewerRole: 'STAFF',
      actions: ['evidence', 'assign', 'note', 'request-info', 'resolve'],
      staff: staffInfo,
    });
    const { calls } = fakeApi({
      ...signedIn(['ADMIN']),
      'GET /api/v1/admin/disputes': () => ({
        body: { data: [{ ...staffView, ...staffInfo }], page: { nextCursor: null } },
      }),
      [`GET /api/v1/disputes/${DISPUTE}`]: () => ({ body: { data: staffView } }),
      [`POST /api/v1/admin/disputes/${DISPUTE}/resolve`]: () => ({
        body: {
          data: { ...staffView, status: 'RESOLVED', resolution: 'CANCEL', actions: ['note'] },
        },
      }),
    });
    renderApp('/desk/disputes');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('link', { name: 'Not returned' }));
    await user.click(await screen.findByRole('button', { name: 'Decide the case' }));
    await user.selectOptions(screen.getByLabelText('Outcome'), 'CANCEL');
    await user.type(
      screen.getByLabelText(/Decision, as the parties/),
      'The item was not returned; deal cancelled.',
    );
    await user.click(screen.getByRole('button', { name: 'Resolve' }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.key === `POST /api/v1/admin/disputes/${DISPUTE}/resolve`)?.body,
      ).toEqual({
        resolution: 'CANCEL',
        note: 'The item was not returned; deal cancelled.',
      }),
    );
    expect(await screen.findByText('Deal cancelled')).toBeInTheDocument();
  });
});

describe('ID checks', () => {
  it('verifies a pending NID with a note', async () => {
    const { calls } = fakeApi({
      ...signedIn(['ADMIN']),
      'GET /api/v1/admin/verifications': () => ({
        body: {
          data: [
            {
              id: 'v1',
              accountId: OTHER,
              kind: 'NID',
              status: 'PENDING',
              provider: 'manual',
              providerRef: null,
              nidLast4: '4321',
              reviewedBy: null,
              reviewNote: null,
              submittedAt: '2026-10-15T08:00:00.000Z',
              verifiedAt: null,
              updatedAt: '2026-10-15T08:00:00.000Z',
              version: 1,
            },
          ],
          page: { nextCursor: null },
        },
      }),
      'POST /api/v1/admin/verifications/v1/decision': () => ({ body: { data: {} } }),
    });
    renderApp('/desk/verifications');
    const user = userEvent.setup();
    expect(await screen.findByText('4321')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Note'), 'Matches the EC record');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.key === 'POST /api/v1/admin/verifications/v1/decision')?.body,
      ).toEqual({
        decision: 'VERIFIED',
        note: 'Matches the EC record',
      }),
    );
  });
});

describe('accounts and content', () => {
  it('suspends a member with a reason', async () => {
    const { calls } = fakeApi({
      ...signedIn(['ADMIN']),
      [`GET /api/v1/users/${OTHER}`]: () => ({
        status: 404,
        body: { error: { code: 'NOT_FOUND' } },
      }),
      [`POST /api/v1/admin/accounts/${OTHER}/status`]: () => ({
        body: { data: { id: OTHER, status: 'SUSPENDED' } },
      }),
    });
    renderApp(`/desk/accounts?id=${OTHER}`);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Reason'), 'Repeated scam reports');
    await user.click(screen.getByRole('button', { name: 'Change status' }));
    expect(await screen.findByText(/is now Suspended/)).toBeInTheDocument();
    expect(
      calls.find((c) => c.key === `POST /api/v1/admin/accounts/${OTHER}/status`)?.body,
    ).toEqual({
      status: 'SUSPENDED',
      reason: 'Repeated scam reports',
    });
  });

  it('lets a moderator hide a need from its page', async () => {
    const { catalogRoutes, need } = await import('./fixtures');
    const { calls } = fakeApi({
      ...signedIn(['MODERATOR']),
      ...catalogRoutes,
      [`GET /api/v1/needs/${NEED}`]: () => ({ body: { data: need({ requesterId: OTHER }) } }),
      [`POST /api/v1/admin/needs/${NEED}/hide`]: () => ({
        body: { data: { id: NEED, status: 'HIDDEN' } },
      }),
    });
    renderApp(`/needs/${NEED}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Hide (staff)' }));
    await user.type(screen.getByLabelText('Reason'), 'Prohibited item');
    await user.click(screen.getByRole('button', { name: 'Hide (staff)' }));
    await waitFor(() =>
      expect(calls.find((c) => c.key === `POST /api/v1/admin/needs/${NEED}/hide`)?.body).toEqual({
        reason: 'Prohibited item',
      }),
    );
  });
});

describe('categories', () => {
  it('creates a category with a question', async () => {
    const { catalogRoutes, ELECTRONICS } = await import('./fixtures');
    const { calls } = fakeApi({
      ...signedIn(['ADMIN']),
      ...catalogRoutes,
      'POST /api/v1/admin/categories': () => ({ status: 201, body: { data: { id: 'new-cat' } } }),
    });
    const { router } = renderApp('/desk/categories/new');
    const user = userEvent.setup();
    await screen.findByRole('option', { name: 'Electronics' });
    await user.selectOptions(screen.getByLabelText('Parent'), ELECTRONICS);
    await user.type(screen.getByLabelText('Name in English'), 'Laptops');
    await user.type(screen.getByLabelText('Name in Bangla'), 'ল্যাপটপ');
    await user.type(screen.getByLabelText(/^Slug/), 'laptops');
    await user.click(screen.getByRole('button', { name: 'Add a question' }));
    await user.type(screen.getByLabelText('Key'), 'ramGb');
    await user.selectOptions(screen.getByLabelText('Answer type'), 'integer');
    await user.type(screen.getByLabelText('Question (English)'), 'RAM');
    await user.type(screen.getByLabelText('Question (Bangla)'), 'র‍্যাম');
    await user.type(screen.getByLabelText('Unit'), 'GB');
    await user.click(screen.getByRole('button', { name: 'Save category' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/desk/categories/new-cat'));
    expect(calls.find((c) => c.key === 'POST /api/v1/admin/categories')?.body).toEqual({
      parentId: ELECTRONICS,
      slug: 'laptops',
      nameEn: 'Laptops',
      nameBn: 'ল্যাপটপ',
      modes: ['BUY'],
      attributeSchema: {
        properties: { ramGb: { type: 'integer', label: { en: 'RAM', bn: 'র‍্যাম' }, unit: 'GB' } },
        required: [],
      },
      sort: 0,
      active: true,
    });
  });
});

describe('verification rules', () => {
  it('shows rules read-only to admins and lets a super admin add one', async () => {
    const rule = {
      id: 'p1',
      name: 'High-value deals need NID',
      action: 'TRANSACTION_CREATE',
      scope: 'VALUE_THRESHOLD',
      selector: { minAmount: 5_000_000 },
      requirement: 'REQUIRED',
      kinds: ['NID'],
      active: true,
      priority: 10,
      version: 1,
      updatedBy: null,
      createdAt: '',
      updatedAt: '',
    };
    fakeApi({
      ...signedIn(['ADMIN']),
      'GET /api/v1/admin/verification-policies': () => ({
        body: { data: [rule], page: { nextCursor: null } },
      }),
    });
    renderApp('/desk/policies');
    expect(await screen.findByText('High-value deals need NID')).toBeInTheDocument();
    expect(screen.getByText(/Amounts from: ৳50,000/)).toBeInTheDocument();
    expect(screen.getByText(/you can read these rules/i)).toBeInTheDocument();
  });

  it('creates a rule as a super admin', async () => {
    const { catalogRoutes } = await import('./fixtures');
    const { calls } = fakeApi({
      ...signedIn(['SUPER_ADMIN']),
      ...catalogRoutes,
      'GET /api/v1/admin/verification-policies': () => ({
        body: { data: [], page: { nextCursor: null } },
      }),
      'POST /api/v1/admin/verification-policies': () => ({ status: 201, body: { data: {} } }),
    });
    renderApp('/desk/policies');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New rule' }));
    await user.type(screen.getByLabelText('Name'), 'Auctions need NID');
    await user.selectOptions(screen.getByLabelText('When someone'), 'AUCTION_CREATE');
    await user.click(screen.getByRole('button', { name: 'Save rule' }));
    await waitFor(() =>
      expect(calls.find((c) => c.key === 'POST /api/v1/admin/verification-policies')?.body).toEqual(
        {
          name: 'Auctions need NID',
          action: 'AUCTION_CREATE',
          scope: 'GLOBAL',
          selector: {},
          requirement: 'REQUIRED',
          kinds: ['NID'],
          active: true,
          priority: 0,
        },
      ),
    );
  });
});

describe('monitors', () => {
  it('lists every deal for support staff', async () => {
    const { deal } = await import('./fixtures');
    fakeApi({
      ...signedIn(['SUPPORT']),
      'GET /api/v1/admin/transactions': () => ({
        body: {
          data: [deal({ terms: { title: 'Ceiling fan repair' } })],
          page: { nextCursor: null },
        },
      }),
    });
    renderApp('/desk/deals');
    expect(await screen.findByRole('link', { name: 'Ceiling fan repair' })).toBeVisible();
  });
});
