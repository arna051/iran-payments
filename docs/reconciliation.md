# Reconciliation

`payments.reconcile({ olderThan, limit })` scans stale pending, verifying, and unknown attempts. It invokes only adapters declaring both `inquiry` and `reconciliation`. Confirmed exact-amount payments become paid once and produce an outbox event. Amount mismatches enter manual review. Definitive failed, cancelled, or expired states close the local attempt. Transient errors remain retryable and are recorded as operations.

Reconciliation uses compare-and-set updates so concurrent callback, refund, reversal, and reconciliation workers cannot overwrite a terminal state. Run it on a schedule. Run the separately leased outbox dispatcher continuously; outbox consumers must deduplicate because a crash after delivery but before acknowledgement causes safe redelivery.
