import { PaymentError } from './errors.js';
import type { Currency, Money } from './types.js';
export function assertMoney(value: Money): Money {
  if (!Number.isSafeInteger(value.value) || value.value <= 0)
    throw new PaymentError('INVALID_INPUT', 'Amount must be a positive safe integer');
  if (value.currency !== 'IRR' && value.currency !== 'IRT')
    throw new PaymentError('INVALID_INPUT', 'Currency must be IRR or IRT');
  return value;
}
export function convertMoney(money: Money, currency: Currency): Money {
  assertMoney(money);
  if (money.currency === currency) return { ...money };
  if (money.currency === 'IRT') {
    const value = money.value * 10;
    if (!Number.isSafeInteger(value))
      throw new PaymentError('INVALID_INPUT', 'Converted amount exceeds safe integer range');
    return { value, currency: 'IRR' };
  }
  if (money.value % 10 !== 0)
    throw new PaymentError('INVALID_INPUT', 'IRR amount is not exactly representable in IRT');
  return { value: money.value / 10, currency: 'IRT' };
}
