import 'server-only';
import type { PaymentGateways } from './orchestrator.js';
import type { GatewayId } from './types.js';
import type { StartPaymentInput } from './types.js';

export function createNextPaymentHandler(
  payments: PaymentGateways,
  resolveTrustedInput: (request: Request) => Promise<StartPaymentInput> | StartPaymentInput,
) {
  return async function createPayment(request: Request): Promise<Response> {
    try {
      const input = await resolveTrustedInput(request);
      const payment = await payments.create(input);
      return Response.json(payment, { status: 201 });
    } catch (error) {
      return Response.json(
        {
          ok: false,
          code:
            error && typeof error === 'object' && 'code' in error
              ? String(error.code)
              : 'PAYMENT_ERROR',
        },
        { status: 400 },
      );
    }
  };
}
export function createNextCallbackHandler(
  payments: PaymentGateways,
  gateway: GatewayId,
  options?: { successRedirect?: URL; failureRedirect?: URL },
) {
  return async function callback(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const body =
        request.method === 'GET'
          ? undefined
          : await request
              .clone()
              .json()
              .catch(() => undefined);
      const attempt = await payments.verifyCallback({
        gateway,
        query: Object.fromEntries(url.searchParams),
        body,
        headers: Object.fromEntries(request.headers.entries()),
        rawBody: new Uint8Array(await request.arrayBuffer()),
      });
      if (options?.successRedirect) return Response.redirect(options.successRedirect, 303);
      return Response.json({ ok: true, paymentId: String(attempt._id) });
    } catch {
      if (options?.failureRedirect) return Response.redirect(options.failureRedirect, 303);
      return Response.json({ ok: false }, { status: 400 });
    }
  };
}

export function createNextWebhookHandler(
  payments: PaymentGateways,
  gateway: GatewayId,
  configurationKey: string,
) {
  return async function webhook(request: Request): Promise<Response> {
    const rawBody = new Uint8Array(await request.arrayBuffer());
    try {
      await payments.processWebhook({
        gateway,
        configurationKey,
        query: Object.fromEntries(new URL(request.url).searchParams),
        headers: Object.fromEntries(request.headers.entries()),
        rawBody,
      });
      return Response.json({ ok: true });
    } catch {
      return Response.json({ ok: false }, { status: 400 });
    }
  };
}
