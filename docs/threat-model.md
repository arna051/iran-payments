# Threat model

Protected assets are provider credentials, encryption keys, payment identity and amount, refund capacity, customer identifiers, and the once-only paid/refunded host effects.

Primary threats and controls:

| Threat                               | Control                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------- |
| Browser changes amount/order/gateway | Host resolves trusted input; persisted amount is authoritative                              |
| Forged or replayed callback          | Stored-attempt correlation, server verification, atomic verification claim                  |
| Duplicate create/refund/cancel       | Durable idempotency key plus canonical fingerprint and unique partial index                 |
| Concurrent over-refund               | Atomic refund reservation bounded by paid minus refunded/reserved amount                    |
| Timeout after provider acceptance    | `unknown` state; no automatic mutation retry; inquiry/reconciliation                        |
| Credential/database disclosure       | AES-256-GCM, write-only admin API, schema serialization transform, redaction                |
| Cross-tenant configuration selection | Explicit scope/environment filtering and stable configuration key                           |
| Unsafe checkout presentation         | Strict DTO allowlist, canonical colour, controlled icon or HTTPS URL                        |
| Paid state without host side effect  | Attempt and outbox commit in one replica-set transaction                                    |
| Duplicate outbox workers             | Lease claim; host event handlers remain idempotent for crash recovery                       |
| SSRF/open redirect                   | Provider base URLs require HTTPS configuration; application redirects are fixed host values |

Residual risks include provider contract changes, settlement APIs unavailable to some merchants, and exactly-once delivery across MongoDB and an external host effect. Outbox delivery is at-least-once after crashes; consumers must deduplicate using event identity.
