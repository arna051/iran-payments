import axios, { AxiosError, type AxiosInstance } from 'axios';
import { z } from 'zod';
import { PaymentError } from '../errors.js';
import { convertMoney } from '../money.js';
import type {
  CallbackInput,
  GatewayAdapter,
  GatewayCapabilities,
  GatewayId,
  PaymentAttemptRecord,
  ProviderContext,
  ProviderVerifyResult,
  StartPaymentInput,
} from '../types.js';

const configurationSchema = z.object({
  baseUrl: z.url().refine((url) => url.startsWith('https://'), 'baseUrl must use HTTPS'),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  username: z.string().min(1),
  password: z.string().min(1),
  venture: z.string().min(1).optional(),
});
const tokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive().optional(),
});
const paymentSchema = z.object({ paymentToken: z.string().min(1), paymentPageUrl: z.url() });
const mutationSchema = z
  .object({ transactionId: z.union([z.string(), z.number()]).optional() })
  .passthrough();
const statusSchema = z
  .object({
    transactionId: z.union([z.string(), z.number()]).optional(),
    status: z.string().optional(),
    amount: z.number().optional(),
  })
  .passthrough();
const envelopeSchema = z.object({
  successful: z.boolean(),
  response: z.unknown().optional(),
  error: z
    .object({
      code: z.number().optional(),
      message: z.string().optional(),
      user_message: z.string().optional(),
    })
    .optional(),
  errorData: z
    .object({ errorCode: z.number().optional(), message: z.string().optional() })
    .optional(),
});

export interface OnlineCreditExtensions {
  cartList: unknown;
  discountAmount?: number;
  externalSourceAmount?: number;
  forcedPaymentMethodTypes?: string[];
}

type OnlineCreditConfiguration = z.infer<typeof configurationSchema>;

function unwrap(payload: unknown): unknown {
  const parsed = envelopeSchema.safeParse(payload);
  if (!parsed.success) return payload;
  if (!parsed.data.successful) {
    const error = parsed.data.error ?? parsed.data.errorData;
    throw new PaymentError('PROVIDER_ERROR', error?.message ?? 'Provider rejected the request');
  }
  return parsed.data.response;
}

function correlation(input: CallbackInput) {
  const body =
    input.body && typeof input.body === 'object' ? (input.body as Record<string, unknown>) : {};
  const attemptId = String(input.query?.iranPaymentId ?? body.iranPaymentId ?? '').trim();
  const providerReference = String(input.query?.paymentToken ?? body.paymentToken ?? '').trim();
  if (!attemptId && !providerReference)
    throw new PaymentError('CALLBACK_UNCORRELATED', 'Callback is missing payment correlation');
  return {
    ...(attemptId ? { attemptId } : {}),
    ...(providerReference ? { providerReference } : {}),
  };
}

abstract class OnlineCreditAdapter implements GatewayAdapter<OnlineCreditExtensions> {
  abstract readonly id: GatewayId;
  abstract readonly capabilities: GatewayCapabilities;
  protected abstract readonly paymentMethodType?: string;
  constructor(
    protected readonly transport: AxiosInstance = axios.create({
      timeout: 25_000,
      maxRedirects: 0,
    }),
  ) {}

