export * from './zarinpal.js';
export * from './manual.js';
export * from './online-credit.js';
export * from './digipay.js';
export * from './budgetpay.js';
export * from './azkivam.js';

import type { AxiosInstance } from 'axios';
import type { GatewayAdapter, GatewayId } from '../types.js';
import { AzkiVamAdapter } from './azkivam.js';
import { BudgetPayAdapter } from './budgetpay.js';
import { DigiPayAdapter } from './digipay.js';
import { SnappPayAdapter, TorobPayAdapter } from './online-credit.js';
import { ZarinpalAdapter } from './zarinpal.js';

export function createBuiltInAdapters(
  transports: Partial<Record<GatewayId, AxiosInstance>> = {},
): GatewayAdapter<any>[] {
  return [
    new ZarinpalAdapter(transports.zarinpal),
    new TorobPayAdapter(transports.torobpay),
    new DigiPayAdapter(transports.digipay),
    new SnappPayAdapter(transports.snapppay),
    new AzkiVamAdapter(transports.azkivam),
    new BudgetPayAdapter(transports.budgetpay),
  ];
}
