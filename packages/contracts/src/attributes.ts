import { z } from 'zod';

/**
 * Category-specific attributes (e.g. phones: brand, storageGb; services: skills) are stored as
 * JSONB and validated against a small schema owned by the category. Deliberately a strict subset
 * of JSON Schema: easy to render as a form, easy to validate on both client and server.
 */
const Label = z.object({ en: z.string().min(1).max(60), bn: z.string().min(1).max(60) });

export const AttributeSpecSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('string'),
    label: Label,
    enum: z.array(z.string().min(1).max(60)).min(1).max(100).optional(),
    maxLength: z.number().int().min(1).max(500).optional(),
  }),
  z.object({
    type: z.literal('integer'),
    label: Label,
    minimum: z.number().int().optional(),
    maximum: z.number().int().optional(),
    unit: z.string().max(12).optional(),
  }),
  z.object({
    type: z.literal('number'),
    label: Label,
    minimum: z.number().optional(),
    maximum: z.number().optional(),
    unit: z.string().max(12).optional(),
  }),
  z.object({ type: z.literal('boolean'), label: Label }),
]);
export type AttributeSpec = z.infer<typeof AttributeSpecSchema>;

export const AttributeSchemaSchema = z.object({
  properties: z.record(z.string().regex(/^[a-z][A-Za-z0-9]{0,39}$/), AttributeSpecSchema),
  required: z.array(z.string()).default([]),
});
export type AttributeSchema = z.infer<typeof AttributeSchemaSchema>;

export type AttributeValues = Record<string, string | number | boolean>;

export type AttributeResult =
  | { ok: true; value: AttributeValues }
  | { ok: false; issues: Array<{ path: string; message: string }> };

/**
 * Validates `input` against `schema`. Unknown keys are rejected (no mass assignment into JSONB).
 * `partial` skips `required` (used for search filters and drafts).
 */
export function validateAttributes(
  schema: AttributeSchema,
  input: unknown,
  opts: { partial?: boolean } = {},
): AttributeResult {
  const issues: Array<{ path: string; message: string }> = [];
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, issues: [{ path: '', message: 'attributes must be an object' }] };
  }
  const value: AttributeValues = {};
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    const spec = schema.properties[key];
    if (!spec) {
      issues.push({ path: key, message: 'unknown attribute' });
      continue;
    }
    switch (spec.type) {
      case 'string':
        if (typeof raw !== 'string' || raw.trim() === '')
          issues.push({ path: key, message: 'must be text' });
        else if (spec.enum && !spec.enum.includes(raw))
          issues.push({ path: key, message: `must be one of ${spec.enum.join(', ')}` });
        else if (raw.length > (spec.maxLength ?? 200))
          issues.push({ path: key, message: 'too long' });
        else value[key] = raw.trim();
        break;
      case 'integer':
      case 'number':
        if (
          typeof raw !== 'number' ||
          !Number.isFinite(raw) ||
          (spec.type === 'integer' && !Number.isInteger(raw))
        ) {
          issues.push({
            path: key,
            message: `must be ${spec.type === 'integer' ? 'a whole number' : 'a number'}`,
          });
        } else if (spec.minimum !== undefined && raw < spec.minimum)
          issues.push({ path: key, message: `must be ≥ ${spec.minimum}` });
        else if (spec.maximum !== undefined && raw > spec.maximum)
          issues.push({ path: key, message: `must be ≤ ${spec.maximum}` });
        else value[key] = raw;
        break;
      case 'boolean':
        if (typeof raw !== 'boolean') issues.push({ path: key, message: 'must be true or false' });
        else value[key] = raw;
        break;
    }
  }
  if (!opts.partial) {
    for (const req of schema.required) {
      if (!(req in value) && !issues.some((i) => i.path === req))
        issues.push({ path: req, message: 'required' });
    }
  }
  return issues.length ? { ok: false, issues } : { ok: true, value };
}
