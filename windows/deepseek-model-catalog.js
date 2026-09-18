const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { ProxyAgent } = require('undici');

const MODELS_URL = 'https://api.deepseek.com/models';
const STATUS_FILE = 'deepseek-model-catalog.json';

function proxyUrl(rule) {
  const match = /(?:PROXY|HTTPS?)\s+([^;\s]+)/i.exec(String(rule || ''));
  if (!match) return '';
  return /^https?:\/\//i.test(match[1]) ? match[1] : `http://${match[1]}`;
}

function atomicWrite(filename, text) {
  const temporary = `${filename}.tmp`;
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  fs.writeFileSync(temporary, text, { mode: 0o600 });
  fs.renameSync(temporary, filename);
  try { fs.chmodSync(filename, 0o600); } catch {}
}

function titleForModel(id) {
  return String(id).split('-').map((part, index) => {
    if (index === 0 && part.toLowerCase() === 'deepseek') return 'DeepSeek';
    if (/^v\d/i.test(part)) return part.toUpperCase();
    return part ? `${part[0].toUpperCase()}${part.slice(1)}` : part;
  }).join('-');
}

function createDeepSeekModelCatalog({ dshHome, resolveProxy = async () => '', fetchImpl = fetch }) {
  const statusPath = () => path.join(dshHome(), STATUS_FILE);
  const settingsPath = () => path.join(dshHome(), 'settings.yaml');
  const credentialsPath = () => path.join(dshHome(), '.credentials.yaml');

  const readYaml = (filename) => {
    try {
      const value = YAML.parse(fs.readFileSync(filename, 'utf8'));
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch { return {}; }
  };
  const readStatus = () => {
    try { return JSON.parse(fs.readFileSync(statusPath(), 'utf8')); }
    catch { return { models: [], lastCheckedAt: null, lastUpdatedAt: null, error: '' }; }
  };
  const publicStatus = () => {
    const value = readStatus();
    return {
      models: Array.isArray(value.models) ? value.models : [],
      lastCheckedAt: value.lastCheckedAt || null,
      lastUpdatedAt: value.lastUpdatedAt || null,
      error: value.error || '',
    };
  };
  const saveStatus = (value) => atomicWrite(statusPath(), `${JSON.stringify(value, null, 2)}\n`);

  async function sync() {
    const previous = readStatus();
    const checkedAt = new Date().toISOString();
    try {
      const credentials = readYaml(credentialsPath());
      const apiKey = credentials.refs?.DEEPSEEK_API_KEY;
      if (typeof apiKey !== 'string' || !apiKey) throw new Error('未配置 DeepSeek API Key。');
      const proxy = proxyUrl(await resolveProxy(MODELS_URL));
      const response = await fetchImpl(MODELS_URL, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(30000),
        ...(proxy ? { dispatcher: new ProxyAgent(proxy) } : {}),
      });
      if (!response.ok) throw new Error(`DeepSeek 官方模型接口返回 HTTP ${response.status}。`);
      const payload = await response.json();
      const ids = [...new Set((Array.isArray(payload.data) ? payload.data : [])
        .map((entry) => String(entry?.id || '').trim()).filter(Boolean))];
      if (!ids.length) throw new Error('DeepSeek 官方模型列表为空。');

      const settings = readYaml(settingsPath());
      const configured = Array.isArray(settings['llm-deepseek']?.models)
        ? settings['llm-deepseek'].models : [];
      const known = new Map(configured.map((model) => [model?.id, model]));
      const models = ids.map((id) => ({
        ...(known.get(id) || {}), id, name: titleForModel(id),
      }));
      settings['llm-deepseek'] = { ...(settings['llm-deepseek'] || {}), models };
      const selected = settings['agent-default-model'];
      if (selected?.provider === 'deepseek-official' && !ids.includes(selected.model)) {
        settings['agent-default-model'] = { ...selected, model: ids[0] };
      }
      atomicWrite(settingsPath(), YAML.stringify(settings));
      const changed = JSON.stringify(previous.models || []) !== JSON.stringify(ids);
      const next = {
        models: ids,
        lastCheckedAt: checkedAt,
        lastUpdatedAt: changed ? checkedAt : (previous.lastUpdatedAt || checkedAt),
        error: '',
      };
      saveStatus(next);
      return { ...next, changed };
    } catch (error) {
      saveStatus({ ...previous, lastCheckedAt: checkedAt, error: error.message });
      throw error;
    }
  }

  return { status: publicStatus, sync };
}

module.exports = { createDeepSeekModelCatalog };
