import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';

const require = createRequire(import.meta.url);
const { createDeepSeekModelCatalog } = require('../deepseek-model-catalog');
const root = await mkdtemp(path.join(os.tmpdir(), 'dsy-model-catalog-'));

try {
  await writeFile(path.join(root, '.credentials.yaml'), 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: test-key\n');
  await writeFile(path.join(root, 'settings.yaml'), [
    'agent-default-model:',
    '  provider: deepseek-official',
    '  model: deepseek-v4-flash',
    '  reasoningEffort: high',
    'pet:',
    '  enabled: true',
    '',
  ].join('\n'));
  const catalog = createDeepSeekModelCatalog({
    dshHome: () => root,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] }),
    }),
  });
  const result = await catalog.sync();
  const settings = YAML.parse(await readFile(path.join(root, 'settings.yaml'), 'utf8'));
  if (settings.pet.enabled !== true) throw new Error('同步模型时丢失了其他设置。');
  if (settings['agent-default-model'].model !== 'deepseek-flash') throw new Error('未替换已失效的默认模型。');
  const ids = settings['llm-deepseek'].models.map((model) => model.id);
  if (JSON.stringify(ids) !== JSON.stringify(['deepseek-flash', 'deepseek-v4-pro'])) {
    throw new Error(`模型目录未与官方响应一致：${JSON.stringify(ids)}`);
  }
  if (!result.changed || catalog.status().error) throw new Error('模型同步状态不正确。');
  process.stdout.write(`DeepSeek model catalog sync passed: ${ids.join(', ')}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
