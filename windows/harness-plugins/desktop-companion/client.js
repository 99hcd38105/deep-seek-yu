(() => {
  if (window.__dshDesktopPetBridgeInstalled) return;
  const actions = [];
  const pending = new Map();
  let requestSequence = 0;
  const mobileClient = window.__dshMobileClient === true;
  const requestThroughMobileGateway = async (type, payload = {}, timeout = 90000) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch('/deep-seek-yu/mobile-control', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type, payload }),
      });
      const value = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
      return value.result;
    } finally { clearTimeout(timer); }
  };
  const requestThroughDesktopBridge = (type, payload = {}, timeout = 90000) => new Promise((resolve, reject) => {
    const requestId = `deep-seek-yu-${Date.now()}-${++requestSequence}`;
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error('操作超时，请重试。'));
    }, timeout);
    pending.set(requestId, { resolve, reject, timer });
    actions.push({ type, requestId, payload });
  });
  const request = mobileClient ? requestThroughMobileGateway : requestThroughDesktopBridge;
  window.__deepSeekYuPluginResolve = (requestId, value, error) => {
    const entry = pending.get(requestId);
    if (!entry) return;
    pending.delete(requestId);
    clearTimeout(entry.timer);
    if (error) entry.reject(new Error(error)); else entry.resolve(value);
  };
  const visible = (element) => {
    if (!(element instanceof HTMLElement)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 1 && rect.height > 1;
  };
  const label = (element) => [element.getAttribute('aria-label'), element.getAttribute('title'),
    element.getAttribute('data-testid'), element.textContent].filter(Boolean).join(' ').trim();
  const editors = () => [...document.querySelectorAll('textarea,[contenteditable="true"],[role="textbox"]')]
    .filter((element) => visible(element) && !element.disabled && element.getAttribute('aria-disabled') !== 'true')
    .sort((left, right) => right.getBoundingClientRect().bottom - left.getBoundingClientRect().bottom);
  const setEditorText = (editor, text) => {
    editor.focus();
    if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
      const prototype = editor instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (setter) setter.call(editor, text); else editor.value = text;
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      editor.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    const selection = getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand('insertText', false, text);
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  };
  const composerFor = (editor) => editor?.closest('[data-slot="conversation.composer.bar"],form')
    || editor?.parentElement?.parentElement || document.body;
  const composerImages = (editor) => [...composerFor(editor).querySelectorAll('img')]
    .filter((image) => visible(image) && image.getBoundingClientRect().width >= 18 && image.getBoundingClientRect().height >= 18);
  const clearComposerImages = async (editor) => {
    const container = composerFor(editor);
    const removeButtons = [...container.querySelectorAll('button')].filter((button) =>
      visible(button) && /删除|移除|清除.*(图片|附件)|remove|delete|clear.*(image|attachment)/i.test(label(button)));
    for (const button of removeButtons) button.click();
    if (removeButtons.length) await new Promise((resolve) => setTimeout(resolve, 80));
    return composerImages(editor).length === 0;
  };
  const cleanText = (value, maximum = 800) => String(value || '').replace(/\u200b/g, '')
    .replace(/\n{3,}/g, '\n\n').trim().slice(0, maximum);
  const extractMessages = () => {
    const items = [...document.querySelectorAll('[data-chat-flow-kind]')].slice(-14);
    const messages = [];
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const kind = item.getAttribute('data-chat-flow-kind') || '';
      let role = '';
      let text = '';
      if (kind === 'user') {
        role = 'user';
        const source = item.querySelector('[class*="bubble"], [data-slot="conversation.chat.node"]') || item;
        text = cleanText(source.innerText || source.textContent, 700).replace(/\n\d{1,2}:\d{2}$/, '').trim();
      } else if (kind === 'assistant-step') {
        role = 'assistant';
        const source = item.querySelector('[data-slot="conversation.chat.node"]') || item;
        const clone = source.cloneNode(true);
        clone.querySelectorAll('[data-variant="think"],button,svg,[aria-label*="复制"],[aria-label*="copy" i]')
          .forEach((node) => node.remove());
        text = cleanText(clone.innerText || clone.textContent, 900);
      } else if (kind === 'tool-call') {
        role = 'tool';
        text = cleanText(item.innerText || item.textContent, 400);
      }
      if (role && text) messages.push({ key: `${kind}:${index}:${text.slice(0, 64)}`, role, text });
    }
    return messages.slice(-8);
  };
  const installPetEntry = () => {
    if (document.getElementById('dsh-desktop-pet-entry')) return;
    const composer = document.querySelector('[data-slot="conversation.composer.bar"]');
    if (!composer) return;
    const addButton = [...composer.querySelectorAll('button')].find((button) => /命令|添加|附件|add|attach/i.test(label(button)));
    if (!addButton?.parentElement) return;
    const button = document.createElement('button');
    button.id = 'dsh-desktop-pet-entry';
    button.type = 'button';
    button.textContent = '◉';
    button.title = mobileClient ? '显示电脑桌宠（Harness 插件）' : '显示桌宠（Harness 插件）';
    button.setAttribute('aria-label', button.title);
    button.style.cssText = 'width:30px;height:30px;margin-left:4px;border:0;border-radius:9px;background:transparent;color:#64748b;font-size:18px;cursor:pointer;';
    button.addEventListener('click', () => {
      if (mobileClient) request('desktop-pet:show').catch(() => {});
      else actions.push({ type: 'show-pet' });
    });
    addButton.insertAdjacentElement('afterend', button);
  };
  let sidebarBalanceTimer = 0;
  const refreshSidebarBalance = async () => {
    const button = document.getElementById('deep-seek-yu-sidebar-balance');
    if (!button) return;
    const valueElement = button.querySelector('[data-sidebar-balance]');
    try {
      const response = await fetch('/deep-seek-yu/api/account-status', { cache: 'no-store' });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
      const balance = value.balances?.[0];
      valueElement.textContent = balance ? `${balance.totalBalance} ${balance.currency}` : (value.configured ? '余额暂无' : '未配置 Key');
      button.title = `${valueElement.textContent} · 点击打开 DeepSeek yu 设置`;
    } catch {
      valueElement.textContent = '余额 --';
      button.title = '余额暂不可用 · 点击打开 DeepSeek yu 设置';
    }
  };
  const installSidebarBalance = () => {
    if (mobileClient || document.getElementById('deep-seek-yu-sidebar-balance')) return;
    const area = document.querySelector('.hHd-Xa_settingsArea');
    const settingsButton = area?.querySelector('button');
    if (!area || !settingsButton) return;
    if (!document.getElementById('deep-seek-yu-sidebar-balance-style')) {
      const style = document.createElement('style');
      style.id = 'deep-seek-yu-sidebar-balance-style';
      style.textContent = `.hHd-Xa_settingsArea{display:flex!important;align-items:center;gap:6px}.hHd-Xa_settingsArea .VOzbGW_trigger{width:88px!important;flex:0 0 88px!important;margin:4px 0!important}#deep-seek-yu-sidebar-balance{min-width:0;height:34px;flex:1;display:flex;align-items:center;justify-content:flex-end;gap:5px;padding:0 8px;border:0;border-radius:9px;background:transparent;color:var(--dsw-alias-label-secondary,#475569);cursor:pointer;font:600 12px/1.2 system-ui;white-space:nowrap;overflow:hidden}#deep-seek-yu-sidebar-balance:hover{background:var(--dsw-alias-interactive-bg-hover,#eef2f7);color:var(--dsw-alias-label-primary,#111827)}#deep-seek-yu-sidebar-balance span{overflow:hidden;text-overflow:ellipsis}.hHd-Xa_collapsed .hHd-Xa_settingsArea .VOzbGW_trigger{width:36px!important;flex-basis:36px!important;margin:8px 0 10px!important}.hHd-Xa_collapsed #deep-seek-yu-sidebar-balance{display:none}`;
      document.head.append(style);
    }
    const button = document.createElement('button');
    button.id = 'deep-seek-yu-sidebar-balance';
    button.type = 'button';
    button.setAttribute('aria-label', 'DeepSeek 余额，打开 DeepSeek yu 设置');
    button.innerHTML = '<span data-sidebar-balance>余额…</span><span aria-hidden="true">›</span>';
    button.addEventListener('click', () => {
      settingsButton.click();
      setTimeout(() => document.getElementById('deep-seek-yu-settings-nav')?.click(), 260);
    });
    area.append(button);
    refreshSidebarBalance();
    if (!sidebarBalanceTimer) sidebarBalanceTimer = window.setInterval(refreshSidebarBalance, 60000);
  };
  window.__dshDesktopPetSend = async (text, options = {}) => {
    const editor = editors()[0];
    if (!editor) return { ok: false, error: '没有找到当前聊天输入框，请先打开一个会话。' };
    if (options.requireNoImage && !(await clearComposerImages(editor))) {
      return { ok: false, error: '聊天框里仍有图片附件，请先删除图片缩略图后重试。' };
    }
    setEditorText(editor, text);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const container = composerFor(editor);
    let send = [...container.querySelectorAll('button')].find((button) => {
      const value = label(button);
      return visible(button) && !button.disabled && (/^(发送|send)$/i.test(value) || /发送消息|send message|submit/i.test(value));
    });
    if (!send) send = container.querySelector('button[type="submit"]:not([disabled])');
    if (!send) return { ok: false, error: '已经写入输入框，但没有找到发送按钮。' };
    send.click();
    return { ok: true };
  };
  window.__dshDesktopPetSnapshot = () => {
    installPetEntry();
    const buttons = [...document.querySelectorAll('button')].filter(visible);
    const stop = buttons.find((button) => /停止生成|停止回答|stop generating|stop response|cancel generation/i.test(label(button)));
    const tail = String(document.body.innerText || '').slice(-10000);
    const command = Boolean(stop) && /执行命令|正在运行|running command|powershell|terminal|shell|bash|command/i.test(tail);
    const alerts = [...document.querySelectorAll('[role="alert"]')].filter(visible).map((item) => item.textContent || '').join(' ');
    return {
      status: { busy: Boolean(stop), command, hasError: /失败|错误|error|failed/i.test(alerts), messages: extractMessages() },
      actions: actions.splice(0, actions.length),
    };
  };

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
  const pluginCss = `
    #deep-seek-yu-plugin-panel{color:var(--dsw-alias-label-primary,#111827);font:14px/1.55 system-ui;max-height:min(68vh,720px);overflow:auto;padding:2px 4px 20px}
    #deep-seek-yu-plugin-panel *{box-sizing:border-box}
    .dsy-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin:4px 0 16px}.dsy-head h3{font-size:18px;margin:0}.dsy-head p{margin:3px 0 0;color:var(--dsw-alias-label-tertiary,#64748b)}
    .dsy-version{flex:none;border:1px solid var(--dsw-alias-border-l2,#dbe2ea);border-radius:999px;padding:3px 9px;font-size:12px;color:var(--dsw-alias-label-secondary,#475569)}
    .dsy-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.dsy-card{border:1px solid var(--dsw-alias-border-l2,#e2e8f0);border-radius:14px;padding:16px;background:var(--dsw-alias-bg-layer-1,#fff);min-width:0}.dsy-card.wide{grid-column:1/-1}.dsy-card h4{font-size:15px;margin:0 0 4px}.dsy-muted{color:var(--dsw-alias-label-tertiary,#64748b);font-size:12px}.dsy-row{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:12px}.dsy-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.dsy-checks{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 14px;margin-top:12px}.dsy-checks label{display:flex;align-items:center;gap:7px}.dsy-button{height:34px;border:1px solid var(--dsw-alias-border-l2,#cbd5e1);border-radius:17px;padding:0 13px;background:transparent;color:inherit;cursor:pointer}.dsy-button.primary{border:0;background:var(--dsw-alias-button-primary-fill,#111827);color:var(--dsw-alias-label-primary-foreground,#fff)}.dsy-button:disabled{opacity:.5;cursor:wait}.dsy-select,.dsy-input{height:34px;border:1px solid var(--dsw-alias-border-l2,#cbd5e1);border-radius:8px;padding:0 9px;background:var(--dsw-alias-bg-layer-1,#fff);color:inherit}.dsy-input{width:100%}.dsy-range{width:150px}.dsy-state{margin-top:10px;min-height:19px;color:var(--dsw-alias-label-secondary,#475569)}.dsy-error{color:var(--dsw-alias-state-error-primary,#dc2626)}.dsy-good{color:var(--dsw-alias-state-success-primary,#16a34a)}.dsy-warning{margin-top:12px;padding:9px 11px;border-radius:9px;background:#fff7ed;color:#9a3412;font-size:12px}.dsy-market-list{display:grid;gap:8px;margin-top:10px;max-height:360px;overflow:auto}.dsy-plugin{border-top:1px solid var(--dsw-alias-border-l2,#e2e8f0);padding:10px 2px}.dsy-plugin:first-child{border-top:0}.dsy-plugin-head{display:flex;justify-content:space-between;gap:12px}.dsy-plugin-title{display:flex;align-items:center;gap:7px;flex-wrap:wrap}.dsy-plugin strong{overflow-wrap:anywhere}.dsy-plugin p{margin:4px 0}.dsy-badge{display:inline-flex;align-items:center;height:20px;border-radius:999px;padding:0 7px;background:#eef2ff;color:#3730a3;font-size:10px;font-weight:650}.dsy-badge.official{background:#e8f7ee;color:#167044}.dsy-badge.unverified{background:#fff7ed;color:#9a3412}.dsy-balance{font-size:21px;font-weight:700;margin-top:8px}
    @media(max-width:760px){.dsy-grid{grid-template-columns:1fr}.dsy-card.wide{grid-column:auto}.dsy-checks{grid-template-columns:1fr}.dsy-row{align-items:flex-start;flex-direction:column}}
  `;

  const renderPluginPanel = (panel) => {
    if (panel.dataset.ready === 'true') return;
    panel.dataset.ready = 'true';
    panel.innerHTML = `
      <div class="dsy-head"><div><h3>DeepSeek yu</h3><p>${mobileClient ? '连接电脑端 Harness，设置会同步并在电脑上立即生效。' : 'Harness 内部插件功能，设置直接保存到本机。'}</p></div><span class="dsy-version">v1.1.0 正式版</span></div>
      <div class="dsy-grid">
        <section class="dsy-card" data-card="pet"><h4>桌宠</h4><div class="dsy-muted">桌宠在电脑桌面显示 Harness 思考、命令和对话进度。</div><div class="dsy-checks"><label><input type="checkbox" data-pet="enabled"> 启用桌宠</label><label><input type="checkbox" data-pet="alwaysOnTop"> 始终置顶</label><label><input type="checkbox" data-pet="showStatus"> 显示状态</label><label><input type="checkbox" data-pet="showChatPanel"> 显示聊天框</label><label><input type="checkbox" data-pet="backgroundOnClose"> 关闭主窗口后在后台</label></div><div class="dsy-row"><label>大小 <input class="dsy-range" data-pet="size" type="range" min="160" max="360" step="10"> <span data-size-value></span></label><div class="dsy-actions"><button class="dsy-button" data-open-pets>${mobileClient ? '打开电脑桌宠目录' : '添加桌宠'}</button><button class="dsy-button primary" data-save-pet>保存</button></div></div><div class="dsy-state" data-pet-state>正在读取…</div></section>
        <section class="dsy-card" data-card="account"><h4>余额与服务状态</h4><div class="dsy-muted">API Key 只由 Harness 后端读取，不会显示在页面。</div><div data-balance class="dsy-balance">正在读取…</div><div data-account-detail class="dsy-state"></div><button class="dsy-button" data-refresh-account>刷新</button></section>
        <section class="dsy-card wide" data-card="runtime"><h4>官方 Harness 更新</h4><div class="dsy-muted">只从 DeepSeek 官方 npm 命名空间下载。</div><div class="dsy-row"><div data-runtime-state>正在读取版本…</div><div class="dsy-actions"><select class="dsy-select" data-runtime-versions></select><button class="dsy-button primary" data-install-runtime>安装并切换</button></div></div></section>
        <section class="dsy-card wide" data-card="market"><h4>社区插件市场</h4><div class="dsy-warning">目录来自独立社区，非 DeepSeek 官方市场。现在会显示全部可安装条目，并明确标记“已验证”或“未验证”；第三方插件可访问文件、命令和网络，安装前请查看源码。</div><div class="dsy-row"><input class="dsy-input" data-market-search placeholder="搜索完整目录：插件名、仓库或标签"><button class="dsy-button" data-load-market>加载市场</button></div><div data-market-state class="dsy-state">点击“加载市场”读取完整社区目录。</div><div data-market-list class="dsy-market-list"></div></section>
      </div>`;

    const stateText = (selector, text, error = false) => {
      const element = panel.querySelector(selector);
      element.textContent = text;
      element.classList.toggle('dsy-error', error);
    };
    const loadPet = async () => {
      try {
        const value = await request('desktop-pet:get-settings');
        for (const name of ['enabled', 'alwaysOnTop', 'showStatus', 'showChatPanel', 'backgroundOnClose']) panel.querySelector(`[data-pet="${name}"]`).checked = value.settings[name] !== false;
        panel.querySelector('[data-pet="size"]').value = value.settings.size;
        panel.querySelector('[data-size-value]').textContent = `${value.settings.size}px`;
        stateText('[data-pet-state]', `当前：${value.characters.find((item) => item.id === value.settings.characterId)?.name || '默认桌宠'}`);
      } catch (error) { stateText('[data-pet-state]', error.message, true); }
    };
    panel.querySelector('[data-pet="size"]').addEventListener('input', (event) => { panel.querySelector('[data-size-value]').textContent = `${event.target.value}px`; });
    panel.querySelector('[data-save-pet]').addEventListener('click', async (event) => {
      const button = event.currentTarget; button.disabled = true;
      try {
        const settings = {};
        for (const name of ['enabled', 'alwaysOnTop', 'showStatus', 'showChatPanel', 'backgroundOnClose']) settings[name] = panel.querySelector(`[data-pet="${name}"]`).checked;
        settings.size = Number(panel.querySelector('[data-pet="size"]').value);
        await request('desktop-pet:save-settings', settings);
        stateText('[data-pet-state]', '已保存并立即应用。');
      } catch (error) { stateText('[data-pet-state]', error.message, true); } finally { button.disabled = false; }
    });
    panel.querySelector('[data-open-pets]').addEventListener('click', () => request('desktop-pet:open-directory').catch((error) => stateText('[data-pet-state]', error.message, true)));

    const loadAccount = async () => {
      try {
        const response = await fetch('/deep-seek-yu/api/account-status', { cache: 'no-store' });
        const value = await response.json();
        if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
        panel.querySelector('[data-balance]').textContent = value.balances?.length ? value.balances.map((item) => `${item.totalBalance} ${item.currency}`).join(' / ') : (value.configured ? '暂无余额数据' : '未配置 DeepSeek API Key');
        const observed = { smooth: '顺畅', busy: '较忙', congested: '拥堵', offline: '不可达', error: '异常', unknown: '未知' }[value.observed] || value.observed;
        stateText('[data-account-detail]', `API ${value.available ? '可用' : '不可用'} · ${value.service?.description || '状态未知'} · 本机观测 ${observed}${value.latencyMs == null ? '' : `（${value.latencyMs} ms）`}`);
      } catch (error) { panel.querySelector('[data-balance]').textContent = '暂不可用'; stateText('[data-account-detail]', error.message, true); }
    };
    panel.querySelector('[data-refresh-account]').addEventListener('click', loadAccount);

    const loadVersions = async () => {
      try {
        const value = await request('extensions:versions');
        panel.querySelector('[data-runtime-versions]').innerHTML = value.versions.map((version) => `<option${version === value.active ? ' selected' : ''}>${escapeHtml(version)}</option>`).join('');
        stateText('[data-runtime-state]', `当前 ${value.active}（${value.activeMode === 'bundled' ? '客户端内置' : '已下载官方版'}）· 官方最新 ${value.latest}${value.warning ? ` · ${value.warning}` : ''}`);
      } catch (error) { stateText('[data-runtime-state]', error.message, true); }
    };
    panel.querySelector('[data-install-runtime]').addEventListener('click', async (event) => {
      const button = event.currentTarget; button.disabled = true; button.textContent = '安装中…';
      try { const result = await request('extensions:install-runtime', { version: panel.querySelector('[data-runtime-versions]').value }, 600000); if (!result.canceled) stateText('[data-runtime-state]', '安装完成，请重启 DeepSeek yu。'); }
      catch (error) { stateText('[data-runtime-state]', error.message, true); }
      finally { button.disabled = false; button.textContent = '安装并切换'; }
    });

    let market = [];
    const renderMarket = () => {
      const query = panel.querySelector('[data-market-search]').value.trim().toLowerCase();
      const matched = market.filter((item) => !query || [item.name, item.repo, item.description, ...(item.tags || [])].join(' ').toLowerCase().includes(query));
      const items = matched.slice(0, query ? 160 : 100);
      panel.querySelector('[data-market-list]').innerHTML = items.map((item, index) => {
        const badge = item.official ? '<span class="dsy-badge official">官方条目</span>'
          : item.verified ? '<span class="dsy-badge">已验证</span>' : '<span class="dsy-badge unverified">未验证</span>';
        return `<div class="dsy-plugin"><div class="dsy-plugin-head"><div><div class="dsy-plugin-title"><strong>${escapeHtml(item.name)}</strong>${badge}</div><div class="dsy-muted">${escapeHtml(item.repo)} · ★ ${item.stars ?? '—'}</div></div><div class="dsy-actions"><button class="dsy-button" data-source="${index}">源码</button><button class="dsy-button primary" data-install="${index}">安装</button></div></div><p>${escapeHtml(item.description)}</p></div>`;
      }).join('') || '<div class="dsy-muted">完整目录中没有匹配的插件。</div>';
      if (market.length) stateText('[data-market-state]', `完整目录 ${market.length} 个 · 匹配 ${matched.length} 个${items.length < matched.length ? ` · 当前显示前 ${items.length} 个，请继续输入关键词缩小范围` : ''}`);
      panel.querySelectorAll('[data-source]').forEach((button) => button.addEventListener('click', () => request('extensions:open-source', { url: items[Number(button.dataset.source)].sourceUrl })));
      panel.querySelectorAll('[data-install]').forEach((button) => button.addEventListener('click', async () => {
        button.disabled = true; button.textContent = '安装中…';
        try { const result = await request('extensions:install-plugin', { plugin: items[Number(button.dataset.install)] }, 600000); if (!result.canceled) stateText('[data-market-state]', '安装完成，请重启 DeepSeek yu。'); }
        catch (error) { stateText('[data-market-state]', error.message, true); }
        finally { button.disabled = false; button.textContent = '安装'; }
      }));
    };
    panel.querySelector('[data-market-search]').addEventListener('input', renderMarket);
    panel.querySelector('[data-load-market]').addEventListener('click', async (event) => {
      const button = event.currentTarget; button.disabled = true; button.textContent = '加载中…';
      try { const value = await request('extensions:registry', {}, 90000); market = value.plugins || []; renderMarket(); if (value.warning) stateText('[data-market-state]', `${panel.querySelector('[data-market-state]').textContent} · ${value.warning}`); }
      catch (error) { stateText('[data-market-state]', error.message, true); }
      finally { button.disabled = false; button.textContent = '重新加载'; }
    });
    loadPet(); loadAccount(); loadVersions();
  };

  const installSettingsPlugin = () => {
    const settingsPanel = document.querySelector('.VOzbGW_panel');
    const navList = settingsPanel?.querySelector('.VOzbGW_navList');
    const options = settingsPanel?.querySelector('.VOzbGW_options');
    if (!navList || !options || navList.querySelector('#deep-seek-yu-settings-nav')) return;
    if (!document.getElementById('deep-seek-yu-plugin-style')) {
      const style = document.createElement('style'); style.id = 'deep-seek-yu-plugin-style'; style.textContent = pluginCss; document.head.append(style);
    }
    const officialNavigation = [...navList.querySelectorAll('button')];
    if (!officialNavigation.length) return;
    const navigation = document.createElement('button');
    navigation.id = 'deep-seek-yu-settings-nav';
    navigation.type = 'button';
    navigation.className = officialNavigation[0].className.replace(/\bVOzbGW_active\b/g, '').trim();
    navigation.setAttribute('aria-label', 'DeepSeek yu');
    const sourceIcon = officialNavigation.find((item) => item.textContent.trim() === '插件')?.querySelector('svg')
      || officialNavigation[0].querySelector('svg');
    if (sourceIcon) navigation.append(sourceIcon.cloneNode(true));
    const labelElement = officialNavigation[0].querySelector('span')?.cloneNode(false) || document.createElement('span');
    labelElement.textContent = 'DeepSeek yu';
    navigation.append(labelElement);
    const panel = document.createElement('div');
    panel.id = 'deep-seek-yu-plugin-panel';
    navigation.addEventListener('click', () => {
      officialNavigation.forEach((item) => { item.classList.remove('VOzbGW_active'); item.removeAttribute('aria-current'); });
      navigation.classList.add('VOzbGW_active'); navigation.setAttribute('aria-current', 'true');
      [...options.children].forEach((item) => {
        if (item === panel) return;
        item.hidden = true;
        item.dataset.deepSeekYuHidden = 'true';
      });
      if (!panel.isConnected) options.append(panel);
      renderPluginPanel(panel);
    });
    officialNavigation.forEach((item) => item.addEventListener('click', () => {
      navigation.classList.remove('VOzbGW_active'); navigation.removeAttribute('aria-current');
      [...options.children].forEach((candidate) => {
        if (candidate.dataset.deepSeekYuHidden) { candidate.hidden = false; delete candidate.dataset.deepSeekYuHidden; }
      });
      panel.remove();
    }));
    navList.append(navigation);
  };

  new MutationObserver(() => { installPetEntry(); installSidebarBalance(); installSettingsPlugin(); }).observe(document.documentElement, { childList: true, subtree: true });
  installPetEntry();
  installSidebarBalance();
  installSettingsPlugin();
  window.__dshDesktopPetBridgeInstalled = true;
})();
