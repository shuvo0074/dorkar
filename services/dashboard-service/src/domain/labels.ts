/**
 * Human labels for audit actions. Keys are the action strings services pass to `appendAudit`
 * (grep `action:` across services/*\/src). Unknown actions get a generic label built from the
 * action itself, so a new action never breaks the log; add it here to give it a proper sentence.
 */
export const ACTION_LABELS: Readonly<Record<string, string>> = {
  // identity
  'auth.otp_requested': 'Requested a login code',
  'auth.otp_verify_failed': 'Entered a wrong login code',
  'auth.account_created': 'Created an account',
  'auth.login_succeeded': 'Signed in',
  'auth.login_denied': 'Sign-in was refused',
  'auth.logout': 'Signed out',
  'auth.logout_all': 'Signed out on all devices',
  'session.refresh_reuse_detected': 'A reused session token was detected and the session ended',
  'device.registered': 'Signed in on a new device',
  'device.revoked': 'Removed a device',
  'contact.read': 'Contact details were shared with a deal partner',
  'admin.account_status_changed': 'Changed an account status',
  'admin.role_granted': 'Granted a staff role',
  // media
  'media.upload_created': 'Started a file upload',
  'media.completed': 'Finished a file upload',
  'media.deleted': 'Deleted a file',
  // verification
  'verification.nid.submitted': 'Submitted a national ID for verification',
  'verification.decided': 'Decided a verification request',
  'verification.policy.created': 'Created a verification policy',
  'verification.policy.updated': 'Updated a verification policy',
  'verification.policy.deactivated': 'Deactivated a verification policy',
  // catalog / demand
  'category.created': 'Created a category',
  'category.updated': 'Updated a category',
  'listing.hidden': 'Hid a listing',
  'listing.restored': 'Restored a listing',
  'need.hidden': 'Hid a need',
  'need.restored': 'Restored a need',
  // offers
  'offer.submit': 'Submitted an offer',
  'offer.counter': 'Countered an offer',
  'offer.accept': 'Accepted an offer',
  'offer.reject': 'Rejected an offer',
  'offer.withdraw': 'Withdrew an offer',
  'offer.admin_read': 'Viewed an offer as staff',
  // transactions
  'transaction.created': 'Started a deal',
  'transaction.confirm': 'Confirmed a deal',
  'transaction.cancel': 'Cancelled a deal',
  'transaction.expire': 'A deal expired',
  'transaction.arrange-delivery': 'Arranged delivery',
  'transaction.mark-delivered': 'Marked a deal as delivered',
  'transaction.confirm-receipt': 'Confirmed receipt',
  'transaction.auto-complete': 'A deal completed automatically',
  'transaction.dispute': 'Disputed a deal',
  'transaction.resolve-release': 'Resolved a dispute by completing the deal',
  'transaction.resolve-cancel': 'Resolved a dispute by cancelling the deal',
  'transaction.resolve-refund': 'Resolved a dispute with a refund',
  'transaction.auto-confirm': 'A deal was confirmed automatically',
  'transaction.hand-over': 'Handed an item over',
  'transaction.report-return': 'Reported an item returned',
  'transaction.confirm-return': 'Confirmed an item came back',
  'transaction.complete': 'Completed a deal',
  'transaction.withdraw-dispute': 'A dispute was withdrawn and the deal resumed',
  'transaction.dispute-refund-ignored': 'A refund was not applied because the deal was in cash',
  // bidding
  'auction.create': 'Started an auction',
  'auction.cancel': 'Cancelled an auction',
  'auction.admin_cancel': 'Cancelled an auction as staff',
  'auction.cancel_subject_gone': 'An auction ended because its item or need was withdrawn',
  'bid.place': 'Placed a bid',
  'bid.retract': 'Withdrew a bid',
  // rental
  'booking.requested': 'Requested a rental booking',
  'booking.confirm': 'Confirmed a rental booking',
  'booking.approve': 'Approved a rental booking',
  'booking.decline': 'Declined a rental booking',
  'booking.cancel': 'Cancelled a rental booking',
  'booking.expire': 'A rental booking request expired',
  'booking.mirror-handed-over': 'A rented item was handed over',
  'booking.mirror-returned': 'A rented item came back',
  'booking.mirror-completed': 'A rental was completed',
  'booking.mirror-cancelled': 'A rental was cancelled',
  'booking.overdue': 'A rented item is overdue',
  'rental.terms-updated': 'Updated rental terms',
  'rental.block-added': 'Blocked dates on the rental calendar',
  'rental.block-removed': 'Freed dates on the rental calendar',
  // lending
  'lending.item.created': 'Listed an item to lend',
  'lending.item.updated': 'Updated an item to lend',
  'lending.item.deactivated': 'Took an item off the lending shelf',
  'lending.loan.requested': 'Asked to borrow an item',
  'lending.loan.approve': 'Agreed to lend an item',
  'lending.loan.decline': 'Declined a borrow request',
  'lending.loan.cancel': 'Cancelled a borrow request',
  'lending.loan.expire': 'A borrow request expired',
  'lending.loan.mirrored': 'A loan moved on with its deal',
  'lending.loan.overdue': 'A borrowed item is overdue',
  // disputes
  'dispute.opened': 'Opened a dispute',
  'dispute.submit-statement': 'Answered a dispute',
  'dispute.respondent-deadline': 'A dispute answer was not given in time',
  'dispute.resolve': 'Decided a dispute',
  'dispute.withdraw': 'Withdrew a dispute',
  'dispute.close-without-decision': 'A dispute closed without a decision',
  'dispute.applied': 'A dispute decision was applied to the deal',
  'dispute.assigned': 'Took a dispute case',
  'dispute.escalated': 'A dispute was escalated',
  'dispute.evidence.added': 'Added evidence to a dispute',
  'dispute.info.requested': 'Asked for more information on a dispute',
  'dispute.note.added': 'Added a staff note to a dispute',
  // messaging
  'conversation.created': 'Started a conversation',
  'user.blocked': 'Blocked someone',
  'user.unblocked': 'Unblocked someone',
  'message.read.admin': 'Read a reported message as staff',
  // media
  'media.access_granted': 'Shared a private file with a deal partner',
  // reputation
  'review.create': 'Wrote a review',
  'review.hide': 'Hid a review',
  'review.restore': 'Restored a review',
  // moderation
  'moderation.cases.listed': 'Listed moderation cases',
  'moderation.case.viewed': 'Viewed a moderation case',
  'moderation.case.assigned': 'Took a moderation case',
  'moderation.case.hide': 'Hid reported content',
  'moderation.case.restore': 'Restored reported content',
  'moderation.case.dismiss': 'Dismissed a report',
  // dashboard
  'activity.exported': 'Exported the activity log',
};

const humanize = (s: string) => s.replace(/[_\-.:]+/g, ' ').trim();

/** `transaction.mark-delivered` → known sentence; `bidding.bid_retracted` → "Bidding: bid retracted". */
export function labelFor(action: string): string {
  const known = ACTION_LABELS[action];
  if (known) return known;
  const dot = action.indexOf('.');
  const area = humanize(dot > 0 ? action.slice(0, dot) : action);
  const rest = dot > 0 ? humanize(action.slice(dot + 1)) : '';
  const head = area ? area.charAt(0).toUpperCase() + area.slice(1) : 'Activity';
  return rest ? `${head}: ${rest}` : head;
}
