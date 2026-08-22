import z from '@deepseek-ai/schemastery';

export const name = 'deep-seek-yu-account-status';
export const inject = ['webServer', 'credentials'];
export const Config = z.object({ enabled: z.boolean().default(true) });

let cache = null;
let cacheAt = 0;

function sendJson(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(value));
}

async function requestJson(url, options = {}, timeout = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const started = Date.now();
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const value = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, value, latencyMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeStatus(summary) {
  const indicator = String(summary?.status?.indicator || 'none');
  const description = String(summary?.status?.description || '状态未知');
  const components = Array.isArray(summary?.components) ? summary.components : [];
  const api = components.find((component) => /api/i.test(String(component?.name || '')));
  const apiStatus = String(api?.status || indicator || 'unknown');
  return { indicator, description, apiStatus, updatedAt: new Date().toISOString() };
}

async function loadState(ctx) {
  if (cache && Date.now() - cacheAt < 30000) return cache;
  const state = {
    configured: false,
    available: false,
    balances: [],
    service: { indicator: 'unknown', description: '状态暂不可用', apiStatus: 'unknown' },
    latencyMs: null,
    observed: 'unknown',
  };
  try {
    const status = await requestJson('https://status.deepseek.com/api/v2/summary.json', {}, 7000);
    if (status.ok) state.service = normalizeStatus(status.value);
  } catch {}
  const credential = await ctx.credentials.resolve('DEEPSEEK_API_KEY');
  if (credential?.value) {
    state.configured = true;
    try {
      const balance = await requestJson('https://api.deepseek.com/user/balance', {
        headers: { Authorization: `Bearer ${credential.value}`, Accept: 'application/json' },
      });
      state.latencyMs = balance.latencyMs;
      if (balance.ok) {
        state.available = balance.value?.is_available === true;
        state.balances = (Array.isArray(balance.value?.balance_infos) ? balance.value.balance_infos : []).map((item) => ({
          currency: String(item.currency || ''),
          totalBalance: String(item.total_balance || ''),
          grantedBalance: String(item.granted_balance || ''),
          toppedUpBalance: String(item.topped_up_balance || ''),
        }));
        state.observed = balance.latencyMs > 3500 ? 'congested' : balance.latencyMs > 1500 ? 'busy' : 'smooth';
      } else {
        state.observed = balance.status === 429 || balance.status === 503 ? 'congested' : 'error';
        state.error = `DeepSeek API 返回 ${balance.status}`;
      }
    } catch (error) {
      state.observed = 'offline';
      state.error = String(error?.message || error).slice(0, 160);
    }
  }
  cache = state;
  cacheAt = Date.now();
  return state;
}

export function apply(ctx, config) {
  if (config.enabled === false) return;
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/deep-seek-yu/api/account-status',
    async handler(req, res) {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method-not-allowed' });
      try { sendJson(res, 200, await loadState(ctx)); }
      catch (error) { sendJson(res, 500, { error: String(error?.message || error).slice(0, 160) }); }
    },
  }), 'deep-seek-yu account status api');
}
