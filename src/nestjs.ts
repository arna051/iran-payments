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
  UseGuards,
  type CanActivate,
  type InjectionToken,
  type OptionalFactoryDependency,
  type Type,
} from '@nestjs/common';
import { createPaymentGateways, type PaymentGatewaysOptions } from './orchestrator.js';
import type { AvailabilityInput, GatewayId, GatewayPresentation } from './types.js';
export const PAYMENT_GATEWAYS = Symbol('PAYMENT_GATEWAYS');
export const PAYMENT_GATEWAYS_OPTIONS = Symbol('PAYMENT_GATEWAYS_OPTIONS');
export interface NestPaymentGatewaysOptions extends PaymentGatewaysOptions {
  admin?: { enabled: boolean; guard: Type<CanActivate>; routePrefix?: string };
  discovery?: { enabled: boolean; route?: string; guard?: Type<CanActivate> };
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
    staticOptions?: Pick<NestPaymentGatewaysOptions, 'admin' | 'discovery'>;
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
      ],
      exports: [PAYMENT_GATEWAYS, PaymentGatewaysService],
    };
  }
}
