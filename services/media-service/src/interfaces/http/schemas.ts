import { z } from 'zod';

export const iso = z.codec(z.iso.datetime({ offset: true }), z.date(), {
  decode: (s) => new Date(s),
  encode: (d) => d.toISOString(),
});

const ErrorResponse = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
    requestId: z.string(),
  }),
});
export const errors = {
  400: ErrorResponse,
  401: ErrorResponse,
  403: ErrorResponse,
  404: ErrorResponse,
  409: ErrorResponse,
  413: ErrorResponse,
  422: ErrorResponse,
};
