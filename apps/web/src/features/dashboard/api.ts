import { api, apiBlob } from '../../lib/http';

/** Integer poisha + currency, as every API returns money. */
export interface Money {
  amount: number;
  currency: 'BDT';
}

// ---------------------------------------------------------------- personal

export interface PersonalDashboard {
  buyer: {
    openNeeds: number;
    offersAwaitingResponse: number;
    transactionsByState: Record<string, number>;
    totalSpent: Money;
  };
  seller: {
    offersByStatus: Record<string, number>;
    transactionsByState: Record<string, number>;
    earnings: Money;
    rating: { average: number | null; count: number; completedCount: number } | null;
  };
  auctions: {
    owned: number;
    bidding: number;
    live: Array<{ auctionId: string; role: 'OWNER' | 'BIDDER'; endsAt: string | null }>;
  };
  bookings: {
    asRenter: number;
    asOwner: number;
    items: Array<{
      bookingId: string;
      listingId: string;
      role: 'OWNER' | 'RENTER';
      status: string;
      startAt: string | null;
      endAt: string | null;
    }>;
  };
  loans: {
    asLender: number;
    asBorrower: number;
    items: Array<{
      loanId: string;
      itemId: string;
      role: 'LENDER' | 'BORROWER';
      status: string;
      returnBy: string | null;
    }>;
  };
  disputes: {
    open: number;
    items: Array<{
      disputeId: string;
      transactionId: string;
      role: 'BUYER' | 'SELLER';
      status: string;
    }>;
  };
}

export interface Target {
  type: string | null;
  id: string | null;
}

export interface MyActivity {
  id: string;
  service: string;
  action: string;
  label: string;
  target: Target | null;
  /** null for your own actions; "Dorkar team" for staff actions on your account. */
  actor: { displayName: string } | null;
  occurredAt: string;
}

export interface Page<T> {
  data: T[];
  page: { nextCursor: string | null };
}

// ---------------------------------------------------------------- admin

export const Metrics = [
  'signups',
  'logins',
  'needs_published',
  'listings_published',
  'offers_submitted',
  'offers_accepted',
  'transactions_created',
  'transactions_completed',
  'gmv_completed',
  'transactions_cancelled',
  'disputes_opened',
  'disputes_resolved',
  'reviews_created',
  'auctions_opened',
  'bids_placed',
  'auctions_awarded',
  'bookings_confirmed',
  'loans_approved',
  'messages_sent',
  'verifications',
] as const;
export type Metric = (typeof Metrics)[number];

export interface MetricChange {
  metric: Metric;
  current: number;
  previous: number;
  change: number;
  changePct: number | null;
}

export interface Summary {
  generatedAt: string;
  today: string;
  gauges: {
    needsByStatus: Record<string, number>;
    activeListings: number;
    transactionsByState: Array<{ state: string; count: number; amount: Money }>;
    openDisputes: number;
    pendingVerifications: number;
    liveAuctions: number;
    upcomingBookings: number;
    activeBookings: number;
    activeLoans: number;
  };
  periods: Array<{
    days: number;
    from: string;
    to: string;
    previousFrom: string;
    previousTo: string;
    metrics: MetricChange[];
  }>;
}

export interface Series {
  metric: Metric;
  dimension: string;
  interval: 'day' | 'week';
  from: string;
  to: string;
  total: number;
  points: Array<{ start: string; value: number }>;
}

export const FunnelSteps = [
  'needsPublished',
  'needsWithOffer',
  'offersAccepted',
  'transactionsCompleted',
] as const;
export type FunnelStep = (typeof FunnelSteps)[number];

export interface Funnel {
  from: string;
  to: string;
  steps: Array<{ step: FunnelStep; count: number; conversionPct: number | null }>;
}

export const ActorTypes = ['USER', 'ADMIN', 'SYSTEM', 'ANONYMOUS'] as const;
export type ActorType = (typeof ActorTypes)[number];

export interface Activity {
  id: string;
  service: string;
  action: string;
  label: string;
  actor: { id: string | null; type: ActorType; displayName: string | null };
  target: Target | null;
  requestId: string | null;
  ipHash: string | null;
  metadata: Record<string, unknown>;
  occurredAt: string;
}

export interface Facets {
  services: Array<{ service: string; count: number }>;
  actions: Array<{ action: string; label: string; count: number }>;
}

/** Filters the activity log understands; all optional. Dates are YYYY-MM-DD (Dhaka days). */
export interface ActivityFilter {
  service?: string | undefined;
  action?: string | undefined;
  actorType?: ActorType | undefined;
  actorId?: string | undefined;
  targetType?: string | undefined;
  targetId?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

/** Bangladesh has no DST: a Dhaka calendar day is a fixed +06:00 window. */
const dayStart = (d: string) => `${d}T00:00:00+06:00`;
const nextDayStart = (d: string) => {
  const t = new Date(`${d}T00:00:00+06:00`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString();
};

export function filterQuery(f: ActivityFilter, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams();
  if (f.service) q.set('service', f.service);
  if (f.action) q.set('action', f.action);
  if (f.actorType) q.set('actorType', f.actorType);
  if (f.actorId) q.set('actorId', f.actorId);
  if (f.targetType) q.set('targetType', f.targetType);
  if (f.targetId) q.set('targetId', f.targetId);
  if (f.from) q.set('from', dayStart(f.from));
  // `to` is inclusive of the whole chosen day.
  if (f.to) q.set('to', nextDayStart(f.to));
  for (const [k, v] of Object.entries(extra)) q.set(k, v);
  const s = q.toString();
  return s ? `?${s}` : '';
}

export const dashboardApi = {
  personal: () => api<{ data: PersonalDashboard }>('/api/v1/me/dashboard').then((r) => r.data),
  myActivity: (scope: 'mine' | 'about-me', cursor?: string) =>
    api<Page<MyActivity>>(
      `/api/v1/me/activity?scope=${scope}&limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    ),

  summary: () => api<{ data: Summary }>('/api/v1/admin/dashboard/summary').then((r) => r.data),
  series: (metric: Metric, interval: 'day' | 'week', from: string, to: string) =>
    api<{ data: Series }>(
      `/api/v1/admin/dashboard/timeseries?metric=${metric}&interval=${interval}&from=${from}&to=${to}`,
    ).then((r) => r.data),
  funnel: (from: string, to: string) =>
    api<{ data: Funnel }>(`/api/v1/admin/dashboard/funnel?from=${from}&to=${to}`).then(
      (r) => r.data,
    ),

  activity: (f: ActivityFilter, cursor?: string) =>
    api<Page<Activity>>(
      `/api/v1/admin/activity${filterQuery(f, { limit: '30', ...(cursor ? { cursor } : {}) })}`,
    ),
  facets: () => api<{ data: Facets }>('/api/v1/admin/activity/facets?days=30').then((r) => r.data),
  exportCsv: (f: ActivityFilter) => apiBlob(`/api/v1/admin/activity/export${filterQuery(f)}`),
};
