import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { GatewayId } from './types.js';
import type { StartPaymentInput } from './types.js';
import type { PaymentGateways } from './orchestrator.js';
export interface CallbackHandlerOptions {
  gateway: GatewayId;
  onSuccess?(attempt: unknown, req: Request, res: Response): unknown;
  onError?(error: unknown, req: Request, res: Response): unknown;
}
export function paymentCallbackHandler(
  payments: PaymentGateways,
  options: CallbackHandlerOptions,
): RequestHandler {
  return async (req, res, next: NextFunction) => {
    try {
      const attempt = await payments.verifyCallback({
        gateway: options.gateway,
        query: req.query,
        body: req.body,
        headers: req.headers as Record<string, string | string[] | undefined>,
        ...(Buffer.isBuffer((req as Request & { rawBody?: Buffer }).rawBody)
          ? { rawBody: (req as Request & { rawBody: Buffer }).rawBody }
          : {}),
      });
      if (options.onSuccess) {
        await options.onSuccess(attempt, req, res);
        return;
      }
      res.status(200).json({ ok: true });
    } catch (error) {
      if (options.onError) {
        await options.onError(error, req, res);
        return;
      }
      next(error);
    }
  };
}
export function preserveRawBody(
  req: Request & { rawBody?: Buffer },
  _res: Response,
  buffer: Buffer,
): void {
  req.rawBody = Buffer.from(buffer);
}

export function paymentWebhookHandler(
  payments: PaymentGateways,
  gateway: GatewayId,
  configurationKey: string,
): RequestHandler {
  return async (req, res, next) => {
    try {
      await payments.processWebhook({
        gateway,
        configurationKey,
        query: req.query,
        body: req.body,
        headers: req.headers as Record<string, string | string[] | undefined>,
        ...(Buffer.isBuffer((req as Request & { rawBody?: Buffer }).rawBody)
          ? { rawBody: (req as Request & { rawBody: Buffer }).rawBody }
          : {}),
      });
      res.status(200).json({ ok: true });
    } catch (error) {
      next(error);
    }
  };
}

export function createPaymentHandler(
  payments: PaymentGateways,
  resolveTrustedInput: (request: Request) => Promise<StartPaymentInput> | StartPaymentInput,
): RequestHandler {
  return async (request, response, next) => {
    try {
      const input = await resolveTrustedInput(request);
      const result = await payments.create(input);
      response.status(201).json(result);
    } catch (error) {
      next(error);
    }
  };
}
