import { z } from 'zod';
import { gatewayIds } from './types.js';
export const moneySchema = z.object({
  value: z.number().int().safe().positive(),
  currency: z.enum(['IRR', 'IRT']),
});
export const startPaymentSchema = z.object({
  gateway: z.enum(gatewayIds),
  configurationId: z.string().optional(),
  scope: z.string().trim().min(1).max(200).optional(),
  environment: z.enum(['sandbox', 'production']).optional(),
  paymentModel: z.enum(['redirect', 'wallet', 'bnpl', 'installment', 'hybrid']).optional(),
  idempotencyKey: z.string().trim().min(1).max(200),
  amount: moneySchema,
  reference: z.object({
    type: z.string().trim().min(1).max(100),
    id: z.string().trim().min(1).max(300),
  }),
  customer: z
    .object({
      phone: z.string().max(32).optional(),
      email: z.email().optional(),
      nationalId: z.string().max(32).optional(),
    })
    .optional(),
  callbackUrl: z
    .url()
    .refine(
      (url) => url.startsWith('https://') || /^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(url),
      'callbackUrl must use HTTPS',
    ),
  description: z.string().max(500).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  extensions: z.unknown().optional(),
});
const builtinIconKeys = [
  'zarinpal',
  'torobpay',
  'digipay',
  'snapppay',
  'azkivam',
  'budgetpay',
  'card',
  'wallet',
  'installment',
] as const;
export const gatewayPresentationSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).optional(),
    icon: z
      .discriminatedUnion('type', [
        z.object({ type: z.literal('builtin'), key: z.enum(builtinIconKeys) }),
        z.object({
          type: z.literal('url'),
          url: z.url().refine((url) => url.startsWith('https://'), 'Icon URL must use HTTPS'),
        }),
      ])
      .optional(),
    color: z
      .string()
      .regex(/^#[0-9A-F]{6}$/u, 'Color must be canonical #RRGGBB uppercase hex')
      .optional(),
    sortOrder: z.number().int().min(-10_000).max(10_000),
  })
  .strict();
export const gatewayConfigurationInputSchema = z
  .object({
    publicKey: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
      .min(3)
      .max(80),
    provider: z.enum(gatewayIds),
    label: z.string().trim().min(1).max(120),
    environment: z.enum(['sandbox', 'production']),
    scope: z.string().trim().min(1).max(200).default('default'),
    credentials: z.record(z.string(), z.unknown()),
    presentation: gatewayPresentationSchema,
    publicLimits: z
      .object({ min: moneySchema.optional(), max: moneySchema.optional() })
      .refine(
        (limits) =>
          !limits.min ||
          !limits.max ||
          (limits.min.currency === limits.max.currency && limits.min.value <= limits.max.value),
        'Minimum and maximum must use one currency and min must not exceed max',
      )
      .optional(),
  })
  .strict();
export const availabilitySchema = z
  .object({
    amount: moneySchema.optional(),
    customer: z
      .object({
        phone: z.string().max(32).optional(),
        email: z.email().optional(),
        nationalId: z.string().max(32).optional(),
      })
      .optional(),
    scope: z
      .object({
        tenantId: z.string().max(200).optional(),
        businessId: z.string().max(200).optional(),
      })
      .optional(),
    paymentModel: z.enum(['redirect', 'wallet', 'bnpl', 'installment', 'hybrid']).optional(),
    environment: z.enum(['sandbox', 'production']).optional(),
  })
  .strict();
