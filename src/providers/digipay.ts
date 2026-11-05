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

const configurationSchema = z.object({
  baseUrl: z.url().refine((url) => url.startsWith('https://')),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  username: z.string().min(1),
  password: z.string().min(1),
});
const tokenSchema = z.object({ access_token: z.string().min(1) });
const ticketSchema = z.object({ redirectUrl: z.url(), ticket: z.string().min(1) });
const verifySchema = z
  .object({
    result: z.object({ status: z.number(), message: z.string().optional() }).optional(),
    trackingCode: z.union([z.string(), z.number()]).optional(),
    providerId: z.union([z.string(), z.number()]).optional(),
    paymentGateway: z.number().optional(),
    amount: z.number().optional(),
  })
  .passthrough();

export interface DigiPayExtensions {
  providerId: string;
  type?: string | number;
  preferredGateway?: number;
  basketDetails?: {
    basketId: string;
    items: Array<{
      sellerId: string;
      supplierId: string;
      productCode: string;
      brand: string;
      productType: number;
      count: number;
      categoryId: string;
    }>;
  };
  additionalInfo?: Record<string, unknown>;
}

export class DigiPayAdapter implements GatewayAdapter<DigiPayExtensions> {
  readonly id = 'digipay' as const;
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
  async create(input: StartPaymentInput<DigiPayExtensions>, context: ProviderContext) {
    const config = this.config(context);
    const extension = z
      .object({
        providerId: z.string().min(1),
        type: z.union([z.string(), z.number()]).optional(),
        preferredGateway: z.number().optional(),
        basketDetails: z.unknown().optional(),
        additionalInfo: z.record(z.string(), z.unknown()).optional(),
      })
      .parse(input.extensions);
    const amount = convertMoney(input.amount, 'IRR');
    const token = await this.token(config);
    const additionalInfo = {
      ...(extension.additionalInfo ?? {}),
      ...(extension.preferredGateway !== undefined
        ? { preferredGateway: extension.preferredGateway }
        : {}),
    };
    const body = {
      amount: amount.value,
      cellNumber: input.customer?.phone,
      providerId: extension.providerId,
      callbackUrl: input.callbackUrl,
      ...(extension.basketDetails ? { basketDetailsDto: extension.basketDetails } : {}),
      ...(Object.keys(additionalInfo).length ? { additionalInfo } : {}),
    };
    try {
      const response = await this.transport.post(
        `${this.base(config)}/tickets/business?type=${encodeURIComponent(String(extension.type ?? 11))}`,
        body,
        { headers: this.headers(token) },
      );
      const parsed = ticketSchema.safeParse(response.data);
      if (!parsed.success)
        throw new PaymentError(
          'PROVIDER_RESPONSE_INVALID',
          'DigiPay ticket response is malformed',
          { issues: parsed.error.issues },
        );
      return {
        providerReference: parsed.data.ticket,
        redirectUrl: parsed.data.redirectUrl,
        providerState: 'ticket_created',
        providerData: { providerId: extension.providerId, type: extension.type ?? 11 },
        wireAmount: amount,
        raw: response.data,
      };
    } catch (cause) {
      throw this.map(cause, 'DigiPay create outcome is unknown');
    }
  }
  correlateCallback(input: CallbackInput) {
    const body =
      input.body && typeof input.body === 'object' ? (input.body as Record<string, unknown>) : {};
    const attemptId = String(input.query?.iranPaymentId ?? body.iranPaymentId ?? '').trim();
    if (!attemptId)
      throw new PaymentError('CALLBACK_UNCORRELATED', 'DigiPay callback is missing iranPaymentId');
    return { attemptId };
  }
  async verify(
    attempt: PaymentAttemptRecord,
    input: CallbackInput | undefined,
    context: ProviderContext,
  ) {
    const query = input?.query ?? {};
    const body =
      input?.body && typeof input.body === 'object' ? (input.body as Record<string, unknown>) : {};
    const trackingCode = String(body.trackingCode ?? query.trackingCode ?? '').trim();
    const providerId = String(
      body.providerId ?? query.providerId ?? attempt.providerData?.providerId ?? '',
    ).trim();
    const type = body.type ?? query.type ?? attempt.providerData?.type ?? 11;
    if (!trackingCode || !providerId)
      throw new PaymentError(
        'INVALID_INPUT',
        'DigiPay callback is missing trackingCode or providerId',
      );
    const config = this.config(context);
    const token = await this.token(config);
    try {
      const response = await this.transport.post(
        `${this.base(config)}/purchases/verify?type=${encodeURIComponent(String(type))}`,
        { trackingCode, providerId },
        { headers: this.headers(token) },
      );
      const parsed = verifySchema.safeParse(response.data);
      if (!parsed.success)
        throw new PaymentError('PROVIDER_RESPONSE_INVALID', 'DigiPay verify response is malformed');
      const status = parsed.data.result?.status ?? -1;
      return {
        paid: status === 0,
        providerReference: attempt.providerReference,
        providerTransactionId: String(parsed.data.trackingCode ?? trackingCode),
        providerState: String(status),
        amount:
          parsed.data.amount === undefined
            ? attempt.amount
            : { value: parsed.data.amount, currency: 'IRR' as const },
        raw: response.data,
      };
    } catch (cause) {
      throw this.map(cause, 'DigiPay verification outcome is unknown');
    }
  }
  async verifyConfiguration(context: ProviderContext) {
    await this.token(this.config(context));
    return { healthy: true };
  }
  private config(context: ProviderContext) {
    const parsed = configurationSchema.safeParse(context.configuration);
    if (!parsed.success)
      throw new PaymentError('INVALID_INPUT', 'Invalid DigiPay configuration', {
        issues: parsed.error.issues,
      });
    return parsed.data;
  }
  private base(config: z.infer<typeof configurationSchema>) {
    return config.baseUrl.replace(/\/+$/u, '');
  }
  private headers(token: string) {
    return {
      Authorization: `Bearer ${token}`,
      Agent: 'WEB',
      'Digipay-Version': '2022-02-02',
      'Content-Type': 'application/json',
    };
  }
  private async token(config: z.infer<typeof configurationSchema>) {
    const form = new FormData();
    form.append('username', config.username);
    form.append('password', config.password);
    form.append('grant_type', 'password');
    const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
    const response = await this.transport.post(`${this.base(config)}/oauth/token`, form, {
      headers: { Authorization: `Basic ${basic}` },
    });
    const parsed = tokenSchema.safeParse(response.data);
    if (!parsed.success)
      throw new PaymentError('PROVIDER_RESPONSE_INVALID', 'DigiPay token response is malformed');
    return parsed.data.access_token;
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
      cause instanceof Error ? cause.message : 'DigiPay request failed',
      undefined,
      { cause },
    );
  }
}
