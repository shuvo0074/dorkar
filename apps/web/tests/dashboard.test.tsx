import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearAccessToken } from '../src/lib/http';
import { account, fakeApi, inTenMinutes } from './fake-api';
import { renderApp } from './render';

afterEach(() => clearAccessToken());

const session = (roles: string[]) => ({
  'POST /api/v1/auth/refresh': () => ({
    body: { data: { accessToken: 'a', accessTokenExpiresAt: inTenMinutes() } },
  }),
  'GET /api/v1/me/account': () => ({ body: { data: { ...account, roles } } }),
});

const money = (taka: number) => ({ amount: taka * 100, currency: 'BDT' });

const personal = {
  buyer: {
    openNeeds: 2,
    offersAwaitingResponse: 3,
    transactionsByState: { CONFIRMED: 1, COMPLETED: 4 },
    totalSpent: money(12_500),
  },
  seller: {
    offersByStatus: { SUBMITTED: 2 },
    transactionsByState: { HANDED_OVER: 1 },
    earnings: money(78_000),
    rating: { average: 4.75, count: 8, completedCount: 9 },
  },
  auctions: {
    owned: 1,
    bidding: 0,
    live: [
      {
        auctionId: '0192f0c4-0000-7000-8000-0000000a1b2c',
        role: 'OWNER',
        endsAt: inTenMinutes(),
      },
    ],
  },
  bookings: { asRenter: 0, asOwner: 0, items: [] },
  loans: { asLender: 0, asBorrower: 0, items: [] },
  disputes: { open: 0, items: [] },
};

const myActivity = {
  data: [
    {
      id: '0192f0c4-0000-7000-8000-000000000001',
      service: 'offer',
      action: 'offer.submit',
      label: 'Submitted an offer',
      target: { type: 'OFFER', id: '0192f0c4-0000-7000-8000-0000000000ff' },
      actor: null,
      occurredAt: '2026-10-02T08:00:00.000Z',
    },
  ],
  page: { nextCursor: null },
};

describe('personal dashboard', () => {
  it('shows the tally, buyer and seller figures, live auctions and activity', async () => {
    fakeApi({
      ...session(['MEMBER']),
      'GET /api/v1/me/dashboard': () => ({ body: { data: personal } }),
      'GET /api/v1/me/activity': () => ({ body: myActivity }),
    });
    renderApp('/dashboard');
    expect(await screen.findByRole('heading', { level: 1, name: 'Your dashboard' })).toBeVisible();
    // In progress = everything not final: 1 (buyer CONFIRMED) + 1 (seller HANDED_OVER).
    expect((await screen.findByText('Deals in progress')).nextSibling).toHaveTextContent('2');
    expect(screen.getAllByText('৳78,000').length).toBeGreaterThan(0);
    expect(screen.getByText('4.8 out of 5 from 8 reviews')).toBeInTheDocument();
    expect(screen.getByText('Auction A-0A1B2C')).toBeInTheDocument();
    expect(await screen.findByText('Submitted an offer')).toBeInTheDocument();
    // Members get no staff links.
    expect(screen.queryByRole('link', { name: 'Open the desk' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Desk' })).not.toBeInTheDocument();
  });

  it('switches the activity to actions done on the account', async () => {
    const { calls } = fakeApi({
      ...session(['MEMBER']),
      'GET /api/v1/me/dashboard': () => ({ body: { data: personal } }),
      'GET /api/v1/me/activity': () => ({ body: myActivity }),
    });
    renderApp('/dashboard');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('radio', { name: 'Done on your account' }));
    await waitFor(() =>
      expect(calls.some((c) => c.key.includes('/me/activity?scope=about-me'))).toBe(true),
    );
  });

  it('renders in Bangla, including activity wording', async () => {
    fakeApi({
      ...session(['MEMBER']),
      'GET /api/v1/me/dashboard': () => ({ body: { data: personal } }),
      'GET /api/v1/me/activity': () => ({ body: myActivity }),
    });
    renderApp('/dashboard', 'bn');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'আপনার ড্যাশবোর্ড' }),
    ).toBeVisible();
    expect(await screen.findByText('অফার পাঠিয়েছেন')).toHaveAttribute('lang', 'bn');
  });
});

