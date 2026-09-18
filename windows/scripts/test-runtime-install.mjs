import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createHarnessRuntimeManager } = require('../harness-runtime-manager');
const userData = await mkdtemp(path.join(os.tmpdir(), 'dsy-runtime-install-'));
const appRoot = path.resolve('.');
const app = {
  isPackaged: false,
  getAppPath: () => appRoot,
  getPath: (name) => name === 'userData' ? userData : userData,
};
const manager = createHarnessRuntimeManager({
  app,
  resolveProxy: async () => 'PROXY 127.0.0.1:7877',
});

try {
  const result = await manager.install(process.argv[2] || '0.1.6-alpha.1', (line) => process.stdout.write(`${line}\n`));
  if (result.mode !== 'installed' || !manager.active().entry) {
    throw new Error(`运行时安装结果异常：${JSON.stringify(result)}`);
  }
  process.stdout.write(`Harness runtime install passed: ${result.version}\n`);
} finally {
  await rm(userData, { recursive: true, force: true });
}
