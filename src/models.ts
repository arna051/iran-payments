import type { Connection, Model } from 'mongoose';
import { Schema } from 'mongoose';
import { gatewayIds } from './types.js';
const moneySchema = new Schema(
  {
    value: { type: Number, required: true },
    currency: { type: String, enum: ['IRR', 'IRT'], required: true },
  },
  { _id: false },
);
const referenceSchema = new Schema(
  { type: { type: String, required: true }, id: { type: String, required: true } },
  { _id: false },
);
const encryptedSchema = new Schema(
  {
    algorithm: { type: String, enum: ['aes-256-gcm'], required: true },
    keyId: { type: String, required: true },
    nonce: { type: String, required: true },
    ciphertext: { type: String, required: true },
    tag: { type: String, required: true },
  },
  { _id: false },
);
const presentationSchema = new Schema(
  {
    title: { type: String, required: true },
    description: String,
    icon: Schema.Types.Mixed,
    color: String,
    sortOrder: { type: Number, required: true },
  },
  { _id: false },
);
const configurationSchema = new Schema(
  {
    publicKey: { type: String, required: true },
    provider: { type: String, enum: gatewayIds, required: true },
    label: { type: String, required: true },
    scope: { type: String, default: 'default' },
    environment: { type: String, enum: ['sandbox', 'production'], required: true },
    credentials: { type: encryptedSchema, required: true, select: false },
    credentialsConfigured: { type: Boolean, default: true },
    presentation: { type: presentationSchema, required: true },
    enabled: { type: Boolean, default: false },
    verifiedAt: Date,
    verificationVersion: Number,
    health: {
      status: { type: String, enum: ['unknown', 'healthy', 'unhealthy'], default: 'unknown' },
      checkedAt: Date,
      consecutiveFailures: { type: Number, default: 0 },
    },
    schemaVersion: { type: Number, default: 1 },
    capabilities: Schema.Types.Mixed,
  },
  { timestamps: true, optimisticConcurrency: true },
);
configurationSchema.index({ publicKey: 1 }, { unique: true });
configurationSchema.index({ provider: 1, scope: 1, environment: 1 });
const attemptSchema = new Schema(
  {
    gateway: { type: String, enum: gatewayIds, required: true },
    configurationId: { type: Schema.Types.ObjectId, ref: 'PaymentGatewayConfiguration' },
    state: { type: String, required: true },
    providerState: String,
    providerData: Schema.Types.Mixed,
    idempotencyKey: { type: String, required: true },
    requestFingerprint: { type: String, required: true },
    reference: { type: referenceSchema, required: true },
    amount: { type: moneySchema, required: true },
    wireAmount: moneySchema,
    providerReference: String,
    providerTransactionId: String,
    callbackUrl: { type: String, required: true },
    metadata: Schema.Types.Mixed,
    redirectUrl: String,
    expiresAt: Date,
    callbackAt: Date,
    verifiedAt: Date,
    reconciledAt: Date,
    paidAmount: { type: Number, default: 0 },
    refundedAmount: { type: Number, default: 0 },
  },
  { timestamps: true, optimisticConcurrency: true },
);
attemptSchema.index({ gateway: 1, idempotencyKey: 1 }, { unique: true });
attemptSchema.index({ gateway: 1, providerReference: 1 }, { unique: true, sparse: true });
attemptSchema.index({ state: 1, updatedAt: 1 });
const operationSchema = new Schema(
  {
    attemptId: { type: Schema.Types.ObjectId, required: true, index: true },
    kind: {
      type: String,
      enum: ['create', 'callback', 'verify', 'inquiry', 'reverse', 'cancel', 'refund'],
      required: true,
    },
    idempotencyKey: String,
    requestFingerprint: String,
    status: { type: String, enum: ['pending', 'succeeded', 'failed', 'unknown'], required: true },
    providerCorrelationId: String,
    requestEvidence: Schema.Types.Mixed,
    responseEvidence: Schema.Types.Mixed,
    error: Schema.Types.Mixed,
  },
  { timestamps: true },
);
operationSchema.index({ attemptId: 1, kind: 1, idempotencyKey: 1 }, { unique: true, sparse: true });
const webhookSchema = new Schema(
  {
    gateway: { type: String, enum: gatewayIds, required: true },
    eventKey: { type: String, required: true },
    signatureValid: Boolean,
    status: { type: String, enum: ['received', 'processed', 'ignored', 'failed'], required: true },
    evidence: Schema.Types.Mixed,
    processedAt: Date,
    expiresAt: Date,
  },
  { timestamps: true },
);
webhookSchema.index({ gateway: 1, eventKey: 1 }, { unique: true });
webhookSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
const outboxSchema = new Schema(
  {
    aggregateId: { type: Schema.Types.ObjectId, required: true },
    type: { type: String, required: true },
    payload: { type: Schema.Types.Mixed, required: true },
    publishedAt: Date,
    attempts: { type: Number, default: 0 },
    nextAttemptAt: Date,
  },
  { timestamps: true },
);
outboxSchema.index({ publishedAt: 1, nextAttemptAt: 1 });
export interface PaymentModels {
  Configuration: Model<any>;
  Attempt: Model<any>;
  Operation: Model<any>;
  WebhookEvent: Model<any>;
  Outbox: Model<any>;
}
export function createPaymentModels(
  connection: Connection,
  prefix = 'IranPayments',
): PaymentModels {
  const model = (name: string, schema: Schema) =>
    connection.models[`${prefix}${name}`] ?? connection.model(`${prefix}${name}`, schema);
  return {
    Configuration: model('Configuration', configurationSchema),
    Attempt: model('Attempt', attemptSchema),
    Operation: model('Operation', operationSchema),
    WebhookEvent: model('WebhookEvent', webhookSchema),
    Outbox: model('Outbox', outboxSchema),
  };
}
