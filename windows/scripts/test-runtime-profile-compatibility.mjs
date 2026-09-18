import { createRequire } from 'node:module';
import { access, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { disableIncompatibleProfileBundles } = require('../runtime-profile-compatibility');
const root = await mkdtemp(path.join(os.tmpdir(), 'dsy-profile-compat-'));
const profile = path.join(root, 'profiles', 'web');
const bundle = path.join(profile, 'node_modules', '@owner', 'bundle');
const oldPlugin = path.join(profile, 'node_modules', '@owner', 'old-plugin');
const compatibleBundle = path.join(profile, 'node_modules', '@owner', 'compatible-bundle');
await mkdir(path.join(bundle), { recursive: true });
await mkdir(path.join(oldPlugin, 'lib'), { recursive: true });
await mkdir(path.join(compatibleBundle, 'lib'), { recursive: true });
await writeFile(path.join(profile, 'package.json'), JSON.stringify({
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@owner/compatible-bundle', '@owner/bundle'] } },
}, null, 2));
await writeFile(path.join(bundle, 'package.json'), JSON.stringify({
  name: '@owner/bundle', dsh: { bundle: { patch: './cordis.patch.yml' } },
}));
await writeFile(path.join(bundle, 'cordis.patch.yml'), "- insert:\n  - id: old\n    name: '@owner/old-plugin'\n");
await writeFile(path.join(oldPlugin, 'lib', 'index.js'),
  "import { installSettingsSection } from '@deepseek-ai/dsh-settings';\n");
await writeFile(path.join(compatibleBundle, 'lib', 'index.js'), 'export const compatible = true;\n');

const result = disableIncompatibleProfileBundles({
  dshHome: root, runtime: { mode: 'installed', version: '0.1.6-alpha.2' },
});
const manifest = JSON.parse(await readFile(path.join(profile, 'package.json'), 'utf8'));
const report = JSON.parse(await readFile(path.join(root, 'disabled-incompatible-plugins.json'), 'utf8'));
await access(path.join(oldPlugin, 'lib', 'index.js'));
if (result.disabled[0]?.name !== '@owner/bundle'
  || manifest.dsh.profile.bundles.includes('@owner/bundle')
  || !manifest.dsh.profile.bundles.includes('@deepseek-ai/dsh-base')
  || !manifest.dsh.profile.bundles.includes('@owner/compatible-bundle')
  || report.disabled[0]?.name !== '@owner/bundle') {
  throw new Error(`Profile compatibility result is incorrect: ${JSON.stringify({ result, manifest, report })}`);
}
process.stdout.write('runtime profile compatibility test passed\n');
