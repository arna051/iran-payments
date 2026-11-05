# Security policy

Report vulnerabilities privately to the repository owner. Do not include credentials, payment payloads, personal data, or production transaction identifiers in an issue.

Provider credentials must be stored only through encrypted configuration using a host-managed 32-byte key. Rotate keys by retaining previous keys for reads, rewriting configurations with the current key, then retiring old keys. Restrict configuration endpoints with host authentication and authorization; callbacks are public but must be authenticated through provider verification or signatures.
