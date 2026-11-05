import mongoose from 'mongoose';
import { existsSync } from 'node:fs';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createPaymentGateways,
  type GatewayAdapter,
  type StartPaymentInput,
} from '../src/index.js';

describe('Mongoose orchestration concurrency', () => {
  let replica: MongoMemoryReplSet;
  let connection: mongoose.Connection;
  const createProviderPayment = vi.fn(async (input: StartPaymentInput) => ({
    providerReference: 'authority-1',
    redirectUrl: 'https://provider.test/pay',
    wireAmount: input.amount,
  }));
  const verifyProviderPayment = vi.fn(async (attempt: any) => ({
    paid: true,
    providerReference: attempt.providerReference,
    providerTransactionId: 'tx-1',
    amount: attempt.amount,
  }));
  const refundProviderPayment = vi.fn(async (_attempt: any, amount: any) => ({
    providerState: 'partially_refunded',
    providerOperationId: `refund-${amount.value}`,
  }));
  const adapter: GatewayAdapter = {
    id: 'zarinpal',
    capabilities: {
      paymentModel: 'redirect',
      createPayment: true,
      customerEligibility: false,
      installmentPlans: false,
      inquiry: false,
      verify: true,
      reverse: false,
      cancel: false,
      partialRefund: true,
      fullRefund: true,
      webhook: false,
      redirectCallback: true,
      reconciliation: false,
    },
    create: createProviderPayment,
    correlateCallback: (input) => ({ attemptId: String(input.query?.iranPaymentId ?? '') }),
    verify: verifyProviderPayment,
    refund: refundProviderPayment,
    verifyConfiguration: async () => ({ healthy: true }),
  };
  beforeAll(async () => {
    replica = await MongoMemoryReplSet.create({
      ...(existsSync('/bin/mongod') ? { binary: { systemBinary: '/bin/mongod' } } : {}),
      replSet: { count: 1 },
    });
    connection = await mongoose.createConnection(replica.getUri()).asPromise();
  }, 30_000);
  afterAll(async () => {
    await connection?.close();
    await replica?.stop();
  });

  it('separates save, verification and activation and creates once under concurrency', async () => {
    const payments = createPaymentGateways({
      connection,
      encryption: { current: { id: 'v1', key: Buffer.alloc(32, 9) } },
      adapters: [adapter],
      modelPrefix: `Test${Date.now()}`,
    });
    const saved = await payments.configure({
      publicKey: 'zarinpal-primary',
      provider: 'zarinpal',
      label: 'Primary',
      environment: 'production',
      credentials: { merchantId: 'write-only' },
      presentation: { title: 'زرین‌پال', sortOrder: 10 },
    });
    expect(saved).toMatchObject({
      configured: true,
      verified: false,
      enabled: false,
      masked: '********',
    });
    await expect(payments.setConfigurationEnabled(saved.id, true)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await payments.verifyConfiguration(saved.id);
    await payments.setConfigurationEnabled(saved.id, true);
    await expect(payments.listAvailable()).resolves.toEqual([
      expect.objectContaining({ key: 'zarinpal-primary', title: 'زرین‌پال' }),
    ]);
    const input = {
      gateway: 'zarinpal' as const,
      configurationId: saved.id,
      idempotencyKey: 'order-1-v1',
      amount: { value: 1_500_000, currency: 'IRR' as const },
      reference: { type: 'order', id: 'order-1' },
      callbackUrl: 'https://merchant.test/callback',
    };
    const results = await Promise.all([payments.create(input), payments.create(input)]);
    expect(createProviderPayment).toHaveBeenCalledTimes(1);
    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    const attemptId = results[0]!.id;
    await Promise.all([
      payments.verifyCallback({ gateway: 'zarinpal', query: { iranPaymentId: attemptId } }),
      payments.verifyCallback({ gateway: 'zarinpal', query: { iranPaymentId: attemptId } }),
    ]);
    expect(verifyProviderPayment).toHaveBeenCalledTimes(1);
    const stored = await payments.models.Attempt.findById(attemptId).lean().exec();
    expect(stored).toMatchObject({ state: 'paid', paidAmount: 1_500_000 });
    expect(await payments.models.Outbox.countDocuments({ aggregateId: attemptId })).toBe(1);

    const refunds = await Promise.allSettled([
      payments.refund(attemptId, { value: 800_000, currency: 'IRR' }, 'refund-a'),
      payments.refund(attemptId, { value: 800_000, currency: 'IRR' }, 'refund-b'),
    ]);
    expect(refunds.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(refunds.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(refundProviderPayment).toHaveBeenCalledTimes(1);
    const refunded = await payments.models.Attempt.findById(attemptId).lean().exec();
    expect(refunded).toMatchObject({
      state: 'partially_refunded',
      refundedAmount: 800_000,
      reservedRefundAmount: 0,
    });
  });
});
