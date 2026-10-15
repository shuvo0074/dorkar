import { useFormat } from '../../lib/format';
import { useI18n } from '../../lib/i18n';
import type { Money } from '../../lib/money';
import type { Notification, PayloadValue } from './api';

const str = (v: PayloadValue | undefined) => (typeof v === 'string' ? v : '');
const isMoney = (v: PayloadValue | undefined): v is Money =>
  typeof v === 'object' && v !== null && 'amount' in v;

/** A notification as one sentence in the page language, and where it leads. */
export function useNotificationText() {
  const { t, num } = useI18n();
  const f = useFormat();
  return (n: Notification): { text: string; href: string | null } => {
    const p = n.payload;
    const money = (k: string) => (isMoney(p[k]) ? f.taka(p[k]) : '');
    const id = (k: string) => str(p[k]);
    switch (n.type) {
      case 'NEED_MATCHED':
        return { text: t('note.NEED_MATCHED'), href: `/needs/${id('needId')}` };
      case 'OFFER_RECEIVED':
      case 'OFFER_ACCEPTED':
        return {
          text: t(`note.${n.type}`, { price: money('price') }),
          href: `/offers/${id('offerId')}`,
        };
      case 'OFFER_COUNTERED':
        return {
          text: t('note.OFFER_COUNTERED', {
            price: money('price'),
            round: typeof p['round'] === 'number' ? num(p['round']) : '',
          }),
          href: `/offers/${id('offerId')}`,
        };
      case 'OFFER_REJECTED':
      case 'OFFER_CLOSED':
        return { text: t(`note.${n.type}`), href: `/offers/${id('offerId')}` };
      case 'TRANSACTION_CREATED':
        return {
          text: t('note.TRANSACTION_CREATED', { amount: money('amount') }),
          href: `/deals/${id('transactionId')}`,
        };
      case 'TRANSACTION_UPDATED':
        return {
          text: t('note.TRANSACTION_UPDATED', { state: f.state(id('to')) }),
          href: `/deals/${id('transactionId')}`,
        };
      case 'NEED_EXPIRED':
      case 'NEED_FULFILLING':
        return { text: t(`note.${n.type}`), href: `/needs/${id('needId')}` };
      case 'REVIEW_RECEIVED':
        return {
          text: t('note.REVIEW_RECEIVED', {
            rating: typeof p['rating'] === 'number' ? num(p['rating']) : '',
          }),
          href: `/deals/${id('transactionId')}`,
        };
      case 'VERIFICATION_UPDATED':
        return {
          text: t('note.VERIFICATION_UPDATED', { status: f.state(id('status')) }),
          href: '/account/profile',
        };
      case 'BID_PLACED':
        return {
          text: t('note.BID_PLACED', { amount: money('amount') }),
          href: `/auctions/${id('auctionId')}`,
        };
      case 'BID_OUTBID':
        return {
          text: t('note.BID_OUTBID', { amount: money('leadingAmount') }),
          href: `/auctions/${id('auctionId')}`,
        };
      case 'AUCTION_CLOSED':
      case 'AUCTION_WON':
      case 'AUCTION_LOST':
      case 'AUCTION_CANCELLED':
        return { text: t(`note.${n.type}`), href: `/auctions/${id('auctionId')}` };
      case 'BOOKING_REQUESTED':
      case 'BOOKING_CONFIRMED':
      case 'BOOKING_DECLINED':
      case 'BOOKING_EXPIRED':
      case 'BOOKING_CANCELLED':
      case 'BOOKING_OVERDUE':
        return { text: t(`note.${n.type}`), href: `/bookings/${id('bookingId')}` };
      case 'LOAN_REQUESTED':
      case 'LOAN_APPROVED':
      case 'LOAN_DECLINED':
      case 'LOAN_EXPIRED':
      case 'LOAN_OVERDUE':
        return { text: t(`note.${n.type}`), href: `/loans/${id('loanId')}` };
      case 'DISPUTE_UPDATED':
        return {
          text: t('note.DISPUTE_UPDATED', { state: f.state(id('to')) }),
          href: `/disputes/${id('disputeId')}`,
        };
      case 'DISPUTE_OPENED':
      case 'DISPUTE_RESOLVED':
      case 'DISPUTE_WITHDRAWN':
        return { text: t(`note.${n.type}`), href: `/disputes/${id('disputeId')}` };
      case 'NEW_MESSAGE': {
        const count = typeof p['count'] === 'number' ? p['count'] : 1;
        return {
          text: count > 1 ? t('note.NEW_MESSAGE', { count }) : t('note.NEW_MESSAGE.one'),
          href: `/messages/${id('conversationId')}`,
        };
      }
      default:
        return { text: String(n.type).toLowerCase().replace(/_/g, ' '), href: null };
    }
  };
}
