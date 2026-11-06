import {
  Body,
  Controller,
  Delete,
  DynamicModule,
  Get,
  Global,
  Inject,
  Injectable,
  Module,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Headers,
  UseGuards,
  type CanActivate,
  type InjectionToken,
  type OptionalFactoryDependency,
  type Type,
} from '@nestjs/common';
import { createPaymentGateways, type PaymentGatewaysOptions } from './orchestrator.js';
import type {
  AvailabilityInput,
  GatewayId,
  GatewayPresentation,
  GatewayPublicLimits,
} from './types.js';
import type { Request } from 'express';
export const PAYMENT_GATEWAYS = Symbol('PAYMENT_GATEWAYS');
export const PAYMENT_GATEWAYS_OPTIONS = Symbol('PAYMENT_GATEWAYS_OPTIONS');
export interface NestPaymentGatewaysOptions extends PaymentGatewaysOptions {
  admin?: { enabled: boolean; guard: Type<CanActivate>; routePrefix?: string };
  discovery?: { enabled: boolean; route?: string; guard?: Type<CanActivate> };
  callbacks?: { enabled: boolean; routePrefix?: string };
}
@Injectable()
export class PaymentGatewaysService {
  constructor(
    @Inject(PAYMENT_GATEWAYS) private readonly payments: ReturnType<typeof createPaymentGateways>,
  ) {}
  get client() {
    return this.payments;
  }
}

@Injectable()
export class PaymentReconciliationService {
  constructor(@Inject(PaymentGatewaysService) private readonly payments: PaymentGatewaysService) {}
  run(options?: { olderThan?: Date; limit?: number }) {
    return this.payments.client.reconcile(options);
  }
  dispatchOutbox(options?: { limit?: number }) {
    return this.payments.client.dispatchOutbox(options);
  }
}
function decorateMethod(decorator: MethodDecorator, target: object, name: string) {
  const descriptor = Object.getOwnPropertyDescriptor(target, name);
  if (!descriptor) throw new Error(`Missing controller method ${name}`);
  decorator(target, name, descriptor);
}
function createAdminController(prefix: string, guard: Type<CanActivate>): Type<unknown> {
  class AdminPaymentGatewaysController {
    constructor(readonly service: PaymentGatewaysService) {}
    providerTypes() {
      return this.service.client.capabilities();
    }
    list() {
      return this.service.client.listConfigurations();
    }
    get(id: string) {
      return this.service.client.getConfiguration(id);
    }
    create(body: {
      publicKey: string;
      provider: GatewayId;
      label: string;
      environment: 'sandbox' | 'production';
      scope?: string;
      credentials: Record<string, unknown>;
      presentation: GatewayPresentation;
      publicLimits?: GatewayPublicLimits;
    }) {
      return this.service.client.configure(body);
    }
    update(
      id: string,
      body: {
        label?: string;
        presentation?: GatewayPresentation;
        credentials?: Record<string, unknown>;
        clearCredentials?: boolean;
      },
    ) {
      return this.service.client.updateConfiguration(id, body);
    }
    verify(id: string) {
      return this.service.client.verifyConfiguration(id);
    }
    enable(id: string) {
      return this.service.client.setConfigurationEnabled(id, true);
    }
    disable(id: string) {
      return this.service.client.setConfigurationEnabled(id, false);
    }
    remove(id: string) {
      return this.service.client.deleteConfiguration(id);
    }
  }
  Controller(prefix)(AdminPaymentGatewaysController);
  UseGuards(guard)(AdminPaymentGatewaysController);
  Inject(PaymentGatewaysService)(AdminPaymentGatewaysController, undefined, 0);
  const proto = AdminPaymentGatewaysController.prototype;
  decorateMethod(Get('provider-types'), proto, 'providerTypes');
  decorateMethod(Get(), proto, 'list');
  decorateMethod(Get(':id'), proto, 'get');
  Param('id')(proto, 'get', 0);
  decorateMethod(Post(), proto, 'create');
  Body()(proto, 'create', 0);
  decorateMethod(Patch(':id'), proto, 'update');
  Param('id')(proto, 'update', 0);
  Body()(proto, 'update', 1);
  decorateMethod(Post(':id/verify'), proto, 'verify');
  Param('id')(proto, 'verify', 0);
  decorateMethod(Post(':id/enable'), proto, 'enable');
  Param('id')(proto, 'enable', 0);
  decorateMethod(Post(':id/disable'), proto, 'disable');
  Param('id')(proto, 'disable', 0);
  decorateMethod(Delete(':id'), proto, 'remove');
  Param('id')(proto, 'remove', 0);
  return AdminPaymentGatewaysController;
}
function createDiscoveryController(route: string, guard?: Type<CanActivate>): Type<unknown> {
  class PaymentGatewayDiscoveryController {
    constructor(readonly service: PaymentGatewaysService) {}
    available(body: AvailabilityInput = {}) {
      return this.service.client.listAvailable(body);
    }
  }
  Controller(route)(PaymentGatewayDiscoveryController);
  if (guard) UseGuards(guard)(PaymentGatewayDiscoveryController);
  Inject(PaymentGatewaysService)(PaymentGatewayDiscoveryController, undefined, 0);
  decorateMethod(Post(), PaymentGatewayDiscoveryController.prototype, 'available');
  Body()(PaymentGatewayDiscoveryController.prototype, 'available', 0);
  return PaymentGatewayDiscoveryController;
}

