# Hookfault

Hookfault is a local-first command-line tool for finding the webhook bugs that happy-path test senders miss. It sends deterministic event sequences to your handler, injects realistic delivery failures, checks the HTTP responses, and can query your application afterward to prove the business outcome.

Use it while developing a handler or as a CI test against an ephemeral application. Hookfault has no hosted service, user interface, account, or telemetry.

## Why Hookfault?

Webhook providers retry, arrive late, send duplicates, and occasionally deliver events in an order your application did not expect. A handler can return `200` every time and still create two orders, move state backward, or accept an invalid signature. Hookfault describes these cases in a versioned JSON scenario and turns them into a repeatable pass or fail.

## Features

- Duplicate delivery with explicit `copies`
- Configurable delay before each copy and before verification
- Out-of-order delivery by putting events in the exact wire order you want
- Arbitrary raw bodies for malformed JSON and normal JSON bodies for valid events
- Global and per-delivery custom headers
- Whole-request timeouts, including stalled response bodies
- Configurable status-based and network-error retries
- Stripe-style HMAC-SHA256 signatures over the exact transmitted bytes
- Assertions for exact status, status range, text, JSON subset, latency, timeout, and network failure
- Follow-up GET or POST verification requests for application state
- Human output, structured JSON reports, and meaningful exit codes
- Localhost-only default, explicit remote opt-in, no redirect following, response limits, and secret redaction

## Requirements and installation

Hookfault requires Node.js 20 or newer. Until the first npm release, install from GitHub or run a clone:

```sh
git clone https://github.com/micheal081/hookfault.git
cd hookfault
npm ci
npm run build
npm link
hookfault --help
```

After an npm release, the intended install command is:

```sh
npm install --global hookfault
```

The package is not published to npm by this repository setup.

## Quick start

Start the application containing your webhook handler, copy the example, and adjust its local URLs:

```sh
cp examples/duplicate-order.json hookfault.json
hookfault validate hookfault.json
hookfault run hookfault.json
```

A minimal scenario looks like this:

```json
{
  "$schema": "./node_modules/hookfault/schema/hookfault.schema.json",
  "version": 1,
  "target": "http://127.0.0.1:3000/webhooks/orders",
  "deliveries": [
    {
      "id": "order-created-twice",
      "body": { "id": "evt_123", "type": "order.created" },
      "copies": 2,
      "assert": { "status": { "min": 200, "max": 299 } }
    }
  ]
}
```

`deliveries` run sequentially in array order. Copies are adjacent, so the example sends the same event twice before moving on. Put a newer event before an older event to model out-of-order arrival. This explicit order and fixed retry policy make scenarios deterministic.

## CLI reference

```text
hookfault run <config.json> [--json <report.json>] [--allow-remote]
hookfault validate <config.json>
hookfault --help
hookfault --version
```

`run` validates and executes a scenario. `--json path` writes a formatted report and enforces mode `0600` on POSIX systems; `--json -` writes JSON to standard output and keeps the human summary on standard error. Remote targets and verification URLs require `--allow-remote`.

`validate` checks JSON syntax and the runtime configuration contract without sending a request. Unknown fields are errors and validation messages include the failing field path.

Exit code `0` means the scenario passed or the configuration is valid. Exit code `1` means the scenario ran and at least one final delivery or verification assertion failed. Exit code `2` means usage, configuration, environment, or report I/O failed.

## Configuration reference

The machine-readable JSON Schema is [schema/hookfault.schema.json](schema/hookfault.schema.json). Runtime validation is authoritative and also enforces rules JSON Schema cannot cleanly express here, including case-insensitive transport-controlled header names, status `min <= max`, and unique IDs across delivery and verification arrays.

| Field              | Meaning                                           | Default / limit            |
| ------------------ | ------------------------------------------------- | -------------------------- |
| `$schema`          | Optional editor schema URL                        | none                       |
| `version`          | Scenario format version                           | required, currently `1`    |
| `target`           | HTTP(S) delivery URL                              | required                   |
| `headers`          | Headers shared by deliveries and verification     | `{}`                       |
| `sensitiveHeaders` | Additional header names whose values are redacted | `[]`                       |
| `timeoutMs`        | Whole-request deadline                            | `5000`, maximum `300000`   |
| `maxResponseBytes` | Per-attempt captured response bytes               | `65536`, maximum `1048576` |
| `retry`            | Default retry policy                              | one attempt                |
| `signing`          | Stripe signing configuration                      | none                       |
| `deliveries`       | Ordered webhook deliveries                        | 1–1000 required            |
| `verify`           | Ordered follow-up application checks              | up to 100                  |

