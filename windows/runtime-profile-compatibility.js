const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const REPORT_FILE = 'disabled-incompatible-plugins.json';
const REMOVED_SETTINGS_EXPORTS = /\b(?:installSettingsSection|settingsNamespace)\b/;
const SETTINGS_MODULE_REFERENCE = /(?:from\s*|require\(\s*)['"]@deepseek-ai\/dsh-settings['"]/;

function atomicJson(filename, value) {
  const temporary = `${filename}.tmp`;
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filename);
}

function readJson(filename) {
  try { return JSON.parse(fs.readFileSync(filename, 'utf8')); } catch { return null; }
}

function packageDirectory(profileDirectory, packageName) {
  return path.join(profileDirectory, 'node_modules', ...packageName.split('/'));
}

function patchPackageNames(profileDirectory, bundleName) {
  const directory = packageDirectory(profileDirectory, bundleName);
  const manifest = readJson(path.join(directory, 'package.json')) || {};
  const relative = manifest.dsh?.bundle?.patch;
  if (!relative) return [bundleName];
  try {
    const document = YAML.parse(fs.readFileSync(path.join(directory, relative), 'utf8'));
    const names = new Set([bundleName]);
    const visit = (value) => {
      if (Array.isArray(value)) return value.forEach(visit);
      if (!value || typeof value !== 'object') return;
      if (typeof value.name === 'string' && !value.name.startsWith('file:')) names.add(value.name);
      Object.values(value).forEach(visit);
    };
    visit(document);
    return [...names];
  } catch {
    return [bundleName];
  }
}

function packageUsesRemovedSettingsApi(profileDirectory, packageName) {
  const directory = packageDirectory(profileDirectory, packageName);
  const pending = [path.join(directory, 'lib'), path.join(directory, 'dist')].filter(fs.existsSync);
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const filename = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(filename);
      else if (/\.[cm]?js$/i.test(entry.name)) {
        const source = fs.readFileSync(filename, 'utf8');
        if (SETTINGS_MODULE_REFERENCE.test(source) && REMOVED_SETTINGS_EXPORTS.test(source)) return true;
      }
    }
  }
  return false;
}

function disableIncompatibleProfileBundles({ dshHome, runtime }) {
  if (runtime?.mode !== 'installed') return { disabled: [] };
  const profileDirectory = path.join(dshHome, 'profiles', 'web');
  const manifestPath = path.join(profileDirectory, 'package.json');
  const manifest = readJson(manifestPath);
  const bundles = manifest?.dsh?.profile?.bundles;
  if (!Array.isArray(bundles)) return { disabled: [] };
  const disabled = [];
  for (const bundleName of bundles) {
    if (bundleName.startsWith('@deepseek-ai/') || bundleName.startsWith('@deep-seek-yu/')) continue;
    const incompatiblePackage = patchPackageNames(profileDirectory, bundleName)
      .find((name) => packageUsesRemovedSettingsApi(profileDirectory, name));
    if (incompatiblePackage) disabled.push({
      name: bundleName,
      incompatiblePackage,
      reason: '插件仍引用新版 Harness 已移除的设置接口。',
    });
  }
  if (!disabled.length) return { disabled: [] };
  const disabledNames = new Set(disabled.map((item) => item.name));
  manifest.dsh.profile.bundles = bundles.filter((name) => !disabledNames.has(name));
  atomicJson(manifestPath, manifest);
  const reportPath = path.join(dshHome, REPORT_FILE);
  const previous = readJson(reportPath);
  atomicJson(reportPath, {
    runtimeVersion: runtime.version,
    checkedAt: new Date().toISOString(),
    disabled,
    history: [...(Array.isArray(previous?.history) ? previous.history : []), {
      runtimeVersion: runtime.version,
      disabled: disabled.map((item) => item.name),
      checkedAt: new Date().toISOString(),
    }].slice(-20),
  });
  return { disabled, reportPath };
}

module.exports = { disableIncompatibleProfileBundles, packageUsesRemovedSettingsApi, patchPackageNames };
