# Existing integration evidence audit

Read-only inspection of `/home/javad/ecommerce` found six active payment implementations: Zarinpal, TorobPay, DigiPay, SnappPay, AzkiVam, and BajetPay/BudgetPay. The useful evidence was provider endpoint shape, authentication, request fields, callback parameters, IRR conversions, and provider status handling. No secrets or production records were read or copied.

Reusable behavior:

- Zarinpal v4 request/verify with authority correlation.
- TorobPay and SnappPay OAuth, eligibility, payment token, verify, and settle flows.
- SnappPay status and pre-settlement cancellation.
- DigiPay OAuth, business ticket, and purchase verification.
- AzkiVam signed purchase and verify requests.
- BudgetPay token, order, and verify calls.

Unsafe baggage excluded from the package:

- Direct coupling to invoice, product, category, and order Mongoose models.
- Provider calls mixed with host order mutation.
- Global/module client caches containing credential-derived keys.
- Callbacks trusting application query fields before stored-attempt correlation.
- Weakly typed raw responses and provider errors containing unredacted bodies.
- Scattered rial/toman conversions and local cancellation conflated with financial operations.

The package keeps provider raw state separate, validates important responses, injects transports, stores exact normalized and wire amounts, and emits commerce-neutral outbox events.
