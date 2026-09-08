import { readFile } from 'node:fs/promises';
import { validateHeaderName, validateHeaderValue } from 'node:http';
import { z } from 'zod';

const json: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(json),
    z.record(json),
  ]),
);
const headerName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const headers = z.record(z.string()).superRefine((value, ctx) => {
  for (const [name, content] of Object.entries(value)) {
    let validValue = true;
    try {
      validateHeaderName(name);
      validateHeaderValue(name, content);
    } catch {
      validValue = false;
    }
    if (!headerName.test(name) || !validValue)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [name],
        message: 'Invalid HTTP header',
      });
    if (
      ['host', 'content-length', 'transfer-encoding', 'connection'].includes(
        name.toLowerCase(),
      )
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [name],
        message: 'Transport-controlled header is not allowed',
      });
  }
});
const httpUrl = z
  .string()
  .url()
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        ['http:', 'https:'].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.hash
      );
    } catch {
      return false;
    }
  }, 'Must be an HTTP(S) URL without credentials or a fragment');
const status = z.number().int().min(100).max(599);
export const assertionSchema = z
  .object({
    status: z
      .union([
        status,
        z
          .object({ min: status, max: status })
          .strict()
          .refine((v) => v.min <= v.max, 'min must not exceed max'),
      ])
      .optional(),
    bodyContains: z.string().optional(),
    jsonSubset: json.optional(),
    maxLatencyMs: z.number().positive().optional(),
    error: z.enum(['timeout', 'network']).optional(),
  })
  .strict();
export const retrySchema = z
  .object({
    maxAttempts: z.number().int().min(1).max(20).default(1),
    delayMs: z.number().int().min(0).max(300000).default(0),
    statuses: z.array(status).default([429, 500, 502, 503, 504]),
  })
  .strict();
const bodyFields = { body: json.optional(), rawBody: z.string().optional() };
const delivery = z
  .object({
    id: z.string().min(1).max(200),
    ...bodyFields,
    copies: z.number().int().min(1).max(100).default(1),
    delayMs: z.number().int().min(0).max(300000).default(0),
    headers: headers.optional(),
    timeoutMs: z.number().int().min(1).max(300000).optional(),
    retry: retrySchema.optional(),
    assert: assertionSchema.optional(),
  })
  .strict()
  .refine(
    (v) => !(v.body !== undefined && v.rawBody !== undefined),
    'Specify body or rawBody, not both',
  );
export const configSchema = z
  .object({
    $schema: z.string().url().optional(),
    version: z.literal(1),
    target: httpUrl,
    headers: headers.default({}),
    sensitiveHeaders: z
      .array(z.string().regex(headerName, 'Invalid HTTP header name'))
      .default([]),
    timeoutMs: z.number().int().min(1).max(300000).default(5000),
    maxResponseBytes: z.number().int().min(1).max(1048576).default(65536),
    retry: retrySchema.default({}),
    signing: z
      .object({
        type: z.literal('stripe'),
        secretEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
        timestamp: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
    deliveries: z.array(delivery).min(1).max(1000),
    verify: z
      .array(
        z
          .object({
            id: z.string().min(1).max(200),
            url: httpUrl,
            method: z.enum(['GET', 'POST']).default('GET'),
            body: json.optional(),
            headers: headers.optional(),
            delayMs: z.number().int().min(0).max(300000).default(0),
            assert: assertionSchema.optional(),
          })
          .strict()
          .refine(
            (v) => v.method !== 'GET' || v.body === undefined,
            'GET verification cannot have a body',
          ),
      )
      .max(100)
      .default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = new Set<string>();
    for (const item of [...value.deliveries, ...value.verify]) {
      if (ids.has(item.id))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['deliveries'],
          message: 'Delivery and verification IDs must be unique',
        });
      ids.add(item.id);
    }
  });
export type Config = z.infer<typeof configSchema>;
export type Assertion = z.infer<typeof assertionSchema>;
export class ConfigError extends Error {}
export function parseConfig(input: unknown): Config {
  const result = configSchema.safeParse(input);
  if (!result.success)
    throw new ConfigError(
      result.error.issues
        .map((i) => {
          const path = i.path.map(String).join('.') || 'config';
          const message =
            i.code === 'unrecognized_keys'
              ? `Unknown configuration field(s): ${i.keys.join(', ')}`
              : i.message;
          return `${path}: ${message}`;
        })
        .join('\n'),
    );
  return result.data;
}
export async function loadConfig(path: string): Promise<Config> {
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch {
    throw new ConfigError(`Cannot read configuration file: ${path}`);
  }
  try {
    return parseConfig(JSON.parse(contents));
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(
      `Configuration is not valid JSON: ${error instanceof Error ? error.message : 'parse failed'}`,
    );
  }
}
