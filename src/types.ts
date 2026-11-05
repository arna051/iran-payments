import type { ClientSession } from 'mongoose';

export const gatewayIds = ['zarinpal', 'torobpay', 'digipay', 'snapppay', 'azkivam', 'budgetpay'] as const;
export type GatewayId = (typeof gatewayIds)[number];
export type Currency = 'IRR' | 'IRT';
export type PaymentModel = 'redirect' | 'wallet' | 'bnpl' | 'installment' | 'hybrid';
export type PaymentState =
  | 'created' | 'provider_pending' | 'customer_action_required' | 'callback_received'
  | 'verifying' | 'paid' | 'partially_refunded' | 'refunded' | 'reversed'
  | 'cancelled' | 'expired' | 'failed' | 'unknown' | 'manual_review';

export interface Money { value: number; currency: Currency }
export interface PaymentReference { type: string; id: string }
export interface Customer { phone?: string; email?: string; nationalId?: string }
export interface GatewayCapabilities {
  paymentModel: PaymentModel; createPayment: boolean; customerEligibility: boolean;
  installmentPlans: boolean; inquiry: boolean; verify: boolean; reverse: boolean;
  cancel: boolean; partialRefund: boolean; fullRefund: boolean; webhook: boolean;
  redirectCallback: boolean; reconciliation: boolean;
}
export interface StartPaymentInput<TExtensions = unknown> {
  gateway: GatewayId; configurationId?: string; idempotencyKey: string; amount: Money;
  reference: PaymentReference; customer?: Customer; callbackUrl: string;
  description?: string; metadata?: Record<string, unknown>; extensions?: TExtensions;
}
export interface StartPaymentResult {
  id: string; gateway: GatewayId; state: PaymentState; redirectUrl?: string;
  providerReference?: string; idempotentReplay: boolean;
}
export interface CallbackInput {
  gateway: GatewayId; query?: Record<string, unknown>; body?: unknown;
  headers?: Record<string, string | string[] | undefined>; rawBody?: Uint8Array;
}
export interface ProviderCreateResult {
  providerReference: string; redirectUrl?: string; providerState?: string;
  wireAmount: Money; expiresAt?: Date; raw?: unknown;
}
export interface ProviderVerifyResult {
  paid: boolean; providerReference?: string; providerTransactionId?: string;
  providerState?: string; amount?: Money; raw?: unknown;
}
export interface ProviderInquiryResult extends ProviderVerifyResult { definitive: boolean }
export interface ProviderOperationResult { providerState?: string; providerOperationId?: string; amount?: Money; raw?: unknown }
export interface ProviderContext { signal?: AbortSignal; configuration: Record<string, unknown> }
export interface GatewayAdapter<TExtensions = unknown> {
  readonly id: GatewayId; readonly capabilities: GatewayCapabilities;
  create(input: StartPaymentInput<TExtensions>, context: ProviderContext): Promise<ProviderCreateResult>;
  correlateCallback(input: CallbackInput): Promise<{ providerReference: string }> | { providerReference: string };
  verify?(attempt: PaymentAttemptRecord, input: CallbackInput | undefined, context: ProviderContext): Promise<ProviderVerifyResult>;
  inquiry?(attempt: PaymentAttemptRecord, context: ProviderContext): Promise<ProviderInquiryResult>;
  cancel?(attempt: PaymentAttemptRecord, idempotencyKey: string, context: ProviderContext): Promise<ProviderOperationResult>;
  reverse?(attempt: PaymentAttemptRecord, idempotencyKey: string, context: ProviderContext): Promise<ProviderOperationResult>;
  refund?(attempt: PaymentAttemptRecord, amount: Money, idempotencyKey: string, context: ProviderContext): Promise<ProviderOperationResult>;
}
export interface PaymentAttemptRecord {
  _id: unknown; gateway: GatewayId; state: PaymentState; idempotencyKey: string; requestFingerprint: string;
  reference: PaymentReference; amount: Money; wireAmount?: Money; providerReference?: string;
  providerTransactionId?: string; paidAmount: number; refundedAmount: number; providerState?: string;
  configurationId?: unknown; callbackUrl: string; metadata?: Record<string, unknown>; __v?: number;
}
export type PaymentEvent = { type: 'paid' | 'refunded' | 'failed' | 'reversed'; attemptId: string; gateway: GatewayId; reference: PaymentReference; amount: Money };
export interface PaymentEvents { onEvent?(event: PaymentEvent, session?: ClientSession): Promise<void> }
