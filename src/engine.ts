import http from 'node:http';
import https from 'node:https';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  ConfigError,
  parseConfig,
  type Config,
  type Assertion,
} from './config.js';
import { signStripe } from './signing.js';

export interface Attempt {
  deliveryId: string;
  phase: 'delivery' | 'verification';
  order: number;
  copy: number;
  attempt: number;
  status?: number;
  durationMs: number;
  responseBody: string;
  truncated: boolean;
  error?: 'timeout' | 'network';
  passed: boolean;
  failures: string[];
}
export interface Report {
  version: 1;
  passed: boolean;
  startedAt: string;
  durationMs: number;
  attempts: Attempt[];
  summary: { requests: number; passed: number; failed: number };
}
export interface RunOptions {
  allowRemote?: boolean;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}
const defaults = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'stripe-signature',
];
function checkedURL(value: string, allowRemote: boolean): URL {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new ConfigError(
      'Targets must be HTTP(S) URLs without credentials or fragments',
    );
  if (
    !allowRemote &&
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  )
    throw new ConfigError('Remote targets require --allow-remote');
  return url;
}
function mergeHeaders(
  ...values: (Record<string, string> | undefined)[]
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const value of values)
    for (const [k, v] of Object.entries(value ?? {}))
      result[k.toLowerCase()] = v;
  return result;
}
function subset(actual: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== 'object')
    return actual === expected;
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((v, i) => subset(actual[i], v))
    );
  return (
    actual !== null &&
    typeof actual === 'object' &&
    !Array.isArray(actual) &&
    Object.entries(expected).every(
      ([k, v]) =>
        Object.hasOwn(actual, k) &&
        subset((actual as Record<string, unknown>)[k], v),
    )
  );
}
function evaluate(
  result: Omit<Attempt, 'passed' | 'failures'>,
  assertion: Assertion | undefined,
): string[] {
  const failures: string[] = [];
  const a = assertion ?? {};
  if (a.error) {
    if (result.error !== a.error) failures.push(`Expected ${a.error} error`);
  } else if (result.error) failures.push(`Request failed: ${result.error}`);
  if (!a.error || a.status !== undefined) {
    const s = a.status ?? { min: 200, max: 299 };
    if (
      result.status === undefined ||
      (typeof s === 'number'
        ? result.status !== s
        : result.status < s.min || result.status > s.max)
    )
      failures.push(
        typeof s === 'number'
          ? `Expected HTTP ${s}`
          : `Expected HTTP ${s.min}-${s.max}`,
      );
  }
  if (
    a.bodyContains !== undefined &&
    !result.responseBody.includes(a.bodyContains)
  )
    failures.push('Response body does not contain expected text');
  if (a.jsonSubset !== undefined) {
    try {
      if (
        result.truncated ||
        !subset(JSON.parse(result.responseBody), a.jsonSubset)
      )
        failures.push('Response JSON does not match expected subset');
    } catch {
      failures.push('Response body is not valid JSON');
    }
  }
  if (a.maxLatencyMs !== undefined && result.durationMs > a.maxLatencyMs)
    failures.push(`Response exceeded ${a.maxLatencyMs}ms`);
  return failures;
}
async function request(
  url: URL,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  timeoutMs: number,
  limit: number,
): Promise<{
  status?: number;
  durationMs: number;
  responseBody: string;
  truncated: boolean;
  error?: 'timeout' | 'network';
}> {
  const start = performance.now();
  return new Promise((resolve) => {
    let finished = false;
    let timedOut = false;
    let responseStatus: number | undefined;
    let truncated = false;
    let size = 0;
    const chunks: Buffer[] = [];
    const done = (error?: 'timeout' | 'network') => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({
        ...(responseStatus !== undefined ? { status: responseStatus } : {}),
        durationMs: Math.round((performance.now() - start) * 100) / 100,
        responseBody: Buffer.concat(chunks).toString('utf8'),
        truncated,
        ...(error ? { error } : {}),
      });
    };
    // localhost is pinned to loopback instead of trusting local DNS/hosts configuration.
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(
      url,
      {
        method,
        headers,
        agent: false,
        ...(url.hostname === 'localhost'
          ? {
              family: 4,
              lookup: (
                _hostname: string,
                _options: unknown,
                callback: (
                  error: Error | null,
                  address: string,
                  family: number,
                ) => void,
              ) => callback(null, '127.0.0.1', 4),
            }
          : {}),
      },
      (res) => {
        responseStatus = res.statusCode;
        res.on('data', (chunk: Buffer) => {
          const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          const remaining = limit - size;
          if (data.length > remaining) truncated = true;
          if (remaining > 0) {
            const kept = data.subarray(0, remaining);
            chunks.push(kept);
            size += kept.length;
          }
          if (truncated) {
            done();
            res.destroy();
            req.destroy();
          }
        });
        res.on('end', () => done());
        res.on('error', () => done(timedOut ? 'timeout' : 'network'));
        res.on('aborted', () => done(timedOut ? 'timeout' : 'network'));
      },
    );
    const timer = setTimeout(() => {
      timedOut = true;
      done('timeout');
      req.destroy();
    }, timeoutMs);
    req.on('error', () => done(timedOut ? 'timeout' : 'network'));
    req.end(body);
  });
}
export async function runScenario(
  input: Config | unknown,
  options: RunOptions = {},
): Promise<Report> {
  const config = parseConfig(input);
  const now = options.now ?? Date.now;
  const start = performance.now();
  const startedAtMs = now();
  const startedAt = new Date(startedAtMs).toISOString();
  const target = checkedURL(config.target, !!options.allowRemote);
  const verifyURLs = config.verify.map((v) =>
    checkedURL(v.url, !!options.allowRemote),
  );
  const sensitive = new Set([
    ...defaults,
    ...config.sensitiveHeaders.map((h) => h.toLowerCase()),
  ]);
  const secrets = new Set<string>();
  for (const headers of [
    config.headers,
    ...config.deliveries.map((v) => v.headers),
    ...config.verify.map((v) => v.headers),
  ])
    for (const [k, v] of Object.entries(headers ?? {}))
      if (sensitive.has(k.toLowerCase()) && v) secrets.add(v);
  const secret = config.signing
    ? (options.env ?? process.env)[config.signing.secretEnv]
    : undefined;
  if (config.signing && !secret)
    throw new ConfigError(
      `Signing environment variable ${config.signing.secretEnv} is missing or empty`,
    );
  if (secret) secrets.add(secret);
  const limitUTF8 = (text: string) => {
    const encoded = Buffer.from(text);
    if (encoded.length <= config.maxResponseBytes) return text;
    let end = config.maxResponseBytes;
    while (end > 0 && (encoded[end]! & 0b11000000) === 0b10000000) end--;
    return encoded.subarray(0, end).toString('utf8');
  };
  const redact = (text: string, truncated: boolean) => {
    const values = [...secrets]
      .flatMap((value) => [value, JSON.stringify(value).slice(1, -1)])
      .sort((a, b) => b.length - a.length);
    for (const value of values) {
      text = text.split(value).join('[REDACTED]');
      if (truncated)
        // A byte capture limit may cut an echoed secret mid-value.
        for (
          let length = Math.min(value.length - 1, text.length);
          length > 0;
          length--
        )
          if (text.endsWith(value.slice(0, length))) {
            text = text.slice(0, -length) + '[REDACTED]';
            break;
          }
    }
    return limitUTF8(text);
  };
  const attempts: Attempt[] = [];
  let passed = true;
  for (const delivery of config.deliveries) {
    const body =
      delivery.rawBody ??
      (delivery.body === undefined ? '' : JSON.stringify(delivery.body));
    const retry = delivery.retry ?? config.retry;
    for (let copy = 1; copy <= delivery.copies; copy++) {
      if (delivery.delayMs) await sleep(delivery.delayMs);
      let finalPassed = false;
      for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
        const headers = mergeHeaders(
          { 'content-type': 'application/json' },
          config.headers,
          delivery.headers,
        );
        if (config.signing && secret) {
          headers['stripe-signature'] = signStripe(
            body,
            secret,
            config.signing.timestamp ?? Math.floor(startedAtMs / 1000),
          );
          secrets.add(headers['stripe-signature']);
        }
        const result = await request(
          target,
          'POST',
          headers,
          body,
          delivery.timeoutMs ?? config.timeoutMs,
          config.maxResponseBytes,
        );
        const raw = {
          deliveryId: delivery.id,
          phase: 'delivery' as const,
          order: attempts.length + 1,
          copy,
          attempt,
          ...result,
        };
        const failures = evaluate(raw, delivery.assert);
        finalPassed = failures.length === 0;
        attempts.push({
          ...raw,
          responseBody: redact(raw.responseBody, raw.truncated),
          deliveryId: redact(raw.deliveryId, false),
          passed: finalPassed,
          failures,
        });
        if (
          attempt === retry.maxAttempts ||
          (!result.error && !retry.statuses.includes(result.status ?? 0))
        )
          break;
        if (retry.delayMs) await sleep(retry.delayMs);
      }
      if (!finalPassed) passed = false;
    }
  }
  for (const [index, verification] of config.verify.entries()) {
    if (verification.delayMs) await sleep(verification.delayMs);
    const headers = mergeHeaders(
      { 'content-type': 'application/json' },
      config.headers,
      verification.headers,
    );
    const result = await request(
      verifyURLs[index]!,
      verification.method,
      headers,
      verification.body === undefined
        ? undefined
        : JSON.stringify(verification.body),
      config.timeoutMs,
      config.maxResponseBytes,
    );
    const raw = {
      deliveryId: verification.id,
      phase: 'verification' as const,
      order: attempts.length + 1,
      copy: 1,
      attempt: 1,
      ...result,
    };
    const failures = evaluate(raw, verification.assert);
    if (failures.length) passed = false;
    attempts.push({
      ...raw,
      responseBody: redact(raw.responseBody, raw.truncated),
      deliveryId: redact(raw.deliveryId, false),
      passed: failures.length === 0,
      failures,
    });
  }
  return {
    version: 1,
    passed,
    startedAt,
    durationMs: Math.round((performance.now() - start) * 100) / 100,
    attempts,
    summary: {
      requests: attempts.length,
      passed: attempts.filter((a) => a.passed).length,
      failed: attempts.filter((a) => !a.passed).length,
    },
  };
}