function createCallbackController(route: string): Type<unknown> {
  class PaymentGatewayCallbackController {
    constructor(readonly service: PaymentGatewaysService) {}
    async callback(
      gateway: GatewayId,
      query: Record<string, unknown>,
      body: unknown,
      headers: Record<string, string | string[] | undefined>,
    ) {
      const attempt = await this.service.client.verifyCallback({ gateway, query, body, headers });
      return { ok: true, state: attempt.state };
    }
    async webhook(
      gateway: GatewayId,
      configurationKey: string,
      request: Request & { rawBody?: Buffer },
    ) {
      await this.service.client.processWebhook({
        gateway,
        configurationKey,
        query: request.query,
        body: request.body,
        headers: request.headers as Record<string, string | string[] | undefined>,
        ...(Buffer.isBuffer(request.rawBody) ? { rawBody: request.rawBody } : {}),
      });
      return { ok: true };
    }
  }
  Controller(route)(PaymentGatewayCallbackController);
  Inject(PaymentGatewaysService)(PaymentGatewayCallbackController, undefined, 0);
  const proto = PaymentGatewayCallbackController.prototype;
  decorateMethod(Post(':gateway'), proto, 'callback');
  Param('gateway')(proto, 'callback', 0);
  Query()(proto, 'callback', 1);
  Body()(proto, 'callback', 2);
  Headers()(proto, 'callback', 3);
  decorateMethod(Post('webhook/:gateway/:configurationKey'), proto, 'webhook');
  Param('gateway')(proto, 'webhook', 0);
  Param('configurationKey')(proto, 'webhook', 1);
  Req()(proto, 'webhook', 2);
  return PaymentGatewayCallbackController;
}
@Global()
@Module({})
export class PaymentGatewaysModule {
  static forRoot(options: NestPaymentGatewaysOptions): DynamicModule {
    return this.forRootAsync({ useFactory: () => options, staticOptions: options });
  }
  static forRootAsync(options: {
    imports?: DynamicModule['imports'];
    inject?: (InjectionToken | OptionalFactoryDependency)[];
    useFactory: (
      ...args: any[]
    ) => NestPaymentGatewaysOptions | Promise<NestPaymentGatewaysOptions>;
    staticOptions?: Pick<NestPaymentGatewaysOptions, 'admin' | 'discovery' | 'callbacks'>;
  }): DynamicModule {
    const controllers: Type<unknown>[] = [];
    if (options.staticOptions?.admin?.enabled)
      controllers.push(
        createAdminController(
          options.staticOptions.admin.routePrefix ?? 'admin/payment-gateways',
          options.staticOptions.admin.guard,
        ),
      );
    if (options.staticOptions?.discovery?.enabled)
      controllers.push(
        createDiscoveryController(
          options.staticOptions.discovery.route ?? 'payment-gateways/available',
          options.staticOptions.discovery.guard,
        ),
      );
    if (options.staticOptions?.callbacks?.enabled)
      controllers.push(
        createCallbackController(
          options.staticOptions.callbacks.routePrefix ?? 'payment-gateways/callback',
        ),
      );
    return {
      module: PaymentGatewaysModule,
      imports: options.imports ?? [],
      controllers,
      providers: [
        {
          provide: PAYMENT_GATEWAYS_OPTIONS,
          useFactory: options.useFactory,
          inject: options.inject ?? [],
        },
        {
          provide: PAYMENT_GATEWAYS,
          useFactory: (value: NestPaymentGatewaysOptions) => createPaymentGateways(value),
          inject: [PAYMENT_GATEWAYS_OPTIONS],
        },
        PaymentGatewaysService,
        PaymentReconciliationService,
      ],
      exports: [PAYMENT_GATEWAYS, PaymentGatewaysService, PaymentReconciliationService],
    };
  }
}