Each delivery accepts:

| Field       | Meaning                                                    |
| ----------- | ---------------------------------------------------------- |
| `id`        | Unique report label, 1–200 characters                      |
| `body`      | Any JSON value, serialized compactly                       |
| `rawBody`   | Exact string bytes to send; cannot be combined with `body` |
| `copies`    | Consecutive sends of this delivery, 1–100; default `1`     |
| `delayMs`   | Wait before every copy; default `0`                        |
| `headers`   | Headers merged over global headers, case-insensitively     |
| `timeoutMs` | Override the global deadline                               |
| `retry`     | Override the global retry policy                           |
| `assert`    | Expected result; defaults to HTTP `200–299`                |

The retry object has `maxAttempts` (1–20), `delayMs`, and `statuses`. It defaults to one attempt, zero delay, and retryable statuses `[429, 500, 502, 503, 504]`. With more than one attempt, Hookfault retries network errors, timeouts, and a response whose status is listed. Assertions are recorded for every attempt, but a delivery copy passes when its final attempt passes.

Verification entries accept `id`, `url`, `method` (`GET` by default or `POST`), optional JSON `body` for POST, `headers`, `delayMs`, and `assert`. They run after every delivery finishes and do not retry in version 1.

Hookfault sets `Content-Type: application/json`; scenario headers can replace it. `Host`, `Content-Length`, `Transfer-Encoding`, and `Connection` are transport-controlled and rejected. Header names and values are checked to prevent request splitting.

## Failure scenarios

### Duplicate and out-of-order delivery

```json
{
  "version": 1,
  "target": "http://localhost:3000/hooks",
  "deliveries": [
    { "id": "new-state", "body": { "sequence": 2 }, "copies": 2 },
    {
      "id": "old-state-arrives-last",
      "body": { "sequence": 1 },
      "delayMs": 100
    }
  ]
}
```

### Malformed body, timeout, and retry

```json
{
  "version": 1,
  "target": "http://localhost:3000/hooks",
  "timeoutMs": 250,
  "retry": { "maxAttempts": 3, "delayMs": 50, "statuses": [429, 503] },
  "deliveries": [
    {
      "id": "broken-json",
      "rawBody": "{\"unfinished\":",
      "headers": { "X-Test-Case": "malformed" },
      "assert": { "status": 400, "bodyContains": "invalid" }
    }
  ]
}
```

To test a timeout as the expected behavior, use `"assert": { "error": "timeout" }`. A response that begins and then stalls is still subject to `timeoutMs`.

## Assertions and business verification

An assertion may combine:

- `status`: an exact number or `{ "min": 200, "max": 299 }`
- `bodyContains`: a case-sensitive substring
- `jsonSubset`: recursively matches the listed object keys; arrays match positionally and must have the same length
- `maxLatencyMs`: maximum elapsed milliseconds for the whole response
- `error`: expected `timeout` or `network`

If no assertion is provided, Hookfault expects HTTP `200–299`. When `error` is expected, there is no implicit status expectation unless `status` is also supplied.

HTTP success alone cannot prove idempotency. A verification request can ask a test-only application endpoint whether duplicate delivery created one order:

```json
{
  "verify": [
    {
      "id": "one-order-exists",
      "url": "http://localhost:3000/test-state/orders/ord_123",
      "delayMs": 100,
      "assert": { "status": 200, "jsonSubset": { "count": 1 } }
    }
  ]
}
```

Expose such endpoints only in isolated test environments and protect them appropriately.

## Stripe-style signing

```json
{
  "signing": {
    "type": "stripe",
    "secretEnv": "HOOKFAULT_STRIPE_SECRET",
    "timestamp": 1700000000
  }
}
```

Set a synthetic endpoint secret in the environment before running:

```sh
HOOKFAULT_STRIPE_SECRET=whsec_test_only hookfault run scenario.json
```

Hookfault creates `Stripe-Signature: t=<timestamp>,v1=<digest>`. The digest is lowercase hexadecimal HMAC-SHA256 using the environment secret over `<timestamp>.<exact request body>`. For JSON bodies, it signs the compact serialized string Hookfault sends. For `rawBody`, every UTF-8 character, space, and newline matters.

