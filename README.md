# iran-payments

Secure, provider-neutral backend payment orchestration for Iranian gateways and BNPL providers. The package treats callbacks as untrusted, keeps IRR/IRT explicit, encrypts provider configuration with AES-256-GCM, persists idempotency and operational evidence in caller-owned Mongoose models, and exposes capability discovery instead of pretending every provider supports the same operations.

## Status

This release includes orchestration, persistence, encryption, state-machine, idempotency, outbox, Express, Next.js, and NestJS foundations. Zarinpal is a built-in adapter. Additional provider adapters are isolated by capability and contract.

```ts
import mongoose from 'mongoose';
import { createPaymentGateways, ZarinpalAdapter } from 'iran-payments';

const payments = createPaymentGateways({
  connection: mongoose.connection,
  encryption: { current: { id: 'v1', key: process.env.PAYMENT_CONFIG_ENCRYPTION_KEY! } },
  adapters: [new ZarinpalAdapter()],
});

await payments.configure({
  provider: 'zarinpal', label: 'Primary gateway', environment: 'production',
  credentials: { merchantId: process.env.ZARINPAL_MERCHANT_ID, currency: 'IRR' },
});

const payment = await payments.create({
  gateway: 'zarinpal', idempotencyKey: 'checkout-order-123-v1',
  amount: { value: 15_000_000, currency: 'IRR' },
  reference: { type: 'order', id: 'order-123' },
  callbackUrl: 'https://example.com/payments/callback/zarinpal',
});
```

The encryption key is 32 random bytes encoded as base64. Never expose configuration or package server exports to a browser bundle. MongoDB transactions require a replica set; an external gateway call is never part of a database transaction. Consume outbox records with idempotent host handlers to mark orders paid exactly once.

## Financial safety

- A redirect callback is not proof of payment; `verifyCallback` performs provider verification.
- Do not retry timed-out financial POSTs blindly. Treat them as unknown and reconcile.
- The host supplies trusted amount and reference. Never accept them from a browser callback.
- Do not infer rial versus toman. Conversion rejects lossy values.
- Refund, cancellation, reversal, and local order cancellation are distinct operations.
- No live financial tests run as part of this package's test suite.

See [SECURITY.md](SECURITY.md) for reporting and operational guidance.

## Admin configuration and checkout discovery

NestJS administration is absent by default. Enable it only with a host-owned guard class so Nest can construct the guard through dependency injection:

```ts
PaymentGatewaysModule.forRoot({
  connection,
  encryption,
  adapters,
  admin: { enabled: true, guard: ApplicationAdminGuard },
  discovery: { enabled: true },
});
```

Admin routes save credentials as write-only encrypted data. Saving or replacing credentials leaves the configuration disabled and unverified. A non-financial provider verification must succeed before an administrator can enable it. Admin responses expose only `configured` and a fixed mask, never credential values or encrypted blobs.

`POST /payment-gateways/available` returns an explicitly allowlisted presentation DTO for verified, enabled, production configurations in the requested scope. Titles support Persian text; colours must be uppercase `#RRGGBB`; icons are controlled built-ins or HTTPS URLs. Static discovery does not perform customer credit checks and is never payment authorization. The backend repeats configuration and amount checks when creating a payment, because checkout availability may become stale.