  async create(input: StartPaymentInput<OnlineCreditExtensions>, context: ProviderContext) {
    const config = this.configuration(context);
    const extensions = z
      .object({
        cartList: z.unknown(),
        discountAmount: z.number().int().nonnegative().optional(),
        externalSourceAmount: z.number().int().nonnegative().optional(),
        forcedPaymentMethodTypes: z.array(z.string()).optional(),
      })
      .parse(input.extensions);
    const amount = convertMoney(input.amount, 'IRR');
    const token = await this.accessToken(config);
    const body: Record<string, unknown> = {
      amount: amount.value,
      cartList: extensions.cartList,
      discountAmount: extensions.discountAmount ?? 0,
      externalSourceAmount: extensions.externalSourceAmount ?? 0,
      mobile: input.customer?.phone,
      returnURL: input.callbackUrl,
      transactionId: input.reference.id,
      ...(this.paymentMethodType ? { paymentMethodTypeDto: this.paymentMethodType } : {}),
      ...(extensions.forcedPaymentMethodTypes
        ? { forcedPaymentMethodTypes: extensions.forcedPaymentMethodTypes }
        : {}),
    };
    try {
      const response = await this.transport.post(
        `${this.base(config)}/api/online/payment/v1/token`,
        body,
        { headers: this.headers(config, token) },
      );
      const parsed = paymentSchema.safeParse(unwrap(response.data));
      if (!parsed.success)
        throw new PaymentError(
          'PROVIDER_RESPONSE_INVALID',
          `${this.id} create response is malformed`,
          { issues: parsed.error.issues },
        );
      return {
        providerReference: parsed.data.paymentToken,
        redirectUrl: parsed.data.paymentPageUrl,
        providerState: 'token_created',
        wireAmount: amount,
        raw: response.data,
      };
    } catch (cause) {
      throw this.mapMutationError(cause, `${this.id} create outcome is unknown`);
    }
  }
  correlateCallback(input: CallbackInput) {
    return correlation(input);
  }
  async verify(
    attempt: PaymentAttemptRecord,
    _input: CallbackInput | undefined,
    context: ProviderContext,
  ): Promise<ProviderVerifyResult> {
    const config = this.configuration(context);
    const token = await this.accessToken(config);
    try {
      const verified = await this.transport.post(
        `${this.base(config)}/api/online/payment/v1/verify`,
        { paymentToken: attempt.providerReference },
        { headers: this.headers(config, token) },
      );
      const verifyData = mutationSchema.safeParse(unwrap(verified.data));
      if (!verifyData.success)
        throw new PaymentError(
          'PROVIDER_RESPONSE_INVALID',
          `${this.id} verify response is malformed`,
        );
      const settled = await this.transport.post(
        `${this.base(config)}/api/online/payment/v1/settle`,
        { paymentToken: attempt.providerReference },
        { headers: this.headers(config, token) },
      );
      unwrap(settled.data);
      return {
        paid: true,
        providerReference: attempt.providerReference,
        ...(verifyData.data.transactionId !== undefined
          ? { providerTransactionId: String(verifyData.data.transactionId) }
          : {}),
        providerState: 'settled',
        amount: attempt.amount,
        raw: { verify: verified.data, settle: settled.data },
      };
    } catch (cause) {
      throw this.mapMutationError(
        cause,
        `${this.id} verification or settlement outcome is unknown`,
      );
    }
  }
  async verifyConfiguration(context: ProviderContext) {
    await this.accessToken(this.configuration(context));
    return { healthy: true };
  }
  async checkEligibility(
    amount: import('../types.js').Money,
    context: ProviderContext,
    paymentMethodTypes?: string[],
  ) {
    const config = this.configuration(context);
    const token = await this.accessToken(config);
    const wire = convertMoney(amount, 'IRR');
    const params = new URLSearchParams({ amount: String(wire.value) });
    if (paymentMethodTypes?.length) params.set('paymentMethodTypes', paymentMethodTypes.join(','));
    const response = await this.transport.get(
      `${this.base(config)}/api/online/offer/v1/eligible?${params}`,
      { headers: this.headers(config, token) },
    );
    return z
      .object({
        eligible: z.boolean(),
        title: z.string().optional(),
        description: z.string().optional(),
      })
      .passthrough()
      .parse(unwrap(response.data));
  }
  protected configuration(context: ProviderContext): OnlineCreditConfiguration {
    const parsed = configurationSchema.safeParse(context.configuration);
    if (!parsed.success)
      throw new PaymentError('INVALID_INPUT', `Invalid ${this.id} configuration`, {
        issues: parsed.error.issues,
      });
    return parsed.data;
  }
  protected base(config: OnlineCreditConfiguration) {
    return config.baseUrl.replace(/\/+$/u, '');
  }
  protected headers(config: OnlineCreditConfiguration, token: string) {
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(config.venture ? { venture: config.venture } : {}),
    };
  }
  protected async accessToken(config: OnlineCreditConfiguration) {
    const credentials = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
    const form = new URLSearchParams({
      grant_type: 'password',
      scope: 'online-merchant',
      username: config.username,
      password: config.password,
    });
    const response = await this.transport.post(
      `${this.base(config)}/api/online/v1/oauth/token`,
      form.toString(),
      {
        headers: {
          Authorization: `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      },
    );
    const parsed = tokenSchema.safeParse(unwrap(response.data));
    if (!parsed.success)
      throw new PaymentError('PROVIDER_RESPONSE_INVALID', `${this.id} token response is malformed`);
    return parsed.data.access_token;
  }
  protected mapMutationError(cause: unknown, message: string) {
    if (cause instanceof PaymentError) return cause;
    if (
      cause instanceof AxiosError &&
      (!cause.response || cause.code === 'ECONNABORTED' || cause.code === 'ETIMEDOUT')
    )
      return new PaymentError('UNKNOWN_OUTCOME', message, undefined, { cause });
    return new PaymentError(
      'PROVIDER_ERROR',
      cause instanceof Error ? cause.message : `${this.id} request failed`,
      undefined,
      { cause },
    );
  }
}

export class TorobPayAdapter extends OnlineCreditAdapter {
  readonly id = 'torobpay' as const;
  readonly paymentMethodType = 'ONLINE_CREDIT';
  readonly capabilities = {
    paymentModel: 'bnpl',
    createPayment: true,
    customerEligibility: true,
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
}

export class SnappPayAdapter extends OnlineCreditAdapter {
  readonly id = 'snapppay' as const;
  readonly paymentMethodType = undefined;
  readonly capabilities = {
    paymentModel: 'bnpl',
    createPayment: true,
    customerEligibility: true,
    installmentPlans: true,
    inquiry: true,
    verify: true,
    reverse: false,
    cancel: true,
    partialRefund: false,
    fullRefund: false,
    webhook: false,
    redirectCallback: true,
    reconciliation: true,
  } as const;
  override async verify(
    attempt: PaymentAttemptRecord,
    input: CallbackInput | undefined,
    context: ProviderContext,
  ) {
    const verified = await super.verify(attempt, input, context);
    try {
      const status = await this.inquiry(attempt, context);
      if (!status.definitive || !status.paid) {
        throw new PaymentError(
          'UNKNOWN_OUTCOME',
          'SnappPay settled but status/amount confirmation is not definitive',
        );
      }
      return {
        ...verified,
        providerTransactionId: status.providerTransactionId ?? verified.providerTransactionId,
        providerState: status.providerState ?? verified.providerState,
        amount: status.amount ?? verified.amount,
        raw: { verifyAndSettle: verified.raw, status: status.raw },
      };
    } catch (cause) {
      throw this.mapMutationError(
        cause,
        'SnappPay verification succeeded but amount confirmation is unknown',
      );
    }
  }
  async inquiry(attempt: PaymentAttemptRecord, context: ProviderContext) {
    const config = this.configuration(context);
    const token = await this.accessToken(config);
    const params = new URLSearchParams({ paymentToken: attempt.providerReference ?? '' });
    const response = await this.transport.get(
      `${this.base(config)}/api/online/payment/v1/status?${params}`,
      { headers: this.headers(config, token) },
    );
    const parsed = statusSchema.safeParse(unwrap(response.data));
    if (!parsed.success)
      throw new PaymentError('PROVIDER_RESPONSE_INVALID', 'SnappPay status response is malformed');
    const paid = ['settled', 'success', 'successful', 'completed'].includes(
      (parsed.data.status ?? '').toLowerCase(),
    );
    return {
      paid,
      definitive: Boolean(parsed.data.status),
      providerReference: attempt.providerReference,
      ...(parsed.data.transactionId !== undefined
        ? { providerTransactionId: String(parsed.data.transactionId) }
        : {}),
      providerState: parsed.data.status,
      amount:
        parsed.data.amount === undefined
          ? attempt.amount
          : { value: parsed.data.amount, currency: 'IRR' as const },
      raw: response.data,
    };
  }
  async cancel(attempt: PaymentAttemptRecord, _key: string, context: ProviderContext) {
    const config = this.configuration(context);
    const token = await this.accessToken(config);
    try {
      const response = await this.transport.post(
        `${this.base(config)}/api/online/payment/v1/cancel`,
        { paymentToken: attempt.providerReference },
        { headers: this.headers(config, token) },
      );
      const parsed = mutationSchema.safeParse(unwrap(response.data));
      if (!parsed.success)
        throw new PaymentError(
          'PROVIDER_RESPONSE_INVALID',
          'SnappPay cancel response is malformed',
        );
      return {
        providerState: 'cancelled',
        ...(parsed.data.transactionId !== undefined
          ? { providerOperationId: String(parsed.data.transactionId) }
          : {}),
        raw: response.data,
      };
    } catch (cause) {
      throw this.mapMutationError(cause, 'SnappPay cancellation outcome is unknown');
    }
  }
}
