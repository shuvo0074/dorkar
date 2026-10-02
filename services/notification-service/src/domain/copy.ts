import type { Notification, NotificationPayload, PayloadValue } from './notification';

/**
 * Short English copy for out-of-band channels (push, and SMS for the Phase 2 types). Built only
 * from the notification's type and enum-like payload facts: never names, phone numbers, message
 * bodies, free text or amounts. Clients render the in-app text themselves from type + payload.
 */
export interface Copy {
  title: string;
  body: string;
}

const str = (v: PayloadValue | undefined): string | null => (typeof v === 'string' ? v : null);

const words = (v: PayloadValue | undefined): string =>
  typeof v === 'string' ? v.toLowerCase().replace(/_/g, ' ') : '';

const count = (p: NotificationPayload): number => {
  const c = p['count'];
  return typeof c === 'number' && Number.isInteger(c) && c > 1 ? c : 1;
};

/** Transaction states that have their own wording (RENT/BORROW hand-over and return). */
const transactionUpdate = (to: string | null): Copy => {
  switch (to) {
    case 'HANDED_OVER':
      return { title: 'Item handed over', body: 'The item in your deal was handed over.' };
    case 'RETURN_REPORTED':
      return {
        title: 'Return reported',
        body: 'The item was reported as returned. Please confirm in the app.',
      };
    case 'RETURNED':
      return { title: 'Item returned', body: 'The return of the item in your deal is confirmed.' };
    default:
      return { title: 'Deal updated', body: `Your deal is now ${words(to) || 'updated'}.` };
  }
};

