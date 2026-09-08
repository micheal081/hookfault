import { createHmac } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import { signStripe } from '../src/signing.js';
import { runScenario } from '../src/engine.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
});
async function serve(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('No listening port');
  return `http://127.0.0.1:${address.port}`;
}
const config = (target: string, extra: Record<string, unknown> = {}) =>
  parseConfig({
    version: 1,
    target,
    deliveries: [{ id: 'event', body: { id: 'evt_1' } }],
    ...extra,
  });

describe('configuration and signing', () => {
  it.each([
    { version: 2 },
    { unexpected: true },
    { timeoutMs: 0 },
    { maxResponseBytes: 0 },
    { deliveries: [] },
    { deliveries: [{ id: 'a', body: {}, rawBody: 'x' }] },
    { deliveries: [{ id: 'a' }, { id: 'a' }] },
    { headers: { host: 'evil.example' } },
    { headers: { 'x-test': 'hello\r\nInjected: yes' } },
    { target: 'ftp://localhost/file' },
    { target: 'http://user:password@localhost/hooks' },
    { target: 'http://localhost/hooks#fragment' },
    { sensitiveHeaders: ['invalid header name'] },
    { target: 'not a URL' },
    { headers: { 'x-test': 'null\u0000byte' } },
    { headers: { 'x-test': 'not latin-1: \u0100' } },
    { retry: { maxAttempts: 21 } },
    { deliveries: [{ id: 'a', assert: { status: { min: 500, max: 200 } } }] },
    { verify: [{ id: 'v', url: 'http://localhost', method: 'GET', body: {} }] },
  ])('rejects invalid configuration %j', (extra) => {
    expect(() => config('http://localhost', extra)).toThrow();
  });
  it('reports a useful configuration path', () => {
    expect(() =>
      config('http://localhost', { deliveries: [{ id: 'x', copies: 0 }] }),
    ).toThrow(/deliveries\.0\.copies/);
    expect(() => config('http://localhost', { unexpected: true })).toThrow(
      /Unknown configuration field\(s\): unexpected/,
    );
  });
  it('signs the exact UTF-8 bytes with an independently computed HMAC', () => {
    const payload = ' {"message":"héllo"}\n';
    const digest = createHmac('sha256', 'whsec_test')
      .update(Buffer.from('1700000000.' + payload))
      .digest('hex');
    expect(signStripe(payload, 'whsec_test', 1700000000)).toBe(
      `t=1700000000,v1=${digest}`,
    );
    expect(signStripe(payload.trim(), 'whsec_test', 1700000000)).not.toBe(
      signStripe(payload, 'whsec_test', 1700000000),
    );
  });
});