If `timestamp` is absent, Hookfault captures the Unix time when the scenario starts and reuses it for every delivery and retry in that run. Set `timestamp` for deterministic fixtures. Production handlers often reject old timestamps, so omit a fixed timestamp when exercising their normal tolerance checks. This implements signature generation; your application remains responsible for constant-time verification, timestamp tolerance, and replay protection. The signing behavior follows [Stripe's webhook signature model](https://docs.stripe.com/webhooks).

The secret is read only from `secretEnv`. The environment value and generated signature are included in automatic redaction and are never printed as headers.

## JSON reports

Reports contain the scenario start time, total duration, overall result, summary counts, and one entry per HTTP attempt. Each entry records the delivery ID, delivery or verification phase, global wire order, copy number, retry attempt, status or normalized error, duration, bounded response body, truncation flag, assertion result, and failure messages.

Attempt-level failures that are later recovered by retry remain visible. `report.passed` reflects final results per delivery copy plus verification assertions.

## Continuous integration

Run the application under test on loopback, then execute Hookfault:

```yaml
- name: Start application
  run: npm run start:test &
- name: Exercise webhook failures
  run: npx hookfault run test/hookfault.json --json hookfault-report.json
- name: Upload report after failure
  if: failure()
  uses: actions/upload-artifact@v4
  with:
    name: hookfault-report
    path: hookfault-report.json
    retention-days: 3
```

Pin the Hookfault version once it is published. The repository's own `quality` workflow runs formatting, linting, type checking, the behavioral test suite, a build, and an isolated packed-package smoke scenario on Node 20.

## Safety and privacy

Hookfault accepts `localhost`, `127.0.0.1`, and `[::1]` by default. Every other delivery or verification hostname requires `--allow-remote`, making real network effects explicit. When enabled, remote requests are real: use only systems you own or are authorized to test, prefer disposable staging environments, and avoid production customer data.

Hookfault does not follow HTTP redirects, so an allowed local URL cannot silently redirect a run elsewhere. It does not retry unless configured beyond one attempt. Every response has a deadline and capture limit.

Values from common sensitive headers (`Authorization`, `Proxy-Authorization`, `Cookie`, `Set-Cookie`, `X-API-Key`, and `Stripe-Signature`), headers named in `sensitiveHeaders`, and the signing secret are replaced in captured response text. Partial secrets cut at the response limit are also masked. Reports intentionally omit request headers and request bodies.

Redaction is defense in depth, not a data-loss-prevention system. It cannot recognize arbitrary personal data, encoded or transformed secrets, values the application exposes without being configured as sensitive, or secrets unrelated to headers/signing. Responses can contain private application data. Store reports with restricted access, short retention, and the same care as test logs. Hookfault emits no telemetry.

## Architecture

- `src/config.ts` defines and validates the strict versioned contract.
- `src/signing.ts` signs exact payload bytes.
- `src/engine.ts` applies network policy, performs ordered requests, evaluates assertions, redacts output, and produces reports.
- `src/cli.ts` handles commands, output, and exit codes.
- `tests/` uses real ephemeral loopback servers for behavior and CLI tests.

The engine is exported for programmatic use, but the CLI is the supported first-release interface.

## Limitations

- Scenario files are JSON only; YAML and JavaScript configuration are not supported.
- Deliveries are sequential. There is no concurrent/race-condition mode.
- Retries use fixed delay, not backoff or jitter; verification requests do not retry.
- Only Stripe-style signing is included.
- JSON subset arrays are positional and exact-length.
- There is no request-body template language, provider event catalog, hosted runner, dashboard, or telemetry.
- Localhost is pinned to IPv4 loopback; use an explicit `[::1]` URL for IPv6.
- Remote opt-in is per CLI run rather than an allowlist. Redirects remain disabled.

## Roadmap

Potential future work includes YAML input, deterministic jitter and backoff, concurrent delivery groups, additional provider signing schemes, configurable host allowlists, JUnit output, richer report formats, and reusable provider scenario packs. Proposals should preserve offline operation, deterministic tests, bounded output, and clear network effects.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md), [GOVERNANCE.md](GOVERNANCE.md), the [Code of Conduct](CODE_OF_CONDUCT.md), and [SECURITY.md](SECURITY.md). Issues and fork-based pull requests are welcome. The repository owner is the sole maintainer and personally merges accepted pull requests; no collaborator access or automatic merging is used.

Hookfault is available under the [MIT License](LICENSE). Changes are tracked in [CHANGELOG.md](CHANGELOG.md).
