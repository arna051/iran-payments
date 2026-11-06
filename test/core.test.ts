import { describe, expect, it } from 'vitest';
import {
  assertTransition,
  canTransition,
  convertMoney,
  decryptJson,
  encryptJson,
  fingerprint,
  PaymentError,
  redact,
  safeEqualSignatures,
} from '../src/index.js';
describe('money', () => {
  it('converts exact integer units', () => {
    expect(convertMoney({ value: 125, currency: 'IRT' }, 'IRR')).toEqual({
      value: 1250,
      currency: 'IRR',
    });
    expect(convertMoney({ value: 1250, currency: 'IRR' }, 'IRT')).toEqual({
      value: 125,
      currency: 'IRT',
    });
  });
  it('rejects lossy conversion', () => {
    expect(() => convertMoney({ value: 1251, currency: 'IRR' }, 'IRT')).toThrow(PaymentError);
  });
});
describe('state machine', () => {
  it('accepts recovery and rejects impossible moves', () => {
    expect(canTransition('unknown', 'paid')).toBe(true);
    expect(() => assertTransition('created', 'refunded')).toThrow(PaymentError);
  });
});
describe('security', () => {
  it('encrypts authenticated JSON and detects tampering', () => {
    const key = { id: 'v1', key: Buffer.alloc(32, 7) };
    const encrypted = encryptJson({ merchantId: 'secret' }, key);
    expect(decryptJson(encrypted, [key])).toEqual({ merchantId: 'secret' });
    expect(() =>
      decryptJson({ ...encrypted, ciphertext: `${encrypted.ciphertext.slice(0, -2)}AA` }, [key]),
    ).toThrow(PaymentError);
  });
  it('redacts recursively and fingerprints deterministically', () => {
    expect(redact({ authorization: 'x', nested: { apiKey: 'y' } })).toEqual({
      authorization: '[REDACTED]',
      nested: { apiKey: '[REDACTED]' },
    });
    expect(fingerprint({ b: 2, a: 1 })).toBe(fingerprint({ a: 1, b: 2 }));
  });
  it('compares signatures without early byte comparison', () => {
    expect(safeEqualSignatures('abc123', 'abc123')).toBe(true);
    expect(safeEqualSignatures('abc123', 'abc124')).toBe(false);
    expect(safeEqualSignatures('abc123', 'abc1230')).toBe(false);
  });
});
