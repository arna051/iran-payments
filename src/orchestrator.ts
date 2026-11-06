import type { ClientSession, Connection } from 'mongoose';
import { PaymentError } from './errors.js';
import { createPaymentModels, type PaymentModels } from './models.js';
import {
  availabilitySchema,
  gatewayConfigurationInputSchema,
  gatewayPresentationSchema,
  startPaymentSchema,
} from './schemas.js';
import { decryptJson, encryptJson, fingerprint, redact, type EncryptionKey } from './security.js';
import { assertTransition } from './state-machine.js';
import type {
  AvailabilityInput,
  AvailableGateway,
  CallbackInput,
  GatewayAdapter,
  GatewayId,
  GatewayPresentation,
  GatewayPublicLimits,
  Money,
  PaymentAttemptRecord,
  PaymentEvents,
  ProviderContext,
  StartPaymentInput,
  StartPaymentResult,
} from './types.js';

export interface PaymentGatewaysOptions {
  connection: Connection;
  encryption: { current: EncryptionKey; previous?: readonly EncryptionKey[] };
  adapters: readonly GatewayAdapter[];
  events?: PaymentEvents;
  modelPrefix?: string;
}
export class PaymentGateways {
  readonly models: PaymentModels;
  private readonly adapters: Map<GatewayId, GatewayAdapter>;
  constructor(private readonly options: PaymentGatewaysOptions) {
    this.models = createPaymentModels(options.connection, options.modelPrefix);
    this.adapters = new Map(options.adapters.map((adapter) => [adapter.id, adapter]));
  }
  capabilities(gateway?: GatewayId) {
    if (gateway) return this.adapter(gateway).capabilities;
    return Object.fromEntries(
      [...this.adapters].map(([id, adapter]) => [id, adapter.capabilities]),
    );
  }
  async configure(input: {
    publicKey: string;
    provider: GatewayId;
    label: string;
    environment: 'sandbox' | 'production';
    credentials: Record<string, unknown>;
    presentation: GatewayPresentation;
    publicLimits?: GatewayPublicLimits;
    scope?: string;
  }) {
    const parsed = gatewayConfigurationInputSchema.parse(input);
    const adapter = this.adapter(parsed.provider);
    const document = await this.models.Configuration.create({
      ...parsed,
      credentials: encryptJson(parsed.credentials, this.options.encryption.current),
      credentialsConfigured: true,
      enabled: false,
      verifiedAt: null,
      verificationVersion: 0,
      health: { status: 'unknown', consecutiveFailures: 0 },
      capabilities: adapter.capabilities,
    });
    return this.adminDto(document);
  }
  async listConfigurations(scope?: string) {
    const documents = await this.models.Configuration.find(scope ? { scope } : {})
      .sort({ createdAt: -1 })
      .exec();
    return documents.map((document) => this.adminDto(document));
  }
  async getConfiguration(id: string) {
    const document = await this.models.Configuration.findById(id).exec();
    if (!document)
      throw new PaymentError('CONFIGURATION_NOT_FOUND', 'Gateway configuration not found');
    return this.adminDto(document);
  }
  async updateConfiguration(
    id: string,
    patch: {
      label?: string;
      presentation?: GatewayPresentation;
      credentials?: Record<string, unknown>;
      clearCredentials?: boolean;
    },
  ) {
    if (patch.credentials && patch.clearCredentials)
      throw new PaymentError(
        'INVALID_INPUT',
        'credentials and clearCredentials are mutually exclusive',
      );
    const document = await this.models.Configuration.findById(id).select('+credentials').exec();
    if (!document)
      throw new PaymentError('CONFIGURATION_NOT_FOUND', 'Gateway configuration not found');
    if (patch.label !== undefined) document.label = patch.label.trim();
    if (patch.presentation !== undefined)
      document.presentation = gatewayPresentationSchema.parse(patch.presentation);
    if (patch.clearCredentials)
      throw new PaymentError(
        'INVALID_INPUT',
        'This provider does not permit clearing all credentials',
      );
    if (patch.credentials !== undefined) {
      document.credentials = encryptJson(patch.credentials, this.options.encryption.current);
      document.verifiedAt = undefined;
      document.verificationVersion = 0;
      document.enabled = false;
      document.health = { status: 'unknown', consecutiveFailures: 0 };
    }
    await document.save();
    return this.adminDto(document);
  }
  async verifyConfiguration(id: string) {
    const document = await this.models.Configuration.findById(id).select('+credentials').exec();
    if (!document)
      throw new PaymentError('CONFIGURATION_NOT_FOUND', 'Gateway configuration not found');
    const adapter = this.adapter(document.provider);
    if (!adapter.verifyConfiguration)
      throw new PaymentError(
        'UNSUPPORTED_OPERATION',
        `${document.provider} has no non-financial configuration verification endpoint`,
      );
    try {
      const result = await adapter.verifyConfiguration(this.context(document));
      if (!result.healthy)
        throw new PaymentError('PROVIDER_ERROR', 'Provider rejected the configuration');
      document.verifiedAt = new Date();
      document.verificationVersion = 1;
      document.health = { status: 'healthy', checkedAt: new Date(), consecutiveFailures: 0 };
      await document.save();
      return this.adminDto(document);
    } catch (cause) {
      document.verifiedAt = undefined;
      document.enabled = false;
      document.health = {
        status: 'unhealthy',
        checkedAt: new Date(),
        consecutiveFailures: Number(document.health?.consecutiveFailures ?? 0) + 1,
      };
      await document.save();
      throw this.providerError(cause);
    }
  }
  async setConfigurationEnabled(id: string, enabled: boolean) {
    const document = await this.models.Configuration.findById(id).exec();
    if (!document)
      throw new PaymentError('CONFIGURATION_NOT_FOUND', 'Gateway configuration not found');
    if (enabled && !document.verifiedAt)
      throw new PaymentError(
        'INVALID_INPUT',
        'Configuration must be verified before it can be enabled',
      );
    document.enabled = enabled;
    await document.save();
    return this.adminDto(document);
  }
  async deleteConfiguration(id: string) {
    const inUse = await this.models.Attempt.exists({ configurationId: id });
    if (inUse)
      throw new PaymentError(
        'INVALID_INPUT',
        'Configuration is referenced by payment attempts and cannot be deleted',
      );
    const result = await this.models.Configuration.deleteOne({ _id: id }).exec();
    if (!result.deletedCount)
      throw new PaymentError('CONFIGURATION_NOT_FOUND', 'Gateway configuration not found');
  }
  async listAvailable(input: AvailabilityInput = {}): Promise<AvailableGateway[]> {
    const parsed = availabilitySchema.parse(input);
    const scope = parsed.scope?.tenantId ?? parsed.scope?.businessId ?? 'default';
    const query: Record<string, unknown> = {
      enabled: true,
      verifiedAt: { $ne: null },
      environment: parsed.environment ?? 'production',
      scope,
      'health.status': { $ne: 'unhealthy' },
    };
    const documents = (await this.models.Configuration.find(query).lean().exec()) as any[];
    return documents
      .filter((document) => {
        const capabilities = document.capabilities as GatewayAdapter['capabilities'];
        if (
          parsed.paymentModel &&
          capabilities.paymentModel !== parsed.paymentModel &&
          capabilities.paymentModel !== 'hybrid'
        )
          return false;
        const limits = document.publicLimits as { min?: Money; max?: Money } | undefined;
        if (
          parsed.amount &&
          limits?.min &&
          (parsed.amount.currency !== limits.min.currency || parsed.amount.value < limits.min.value)
        )
          return false;
        if (
          parsed.amount &&
          limits?.max &&
          (parsed.amount.currency !== limits.max.currency || parsed.amount.value > limits.max.value)
        )
          return false;
        return true;
      })
      .map((document) => this.publicDto(document))
      .sort((a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key));
  }
  async create(input: StartPaymentInput): Promise<StartPaymentResult> {
    const parsed = startPaymentSchema.parse(input) as StartPaymentInput;
    const adapter = this.adapter(parsed.gateway);
    const requestFingerprint = fingerprint({
      gateway: parsed.gateway,
      configurationId: parsed.configurationId,
      scope: parsed.scope ?? 'default',
      environment: parsed.environment ?? 'production',
      amount: parsed.amount,
      reference: parsed.reference,
      customer: parsed.customer,
      callbackUrl: parsed.callbackUrl,
      extensions: parsed.extensions,
    });
    const config = await this.loadConfiguration(
      parsed.gateway,
      parsed.configurationId,
      parsed.scope ?? 'default',
      parsed.environment ?? 'production',
    );
    this.assertConfigurationAvailable(config, parsed.amount, parsed.paymentModel);
    const claimed = (await this.models.Attempt.findOneAndUpdate(
      { gateway: parsed.gateway, idempotencyKey: parsed.idempotencyKey },
      {
        $setOnInsert: {
          gateway: parsed.gateway,
          configurationId: config._id,
          state: 'created',
          idempotencyKey: parsed.idempotencyKey,
          requestFingerprint,
          reference: parsed.reference,
          amount: parsed.amount,
          callbackUrl: parsed.callbackUrl,
          metadata: parsed.metadata,
          paidAmount: 0,
          refundedAmount: 0,
          reservedRefundAmount: 0,
        },
      },
      { upsert: true, new: true, includeResultMetadata: true, setDefaultsOnInsert: true },
    ).exec()) as any;
    const attempt = claimed.value;
    const inserted = !claimed.lastErrorObject?.updatedExisting;
    if (!attempt) throw new PaymentError('CONCURRENCY_CONFLICT', 'Failed to claim payment attempt');
    if (!inserted) {
      if (attempt.requestFingerprint !== requestFingerprint) {
        throw new PaymentError(
          'IDEMPOTENCY_CONFLICT',
          'Idempotency key was already used with a different request',
        );
      }
      return this.result(attempt.toObject(), true);
    }
    const operation = await this.models.Operation.create({
      attemptId: attempt._id,
      kind: 'create',
      idempotencyKey: parsed.idempotencyKey,
      requestFingerprint,
      status: 'pending',
      requestEvidence: redact(parsed),
    });
    let providerAccepted = false;
    try {
      const providerInput = {
        ...parsed,
        callbackUrl: this.callbackWithCorrelation(parsed.callbackUrl, String(attempt._id)),
      };
      const created = await adapter.create(providerInput, this.context(config));
      providerAccepted = true;
      const nextState = created.redirectUrl ? 'customer_action_required' : 'provider_pending';
      assertTransition('created', nextState);
      const session = await this.options.connection.startSession();
      let committedAttempt: any;
      try {
        await session.withTransaction(async () => {
          committedAttempt = await this.models.Attempt.findOneAndUpdate(
            { _id: attempt._id, state: 'created' },
            {
              $set: {
                state: nextState,
                providerReference: created.providerReference,
                providerState: created.providerState,
                providerData: created.providerData,
                wireAmount: created.wireAmount,
                redirectUrl: created.redirectUrl,
                expiresAt: created.expiresAt,
              },
            },
            { new: true, session },
          ).exec();
          if (!committedAttempt)
            throw new PaymentError(
              'CONCURRENCY_CONFLICT',
              'Payment create result could not be committed',
            );
          await this.models.Operation.updateOne(
            { _id: operation._id, status: 'pending' },
            {
              $set: {
                status: 'succeeded',
                providerCorrelationId: created.providerReference,
                responseEvidence: redact(created.raw),
              },
            },
            { session },
          ).exec();
        });
      } finally {
        await session.endSession();
      }
      return this.result(
        committedAttempt.toObject() as PaymentAttemptRecord & { redirectUrl?: string },
        false,
      );
    } catch (cause) {
      const unknown = providerAccepted || this.isUnknown(cause);
      await this.models.Attempt.updateOne(
        { _id: attempt._id, state: 'created' },
        { $set: { state: unknown ? 'unknown' : 'failed' } },
      ).exec();
      await this.models.Operation.updateOne(
        { _id: operation._id, status: 'pending' },
        { $set: { status: unknown ? 'unknown' : 'failed', error: this.safeError(cause) } },
      ).exec();
      throw this.providerError(cause);
    }
  }
  async verifyCallback(input: CallbackInput): Promise<PaymentAttemptRecord> {
    const adapter = this.adapter(input.gateway);
    if (!adapter.verify)
      throw new PaymentError(
        'UNSUPPORTED_OPERATION',
        `${input.gateway} does not support verification`,
      );
    const correlation = await adapter.correlateCallback(input);
    if (!correlation.providerReference && !correlation.attemptId) {
      throw new PaymentError('CALLBACK_UNCORRELATED', 'Callback is missing correlation data');
    }
    const lookup = correlation.attemptId
      ? { _id: correlation.attemptId, gateway: input.gateway }
      : { gateway: input.gateway, providerReference: correlation.providerReference };
    const current = await this.models.Attempt.findOne(lookup).exec();
    if (!current)
      throw new PaymentError(
        'CALLBACK_UNCORRELATED',
        'Callback could not be correlated to a payment',
      );
    if (['paid', 'refunded', 'partially_refunded'].includes(current.state)) {
      return current.toObject() as PaymentAttemptRecord;
    }
    if (current.state === 'created') {
      throw new PaymentError(
        'UNKNOWN_OUTCOME',
        'The provider callback arrived before payment creation was committed; reconciliation will recover it',
      );
    }
    assertTransition(current.state, 'verifying');
    const attempt = await this.models.Attempt.findOneAndUpdate(
      {
        ...lookup,
        state: {
          $in: [
            'provider_pending',
            'customer_action_required',
            'callback_received',
            'unknown',
            'expired',
            'failed',
          ],
        },
      },
      {
        $set: {
          state: 'verifying',
          callbackAt: new Date(),
          ...(correlation.providerReference
            ? { providerReference: correlation.providerReference }
            : {}),
        },
      },
      { new: true },
    ).exec();
    if (!attempt) {
      const concurrentlyClaimed = await this.models.Attempt.findOne(lookup).exec();
      if (!concurrentlyClaimed)
        throw new PaymentError('CALLBACK_UNCORRELATED', 'Payment disappeared during verification');
      if (concurrentlyClaimed.state === 'created') {
        throw new PaymentError(
          'UNKNOWN_OUTCOME',
          'The provider callback arrived before payment creation was committed; reconciliation will recover it',
        );
      }
      return concurrentlyClaimed.toObject() as PaymentAttemptRecord;
    }
    const config = await this.loadAttemptConfiguration(input.gateway, attempt.configurationId);
    const operation = await this.models.Operation.create({
      attemptId: attempt._id,
      kind: 'verify',
      status: 'pending',
      requestEvidence: redact({ query: input.query, body: input.body, headers: input.headers }),
    });
    let result;
    try {
      result = await adapter.verify(
        attempt.toObject() as PaymentAttemptRecord,
        input,
        this.context(config),
      );
    } catch (cause) {
      const definitiveInputFailure =
        cause instanceof PaymentError &&
        ['INVALID_INPUT', 'CALLBACK_UNCORRELATED'].includes(cause.code);
      await this.models.Attempt.updateOne(
        { _id: attempt._id, state: 'verifying' },
        { $set: { state: definitiveInputFailure ? 'failed' : 'unknown' } },
      ).exec();
      operation.status = this.isUnknown(cause) ? 'unknown' : 'failed';
      operation.error = this.safeError(cause);
      await operation.save();
      throw this.providerError(cause);
    }
    const amountMismatch =
      result.amount &&
      (result.amount.value !== attempt.amount.value ||
        result.amount.currency !== attempt.amount.currency);
    const session = await this.options.connection.startSession();
    let committedAttempt: any;
    try {
      await session.withTransaction(async () => {
        committedAttempt = await this.models.Attempt.findOneAndUpdate(
          { _id: attempt._id, state: 'verifying' },
          {
            $set: amountMismatch
              ? { state: 'manual_review', providerState: result.providerState }
              : {
                  state: result.paid ? 'paid' : 'failed',
                  providerState: result.providerState,
                  providerTransactionId: result.providerTransactionId,
                  verifiedAt: new Date(),
                  ...(result.paid ? { paidAmount: attempt.amount.value } : {}),
                },
          },
          { new: true, session },
        ).exec();
        if (!committedAttempt) {
          throw new PaymentError(
            'CONCURRENCY_CONFLICT',
            'Payment verification was completed concurrently',
          );
        }
        await this.models.Operation.updateOne(
          { _id: operation._id },
          {
            $set: amountMismatch
              ? {
                  status: 'failed',
                  error: { code: 'AMOUNT_MISMATCH', message: 'Provider amount mismatch' },
                }
              : {
                  status: 'succeeded',
                  responseEvidence: redact(result.raw),
                  providerCorrelationId: result.providerTransactionId,
                },
          },
          { session },
        ).exec();
        if (result.paid && !amountMismatch) {
          await this.enqueue(committedAttempt, 'paid', attempt.amount, session);
        }
      });
    } catch (cause) {
      await this.models.Attempt.updateOne(
        { _id: attempt._id, state: 'verifying' },
        { $set: { state: 'unknown' } },
      ).exec();
      await this.models.Operation.updateOne(
        { _id: operation._id, status: 'pending' },
        { $set: { status: 'unknown', error: this.safeError(cause) } },
      ).exec();
      throw this.providerError(cause);
    } finally {
      await session.endSession();
    }
    if (amountMismatch) {
      throw new PaymentError(
        'AMOUNT_MISMATCH',
        'Verified provider amount does not match the stored trusted amount',
      );
    }
    return committedAttempt.toObject() as PaymentAttemptRecord;
  }
  async processWebhook(input: CallbackInput & { configurationKey: string }) {
    const adapter = this.adapter(input.gateway);
    if (!adapter.verifyWebhook || !adapter.capabilities.webhook) {
      throw new PaymentError(
        'UNSUPPORTED_OPERATION',
        `${input.gateway} does not support authenticated webhooks`,
      );
    }
    const configuration = await this.models.Configuration.findOne({
      provider: input.gateway,
      publicKey: input.configurationKey,
    })
      .select('+credentials')
      .exec();
    if (!configuration)
      throw new PaymentError('CONFIGURATION_NOT_FOUND', 'Webhook configuration not found');
    const verification = await adapter.verifyWebhook(input, this.context(configuration));
    const eventKey =
      verification.eventId ??
      fingerprint({
        rawBody: input.rawBody ? Buffer.from(input.rawBody).toString('base64') : null,
        body: input.body,
      });
    const claimed = (await this.models.WebhookEvent.findOneAndUpdate(
      { gateway: input.gateway, eventKey },
      {
        $setOnInsert: {
          gateway: input.gateway,
          eventKey,
          signatureValid: verification.signatureValid,
          status: verification.signatureValid ? 'received' : 'failed',
          evidence: redact({ headers: input.headers, body: input.body }),
          expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60_000),
        },
      },
      { upsert: true, new: true, includeResultMetadata: true },
    ).exec()) as any;
    const event = claimed.value;
    if (!verification.signatureValid) {
      throw new PaymentError('PROVIDER_ERROR', 'Webhook signature is invalid');
    }
    if (claimed.lastErrorObject?.updatedExisting && event?.status === 'processed') {
      return { duplicate: true, paymentId: event.attemptId };
    }
    const webhookAttemptId = verification.attemptId
      ? verification.attemptId
      : verification.providerReference
        ? String(
            (
              (await this.models.Attempt.findOne({
                gateway: input.gateway,
                configurationId: configuration._id,
                providerReference: verification.providerReference,
              })
                .select('_id')
                .exec()) as any
            )?._id ?? '',
          )
        : '';
    const callback: CallbackInput = {
      ...input,
      query: {
        ...input.query,
        ...(webhookAttemptId ? { iranPaymentId: webhookAttemptId } : {}),
        ...(verification.providerReference
          ? { providerReference: verification.providerReference }
          : {}),
      },
    };
    const attempt = await this.verifyCallback(callback);
    await this.models.WebhookEvent.updateOne(
      { _id: event._id },
      { $set: { status: 'processed', processedAt: new Date(), attemptId: attempt._id } },
    ).exec();
    return { duplicate: false, paymentId: String(attempt._id), state: attempt.state };
  }
  async refund(attemptId: string, amount: Money, idempotencyKey: string) {
    const initialAttempt = await this.models.Attempt.findById(attemptId).exec();
    if (!initialAttempt) throw new PaymentError('INVALID_INPUT', 'Payment not found');
    const adapter = this.adapter(initialAttempt.gateway);
    if (
      !adapter.refund ||
      (!adapter.capabilities.fullRefund && !adapter.capabilities.partialRefund)
    )
      throw new PaymentError(
        'UNSUPPORTED_OPERATION',
        `${initialAttempt.gateway} does not support refunds`,
      );
    if (
      !Number.isSafeInteger(amount.value) ||
      amount.currency !== initialAttempt.amount.currency ||
      amount.value <= 0
    )
      throw new PaymentError(
        'INVALID_INPUT',
        'Refund amount is invalid or exceeds the unrefunded paid amount',
      );
    const fp = fingerprint({ attemptId, amount });
    const claimed = (await this.models.Operation.findOneAndUpdate(
      { attemptId, kind: 'refund', idempotencyKey },
      {
        $setOnInsert: {
          attemptId,
          kind: 'refund',
          idempotencyKey,
          requestFingerprint: fp,
          status: 'pending',
        },
      },
      { upsert: true, new: true, includeResultMetadata: true },
    ).exec()) as any;
    const operation = claimed.value;
    if (!operation) throw new PaymentError('CONCURRENCY_CONFLICT', 'Failed to claim refund');
    if (claimed.lastErrorObject?.updatedExisting) {
      if (operation.requestFingerprint !== fp)
        throw new PaymentError('IDEMPOTENCY_CONFLICT', 'Refund idempotency key conflict');
      if (operation.status === 'succeeded') {
        const replay = await this.models.Attempt.findById(attemptId).exec();
        if (!replay) throw new PaymentError('INVALID_INPUT', 'Payment not found');
        return replay.toObject();
      }
      if (operation.status === 'pending' || operation.status === 'unknown') {
        throw new PaymentError(
          'UNKNOWN_OUTCOME',
          'The prior refund outcome is not confirmed; reconcile before retrying',
        );
      }
      throw new PaymentError('PROVIDER_ERROR', 'The prior refund attempt failed');
    }
    const reserved = await this.models.Attempt.findOneAndUpdate(
      {
        _id: attemptId,
        state: { $in: ['paid', 'partially_refunded'] },
        $expr: {
          $lte: [
            {
              $add: ['$refundedAmount', { $ifNull: ['$reservedRefundAmount', 0] }, amount.value],
            },
            '$paidAmount',
          ],
        },
      },
      { $inc: { reservedRefundAmount: amount.value } },
      { new: true },
    ).exec();
    if (!reserved) {
      operation.status = 'failed';
      operation.error = { code: 'INVALID_INPUT', message: 'Refund exceeds available paid amount' };
      await operation.save();
      throw new PaymentError('INVALID_INPUT', 'Refund amount exceeds the available paid amount');
    }
    const config = await this.loadAttemptConfiguration(reserved.gateway, reserved.configurationId);
    try {
      const result = await adapter.refund(
        reserved.toObject(),
        amount,
        idempotencyKey,
        this.context(config),
      );
      const session = await this.options.connection.startSession();
      let committedAttempt: any;
      try {
        await session.withTransaction(async () => {
          committedAttempt = await this.models.Attempt.findOneAndUpdate(
            { _id: attemptId, reservedRefundAmount: { $gte: amount.value } },
            [
              {
                $set: {
                  reservedRefundAmount: {
                    $subtract: ['$reservedRefundAmount', amount.value],
                  },
                  refundedAmount: { $add: ['$refundedAmount', amount.value] },
                  providerState: result.providerState,
                },
              },
              {
                $set: {
                  state: {
                    $cond: [
                      { $eq: ['$refundedAmount', '$paidAmount'] },
                      'refunded',
                      'partially_refunded',
                    ],
                  },
                },
              },
            ],
            { new: true, session },
          ).exec();
          if (!committedAttempt)
            throw new PaymentError(
              'CONCURRENCY_CONFLICT',
              'Refund succeeded remotely but local accounting requires reconciliation',
            );
          await this.models.Operation.updateOne(
            { _id: operation._id },
            {
              $set: {
                status: 'succeeded',
                responseEvidence: redact(result.raw),
                providerCorrelationId: result.providerOperationId,
              },
            },
            { session },
          ).exec();
          await this.enqueue(committedAttempt, 'refunded', amount, session);
        });
      } finally {
        await session.endSession();
      }
      return committedAttempt.toObject();
    } catch (cause) {
      const unknown =
        this.isUnknown(cause) ||
        (cause instanceof PaymentError && cause.code === 'CONCURRENCY_CONFLICT');
      operation.status = unknown ? 'unknown' : 'failed';
      operation.error = this.safeError(cause);
      await operation.save();
      if (!unknown) {
        await this.models.Attempt.updateOne(
          { _id: attemptId, reservedRefundAmount: { $gte: amount.value } },
          { $inc: { reservedRefundAmount: -amount.value } },
        ).exec();
      }
      throw this.providerError(cause);
    }
  }
  async inquiry(attemptId: string) {
    const attempt = await this.models.Attempt.findById(attemptId).exec();
    if (!attempt) throw new PaymentError('INVALID_INPUT', 'Payment not found');
    const adapter = this.adapter(attempt.gateway);
    if (!adapter.inquiry || !adapter.capabilities.inquiry) {
      throw new PaymentError(
        'UNSUPPORTED_OPERATION',
        `${attempt.gateway} does not support inquiry`,
      );
    }
    const config = await this.loadAttemptConfiguration(attempt.gateway, attempt.configurationId);
    const operation = await this.models.Operation.create({
      attemptId: attempt._id,
      kind: 'inquiry',
      status: 'pending',
    });
    try {
      const result = await adapter.inquiry(attempt.toObject(), this.context(config));
      operation.status = 'succeeded';
      operation.responseEvidence = redact(result.raw);
      await operation.save();
      return result;
    } catch (cause) {
      operation.status = 'failed';
      operation.error = this.safeError(cause);
      await operation.save();
      throw this.providerError(cause);
    }
  }
  async cancel(attemptId: string, idempotencyKey: string) {
    const attempt = await this.models.Attempt.findById(attemptId).exec();
    if (!attempt) throw new PaymentError('INVALID_INPUT', 'Payment not found');
    const adapter = this.adapter(attempt.gateway);
    if (!adapter.cancel || !adapter.capabilities.cancel) {
      throw new PaymentError(
        'UNSUPPORTED_OPERATION',
        `${attempt.gateway} does not support cancellation`,
      );
    }
    if (!['provider_pending', 'customer_action_required', 'unknown'].includes(attempt.state)) {
      throw new PaymentError(
        'INVALID_STATE_TRANSITION',
        `Cannot cancel payment in ${attempt.state}`,
      );
    }
    const fingerprintValue = fingerprint({ attemptId, kind: 'cancel' });
    const existing = (await this.models.Operation.findOne({
      attemptId,
      kind: 'cancel',
      idempotencyKey,
    })
      .lean()
      .exec()) as any;
    if (existing) {
      if (existing.requestFingerprint !== fingerprintValue) {
        throw new PaymentError('IDEMPOTENCY_CONFLICT', 'Cancellation idempotency key conflict');
      }
      if (existing.status === 'succeeded') {
        const replay = await this.models.Attempt.findById(attemptId).exec();
        if (!replay) throw new PaymentError('INVALID_INPUT', 'Payment not found');
        return replay.toObject();
      }
      if (existing.status === 'pending' || existing.status === 'unknown') {
        throw new PaymentError(
          'UNKNOWN_OUTCOME',
          'The prior cancellation outcome is not confirmed; inquire before retrying',
        );
      }
      throw new PaymentError('PROVIDER_ERROR', 'The prior cancellation attempt failed');
    }
    const operation = await this.models.Operation.create({
      attemptId,
      kind: 'cancel',
      idempotencyKey,
      requestFingerprint: fingerprintValue,
      status: 'pending',
    });
    const config = await this.loadAttemptConfiguration(attempt.gateway, attempt.configurationId);
    try {
      const result = await adapter.cancel(attempt.toObject(), idempotencyKey, this.context(config));
      assertTransition(attempt.state, 'cancelled');
      const session = await this.options.connection.startSession();
      let committed: any;
      try {
        await session.withTransaction(async () => {
          committed = await this.models.Attempt.findOneAndUpdate(
            {
              _id: attempt._id,
              state: { $in: ['provider_pending', 'customer_action_required', 'unknown'] },
            },
            { $set: { state: 'cancelled', providerState: result.providerState } },
            { new: true, session },
          ).exec();
          if (!committed)
            throw new PaymentError(
              'CONCURRENCY_CONFLICT',
              'Cancellation succeeded remotely but local state changed concurrently',
            );
          await this.models.Operation.updateOne(
            { _id: operation._id },
            {
              $set: {
                status: 'succeeded',
                providerCorrelationId: result.providerOperationId,
                responseEvidence: redact(result.raw),
              },
            },
            { session },
          ).exec();
        });
      } finally {
        await session.endSession();
      }
      return committed.toObject();
    } catch (cause) {
      operation.status = this.isUnknown(cause) ? 'unknown' : 'failed';
      operation.error = this.safeError(cause);
      await operation.save();
      if (
        this.isUnknown(cause) ||
        (cause instanceof PaymentError && cause.code === 'CONCURRENCY_CONFLICT')
      )
        await this.models.Attempt.updateOne(
          { _id: attempt._id, state: { $ne: 'cancelled' } },
          { $set: { state: 'unknown' } },
        ).exec();
      throw this.providerError(cause);
    }
  }
  async reverse(attemptId: string, idempotencyKey: string) {
    const attempt = await this.models.Attempt.findById(attemptId).exec();
    if (!attempt) throw new PaymentError('INVALID_INPUT', 'Payment not found');
    const adapter = this.adapter(attempt.gateway);
    if (!adapter.reverse || !adapter.capabilities.reverse) {
      throw new PaymentError(
        'UNSUPPORTED_OPERATION',
        `${attempt.gateway} does not support reversal`,
      );
    }
    if (attempt.state !== 'paid') {
      throw new PaymentError(
        'INVALID_STATE_TRANSITION',
        `Cannot reverse payment in ${attempt.state}`,
      );
    }
    const requestFingerprint = fingerprint({ attemptId, kind: 'reverse' });
    const claimed = (await this.models.Operation.findOneAndUpdate(
      { attemptId, kind: 'reverse', idempotencyKey },
      {
        $setOnInsert: {
          attemptId,
          kind: 'reverse',
          idempotencyKey,
          requestFingerprint,
          status: 'pending',
        },
      },
      { upsert: true, new: true, includeResultMetadata: true },
    ).exec()) as any;
    const operation = claimed.value;
    if (!operation) throw new PaymentError('CONCURRENCY_CONFLICT', 'Failed to claim reversal');
    if (claimed.lastErrorObject?.updatedExisting) {
      if (operation.requestFingerprint !== requestFingerprint)
        throw new PaymentError('IDEMPOTENCY_CONFLICT', 'Reversal idempotency key conflict');
      if (operation.status === 'succeeded') {
        const replay = await this.models.Attempt.findById(attemptId).exec();
        if (!replay) throw new PaymentError('INVALID_INPUT', 'Payment not found');
        return replay.toObject();
      }
      throw new PaymentError(
        'UNKNOWN_OUTCOME',
        'The prior reversal is not safely retryable; reconcile it first',
      );
    }
    const config = await this.loadAttemptConfiguration(attempt.gateway, attempt.configurationId);
    try {
      const result = await adapter.reverse(
        attempt.toObject(),
        idempotencyKey,
        this.context(config),
      );
      const session = await this.options.connection.startSession();
      let committed: any;
      try {
        await session.withTransaction(async () => {
          committed = await this.models.Attempt.findOneAndUpdate(
            { _id: attemptId, state: 'paid' },
            { $set: { state: 'reversed', providerState: result.providerState } },
            { new: true, session },
          ).exec();
          if (!committed)
            throw new PaymentError(
              'CONCURRENCY_CONFLICT',
              'Reversal succeeded remotely but local state changed concurrently',
            );
          await this.models.Operation.updateOne(
            { _id: operation._id },
            {
              $set: {
                status: 'succeeded',
                providerCorrelationId: result.providerOperationId,
                responseEvidence: redact(result.raw),
              },
            },
            { session },
          ).exec();
          await this.enqueue(committed, 'reversed', attempt.amount, session);
        });
      } finally {
        await session.endSession();
      }
      return committed.toObject();
    } catch (cause) {
      const unknown =
        this.isUnknown(cause) ||
        (cause instanceof PaymentError && cause.code === 'CONCURRENCY_CONFLICT');
      await this.models.Operation.updateOne(
        { _id: operation._id },
        { $set: { status: unknown ? 'unknown' : 'failed', error: this.safeError(cause) } },
      ).exec();
      if (unknown)
        await this.models.Attempt.updateOne(
          { _id: attemptId, state: 'paid' },
          { $set: { state: 'manual_review' } },
        ).exec();
      throw this.providerError(cause);
    }
  }
  async reconcile(options: { olderThan?: Date; limit?: number } = {}) {
    const olderThan = options.olderThan ?? new Date(Date.now() - 5 * 60_000);
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const attempts = await this.models.Attempt.find({
      $or: [
        {
          state: { $in: ['provider_pending', 'customer_action_required', 'unknown', 'verifying'] },
        },
        { state: 'created', providerReference: { $type: 'string' } },
      ],
      updatedAt: { $lte: olderThan },
    })
      .sort({ updatedAt: 1, _id: 1 })
      .limit(limit)
      .exec();
    const summary = { examined: attempts.length, paid: 0, failed: 0, unchanged: 0, errors: 0 };
    for (const attempt of attempts) {
      const adapter = this.adapters.get(attempt.gateway);
      if (!adapter?.inquiry || !adapter.capabilities.reconciliation) {
        summary.unchanged += 1;
        continue;
      }
      try {
        const config = await this.loadAttemptConfiguration(
          attempt.gateway,
          attempt.configurationId,
        );
        const result = await adapter.inquiry(attempt.toObject(), this.context(config));
        if (
          result.amount &&
          (result.amount.value !== attempt.amount.value ||
            result.amount.currency !== attempt.amount.currency)
        ) {
          const changed = await this.models.Attempt.updateOne(
            {
              _id: attempt._id,
              state: {
                $in: ['provider_pending', 'customer_action_required', 'unknown', 'verifying'],
              },
            },
            {
              $set: {
                state: 'manual_review',
                reconciledAt: new Date(),
                providerState: result.providerState,
              },
            },
          ).exec();
          if (changed.modifiedCount) summary.errors += 1;
          else summary.unchanged += 1;
          continue;
        }
        if (result.paid) {
          const session = await this.options.connection.startSession();
          let changed = false;
          try {
            await session.withTransaction(async () => {
              const committed = await this.models.Attempt.findOneAndUpdate(
                {
                  _id: attempt._id,
                  state: {
                    $in: ['provider_pending', 'customer_action_required', 'unknown', 'verifying'],
                  },
                },
                {
                  $set: {
                    state: 'paid',
                    paidAmount: attempt.amount.value,
                    verifiedAt: new Date(),
                    reconciledAt: new Date(),
                    providerState: result.providerState,
                    providerTransactionId: result.providerTransactionId,
                  },
                },
                { new: true, session },
              ).exec();
              if (committed) {
                changed = true;
                await this.enqueue(committed, 'paid', attempt.amount, session);
              }
            });
          } finally {
            await session.endSession();
          }
          if (changed) summary.paid += 1;
          else summary.unchanged += 1;
        } else if (
          result.definitive &&
          ['failed', 'cancelled', 'expired'].includes((result.providerState ?? '').toLowerCase())
        ) {
          const changed = await this.models.Attempt.updateOne(
            {
              _id: attempt._id,
              state: {
                $in: ['provider_pending', 'customer_action_required', 'unknown', 'verifying'],
              },
            },
            {
              $set: {
                state: (result.providerState ?? 'failed').toLowerCase(),
                reconciledAt: new Date(),
                providerState: result.providerState,
              },
            },
          ).exec();
          if (changed.modifiedCount) summary.failed += 1;
          else summary.unchanged += 1;
        } else {
          await this.models.Attempt.updateOne(
            {
              _id: attempt._id,
              state: {
                $in: ['provider_pending', 'customer_action_required', 'unknown', 'verifying'],
              },
            },
            { $set: { reconciledAt: new Date(), providerState: result.providerState } },
          ).exec();
          summary.unchanged += 1;
        }
        await this.models.Operation.create({
          attemptId: attempt._id,
          kind: 'inquiry',
          status: 'succeeded',
          responseEvidence: redact(result.raw),
        });
      } catch (cause) {
        summary.errors += 1;
        await this.models.Operation.create({
          attemptId: attempt._id,
          kind: 'inquiry',
          status: 'failed',
          error: this.safeError(cause),
        });
      }
    }
    return summary;
  }
  async dispatchOutbox(options: { limit?: number } = {}) {
    if (!this.options.events?.onEvent) return { examined: 0, published: 0, failed: 0 };
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const now = new Date();
    const events = await this.models.Outbox.find({
      publishedAt: null,
      $and: [
        { $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }] },
        { $or: [{ lockedAt: null }, { lockedAt: { $lte: new Date(now.getTime() - 5 * 60_000) } }] },
      ],
    })
      .sort({ createdAt: 1, _id: 1 })
      .limit(limit)
      .exec();
    const summary = { examined: events.length, published: 0, failed: 0 };
    for (const event of events) {
      const lease = await this.models.Outbox.updateOne(
        {
          _id: event._id,
          publishedAt: null,
          $or: [{ lockedAt: null }, { lockedAt: { $lte: new Date(Date.now() - 5 * 60_000) } }],
        },
        { $set: { lockedAt: new Date() } },
      ).exec();
      if (!lease.modifiedCount) continue;
      try {
        await this.options.events.onEvent(event.payload);
        const claimed = await this.models.Outbox.updateOne(
          { _id: event._id, publishedAt: null, lockedAt: { $ne: null } },
          { $set: { publishedAt: new Date() }, $unset: { lockedAt: 1 }, $inc: { attempts: 1 } },
        ).exec();
        if (claimed.modifiedCount) summary.published += 1;
      } catch {
        summary.failed += 1;
        await this.models.Outbox.updateOne(
          { _id: event._id },
          {
            $inc: { attempts: 1 },
            $set: { nextAttemptAt: new Date(Date.now() + 60_000) },
            $unset: { lockedAt: 1 },
          },
        ).exec();
      }
    }
    return summary;
  }
  private adapter(id: GatewayId) {
    const adapter = this.adapters.get(id);
    if (!adapter)
      throw new PaymentError('UNSUPPORTED_OPERATION', `No adapter registered for ${id}`);
    return adapter;
  }
  private async loadConfiguration(
    provider: GatewayId,
    id: string | undefined,
    scope: string,
    environment: 'sandbox' | 'production',
  ) {
    const base = {
      provider,
      scope,
      environment,
      enabled: true,
      verifiedAt: { $ne: null },
      'health.status': { $ne: 'unhealthy' },
    };
    const query =
      id && id !== 'undefined' ? { ...base, $or: [{ _id: id }, { publicKey: id }] } : base;
    const config = await this.models.Configuration.findOne(query).select('+credentials').exec();
    if (!config)
      throw new PaymentError(
        'CONFIGURATION_NOT_FOUND',
        `No verified, enabled and healthy ${provider} configuration found`,
      );
    return config;
  }
  private assertConfigurationAvailable(config: any, amount: Money, paymentModel?: string) {
    const capabilities = config.capabilities as GatewayAdapter['capabilities'];
    if (
      paymentModel &&
      capabilities.paymentModel !== paymentModel &&
      capabilities.paymentModel !== 'hybrid'
    ) {
      throw new PaymentError('GATEWAY_UNAVAILABLE', 'Gateway does not support this payment model');
    }
    const limits = config.publicLimits as { min?: Money; max?: Money } | undefined;
    if (
      (limits?.min &&
        (amount.currency !== limits.min.currency || amount.value < limits.min.value)) ||
      (limits?.max && (amount.currency !== limits.max.currency || amount.value > limits.max.value))
    ) {
      throw new PaymentError('GATEWAY_UNAVAILABLE', 'Payment amount is outside gateway limits');
    }
  }
  private async loadAttemptConfiguration(provider: GatewayId, id: unknown) {
    const config = await this.models.Configuration.findOne({ _id: id, provider })
      .select('+credentials')
      .exec();
    if (!config) {
      throw new PaymentError(
        'CONFIGURATION_NOT_FOUND',
        `The ${provider} configuration used by this payment is unavailable`,
      );
    }
    return config;
  }
  private context(config: any): ProviderContext {
    return {
      configuration: decryptJson(config.credentials, [
        this.options.encryption.current,
        ...(this.options.encryption.previous ?? []),
      ]),
    };
  }
  private result(
    attempt: PaymentAttemptRecord & { redirectUrl?: string },
    replay: boolean,
  ): StartPaymentResult {
    return {
      id: String(attempt._id),
      gateway: attempt.gateway,
      state: attempt.state,
      ...(attempt.redirectUrl ? { redirectUrl: attempt.redirectUrl } : {}),
      ...(attempt.providerReference ? { providerReference: attempt.providerReference } : {}),
      idempotentReplay: replay,
    };
  }
  private callbackWithCorrelation(callbackUrl: string, attemptId: string) {
    const url = new URL(callbackUrl);
    url.searchParams.set('iranPaymentId', attemptId);
    return url.toString();
  }
  private adminDto(document: any) {
    const value = document.toObject ? document.toObject() : document;
    return {
      id: String(value._id),
      publicKey: value.publicKey,
      provider: value.provider,
      label: value.label,
      scope: value.scope,
      environment: value.environment,
      presentation: value.presentation,
      publicLimits: value.publicLimits,
      enabled: Boolean(value.enabled),
      verified: Boolean(value.verifiedAt),
      verifiedAt: value.verifiedAt,
      healthy: value.health?.status === 'healthy',
      configured: Boolean(value.credentialsConfigured),
      masked: value.credentialsConfigured ? '********' : undefined,
      capabilities: value.capabilities,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
    };
  }
  private publicDto(document: any): AvailableGateway {
    const presentation = document.presentation as GatewayPresentation;
    const capabilities = document.capabilities as GatewayAdapter['capabilities'];
    return {
      key: document.publicKey,
      provider: document.provider,
      title: presentation.title,
      ...(presentation.description ? { description: presentation.description } : {}),
      ...(presentation.icon ? { icon: presentation.icon } : {}),
      ...(presentation.color ? { color: presentation.color } : {}),
      paymentModel: capabilities.paymentModel,
      capabilities: {
        customerEligibility: capabilities.customerEligibility,
        installmentPlans: capabilities.installmentPlans,
      },
      sortOrder: presentation.sortOrder,
      ...(document.publicLimits ? { limits: document.publicLimits } : {}),
    };
  }
  private async enqueue(
    attempt: any,
    type: 'paid' | 'refunded' | 'failed' | 'reversed',
    amount: Money,
    session?: ClientSession,
  ) {
    const payload = {
      type,
      attemptId: String(attempt._id),
      gateway: attempt.gateway,
      reference: attempt.reference,
      amount,
    };
    await this.models.Outbox.create(
      [{ aggregateId: attempt._id, type: `payment.${type}`, payload }],
      session ? { session } : undefined,
    );
  }
  private isUnknown(error: unknown) {
    return error instanceof PaymentError && error.code === 'UNKNOWN_OUTCOME';
  }
  private safeError(error: unknown) {
    return error instanceof PaymentError
      ? { code: error.code, message: error.message }
      : {
          code: 'PROVIDER_ERROR',
          message: error instanceof Error ? error.message : 'Provider request failed',
        };
  }
  private providerError(cause: unknown) {
    return cause instanceof PaymentError
      ? cause
      : new PaymentError(
          'PROVIDER_ERROR',
          cause instanceof Error ? cause.message : 'Provider request failed',
          undefined,
          { cause },
        );
  }
}
export function createPaymentGateways(options: PaymentGatewaysOptions) {
  return new PaymentGateways(options);
}
