import { AxiosError, type AxiosInstance } from 'axios';
import { describe, expect, it, vi } from 'vitest';
import {
  AzkiVamAdapter,
  BudgetPayAdapter,
  DigiPayAdapter,
  PaymentError,
  SnappPayAdapter,
  TorobPayAdapter,
} from '../src/index.js';
import type { PaymentAttemptRecord, ProviderContext, StartPaymentInput } from '../src/index.js';

function transport(
  handler: (method: 'get' | 'post', url: string, body?: unknown, config?: unknown) => unknown,
) {
  return {
    post: vi.fn(async (url: string, body?: unknown, config?: unknown) => ({
      data: handler('post', url, body, config),
    })),
    get: vi.fn(async (url: string, config?: unknown) => ({
      data: handler('get', url, undefined, config),
    })),
  } as unknown as AxiosInstance;
}
const baseInput = {
  gateway: 'torobpay',
  idempotencyKey: 'key',
  amount: { value: 1_500_000, currency: 'IRR' },
  reference: { type: 'order', id: 'order-1' },
  customer: { phone: '09123456789' },
  callbackUrl: 'https://merchant.test/callback?iranPaymentId=a1',
} as const;
const attempt = {
  _id: 'a1',
  gateway: 'snapppay',
  state: 'customer_action_required',
  idempotencyKey: 'key',
  requestFingerprint: 'fp',
  reference: baseInput.reference,
  amount: baseInput.amount,
  wireAmount: baseInput.amount,
  providerReference: 'pay-token',
  paidAmount: 0,
  refundedAmount: 0,
  callbackUrl: baseInput.callbackUrl,
} as PaymentAttemptRecord;
const oauthContext = {
  configuration: {
    baseUrl: 'https://provider.test',
    clientId: 'client',
    clientSecret: 'secret',
    username: 'user',
    password: 'pass',
  },
} satisfies ProviderContext;

describe('TorobPay adapter', () => {
  it('maps OAuth, create, verify and settle without retrying mutations', async () => {
    const calls: string[] = [];
    const mock = transport((method, url, body) => {
      calls.push(`${method} ${new URL(url).pathname}`);
      if (url.endsWith('/oauth/token')) return { access_token: 'access' };
      if (url.endsWith('/token')) {
        expect(body).toMatchObject({
          amount: 1_500_000,
          transactionId: 'order-1',
          paymentMethodTypeDto: 'ONLINE_CREDIT',
        });
        return {
          successful: true,
          response: { paymentToken: 'payment-token', paymentPageUrl: 'https://provider.test/pay' },
        };
      }
      return { successful: true, response: { transactionId: 'provider-tx' } };
    });
    const adapter = new TorobPayAdapter(mock);
    const created = await adapter.create(
      { ...baseInput, extensions: { cartList: [{ id: 1 }] } },
      oauthContext,
    );
    expect(created).toMatchObject({
      providerReference: 'payment-token',
      redirectUrl: 'https://provider.test/pay',
      wireAmount: baseInput.amount,
    });
    const verified = await adapter.verify(
      { ...attempt, gateway: 'torobpay', providerReference: 'payment-token' },
      undefined,
      oauthContext,
    );
    expect(verified).toMatchObject({
      paid: true,
      providerTransactionId: 'provider-tx',
      providerState: 'settled',
    });
    expect(calls.filter((call) => call.endsWith('/verify'))).toHaveLength(1);
    expect(calls.filter((call) => call.endsWith('/settle'))).toHaveLength(1);
  });
});

describe('SnappPay adapter', () => {
  it('supports inquiry, cancellation, and callback correlation', async () => {
    const mock = transport((method, url) => {
      if (url.endsWith('/oauth/token')) return { access_token: 'access' };
      if (method === 'get')
        return {
          successful: true,
          response: { transactionId: 'tx', status: 'settled', amount: 1_500_000 },
        };
      return { successful: true, response: { transactionId: 'cancel-tx' } };
    });
    const adapter = new SnappPayAdapter(mock);
    expect(
      adapter.correlateCallback({ gateway: 'snapppay', query: { iranPaymentId: 'a1' } }),
    ).toEqual({ attemptId: 'a1' });
    await expect(adapter.inquiry(attempt, oauthContext)).resolves.toMatchObject({
      paid: true,
      definitive: true,
      providerState: 'settled',
    });
    await expect(adapter.cancel(attempt, 'cancel-key', oauthContext)).resolves.toMatchObject({
      providerState: 'cancelled',
      providerOperationId: 'cancel-tx',
    });
  });
});