describe('real webhook delivery', () => {
  it('preserves declared out-of-order delivery, duplicates, raw bytes, headers and delay', async () => {
    const received: {
      body: string;
      header: string | undefined;
      time: number;
    }[] = [];
    const url = await serve((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (part) => (body += part));
      req.on('end', () => {
        received.push({
          body,
          header: req.headers['x-event'] as string | undefined,
          time: Date.now(),
        });
        res.end('accepted');
      });
    });
    const report = await runScenario(
      config(url, {
        deliveries: [
          {
            id: 'newer',
            body: { sequence: 2 },
            copies: 2,
            headers: { 'x-event': 'newer' },
          },
          { id: 'older', body: { sequence: 1 }, delayMs: 40 },
          { id: 'broken', rawBody: '{"unfinished":' },
        ],
      }),
    );
    expect(report.passed).toBe(true);
    expect(received.map((r) => r.body)).toEqual([
      '{"sequence":2}',
      '{"sequence":2}',
      '{"sequence":1}',
      '{"unfinished":',
    ]);
    expect(received[0].header).toBe('newer');
    expect(received[2].time - received[1].time).toBeGreaterThanOrEqual(30);
    expect(report.attempts.map((a) => a.deliveryId)).toEqual([
      'newer',
      'newer',
      'older',
      'broken',
    ]);
    expect(new Set(report.attempts.map((a) => a.order)).size).toBe(4);
  });
  it('retries configured responses then asserts the final success', async () => {
    let requests = 0;
    const url = await serve((_req, res) => {
      res.statusCode = ++requests < 3 ? 503 : 201;
      res.end('ok');
    });
    const report = await runScenario(
      config(url, {
        retry: { maxAttempts: 3, delayMs: 1, statuses: [503] },
        deliveries: [{ id: 'retry', assert: { status: 201 } }],
      }),
    );
    expect(requests).toBe(3);
    expect(report.passed).toBe(true);
    expect(report.attempts.map((a) => a.status)).toEqual([503, 503, 201]);
    expect(report.attempts.map((a) => a.attempt)).toEqual([1, 2, 3]);
  });
  it('does not retry an unconfigured response status', async () => {
    let requests = 0;
    const url = await serve((_req, res) => {
      requests++;
      res.statusCode = 400;
      res.end();
    });
    const report = await runScenario(
      config(url, { retry: { maxAttempts: 4, statuses: [503] } }),
    );
    expect(requests).toBe(1);
    expect(report.passed).toBe(false);
  });
  it('times out while reading a body and retries deterministically', async () => {
    let requests = 0;
    const url = await serve((_req, res) => {
      requests++;
      res.writeHead(200);
      res.write('never finishes');
    });
    const report = await runScenario(
      config(url, {
        timeoutMs: 30,
        retry: { maxAttempts: 2, delayMs: 0 },
        deliveries: [{ id: 'timeout', assert: { error: 'timeout' } }],
      }),
    );
    expect(requests).toBe(2);
    expect(report.attempts.every((a) => a.error === 'timeout')).toBe(true);
    expect(report.passed).toBe(true);
  });
  it('signs wire bodies with the selected timestamp and secret environment', async () => {
    let signature: string | undefined;
    let body = '';
    const url = await serve((req, res) => {
      signature = req.headers['stripe-signature'] as string;
      req.on('data', (part) => (body += part));
      req.on('end', () => res.end());
    });
    const report = await runScenario(
      config(url, {
        signing: {
          type: 'stripe',
          secretEnv: 'TEST_SECRET',
          timestamp: 1700000000,
        },
        deliveries: [{ id: 'signed', rawBody: ' {"ok":true} ' }],
      }),
      { env: { TEST_SECRET: 'secret-value' } },
    );
    expect(report.passed).toBe(true);
    expect(signature).toBe(signStripe(body, 'secret-value', 1700000000));
    expect(JSON.stringify(report)).not.toContain('secret-value');
  });
  it('reuses the scenario-start timestamp for signatures across retries', async () => {
    const signatures: string[] = [];
    let requests = 0;
    const url = await serve((req, res) => {
      signatures.push(String(req.headers['stripe-signature']));
      res.statusCode = ++requests === 1 ? 503 : 200;
      res.end();
    });
    const clock = [1_700_000_000_000, 1_800_000_000_000];
    const report = await runScenario(
      config(url, {
        signing: { type: 'stripe', secretEnv: 'TEST_SECRET' },
        retry: { maxAttempts: 2, statuses: [503] },
      }),
      { env: { TEST_SECRET: 'test-secret' }, now: () => clock.shift()! },
    );
    expect(report.passed).toBe(true);
    expect(signatures).toHaveLength(2);
    expect(signatures[0]).toBe(signatures[1]);
    expect(signatures[0]).toContain('t=1700000000');
  });
  it('checks duplicate business outcomes using a follow-up endpoint', async () => {
    const orders = new Set<string>();
    const url = await serve((req, res) => {
      if (req.url === '/orders') {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            orders: [{ id: 'evt_1', state: 'paid' }],
            count: orders.size,
          }),
        );
        return;
      }
      let body = '';
      req.on('data', (part) => (body += part));
      req.on('end', () => {
        orders.add(JSON.parse(body).id);
        res.statusCode = 202;
        res.end('queued');
      });
    });
    const report = await runScenario(
      config(url, {
        deliveries: [
          {
            id: 'duplicate',
            body: { id: 'evt_1' },
            copies: 2,
            assert: { status: { min: 200, max: 299 }, bodyContains: 'queued' },
          },
        ],
        verify: [
          {
            id: 'business',
            url: url + '/orders',
            assert: { jsonSubset: { count: 1, orders: [{ state: 'paid' }] } },
          },
        ],
      }),
    );
    expect(report.passed).toBe(true);
    expect(report.attempts.at(-1)?.phase).toBe('verification');
  });
  it('reports status, body, JSON subset and latency assertion failures', async () => {
    const url = await serve((_req, res) => {
      setTimeout(() => {
        res.statusCode = 202;
        res.end('{"count":2}');
      }, 20);
    });
    const report = await runScenario(
      config(url, {
        deliveries: [
          {
            id: 'bad',
            assert: {
              status: 200,
              bodyContains: 'absent',
              jsonSubset: { count: 1 },
              maxLatencyMs: 1,
            },
          },
        ],
      }),
    );
    expect(report.passed).toBe(false);
    expect(report.attempts[0].failures).toHaveLength(4);
  });
  it('bounds captured response bytes and redacts echoed sensitive headers', async () => {
    const url = await serve((req, res) =>
      res.end(
        `${req.headers.authorization} ${req.headers['x-private']} ` +
          'x'.repeat(500),
      ),
    );
    const report = await runScenario(
      config(url, {
        headers: {
          Authorization: 'Bearer top-secret',
          'X-Private': 'private-value',
        },
        sensitiveHeaders: ['x-private'],
        maxResponseBytes: 100,
      }),
    );
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('top-secret');
    expect(serialized).not.toContain('private-value');
    expect(report.attempts[0].truncated).toBe(true);
    expect(report.attempts[0].responseBody.length).toBeLessThanOrEqual(100);
  });
  it('does not redact an ordinary suffix in an untruncated response', async () => {
    const url = await serve((_req, res) =>
      res.end('ordinary response ending s'),
    );
    const report = await runScenario(
      config(url, {
        headers: { Authorization: 'secret' },
        maxResponseBytes: 100,
      }),
    );
    expect(report.attempts[0].responseBody).toBe('ordinary response ending s');
  });
  it('keeps redacted output within the configured byte limit', async () => {
    const url = await serve((req, res) =>
      res.end(String(req.headers.authorization).repeat(20)),
    );
    const report = await runScenario(
      config(url, {
        headers: { Authorization: 'x' },
        maxResponseBytes: 8,
      }),
    );
    expect(report.attempts[0].responseBody).not.toContain('x');
    expect(
      Buffer.byteLength(report.attempts[0].responseBody),
    ).toBeLessThanOrEqual(8);
  });
  it('blocks remote targets by default before making any request', async () => {
    await expect(runScenario(config('https://example.com'))).rejects.toThrow(
      /remote|localhost|loopback/i,
    );
  });
  it('does not follow redirects to another endpoint', async () => {
    let redirected = 0;
    const target = await serve((_req, res) => {
      redirected++;
      res.end();
    });
    const source = await serve((_req, res) => {
      res.writeHead(302, { location: target });
      res.end();
    });
    const report = await runScenario(config(source));
    expect(redirected).toBe(0);
    expect(report.attempts[0].status).toBe(302);
    expect(report.passed).toBe(false);
  });
});
