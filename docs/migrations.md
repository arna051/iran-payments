# Schema migrations

Models carry a schema version and use a configurable name prefix. Deploy index and data migrations before enabling new package versions in production; do not rely on `autoIndex` for a busy payment database.

For the initial pre-release schema transition:

1. Backfill each gateway configuration with a unique stable `publicKey`, `presentation`, `credentialsConfigured`, `health`, and explicit `scope`/`environment`.
2. Leave legacy configurations disabled and unverified until a safe provider verification succeeds.
3. Backfill `reservedRefundAmount: 0` on attempts.
4. Drop the legacy sparse operation index `attemptId_1_kind_1_idempotencyKey_1`, then recreate the same keys with the partial filter `{ idempotencyKey: { $type: 'string' } }`. This permits multiple non-idempotent inquiry/verification evidence records while keeping mutation keys unique.
5. Build the unique `publicKey` configuration index only after resolving duplicates.

Take a backup, rehearse on a production-shaped copy, and inspect duplicate keys before creating unique indexes. Never rewrite encrypted credential blobs without all referenced encryption keys available.
