#!/usr/bin/env node
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { loadConfig, ConfigError } from './config.js';
import { runScenario } from './engine.js';

const help = `Hookfault — exercise webhook failures locally and in CI

Usage:
  hookfault run <config.json> [--json <report.json>] [--allow-remote]
  hookfault validate <config.json>
  hookfault --help
  hookfault --version

Options:
  --json <path>    Save a structured JSON report (use - for stdout)
  --allow-remote  Explicitly permit non-loopback HTTP(S) targets
  -h, --help      Show help
  -v, --version   Show version

Exit codes: 0 passed/valid; 1 scenario failed; 2 usage/configuration/I/O error.
`;
async function main(): Promise<number> {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs({
      allowPositionals: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
        json: { type: 'string' },
        'allow-remote': { type: 'boolean' },
      },
    });
  } catch {
    console.error('Invalid arguments. Run hookfault --help.');
    return 2;
  }
  if (args.values.help) {
    console.log(help);
    return 0;
  }
  if (args.values.version) {
    const pkg = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    console.log(pkg.version);
    return 0;
  }
  const [command, path, ...extra] = args.positionals;
  if (!path || extra.length || !['run', 'validate'].includes(command ?? '')) {
    console.error(help);
    return 2;
  }
  if (
    command === 'validate' &&
    (args.values.json || args.values['allow-remote'])
  ) {
    console.error('validate accepts only a configuration path.');
    return 2;
  }
  const config = await loadConfig(path);
  if (command === 'validate') {
    console.log('Configuration is valid.');
    return 0;
  }
  const report = await runScenario(config, {
    allowRemote: args.values['allow-remote'] === true,
  });
  const serialized = JSON.stringify(report, null, 2) + '\n';
  if (typeof args.values.json === 'string') {
    if (args.values.json === '-') process.stdout.write(serialized);
    else {
      await writeFile(args.values.json, serialized, { mode: 0o600 });
      if (process.platform !== 'win32') await chmod(args.values.json, 0o600);
    }
  }
  const log = args.values.json === '-' ? console.error : console.log;
  log(
    `Hookfault ${report.passed ? 'PASS' : 'FAIL'} — ${report.summary.requests} requests, ${report.summary.passed} passing attempts, ${report.summary.failed} failing attempts (${report.durationMs}ms)`,
  );
  for (const attempt of report.attempts) {
    log(
      `${attempt.passed ? '✓' : '✗'} ${attempt.deliveryId} [${attempt.phase} #${attempt.order}, copy ${attempt.copy}, attempt ${attempt.attempt}] ${attempt.error ?? attempt.status} ${attempt.durationMs}ms${attempt.truncated ? ' (body truncated)' : ''}`,
    );
    for (const failure of attempt.failures) log(`  ${failure}`);
  }
  return report.passed ? 0 : 1;
}
main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(
      error instanceof ConfigError
        ? error.message
        : 'Unable to complete run or write report. Check file permissions and configuration.',
    );
    process.exitCode = 2;
  });
