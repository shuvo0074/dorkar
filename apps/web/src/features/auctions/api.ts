import type { District, NeedMode } from '@dorkar/contracts';
import { shortCode } from '../../lib/format';
import { api, query, type Page } from '../../lib/http';
import type { Money } from '../../lib/money';

export type AuctionKind = 'FORWARD' | 'REVERSE';
export const AuctionStatuses = [
  'SCHEDULED',
  'OPEN',
  'CLOSING',
  'AWARDED',
  'SETTLED',
  'NO_WINNER',
  'CANCELLED',
] as const;
export type AuctionStatus = (typeof AuctionStatuses)[number];
export type BidStatus = 'LEADING' | 'OUTBID' | 'RETRACTED' | 'WON' | 'LOST';
export type AuctionAction = 'BID' | 'CANCEL' | 'ADMIN_CANCEL' | 'RETRACT_BID';

export interface Auction {
  id: string;
  kind: AuctionKind;
  ownerId: string;
  subjectType: 'LISTING' | 'NEED';
  subjectId: string;
  categoryId: string;
  title: string;
  district: District;
  mode: NeedMode;
  quantity: number;
  startPrice: Money;
  minIncrement: Money;
  reservePrice: Money | null;
  reserveMet: boolean;
  startsAt: string;
  endsAt: string;
  antiSnipeSeconds: number;
  status: AuctionStatus;
  leadingAmount: Money | null;
  bidCount: number;
  hidden: boolean;
  cancelReason: string | null;
  closedAt: string | null;
  createdAt: string;
}

export interface MyBid {
  id: string;
  amount: Money;
  status: BidStatus;
  placedAt: string;
}

export interface AuctionDetail extends Auction {
  actions: AuctionAction[];
  myBid: MyBid | null;
  nextBid: { minimum: Money; maximum: Money | null } | null;
  winnerId: string | null;
}

export interface Bid {
  id: string;
  bidder: string;
  isMine: boolean;
  amount: Money;
  status: BidStatus;
  placedAt: string;
}

export interface MyBidListItem extends MyBid {
  auction: {
    id: string;
    kind: AuctionKind;
    title: string;
    status: AuctionStatus;
    endsAt: string;
    leadingAmount: Money | null;
  };
}

export interface AuctionInput {
  kind: AuctionKind;
  subjectId: string;
  quantity?: number;
  startPrice?: Money;
  reservePrice?: Money | null;
  minIncrement: Money;
  startsAt?: string;
  endsAt: string;
  antiSnipeSeconds?: number;
}

export const auctionCode = (id: string) => shortCode('A', id);

const enc = encodeURIComponent;
const one = <T>(p: Promise<{ data: T }>) => p.then((r) => r.data);

export const auctionsApi = {
  list: (
    f: {
      kind?: AuctionKind | undefined;
      categoryId?: string | undefined;
      district?: string | undefined;
      status?: AuctionStatus | undefined;
    },
    cursor?: string,
  ) => api<Page<Auction>>(`/api/v1/auctions${query({ ...f, cursor, limit: 24 })}`),
  get: (id: string) => one(api<{ data: AuctionDetail }>(`/api/v1/auctions/${enc(id)}`)),
  bids: (id: string, cursor?: string) =>
    api<Page<Bid>>(`/api/v1/auctions/${enc(id)}/bids${query({ cursor, limit: 20 })}`),
  create: (input: AuctionInput, key: string) =>
    one(
      api<{ data: AuctionDetail }>('/api/v1/auctions', {
        method: 'POST',
        body: input,
        idempotencyKey: key,
      }),
    ),
  bid: (id: string, amount: Money, key: string) =>
    one(
      api<{ data: { bid: Bid; auction: AuctionDetail } }>(`/api/v1/auctions/${enc(id)}/bids`, {
        method: 'POST',
        body: { amount },
        idempotencyKey: key,
      }),
    ),
  retract: (id: string, bidId: string, key: string) =>
    one(
      api<{ data: { bid: Bid; auction: AuctionDetail } }>(
        `/api/v1/auctions/${enc(id)}/bids/${enc(bidId)}/retract`,
        { method: 'POST', body: {}, idempotencyKey: key },
      ),
    ),
  cancel: (id: string, reason: string | undefined, key: string) =>
    one(
      api<{ data: AuctionDetail }>(`/api/v1/auctions/${enc(id)}/cancel`, {
        method: 'POST',
        body: reason ? { reason } : {},
        idempotencyKey: key,
      }),
    ),
  mine: (cursor?: string) =>
    api<Page<Auction>>(`/api/v1/me/auctions${query({ cursor, limit: 20 })}`),
  myBids: (cursor?: string) =>
    api<Page<MyBidListItem>>(`/api/v1/me/bids${query({ cursor, limit: 20 })}`),

  // Staff
  adminList: (status: AuctionStatus | undefined, cursor?: string) =>
    api<Page<Auction>>(`/api/v1/admin/auctions${query({ status, cursor, limit: 20 })}`),
  adminCancel: (id: string, reason: string, key: string) =>
    one(
      api<{ data: AuctionDetail }>(`/api/v1/admin/auctions/${enc(id)}/cancel`, {
        method: 'POST',
        body: { reason },
        idempotencyKey: key,
      }),
    ),
};