const summary = {
  generatedAt: '2026-10-02T10:00:00.000Z',
  today: '2026-10-02',
  gauges: {
    needsByStatus: { OPEN: 5 },
    activeListings: 29,
    transactionsByState: [{ state: 'COMPLETED', count: 3, amount: money(1_500) }],
    openDisputes: 1,
    pendingVerifications: 0,
    liveAuctions: 2,
    upcomingBookings: 0,
    activeBookings: 1,
    activeLoans: 0,
  },
  periods: [1, 7, 30].map((days) => ({
    days,
    from: '2026-09-26',
    to: '2026-10-02',
    previousFrom: '2026-09-19',
    previousTo: '2026-09-25',
    metrics: [
      {
        metric: 'signups',
        current: days * 10,
        previous: 10,
        change: days * 10 - 10,
        changePct: (days - 1) * 100,
      },
      { metric: 'gmv_completed', current: 150_000, previous: 0, change: 150_000, changePct: null },
    ],
  })),
};
const series = {
  metric: 'transactions_completed',
  dimension: '',
  interval: 'day',
  from: '2026-09-03',
  to: '2026-10-02',
  total: 5,
  points: [
    { start: '2026-09-30', value: 1 },
    { start: '2026-10-01', value: 4 },
    { start: '2026-10-02', value: 0 },
  ],
};
const funnel = {
  from: '2026-09-03',
  to: '2026-10-02',
  steps: [
    { step: 'needsPublished', count: 10, conversionPct: null },
    { step: 'needsWithOffer', count: 5, conversionPct: 50 },
    { step: 'offersAccepted', count: 2, conversionPct: 40 },
    { step: 'transactionsCompleted', count: 4, conversionPct: 200 },
  ],
};
const desk = {
  'GET /api/v1/admin/dashboard/summary': () => ({ body: { data: summary } }),
  'GET /api/v1/admin/dashboard/timeseries': () => ({ body: { data: series } }),
  'GET /api/v1/admin/dashboard/funnel': () => ({ body: { data: funnel } }),
};

describe('desk', () => {
  it('is staff only: a member sees a refusal and no API call is made', async () => {
    const { calls } = fakeApi({ ...session(['MEMBER']), ...desk });
    renderApp('/desk');
    expect(await screen.findByRole('heading', { level: 1, name: 'Staff only' })).toBeVisible();
    expect(calls.some((c) => c.key.includes('/admin/'))).toBe(false);
  });

  it('shows figures per period, gauges, the chart and the funnel to staff', async () => {
    fakeApi({ ...session(['ADMIN']), ...desk });
    renderApp('/desk');
    expect(await screen.findByRole('heading', { level: 1, name: 'The desk' })).toBeVisible();
    const signups = await screen.findByRole('row', { name: /New accounts/ });
    const figures = signups.closest('table')!;
    expect(signups).toHaveTextContent('70'); // 7 days is the default period
    expect(signups).toHaveTextContent('+600%');
    expect(
      within(figures).getByRole('row', { name: /Value of completed deals/ }),
    ).toHaveTextContent('৳1,500');
    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: '30 days' }));
    expect(within(figures).getByRole('row', { name: /New accounts/ })).toHaveTextContent('300');

    // Gauges and deal states.
    expect(screen.getByText('Live auctions').nextSibling).toHaveTextContent('2');
    expect(screen.getByText('3 · ৳1,500')).toBeInTheDocument();
    // Chart: peak and accessible values.
    expect(await screen.findByText('Total 5 · highest 4 on 1 Oct')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Values by date' })).toBeInTheDocument();
    // Funnel: a later step above the one before is explained, not shown as 200%.
    expect(await screen.findByText('50% of the step before')).toBeInTheDocument();
    expect(
      screen.getByText('More than the step before: includes deals that didn’t start from a need'),
    ).toBeInTheDocument();
    // ADMIN has audit:read, so the activity log link is offered.
    expect(screen.getByRole('link', { name: 'Activity log' })).toHaveAttribute(
      'href',
      '/desk/activity',
    );
  });

  it('lets support read the desk but not the activity log', async () => {
    fakeApi({ ...session(['SUPPORT']), ...desk });
    renderApp('/desk');
    expect(await screen.findByRole('heading', { level: 1, name: 'The desk' })).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Activity log' })).not.toBeInTheDocument();
  });
});

