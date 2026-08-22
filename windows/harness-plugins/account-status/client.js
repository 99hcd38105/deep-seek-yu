(() => {
  if (window.__deepSeekYuAccountStatus) return;
  const labels = { smooth: '顺畅', busy: '较忙', congested: '拥堵', offline: '不可达', error: '异常', unknown: '检测中' };
  const colors = { smooth: '#16a34a', busy: '#d97706', congested: '#dc2626', offline: '#64748b', error: '#dc2626', unknown: '#64748b' };
  const safe = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
  const button = document.createElement('button');
  button.type = 'button';
  button.id = 'deep-seek-yu-account-status';
  button.style.cssText = 'position:fixed;right:18px;top:14px;z-index:9998;height:32px;padding:0 12px;border:1px solid #e2e8f0;border-radius:999px;background:rgba(255,255,255,.94);box-shadow:0 4px 16px rgba(15,23,42,.08);font:12px/1.2 system-ui;color:#334155;cursor:pointer;';
  button.textContent = '余额与服务状态 · 检测中';
  const dialog = document.createElement('dialog');
  dialog.id = 'deep-seek-yu-account-dialog';
  dialog.style.cssText = 'width:min(430px,calc(100vw - 32px));border:0;border-radius:18px;padding:0;box-shadow:0 24px 80px rgba(15,23,42,.28);font:14px/1.55 system-ui;color:#0f172a;';
  dialog.innerHTML = '<div style="padding:22px"><div style="display:flex;justify-content:space-between;align-items:center"><strong style="font-size:18px">DeepSeek 账户与服务状态</strong><button data-close style="border:0;background:none;font-size:22px;cursor:pointer">×</button></div><div data-body style="margin-top:18px;color:#475569">正在读取…</div><p style="margin:18px 0 0;font-size:12px;color:#94a3b8">密钥只由 Harness 后端读取，不会发送到本页面。服务繁忙程度来自官方状态与本机 API 响应，不代表价格折扣时段。</p></div>';
  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
  button.addEventListener('click', () => dialog.showModal());
  document.body.append(button, dialog);
  async function refresh() {
    try {
      const response = await fetch('/deep-seek-yu/api/account-status', { cache: 'no-store' });
      const state = await response.json();
      if (!response.ok) throw new Error(state.error || `HTTP ${response.status}`);
      const observed = state.observed || 'unknown';
      button.textContent = `余额与服务状态 · ${labels[observed] || observed}`;
      button.style.color = colors[observed] || colors.unknown;
      const balances = state.balances?.length
        ? state.balances.map((item) => `<div style="font-size:24px;font-weight:700;color:#0f172a">${safe(item.totalBalance)} ${safe(item.currency)}</div>`).join('')
        : `<div>${state.configured ? '暂无可用余额数据' : '尚未配置 DeepSeek API Key'}</div>`;
      dialog.querySelector('[data-body]').innerHTML = `${balances}<div style="margin-top:16px;display:grid;gap:8px"><div>API 可用：${state.available ? '是' : '否'}</div><div>官方服务：${safe(state.service?.description || '未知')}</div><div>本机观测：${safe(labels[observed] || observed)}${state.latencyMs == null ? '' : `（${Number(state.latencyMs)} ms）`}</div></div>`;
    } catch (error) {
      button.textContent = '余额与服务状态 · 暂不可用';
      button.style.color = colors.error;
      dialog.querySelector('[data-body]').textContent = String(error?.message || error);
    }
  }
  window.__deepSeekYuAccountStatus = { refresh };
  refresh();
  setInterval(refresh, 60000);
})();
