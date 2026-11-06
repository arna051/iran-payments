# Implementation, migration, and release phases

1. **Contract and mock validation:** run unit, provider-contract, type, package, security, and replica-set concurrency tests without provider traffic.
2. **Host migration:** deploy schemas/index migrations, configure encryption-key rotation, create disabled configurations, and integrate an idempotent outbox consumer.
3. **Sandbox:** validate each documented provider sandbox independently, including callback, verify/settle, timeout, duplicate callback, and reconciliation behavior.
4. **Controlled live tests:** only after explicit per-test authorization, use isolated minimum-value transactions and documented recovery. Do not reuse customer transactions.
5. **Canary:** enable one verified configuration for a constrained tenant/order cohort with reconciliation and manual-review alerting.
6. **General release:** expand traffic after settlement comparison, dependency/secret scans, independent security review, and rollback rehearsal.
7. **npm publication:** inspect the clean tarball, sign/tag the release, and publish only after separate explicit npm authorization.

Non-goals remain frontend UI, order/cart/accounting models, custody, fake provider parity, and treating a browser callback as proof of payment.
