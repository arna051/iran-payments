import { createCipheriv } from 'node:crypto';
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

const configSchema = z
  .object({
    baseUrl: z.url().refine((url) => url.startsWith('https://')),
    merchantId: z.string().min(1),
    username: z.string().min(1).optional(),
    password: z.string().min(1).optional(),
    apiKey: z
      .string()
      .regex(/^(?:[0-9a-fA-F]{32}|[0-9a-fA-F]{48}|[0-9a-fA-F]{64})$/u)
      .optional(),
  })
  .refine(
    (value) => Boolean(value.apiKey || (value.username && value.password)),
    'apiKey or username/password is required',
  );
const envelopeSchema = z.object({
  rsCode: z.number().optional(),
  message: z.string().optional(),
  result: z.unknown().optional(),
});
const purchaseSchema = z.object({ payment_uri: z.url(), ticket_id: z.string().min(1) });
const verifySchema = z.object({
  rsCode: z.number().optional(),
  ticket_id: z.string().optional(),
  status: z.number().optional(),
});
const authSchema = z.object({
  accessToken: z.string().optional(),
  access_token: z.string().optional(),
});
export interface AzkiVamExtensions {
  providerId: number;
  fallbackUrl?: string;
  items: Array<{ name: string; count: number; amount: number; url: string }>;
}

export class AzkiVamAdapter implements GatewayAdapter<AzkiVamExtensions> {
  readonly id = 'azkivam' as const;
  readonly capabilities = {
    paymentModel: 'installment',
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
  async create(input: StartPaymentInput<AzkiVamExtensions>, context: ProviderContext) {
    const config = this.config(context);
    if (!input.customer?.phone)
      throw new PaymentError('INVALID_INPUT', 'AzkiVam requires customer.phone');
    const extension = z
      .object({
        providerId: z.number().int(),
        fallbackUrl: z.url().optional(),
        items: z
          .array(
            z.object({
              name: z.string().min(1),
              count: z.number().int().positive(),
              amount: z.number().int().nonnegative(),
              url: z.url(),
            }),
          )
          .min(1),
      })
      .parse(input.extensions);
    const amount = convertMoney(input.amount, 'IRR');
    const path = '/payment/purchase';
    try {
      const response = await this.transport.post(
        `${this.base(config)}${path}`,
        {
          amount: amount.value,
          redirect_uri: input.callbackUrl,
          fallback_uri: extension.fallbackUrl ?? input.callbackUrl,
          provider_id: extension.providerId,
          mobile_number: input.customer.phone,
          merchant_id: /^\d+$/u.test(config.merchantId)
            ? Number(config.merchantId)
            : config.merchantId,
          items: extension.items,
        },
        { headers: await this.headers(config, path) },
      );
      const envelope = envelopeSchema.safeParse(response.data);
      const result = envelope.success ? purchaseSchema.safeParse(envelope.data.result) : undefined;
      if (!envelope.success || envelope.data.rsCode !== 0 || !result?.success)
        throw new PaymentError(
          'PROVIDER_RESPONSE_INVALID',
          'AzkiVam purchase response is malformed or unsuccessful',
        );
      return {
        providerReference: result.data.ticket_id,
        redirectUrl: result.data.payment_uri,
        providerState: 'ticket_created',
        providerData: { providerId: extension.providerId },
        wireAmount: amount,
        raw: response.data,
      };
    } catch (cause) {
      throw this.map(cause, 'AzkiVam purchase outcome is unknown');
    }
  }
  correlateCallback(input: CallbackInput) {
    const body =
      input.body && typeof input.body === 'object' ? (input.body as Record<string, unknown>) : {};
    const providerReference = String(
      input.query?.ticket_id ?? input.query?.ticketId ?? body.ticket_id ?? body.ticketId ?? '',
    ).trim();
    const attemptId = String(input.query?.iranPaymentId ?? body.iranPaymentId ?? '').trim();
    if (!providerReference && !attemptId)
      throw new PaymentError('CALLBACK_UNCORRELATED', 'AzkiVam callback is missing correlation');
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
    const path = '/payment/verify';
    try {
      const response = await this.transport.post(
        `${this.base(config)}${path}`,
        { ticket_id: attempt.providerReference },
        { headers: await this.headers(config, path) },
      );
      const envelope = envelopeSchema.safeParse(response.data);
      const result = envelope.success ? verifySchema.safeParse(envelope.data.result) : undefined;
      if (!envelope.success || !result?.success)
        throw new PaymentError('PROVIDER_RESPONSE_INVALID', 'AzkiVam verify response is malformed');
      const inner = result.data.rsCode ?? envelope.data.rsCode ?? -1;
      const paid =
        envelope.data.rsCode === 0 && inner === 0 && [2, 6].includes(result.data.status ?? -1);
      return {
        paid,
        providerReference: result.data.ticket_id ?? attempt.providerReference,
        providerState: String(result.data.status ?? inner),
        amount: attempt.amount,
        raw: response.data,
      };
    } catch (cause) {
      throw this.map(cause, 'AzkiVam verification outcome is unknown');
    }
  }
  private config(context: ProviderContext) {
    const parsed = configSchema.safeParse(context.configuration);
    if (!parsed.success)
      throw new PaymentError('INVALID_INPUT', 'Invalid AzkiVam configuration', {
        issues: parsed.error.issues,
      });
    return parsed.data;
  }
  private base(config: z.infer<typeof configSchema>) {
    return config.baseUrl.replace(/\/+$/u, '');
  }
  private signature(apiKey: string, path: string) {
    const key = Buffer.from(apiKey, 'hex');
    const cipher = createCipheriv(`aes-${key.length * 8}-cbc`, key, Buffer.alloc(16));
    return Buffer.concat([
      cipher.update(Buffer.from(`${path}##POST#${apiKey}`, 'utf8')),
      cipher.final(),
    ]).toString('hex');
  }
  private async headers(config: z.infer<typeof configSchema>, path: string) {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      MerchantId: config.merchantId,
    };
    if (config.apiKey) {
      headers.Signature = this.signature(config.apiKey, path);
      if (config.username && config.password)
        headers.Authorization = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`;
      return headers;
    }
    const response = await this.transport.post(
      `${this.base(config)}/auth/authenticate`,
      { username: config.username, password: config.password },
      { headers: { 'Content-Type': 'application/json' } },
    );
    const envelope = envelopeSchema.parse(response.data);
    const auth = authSchema.parse(envelope.result);
    const token = auth.accessToken ?? auth.access_token;
    if (!token)
      throw new PaymentError('PROVIDER_RESPONSE_INVALID', 'AzkiVam auth response is missing token');
    headers.Authorization = `Bearer ${token}`;
    return headers;
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
      cause instanceof Error ? cause.message : 'AzkiVam request failed',
      undefined,
      { cause },
    );
  }
}
