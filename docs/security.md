# Security and financial-safety rules

- Supply a 32-byte host-managed encryption key. AES-256-GCM uses a unique nonce and authenticated key identifier.
- Credentials are selected explicitly only inside provider calls. Admin output reports a fixed mask; public output is allowlisted.
- Never log authorization headers, signatures, tokens, merchant credentials, PANs, national IDs, or raw provider payloads.
- Callback data is untrusted. Verify server-to-server before emitting `payment.paid`.
- Use HTTPS callback URLs. Local HTTP is accepted only for localhost development.
- Treat mutation timeouts as unknown and inquire; do not blindly retry.
- Customer eligibility can reveal financial status. Require checkout intent, consent, and host rate limiting. Static discovery never calls eligibility APIs.
- Admin controllers are disabled by default and require a host guard class through Nest dependency injection.
- Live payment, OTP, settlement, cancellation, or refund tests require separate explicit authorization.
