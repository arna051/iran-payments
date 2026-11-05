# Reconciliation

`payments.reconcile({ olderThan, limit })` scans stale pending, verifying, and unknown attempts. It invokes only adapters declaring both `inquiry` and `reconciliation`. Confirmed exact-amount payments become paid once and produce an outbox event. Amount mismatches enter manual review. Definitive failed, cancelled, or expired states close the local attempt. Transient errors remain retryable and are recorded as operations.

Run reconciliation from a single scheduled worker or add MongoDB worker leasing in a horizontally scaled host. Optimistic document versions prevent conflicting terminal writes; outbox consumers must also deduplicate.