const activity = (n: number, cursor: string | null) => ({
  data: Array.from({ length: n }, (_, i) => ({
    id: `0192f0c4-0000-7000-8000-${String(i + (cursor ? 100 : 0)).padStart(12, '0')}`,
    service: 'transaction',
    action: 'transaction.confirm',
    label: 'Confirmed a deal',
    actor: {
      id: '0192f0c4-0000-7000-8000-00000000beef',
      type: 'USER',
      displayName: 'Rahim Stores',
    },
    target: { type: 'TRANSACTION', id: '0192f0c4-0000-7000-8000-00000000c0de' },
    requestId: 'req-1',
    ipHash: 'abcdef0123456789abcdef',
    metadata: { from: 'CREATED', to: 'CONFIRMED' },
    occurredAt: '2026-10-02T08:00:00.000Z',
  })),
  page: { nextCursor: cursor },
});
const facets = {
  services: [{ service: 'transaction', count: 40 }],
  actions: [{ action: 'transaction.confirm', label: 'Confirmed a deal', count: 12 }],
};

describe('activity log', () => {
  it('is for audit:read only (support is refused)', async () => {
    fakeApi({ ...session(['SUPPORT']) });
    renderApp('/desk/activity');
    expect(await screen.findByRole('heading', { level: 1, name: 'Staff only' })).toBeVisible();
  });

  it('lists entries, pages older ones, expands details and filters by actor via the URL', async () => {
    let page = 0;
    const { calls } = fakeApi({
      ...session(['ADMIN']),
      'GET /api/v1/admin/activity/facets?days=30': () => ({ body: { data: facets } }),
      'GET /api/v1/admin/activity': () => ({ body: activity(2, page++ === 0 ? 'c1' : null) }),
    });
    const { router } = renderApp('/desk/activity');
    expect(await screen.findByRole('heading', { level: 1, name: 'Activity log' })).toBeVisible();
    expect(await screen.findAllByText('Confirmed a deal')).not.toHaveLength(0);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Load older' }));
    await waitFor(() => expect(screen.getByText('4 shown')).toBeInTheDocument());
    expect(calls.some((c) => c.key.includes('cursor=c1'))).toBe(true);

    // Details: metadata and a one-click actor filter.
    await user.click(screen.getAllByText('Confirmed a deal', { selector: '.ledger__title' })[0]!);
    expect(screen.getAllByText(/"to": "CONFIRMED"/)[0]).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Only this account' })[0]!);
    await waitFor(() =>
      expect(router.state.location.search).toContain(
        'actorId=0192f0c4-0000-7000-8000-00000000beef',
      ),
    );
    await waitFor(() =>
      expect(
        calls.some((c) => c.key.includes('actorId=0192f0c4-0000-7000-8000-00000000beef')),
      ).toBe(true),
    );
  });

  it('validates the account id and date range before applying, and sends Dhaka day bounds', async () => {
    const { calls } = fakeApi({
      ...session(['ADMIN']),
      'GET /api/v1/admin/activity/facets?days=30': () => ({ body: { data: facets } }),
      'GET /api/v1/admin/activity': () => ({ body: activity(0, null) }),
    });
    renderApp('/desk/activity');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Account ID'), 'not-an-id');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('An account ID looks like');

    await user.clear(screen.getByLabelText('Account ID'));
    await user.type(screen.getByLabelText('From'), '2026-10-01');
    await user.type(screen.getByLabelText('To'), '2026-10-01');
    await user.selectOptions(await screen.findByLabelText('Service'), 'transaction');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => {
      const c = calls.find((x) => x.key.includes('service=transaction'));
      expect(c?.key).toContain(`from=${encodeURIComponent('2026-10-01T00:00:00+06:00')}`);
      expect(c?.key).toContain(`to=${encodeURIComponent('2026-10-01T18:00:00.000Z')}`);
    });
    expect(await screen.findByText('Nothing matches these filters.')).toBeInTheDocument();
  });

  it('exports CSV with the applied filters through the authenticated client', async () => {
    const { calls } = fakeApi({
      ...session(['ADMIN']),
      'GET /api/v1/admin/activity/facets?days=30': () => ({ body: { data: facets } }),
      'GET /api/v1/admin/activity': () => ({ body: activity(1, null) }),
      'GET /api/v1/admin/activity/export': () => ({ body: 'id,action\n' }),
    });
    const createObjectURL = vi.fn(() => 'blob:x');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    renderApp('/desk/activity?service=transaction');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Export CSV' }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    const exportCall = calls.find((c) => c.key.includes('/export'))!;
    expect(exportCall.key).toContain('service=transaction');
    expect(exportCall.headers['authorization']).toBe('Bearer a');
    click.mockRestore();
  });
});
