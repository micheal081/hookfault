import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, it } from 'vitest';
const exec = promisify(execFile);
let directory: string;
const cli = resolve('dist/cli.js');
beforeAll(async () => {
  await exec(process.execPath, [
    'node_modules/typescript/bin/tsc',
    '-p',
    'tsconfig.build.json',
  ]);
  directory = await mkdtemp(join(tmpdir(), 'hookfault-cli-'));
});
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function invoke(args: string[]) {
  try {
    const result = await exec(process.execPath, [cli, ...args]);
    return { ...result, code: 0 };
  } catch (error) {
    const result = error as { stdout: string; stderr: string; code: number };
    return result;
  }
}
it('provides help and package version without network access', async () => {
  const help = await invoke(['--help']);
  expect(help.code).toBe(0);
  expect(help.stdout).toMatch(/hookfault/);
  expect(help.stdout).toMatch(/run/);
  const version = await invoke(['--version']);
  expect(version.code).toBe(0);
  expect(version.stdout.trim()).toBe('0.1.0');
});
it('distinguishes usage and validation errors with exit 2', async () => {
  expect((await invoke(['unknown'])).code).toBe(2);
  const path = join(directory, 'bad.json');
  await writeFile(path, '{"version":1}');
  expect((await invoke(['validate', path])).code).toBe(2);
  await writeFile(path, 'broken json');
  expect((await invoke(['run', path])).code).toBe(2);
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      target: 'file:///tmp/webhook',
      deliveries: [{ id: 'bad-target' }],
    }),
  );
  expect(await invoke(['validate', path])).toMatchObject({ code: 2 });
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      target: 'http://localhost/webhook',
      deliveries: [{ id: 'delivery' }],
      verify: [{ id: 'bad-verification', url: 'ftp://localhost/state' }],
    }),
  );
  expect(await invoke(['validate', path])).toMatchObject({ code: 2 });
});
it('writes a machine-readable report and returns failure exit 1', async () => {
  const server = createServer((_req, res) => {
    res.statusCode = 409;
    res.end('conflict');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No port');
    const path = join(directory, 'scenario.json');
    const output = join(directory, 'report.json');
    await writeFile(output, 'old report', { mode: 0o644 });
    await chmod(output, 0o644);
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        target: `http://127.0.0.1:${address.port}`,
        deliveries: [{ id: 'conflict', assert: { status: 200 } }],
      }),
    );
    expect((await invoke(['validate', path])).code).toBe(0);
    const result = await invoke(['run', path, '--json', output]);
    expect(result.code).toBe(1);
    const report = JSON.parse(await readFile(output, 'utf8'));
    if (process.platform !== 'win32') {
      expect((await stat(output)).mode & 0o777).toBe(0o600);
    }
    expect(report.version).toBe(1);
    expect(report.passed).toBe(false);
    expect(report.attempts[0]).toMatchObject({
      deliveryId: 'conflict',
      status: 409,
      responseBody: 'conflict',
      passed: false,
    });
    expect(result.stdout).toMatch(/fail/i);
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        target: `http://127.0.0.1:${address.port}`,
        deliveries: [{ id: 'accepted', assert: { status: 409 } }],
      }),
    );
    expect((await invoke(['run', path])).code).toBe(0);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
});
