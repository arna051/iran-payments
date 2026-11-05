# Provider capability matrix

Capabilities are intentionally conservative; an absent capability is not emulated locally.

| Provider  | Model              | Create | Eligibility |          Verify |        Inquiry/reconcile |            Cancel |      Refund/reverse |
| --------- | ------------------ | -----: | ----------: | --------------: | -----------------------: | ----------------: | ------------------: |
| Zarinpal  | Redirect           |    Yes |          No |             Yes |   No documented read API |                No | No built-in support |
| TorobPay  | BNPL               |    Yes |         Yes | Verify + settle | No documented status API |                No | No built-in support |
| DigiPay   | Hybrid/installment |    Yes |          No |             Yes |   No documented read API |                No | No built-in support |
| SnappPay  | BNPL               |    Yes |         Yes | Verify + settle |                      Yes | Before settlement | No built-in support |
| AzkiVam   | Installment        |    Yes |          No |             Yes |   No documented read API |                No | No built-in support |
| BudgetPay | Hybrid             |    Yes |          No |             Yes |   No documented read API |                No | No built-in support |

`cancel`, `reverse`, and `refund` are different financial operations. A local order cancellation never implies one of them. Provider-specific merchant contracts may add capabilities; expose those through a custom adapter only after validating current provider documentation.

The existing ecommerce application calls the BudgetPay integration “BajetPay”. The public package uses the requested stable identifier `budgetpay` while preserving the evidenced wire contract.
