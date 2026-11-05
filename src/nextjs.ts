import 'server-only';
import type { PaymentGateways } from './orchestrator.js';
import type { GatewayId } from './types.js';
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
