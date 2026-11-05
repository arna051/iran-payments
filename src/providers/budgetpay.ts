import axios, { AxiosError, type AxiosInstance } from 'axios';
import { z } from 'zod';
import { PaymentError } from '../errors.js';
import { convertMoney } from '../money.js';
import type {
  CallbackInput,
  GatewayAdapter,
  PaymentAttemptRecord,
  ProviderContext,
  StartPaymentInput,
} from '../types.js';

const configSchema = z.object({
  baseUrl: z.url().refine((url) => url.startsWith('https://')),
  terminalId: z.string().min(1),
  username: z.string().min(1),
  password: z.string().min(1),
});
const responseSchema = z.object({
  success: z.boolean().optional(),
  message: z.string().optional(),
  result: z
    .object({
      token: z.string().optional(),
      referenceId: z.string().optional(),
      referUrl: z.url().optional(),
      status: z.union([z.string(), z.number()]).optional(),
      creditAmount: z.number().optional(),
      cashAmount: z.number().optional(),
    })
    .optional(),
});
export interface BudgetPayExtensions {
  orderId?: string;
}

export class BudgetPayAdapter implements GatewayAdapter<BudgetPayExtensions> {
  readonly id = 'budgetpay' as const;
  readonly capabilities = {
    paymentModel: 'hybrid',
    createPayment: true,
    customerEligibility: false,
    installmentPlans: true,
    inquiry: false,
    verify: true,
    reverse: false,
    cancel: false,
    partialRefund: false,
    fullRefund: false,
    webhook: false,
    redirectCallback: true,
    reconciliation: false,
  } as const;
  constructor(
    private readonly transport: AxiosInstance = axios.create({ timeout: 25_000, maxRedirects: 0 }),
  ) {}
  async create(input: StartPaymentInput<BudgetPayExtensions>, context: ProviderContext) {
    const config = this.config(context);
    if (!input.customer?.phone)
      throw new PaymentError('INVALID_INPUT', 'BudgetPay requires customer.phone');
    const amount = convertMoney(input.amount, 'IRR');
    const token = await this.token(config);
    try {
      const response = await this.transport.post(
        `${this.base(config)}/order`,
        {
          orderId: input.extensions?.orderId ?? input.reference.id,
          amount: amount.value,
          returnUrl: input.callbackUrl,
          mobile: input.customer.phone,
        },
        { headers: this.headers(token) },
      );
      const parsed = responseSchema.safeParse(response.data);
      const result = parsed.success ? parsed.data.result : undefined;
      if (!parsed.success || !parsed.data.success || !result?.referenceId || !result.referUrl)
        throw new PaymentError(
          'PROVIDER_RESPONSE_INVALID',
          'BudgetPay order response is malformed or unsuccessful',
        );
      return {
        providerReference: result.referenceId,
        redirectUrl: result.referUrl,
        providerState: 'order_created',
        wireAmount: amount,
        raw: response.data,
      };
    } catch (cause) {
      throw this.map(cause, 'BudgetPay create outcome is unknown');
    }
  }
  correlateCallback(input: CallbackInput) {
    const body =
      input.body && typeof input.body === 'object' ? (input.body as Record<string, unknown>) : {};
    const providerReference = String(
      input.query?.referenceId ?? input.query?.ref ?? body.referenceId ?? body.ref ?? '',
    ).trim();
    const attemptId = String(input.query?.iranPaymentId ?? body.iranPaymentId ?? '').trim();
    if (!providerReference && !attemptId)
      throw new PaymentError('CALLBACK_UNCORRELATED', 'BudgetPay callback is missing correlation');
    return {
      ...(providerReference ? { providerReference } : {}),
      ...(attemptId ? { attemptId } : {}),
    };
  }
  async verify(
    attempt: PaymentAttemptRecord,
    _input: CallbackInput | undefined,
    context: ProviderContext,
  ) {
    const config = this.config(context);
    const token = await this.token(config);
    try {
      const response = await this.transport.post(
        `${this.base(config)}/verify`,
        { referenceId: attempt.providerReference },
        { headers: this.headers(token) },
      );
      const parsed = responseSchema.safeParse(response.data);
      if (!parsed.success)
        throw new PaymentError(
          'PROVIDER_RESPONSE_INVALID',
          'BudgetPay verify response is malformed',
        );
      const result = parsed.data.result;
      const status = String(result?.status ?? '').toLowerCase();
      const amount = Number(result?.creditAmount ?? 0) + Number(result?.cashAmount ?? 0);
      const paid =
        Boolean(parsed.data.success) &&
        (['success', 'successful', 'completed'].includes(status) || amount > 0);
      return {
        paid,
        providerReference: result?.referenceId ?? attempt.providerReference,
        providerState: status || (paid ? 'successful' : 'failed'),
        amount: amount > 0 ? { value: amount, currency: 'IRR' as const } : attempt.amount,
        raw: response.data,
      };
    } catch (cause) {
      throw this.map(cause, 'BudgetPay verification outcome is unknown');
    }
  }
  async verifyConfiguration(context: ProviderContext) {
    await this.token(this.config(context));
    return { healthy: true };
  }
  private config(context: ProviderContext) {
    const parsed = configSchema.safeParse(context.configuration);
    if (!parsed.success)
      throw new PaymentError('INVALID_INPUT', 'Invalid BudgetPay configuration', {
        issues: parsed.error.issues,
      });
    return parsed.data;
  }
  private base(config: z.infer<typeof configSchema>) {
    return config.baseUrl.replace(/\/+$/u, '');
  }
  private headers(token?: string) {
    return {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }
  private async token(config: z.infer<typeof configSchema>) {
    const response = await this.transport.post(
      `${this.base(config)}/token`,
      { username: config.username, password: config.password, terminalId: config.terminalId },
      { headers: this.headers() },
    );
    const parsed = responseSchema.safeParse(response.data);
    if (!parsed.success || !parsed.data.success || !parsed.data.result?.token)
      throw new PaymentError('PROVIDER_RESPONSE_INVALID', 'BudgetPay token response is malformed');
    return parsed.data.result.token;
  }
  private map(cause: unknown, message: string) {
    if (cause instanceof PaymentError) return cause;
    if (
      cause instanceof AxiosError &&
      (!cause.response || ['ECONNABORTED', 'ETIMEDOUT'].includes(cause.code ?? ''))
    )
      return new PaymentError('UNKNOWN_OUTCOME', message, undefined, { cause });
    return new PaymentError(
      'PROVIDER_ERROR',
      cause instanceof Error ? cause.message : 'BudgetPay request failed',
      undefined,
      { cause },
    );
  }
}
