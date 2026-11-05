# Architecture

The host owns the Mongoose connection, encryption keys, trusted order amount, callback routes, authorization, and commerce state. `iran-payments` owns provider configuration, payment attempts, append-oriented operations, webhook deduplication records, and outbox events. It never imports host order models.

Provider calls cannot participate in a MongoDB transaction. The package persists an attempt before calling a gateway, models uncertain results as `unknown`, and uses provider inquiry for reconciliation where a safe read API exists. The same idempotency key plus request fingerprint claims one attempt atomically; reuse with different trusted input fails.

Payment side effects are emitted through the outbox. Host consumers must be idempotent. A callback is correlated to the stored attempt and verified server-to-server; browser-provided amount, order identifiers, and success flags are not authoritative.

MongoDB transactions and reliable outbox consumption require a replica set. A transaction still cannot encompass external HTTP.
