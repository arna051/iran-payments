# State machines

```text
created → provider_pending | customer_action_required | failed | unknown
provider_pending/customer_action_required → callback_received → verifying → paid | failed | unknown
pending/action/unknown → cancelled | expired
expired/failed/unknown → verifying → paid | manual_review
paid → partially_refunded → refunded
paid → reversed (only where declared by the adapter)
any inconsistent amount/identity → manual_review
```

BNPL eligibility and plan selection remain provider extension data; they are not falsely flattened into “paid”. TorobPay and SnappPay become paid only after verify and settle complete. A financial-mutation timeout becomes `unknown`; the POST is not repeated. SnappPay can reconcile unknown attempts through its status endpoint.
