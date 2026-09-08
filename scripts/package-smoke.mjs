import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const temporary = await mkdtemp(join(tmpdir(), 'hookfault-package-'));
const packed = JSON.parse(
  (await exec('npm', ['pack', '--json', '--pack-destination', temporary]))
    .stdout,
)[0];
const archive = join(temporary, packed.filename);
const installed = join(temporary, 'installed');
await exec('npm', [
  'install',
  '--prefix',
  installed,
  '--ignore-scripts',
  '--no-audit',
  '--no-fund',
  archive,
]);
const executable = resolve(installed, 'node_modules/.bin/hookfault');
const help = await exec(executable, ['--help']);
if (!help.stdout.includes('exercise webhook failures')) {
  throw new Error('Installed CLI help was not available');
}

let received = '';
const server = createServer((request, response) => {
  request.setEncoding('utf8');
  request.on('data', (part) => (received += part));
  request.on('end', () => {
    response.statusCode = 202;
    response.end('accepted');
  });
});
await new Promise((resolveListen, rejectListen) => {
  server.once('error', rejectListen);
  server.listen(0, '127.0.0.1', resolveListen);
});
try {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing port');
  const scenario = join(temporary, 'smoke.json');
  const report = join(temporary, 'report.json');
  await writeFile(
    scenario,
    JSON.stringify({
      version: 1,
      target: `http://127.0.0.1:${address.port}/webhook`,
      deliveries: [
        { id: 'package-smoke', body: { ok: true }, assert: { status: 202 } },
      ],
    }),
  );
  await exec(executable, ['run', scenario, '--json', report]);
  const result = JSON.parse(await readFile(report, 'utf8'));
  if (!result.passed || received !== '{"ok":true}') {
    throw new Error('Installed CLI scenario did not pass end to end');
  }
  console.log(`Package smoke passed: hookfault ${packed.version}`);
} finally {
  await new Promise((resolveClose) => {
    server.close(() => resolveClose());
    server.closeAllConnections();
  });
  await rm(temporary, { recursive: true, force: true });
}
