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