export function copyFor(n: Pick<Notification, 'type' | 'payload'>): Copy {
  const p = n.payload;
  switch (n.type) {
    case 'NEED_MATCHED':
      return { title: 'New matching request', body: 'A new buyer request matches what you offer.' };
    case 'OFFER_RECEIVED':
      return { title: 'New offer', body: 'You received a new offer on your request.' };
    case 'OFFER_COUNTERED':
      return { title: 'Counter-offer', body: 'You received a counter-offer.' };
    case 'OFFER_ACCEPTED':
      return { title: 'Offer accepted', body: 'Your offer was accepted.' };
    case 'OFFER_REJECTED':
      return { title: 'Offer declined', body: 'Your offer was declined.' };
    case 'OFFER_CLOSED':
      return { title: 'Request closed', body: 'A request you made an offer on is no longer open.' };
    case 'TRANSACTION_CREATED':
      return { title: 'Deal created', body: 'You have a new deal. Next steps are in the app.' };
    case 'TRANSACTION_UPDATED':
      return transactionUpdate(str(p['to']));
    case 'NEED_EXPIRED':
      return {
        title: 'Request expired',
        body: 'Your request has expired. You can renew it in the app.',
      };
    case 'NEED_FULFILLING':
      return { title: 'Request in progress', body: 'Your request is being fulfilled.' };
    case 'REVIEW_RECEIVED':
      return { title: 'New review', body: 'You received a new review.' };
    case 'VERIFICATION_UPDATED':
      return p['status'] === 'VERIFIED'
        ? { title: 'Verification approved', body: 'Your NID verification is approved.' }
        : {
            title: 'Verification not approved',
            body: 'Your NID verification was not approved. See the app for details.',
          };

    case 'BID_PLACED':
      return {
        title: 'New bid on your auction',
        body: 'Someone placed a new bid on your auction.',
      };
    case 'BID_OUTBID':
      return { title: 'You were outbid', body: 'Another bidder outbid you. Bid again in the app.' };
    case 'AUCTION_CLOSED':
      switch (str(p['outcome'])) {
        case 'AWARDED':
          return { title: 'Auction ended', body: 'Your auction ended with a winning bid.' };
        case 'CANCELLED':
          return { title: 'Auction cancelled', body: 'Your auction was cancelled.' };
        default:
          return { title: 'Auction ended', body: 'Your auction ended without a winner.' };
      }
    case 'AUCTION_WON':
      return { title: 'You won the auction', body: 'Your bid won. Next steps are in the app.' };
    case 'AUCTION_LOST':
      return { title: 'Auction ended', body: 'An auction you bid on ended. Your bid did not win.' };
    case 'AUCTION_CANCELLED':
      return { title: 'Auction cancelled', body: 'An auction you bid on was cancelled.' };

    case 'BOOKING_REQUESTED':
      return {
        title: 'New booking request',
        body: 'Someone wants to rent your item. Please respond.',
      };
    case 'BOOKING_CONFIRMED':
      return {
        title: 'Booking confirmed',
        body: 'A rental booking is confirmed. Details are in the app.',
      };
    case 'BOOKING_DECLINED':
      return { title: 'Booking declined', body: 'Your booking request was declined.' };
    case 'BOOKING_EXPIRED':
      return { title: 'Booking expired', body: 'Your booking request expired without a response.' };
    case 'BOOKING_CANCELLED':
      return { title: 'Booking cancelled', body: 'A rental booking was cancelled.' };
    case 'BOOKING_OVERDUE':
      return p['role'] === 'RENTER'
        ? { title: 'Rental overdue', body: 'Your rental period has ended. Please return the item.' }
        : { title: 'Rental overdue', body: 'Your rented-out item is past its return time.' };

    case 'LOAN_REQUESTED':
      return {
        title: 'New borrow request',
        body: 'Someone wants to borrow your item. Please respond.',
      };
    case 'LOAN_APPROVED':
      return { title: 'Borrow request approved', body: 'Your request to borrow was approved.' };
    case 'LOAN_DECLINED':
      return { title: 'Borrow request declined', body: 'Your request to borrow was declined.' };
    case 'LOAN_EXPIRED':
      return {
        title: 'Borrow request expired',
        body: 'Your request to borrow expired without a response.',
      };
    case 'LOAN_OVERDUE':
      return p['role'] === 'BORROWER'
        ? { title: 'Loan overdue', body: 'The return date has passed. Please return the item.' }
        : { title: 'Loan overdue', body: 'Your lent item is past its return date.' };

    case 'DISPUTE_OPENED':
      return p['role'] === 'RESPONDENT'
        ? {
            title: 'Dispute opened on your deal',
            body: 'The other party opened a dispute. Please respond in the app.',
          }
        : { title: 'Dispute opened', body: 'A dispute was opened on your deal.' };
    case 'DISPUTE_UPDATED':
      return {
        title: 'Dispute updated',
        body: `Your dispute is now ${words(p['to']) || 'updated'}.`,
      };
    case 'DISPUTE_RESOLVED':
      return {
        title: 'Dispute resolved',
        body: 'Your dispute was resolved. See the outcome in the app.',
      };
    case 'DISPUTE_WITHDRAWN':
      return { title: 'Dispute withdrawn', body: 'The dispute on your deal was withdrawn.' };

    case 'NEW_MESSAGE': {
      const c = count(p);
      return {
        title: 'New message',
        body: c > 1 ? `You have ${c} new messages.` : 'You have a new message.',
      };
    }
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Builds `/<prefix>/<id>` only from a well-formed id, so a payload can never inject a path. */
const at = (prefix: string, v: PayloadValue | undefined): string | null =>
  typeof v === 'string' && UUID.test(v) ? `${prefix}/${v}` : null;

/** In-app deep-link path (relative; clients resolve it). Falls back to the inbox. */
export function deepLinkFor(n: Pick<Notification, 'type' | 'payload'>): string {
  const p = n.payload;
  const path = ((): string | null => {
    switch (n.type) {
      case 'NEED_MATCHED':
      case 'NEED_EXPIRED':
      case 'NEED_FULFILLING':
        return at('/needs', p['needId']);
      case 'OFFER_RECEIVED':
      case 'OFFER_COUNTERED':
      case 'OFFER_ACCEPTED':
      case 'OFFER_REJECTED':
      case 'OFFER_CLOSED':
        return at('/offers', p['offerId']);
      case 'TRANSACTION_CREATED':
      case 'TRANSACTION_UPDATED':
      case 'REVIEW_RECEIVED':
        return at('/transactions', p['transactionId']);
      case 'VERIFICATION_UPDATED':
        return '/account/verification';
      case 'BID_PLACED':
      case 'BID_OUTBID':
      case 'AUCTION_CLOSED':
      case 'AUCTION_WON':
      case 'AUCTION_LOST':
      case 'AUCTION_CANCELLED':
        return at('/auctions', p['auctionId']);
      case 'BOOKING_REQUESTED':
      case 'BOOKING_CONFIRMED':
      case 'BOOKING_DECLINED':
      case 'BOOKING_EXPIRED':
      case 'BOOKING_CANCELLED':
      case 'BOOKING_OVERDUE':
        return at('/rentals/bookings', p['bookingId']);
      case 'LOAN_REQUESTED':
      case 'LOAN_APPROVED':
      case 'LOAN_DECLINED':
      case 'LOAN_EXPIRED':
      case 'LOAN_OVERDUE':
        return at('/loans', p['loanId']);
      case 'DISPUTE_OPENED':
      case 'DISPUTE_UPDATED':
      case 'DISPUTE_RESOLVED':
      case 'DISPUTE_WITHDRAWN':
        return at('/disputes', p['disputeId']);
      case 'NEW_MESSAGE':
        return at('/messages', p['conversationId']);
    }
  })();
  return path ?? '/notifications';
}
