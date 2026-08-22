import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import LocalVision from '../harness-plugins/local-vision/index.js';

const root = path.resolve(import.meta.dirname, '..');
const imagePath = process.argv[2]
  || path.join(root, 'assets', 'pets', 'default-maid', 'idle.png');
const cacheDir = process.env.DSH_TEST_MODEL_CACHE
  || path.join(process.env.APPDATA || os.homedir(), 'deepseek-harness-desktop', 'models');
const context = new Context();
await context.plugin(LocalVision, { cacheDir, proxyRule: process.env.DSH_TEST_PROXY_RULE || 'DIRECT' });
const localVision = context.get('localVision');
if (!localVision) throw new Error('Harness localVision service did not register.');
const extension = path.extname(imagePath).toLowerCase();
const mediaType = extension === '.webp' ? 'image/webp' : extension === '.png' ? 'image/png' : 'image/jpeg';
const description = await localVision.describe({
  data: await readFile(imagePath),
  mediaType,
  prompt: '请描述这张图片。',
});
if (!description) throw new Error('Harness localVision service returned no description.');

const temporary = await mkdtemp(path.join(os.tmpdir(), 'dsh-local-vision-'));
const patchPath = path.join(temporary, 'runtime.patch.yml');
try {
  const template = await readFile(path.join(root, 'assets', 'directory-picker-browse.patch.yml'), 'utf8');
  const pluginUrl = pathToFileURL(path.join(root, 'harness-plugins', 'local-vision', 'index.js')).href;
  await writeFile(patchPath, template.replace('__DSH_LOCAL_VISION_PLUGIN__', pluginUrl));
  const child = spawn(process.execPath, [
    path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    'web', '--patch', patchPath, '--host', '127.0.0.1', '--port', '0',
  ], {
    cwd: root,
    env: {
      ...process.env,
      DSH_HOME: process.env.DSH_TEST_HOME
        || path.join(process.env.APPDATA || os.homedir(), 'deepseek-harness-desktop', 'dsh-home'),
      DSH_LOCAL_VISION_CACHE: cacheDir,
      DSH_LOCAL_VISION_PROXY_RULE: process.env.DSH_TEST_PROXY_RULE || 'DIRECT',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Harness boot timed out:\n${output}`)), 30000);
    const consume = chunk => {
      output += chunk.toString();
      if (/http:\/\/127\.0\.0\.1:\d+/.test(output)) {
        clearTimeout(timeout);
        resolve();
      }
    };
    child.stdout.on('data', consume);
    child.stderr.on('data', consume);
    child.once('exit', code => {
      clearTimeout(timeout);
      reject(new Error(`Harness exited before ready (${code}):\n${output}`));
    });
  });
  await ready;
  child.kill();
  await new Promise(resolve => child.once('exit', resolve));
} finally {
  await rm(temporary, { recursive: true, force: true });
}

process.stdout.write(`Harness internal vision passed: ${description}\n`);
