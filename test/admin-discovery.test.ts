import 'reflect-metadata';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { gatewayPresentationSchema, PaymentGateways } from '../src/index.js';
import { PaymentGatewaysModule, type NestPaymentGatewaysOptions } from '../src/nestjs.js';

class HostAdminGuard implements CanActivate {
  canActivate(_context: ExecutionContext) {
    return true;
  }
}
const options = {
  connection: {} as never,
  encryption: { current: { id: 'test', key: Buffer.alloc(32) } },
  adapters: [],
} satisfies NestPaymentGatewaysOptions;

describe('admin and discovery integration', () => {
  it('ships no controllers by default', () => {
    expect(PaymentGatewaysModule.forRoot(options).controllers).toEqual([]);
  });
  it('mounts admin only when enabled and attaches the host guard', () => {
    const module = PaymentGatewaysModule.forRoot({
      ...options,
      admin: { enabled: true, guard: HostAdminGuard },
    });
    expect(module.controllers).toHaveLength(1);
    const controller = module.controllers?.[0] as object;
    expect(Reflect.getMetadata(PATH_METADATA, controller)).toBe('admin/payment-gateways');
    expect(Reflect.getMetadata(GUARDS_METADATA, controller)).toContain(HostAdminGuard);
  });
  it('mounts sanitized discovery independently', () => {
    const module = PaymentGatewaysModule.forRoot({ ...options, discovery: { enabled: true } });
    expect(module.controllers).toHaveLength(1);
    expect(Reflect.getMetadata(PATH_METADATA, module.controllers?.[0] as object)).toBe(
      'payment-gateways/available',
    );
  });
  it('mounts public provider callbacks only when explicitly enabled', () => {
    const module = PaymentGatewaysModule.forRoot({ ...options, callbacks: { enabled: true } });
    expect(module.controllers).toHaveLength(1);
    expect(Reflect.getMetadata(PATH_METADATA, module.controllers?.[0] as object)).toBe(
      'payment-gateways/callback',
    );
    expect(Reflect.getMetadata(GUARDS_METADATA, module.controllers?.[0] as object)).toBeUndefined();
  });
});

describe('presentation validation', () => {
  const valid = { title: 'پرداخت امن', sortOrder: 10, color: '#F4B400' };
  it('accepts Unicode and canonical display fields', () => {
    expect(gatewayPresentationSchema.parse(valid)).toEqual(valid);
  });
  it.each([
    { ...valid, color: 'red' },
    { ...valid, color: '#fff' },
    { ...valid, icon: { type: 'url', url: 'javascript:alert(1)' } },
    { ...valid, icon: { type: 'url', url: 'data:image/svg+xml,<svg onload=alert(1)>' } },
    { ...valid, icon: { type: 'builtin', key: '<script>' } },
  ])('rejects unsafe presentation %#', (value) => {
    expect(gatewayPresentationSchema.safeParse(value).success).toBe(false);
  });
});

describe('explicit public DTO', () => {
  it('allowlists fields and sorts without leaking internal data', () => {
    const prototype = PaymentGateways.prototype as unknown as {
      publicDto(value: unknown): unknown;
    };
    const output = prototype.publicDto({
      publicKey: 'zarinpal-primary',
      provider: 'zarinpal',
      credentials: 'secret',
      merchantId: 'private',
      presentation: { title: 'زرین‌پال', sortOrder: 1 },
      capabilities: {
        paymentModel: 'redirect',
        customerEligibility: false,
        installmentPlans: false,
      },
    });
    expect(output).toEqual({
      key: 'zarinpal-primary',
      provider: 'zarinpal',
      title: 'زرین‌پال',
      paymentModel: 'redirect',
      capabilities: { customerEligibility: false, installmentPlans: false },
      sortOrder: 1,
    });
    expect(JSON.stringify(output)).not.toMatch(/secret|merchant|credentials/iu);
  });
});