describe('DigiPay adapter', () => {
  it('maps ticket extensions and verifies callback values server-to-server', async () => {
    const mock = transport((_method, url, body) => {
      if (url.endsWith('/oauth/token')) return { access_token: 'access' };
      if (url.includes('/tickets/business')) {
        expect(body).toMatchObject({
          amount: 1_500_000,
          cellNumber: '09123456789',
          providerId: 'merchant-provider',
        });
        return { redirectUrl: 'https://provider.test/pay', ticket: 'ticket-1' };
      }
      expect(body).toEqual({ trackingCode: 'track-1', providerId: 'merchant-provider' });
      return {
        result: { status: 0 },
        trackingCode: 'track-1',
        providerId: 'merchant-provider',
        amount: 1_500_000,
      };
    });
    const adapter = new DigiPayAdapter(mock);
    const created = await adapter.create(
      { ...baseInput, gateway: 'digipay', extensions: { providerId: 'merchant-provider' } },
      oauthContext,
    );
    expect(created.providerData).toEqual({ providerId: 'merchant-provider', type: 11 });
    const verified = await adapter.verify(
      {
        ...attempt,
        gateway: 'digipay',
        providerReference: 'ticket-1',
        providerData: created.providerData,
      },
      { gateway: 'digipay', query: { trackingCode: 'track-1', providerId: 'merchant-provider' } },
      oauthContext,
    );
    expect(verified).toMatchObject({
      paid: true,
      providerTransactionId: 'track-1',
      amount: baseInput.amount,
    });
  });
});

describe('BudgetPay adapter', () => {
  it('authenticates, creates, correlates and verifies exact paid amount', async () => {
    const context = {
      configuration: {
        baseUrl: 'https://provider.test',
        terminalId: 'terminal',
        username: 'user',
        password: 'pass',
      },
    };
    const mock = transport((_method, url) => {
      if (url.endsWith('/token')) return { success: true, result: { token: 'access' } };
      if (url.endsWith('/order'))
        return {
          success: true,
          result: { referenceId: 'ref-1', referUrl: 'https://provider.test/pay' },
        };
      return {
        success: true,
        result: {
          referenceId: 'ref-1',
          status: 'completed',
          creditAmount: 1_000_000,
          cashAmount: 500_000,
        },
      };
    });
    const adapter = new BudgetPayAdapter(mock);
    const created = await adapter.create({ ...baseInput, gateway: 'budgetpay' }, context);
    expect(created.providerReference).toBe('ref-1');
    expect(
      adapter.correlateCallback({ gateway: 'budgetpay', query: { referenceId: 'ref-1' } }),
    ).toEqual({ providerReference: 'ref-1' });
    await expect(
      adapter.verify(
        { ...attempt, gateway: 'budgetpay', providerReference: 'ref-1' },
        undefined,
        context,
      ),
    ).resolves.toMatchObject({ paid: true, amount: baseInput.amount });
  });
});

describe('AzkiVam adapter', () => {
  it('signs purchase/verify requests and validates provider statuses', async () => {
    const context = {
      configuration: {
        baseUrl: 'https://provider.test',
        merchantId: '42',
        apiKey: '11'.repeat(16),
      },
    };
    const headers: Array<Record<string, string>> = [];
    const mock = transport((_method, url, _body, config) => {
      headers.push((config as { headers: Record<string, string> }).headers);
      if (url.endsWith('/purchase'))
        return {
          rsCode: 0,
          result: { payment_uri: 'https://provider.test/pay', ticket_id: 'ticket-1' },
        };
      return { rsCode: 0, result: { rsCode: 0, ticket_id: 'ticket-1', status: 2 } };
    });
    const adapter = new AzkiVamAdapter(mock);
    const input: StartPaymentInput<{
      providerId: number;
      items: Array<{ name: string; count: number; amount: number; url: string }>;
    }> = {
      ...baseInput,
      gateway: 'azkivam',
      extensions: {
        providerId: 7,
        items: [
          { name: 'کالا', count: 1, amount: 1_500_000, url: 'https://merchant.test/product' },
        ],
      },
    };
    const created = await adapter.create(input, context);
    expect(created.providerReference).toBe('ticket-1');
    expect(headers[0]?.Signature).toMatch(/^[0-9a-f]+$/u);
    await expect(
      adapter.verify(
        { ...attempt, gateway: 'azkivam', providerReference: 'ticket-1' },
        undefined,
        context,
      ),
    ).resolves.toMatchObject({ paid: true, providerState: '2' });
  });
});

describe('financial timeout semantics', () => {
  it('returns UNKNOWN_OUTCOME for an unconfirmed mutation', async () => {
    const mock = {
      post: vi
        .fn()
        .mockResolvedValueOnce({ data: { success: true, result: { token: 'access' } } })
        .mockRejectedValueOnce(new AxiosError('timeout', 'ETIMEDOUT')),
    } as unknown as AxiosInstance;
    const adapter = new BudgetPayAdapter(mock);
    await expect(
      adapter.create(
        { ...baseInput, gateway: 'budgetpay' },
        {
          configuration: {
            baseUrl: 'https://provider.test',
            terminalId: 't',
            username: 'u',
            password: 'p',
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'UNKNOWN_OUTCOME' } satisfies Partial<PaymentError>);
  });
});
