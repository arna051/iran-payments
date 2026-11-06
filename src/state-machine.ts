import { PaymentError } from './errors.js';
import type { PaymentState } from './types.js';
const transitions: Record<PaymentState, readonly PaymentState[]> = {
  created: ['provider_pending', 'customer_action_required', 'failed', 'unknown'],
  provider_pending: [
    'customer_action_required',
    'callback_received',
    'paid',
    'cancelled',
    'expired',
    'failed',
    'unknown',
    'verifying',
  ],
  customer_action_required: [
    'callback_received',
    'paid',
    'cancelled',
    'expired',
    'failed',
    'unknown',
    'verifying',
  ],
  callback_received: ['verifying', 'cancelled', 'failed', 'unknown'],
  verifying: ['paid', 'failed', 'unknown', 'manual_review'],
  paid: ['partially_refunded', 'refunded', 'reversed', 'manual_review'],
  partially_refunded: ['partially_refunded', 'refunded', 'manual_review'],
  refunded: [],
  reversed: [],
  cancelled: [],
  expired: ['verifying', 'paid', 'manual_review'],
  failed: ['verifying', 'paid', 'manual_review'],
  unknown: [
    'provider_pending',
    'customer_action_required',
    'paid',
    'failed',
    'cancelled',
    'expired',
    'manual_review',
    'verifying',
  ],
  manual_review: ['paid', 'failed', 'cancelled', 'refunded'],
};
export function canTransition(from: PaymentState, to: PaymentState): boolean {
  return from === to || transitions[from].includes(to);
}
export function assertTransition(from: PaymentState, to: PaymentState): void {
  if (!canTransition(from, to))
    throw new PaymentError(
      'INVALID_STATE_TRANSITION',
      `Cannot transition payment from ${from} to ${to}`,
      { from, to },
    );
}
