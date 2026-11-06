export type PaymentErrorCode =
  | 'INVALID_INPUT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'UNSUPPORTED_OPERATION'
  | 'INVALID_STATE_TRANSITION'
  | 'CONFIGURATION_NOT_FOUND'
  | 'GATEWAY_UNAVAILABLE'
  | 'PROVIDER_ERROR'
  | 'PROVIDER_RESPONSE_INVALID'
  | 'CALLBACK_UNCORRELATED'
  | 'AMOUNT_MISMATCH'
  | 'CONCURRENCY_CONFLICT'
  | 'ENCRYPTION_ERROR'
  | 'UNKNOWN_OUTCOME';
export class PaymentError extends Error {
  constructor(
    public readonly code: PaymentErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'PaymentError';
  }
}
