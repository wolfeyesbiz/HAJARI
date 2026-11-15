import type { NextFunction, Request, Response } from 'express';

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (m: string, d?: unknown) => new ApiError(400, 'bad_request', m, d);
export const unauthorized = (m = 'You must sign in to continue.') => new ApiError(401, 'unauthorized', m);
export const forbidden = (m = 'You do not have permission to do that.') => new ApiError(403, 'forbidden', m);
export const notFound = (m = 'Not found.') => new ApiError(404, 'not_found', m);
export const conflict = (m: string, d?: unknown) => new ApiError(409, 'conflict', m, d);
export const unprocessable = (m: string, d?: unknown) => new ApiError(422, 'validation_error', m, d);

type Handler = (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown;

/** Wrap async route handlers so rejections reach the error middleware. */
export function ah(fn: Handler) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

const PG_MESSAGES: Record<string, [number, string, string]> = {
  '23505': [409, 'conflict', 'That record already exists.'],
  '23503': [409, 'conflict', 'That record is still referenced by other data.'],
  '23502': [400, 'bad_request', 'A required field is missing.'],
  '23514': [400, 'bad_request', 'A value is outside the allowed range.'],
  '22P02': [400, 'bad_request', 'Invalid input format.'],
};

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  const anyErr = err as { code?: string; message?: string; detail?: string };
  const mapped = anyErr?.code ? PG_MESSAGES[anyErr.code] : undefined;
  if (mapped) {
    const [status, code, message] = mapped;
    return res.status(status).json({
      error: { code, message, details: anyErr.detail ?? undefined },
    });
  }
  console.error('[attendease] unhandled error:', err);
  return res.status(500).json({
    error: { code: 'internal_error', message: 'Something went wrong on our side. Please try again.' },
  });
}
