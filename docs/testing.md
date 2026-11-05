# Testing and authorization boundaries

Normal tests use injected transports and sanitized fixtures. They do not contact provider hosts or create charges. The suite covers money, state transitions, encryption tampering, redaction, provider mappings, callback correlation, verify/settle, inquiry/cancel, configuration lifecycle, public DTO allowlisting, concurrent idempotent create, concurrent callback verification, and outbox uniqueness.

Before a live test, record the provider account and environment, exact amount/unit, callback URL, customer interaction or OTP, expected settlement, and recovery operation. Use an isolated minimum-value payment. Never cancel or refund an unrelated transaction.
