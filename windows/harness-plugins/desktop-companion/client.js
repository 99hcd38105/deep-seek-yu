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
    #deep-seek-yu-plugin-panel,#deep-seek-yu-market-panel,#deep-seek-yu-vision-panel{color:var(--dsw-alias-label-primary,#111827);font:14px/1.55 system-ui;max-height:min(68vh,720px);overflow:auto;padding:2px 4px 20px}
    #deep-seek-yu-plugin-panel *,#deep-seek-yu-market-panel *,#deep-seek-yu-vision-panel *{box-sizing:border-box}.dsy-native-hidden{display:none!important}
    .dsy-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin:4px 0 16px}.dsy-head h3{font-size:18px;margin:0}.dsy-head p{margin:3px 0 0;color:var(--dsw-alias-label-tertiary,#64748b)}
    .dsy-version{flex:none;border:1px solid var(--dsw-alias-border-l2,#dbe2ea);border-radius:999px;padding:3px 9px;font-size:12px;color:var(--dsw-alias-label-secondary,#475569)}
    .dsy-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.dsy-card{border:1px solid var(--dsw-alias-border-l2,#e2e8f0);border-radius:14px;padding:16px;background:var(--dsw-alias-bg-layer-1,#fff);min-width:0}.dsy-card.wide{grid-column:1/-1}.dsy-card h4{font-size:15px;margin:0 0 4px}.dsy-muted{color:var(--dsw-alias-label-tertiary,#64748b);font-size:12px}.dsy-row{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:12px}.dsy-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.dsy-checks{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 14px;margin-top:12px}.dsy-checks label{display:flex;align-items:center;gap:7px}.dsy-button{height:34px;border:1px solid var(--dsw-alias-border-l2,#cbd5e1);border-radius:17px;padding:0 13px;background:transparent;color:inherit;cursor:pointer}.dsy-button.primary{border:0;background:var(--dsw-alias-button-primary-fill,#111827);color:var(--dsw-alias-label-primary-foreground,#fff)}.dsy-button:disabled{opacity:.5;cursor:wait}.dsy-select,.dsy-input{height:34px;border:1px solid var(--dsw-alias-border-l2,#cbd5e1);border-radius:8px;padding:0 9px;background:var(--dsw-alias-bg-layer-1,#fff);color:inherit}.dsy-input{width:100%}.dsy-range{width:150px}.dsy-state{margin-top:10px;min-height:19px;color:var(--dsw-alias-label-secondary,#475569)}.dsy-error{color:var(--dsw-alias-state-error-primary,#dc2626);white-space:pre-wrap;overflow-wrap:anywhere}.dsy-good{color:var(--dsw-alias-state-success-primary,#16a34a)}.dsy-warning{margin-top:12px;padding:9px 11px;border-radius:9px;background:#fff7ed;color:#9a3412;font-size:12px}.dsy-market-list{display:grid;gap:8px;margin-top:10px;max-height:360px;overflow:auto}.dsy-plugin{border-top:1px solid var(--dsw-alias-border-l2,#e2e8f0);padding:10px 2px}.dsy-plugin:first-child{border-top:0}.dsy-plugin-head{display:flex;justify-content:space-between;gap:12px}.dsy-plugin-title{display:flex;align-items:center;gap:7px;flex-wrap:wrap}.dsy-plugin strong{overflow-wrap:anywhere}.dsy-plugin p{margin:4px 0}.dsy-badge{display:inline-flex;align-items:center;height:20px;border-radius:999px;padding:0 7px;background:#eef2ff;color:#3730a3;font-size:10px;font-weight:650}.dsy-badge.official{background:#e8f7ee;color:#167044}.dsy-badge.unverified{background:#fff7ed;color:#9a3412}.dsy-badge.source{background:var(--dsw-alias-bg-layer-2,#f1f5f9);color:var(--dsw-alias-label-secondary,#475569);font-weight:500}.dsy-balance{font-size:21px;font-weight:700;margin-top:8px}
    .dsy-balance-row{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin-top:8px}.dsy-balance-row .dsy-balance{margin-top:0}.dsy-peak{display:inline-flex;align-items:center;height:24px;border-radius:999px;padding:0 9px;font-size:11px;font-weight:700;background:#e0f2fe;color:#075985}.dsy-peak.peak{background:#fff7ed;color:#c2410c}.dsy-progress{height:7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,#eef2f7);overflow:hidden;margin-top:7px}.dsy-progress>i{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,#38bdf8,#4f46e5)}
    @media(max-width:760px){.dsy-grid{grid-template-columns:1fr}.dsy-card.wide{grid-column:auto}.dsy-checks{grid-template-columns:1fr}.dsy-row{align-items:flex-start;flex-direction:column}}
  `;

  const renderPluginPanel = (panel) => {
    if (panel.dataset.ready === 'true') return;
    panel.dataset.ready = 'true';
    panel.innerHTML = `
      <div class="dsy-head"><div><h3>DeepSeek yu</h3><p>${mobileClient ? '连接电脑端 Harness，设置会同步并在电脑上立即生效。' : 'Harness 内部插件功能，设置直接保存到本机。'}</p></div><span class="dsy-version">v1.1.3 正式版</span></div>
      <div class="dsy-grid">
        <section class="dsy-card" data-card="pet"><h4>桌宠</h4><div class="dsy-muted">会呼吸、工作、睡觉、玩耍和成长；完成工作获得小鱼干。</div><div class="dsy-checks"><label><input type="checkbox" data-pet="enabled"> 启用桌宠</label><label><input type="checkbox" data-pet="alwaysOnTop"> 始终置顶</label><label><input type="checkbox" data-pet="showStatus"> 显示状态</label><label><input type="checkbox" data-pet="showChatPanel"> 显示聊天框</label><label><input type="checkbox" data-pet="dynamicActions"> 动态拟人动作</label><label><input type="checkbox" data-pet="eatDroppedFiles"> 拖入文件时吃掉</label><label><input type="checkbox" data-pet="backgroundOnClose"> 关闭主窗口后在后台</label></div><div class="dsy-row"><label>大小 <input class="dsy-range" data-pet="size" type="range" min="160" max="360" step="10"> <span data-size-value></span></label><div class="dsy-actions"><button class="dsy-button" data-open-pets>${mobileClient ? '打开电脑桌宠目录' : '添加桌宠'}</button><button class="dsy-button primary" data-save-pet>保存</button></div></div><div class="dsy-state" data-pet-state>正在读取…</div><div class="dsy-progress"><i data-growth-bar style="width:0"></i></div><div class="dsy-muted" data-growth-detail></div></section>
        <section class="dsy-card" data-card="account"><h4>余额与服务状态</h4><div class="dsy-muted">API Key 只由 Harness 后端读取，不会显示在页面。</div><div class="dsy-balance-row"><div data-balance class="dsy-balance">正在读取…</div><span data-peak class="dsy-peak" hidden></span></div><div data-account-detail class="dsy-state"></div><div class="dsy-actions"><button class="dsy-button" data-refresh-account>刷新</button><label><input type="checkbox" data-account-show-peak> 显示峰谷时段</label></div><div class="dsy-muted" data-peak-detail></div></section>
        <section class="dsy-card wide" data-card="runtime"><h4>DeepSeek Harness 更新</h4><div class="dsy-muted">直接核对 DeepSeek 官方 npm 发布目录。版本按完整编号比较，例如 0.1.1-rc.2 新于 0.1.0-rc.8；这里不更新 DeepSeek yu 或社区插件。</div><div class="dsy-row"><div><div data-runtime-state>正在读取版本…</div><div class="dsy-muted" data-runtime-history></div></div><div class="dsy-actions"><button class="dsy-button" data-check-runtime>重新核对官方版本</button><select class="dsy-select" data-runtime-versions></select><button class="dsy-button" data-install-runtime>安装所选版本</button><button class="dsy-button primary" data-update-runtime>更新到最新版</button></div></div><details data-runtime-history-details style="margin-top:12px"><summary style="cursor:pointer">查看全部历史版本</summary><div class="dsy-state" data-runtime-history-list>正在读取…</div></details></section>
      </div>`;

    const stateText = (selector, text, error = false) => {
      const element = panel.querySelector(selector);
      element.textContent = text;
      element.classList.toggle('dsy-error', error);
    };
    let currentPetSettings = { showPeakStatus: true };
    const loadPet = async () => {
      try {
        const value = await request('desktop-pet:get-settings');
        currentPetSettings = value.settings;
        for (const name of ['enabled', 'alwaysOnTop', 'showStatus', 'showChatPanel', 'dynamicActions', 'eatDroppedFiles', 'backgroundOnClose']) panel.querySelector(`[data-pet="${name}"]`).checked = value.settings[name] !== false;
        panel.querySelector('[data-account-show-peak]').checked = value.settings.showPeakStatus !== false;
        panel.querySelector('[data-pet="size"]').value = value.settings.size;
        panel.querySelector('[data-size-value]').textContent = `${value.settings.size}px`;
        const growth = value.progress?.growth || {};
        panel.querySelector('[data-growth-bar]').style.width = `${growth.percent ?? 0}%`;
        stateText('[data-pet-state]', `当前：${value.characters.find((item) => item.id === value.settings.characterId)?.name || '默认桌宠'} · 🐟 ${value.progress?.fish || 0} · Lv.${growth.number || 1} ${growth.name || '初次相遇'}`);
        stateText('[data-growth-detail]', growth.nextMinimum == null ? `已达到最高阶段「${growth.title || growth.name}」` : `经验 ${value.progress?.experience || 0}/${growth.nextMinimum} · 下一阶段「${growth.nextName}」`);
      } catch (error) { stateText('[data-pet-state]', error.message, true); }
    };
    panel.querySelector('[data-pet="size"]').addEventListener('input', (event) => { panel.querySelector('[data-size-value]').textContent = `${event.target.value}px`; });
    panel.querySelector('[data-save-pet]').addEventListener('click', async (event) => {
      const button = event.currentTarget; button.disabled = true;
      try {
        const settings = {};
        for (const name of ['enabled', 'alwaysOnTop', 'showStatus', 'showChatPanel', 'dynamicActions', 'eatDroppedFiles', 'backgroundOnClose']) settings[name] = panel.querySelector(`[data-pet="${name}"]`).checked;
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
        const showPeak = panel.querySelector('[data-account-show-peak]').checked;
        const peak = panel.querySelector('[data-peak]');
        peak.hidden = !showPeak;
        peak.textContent = value.pricing?.label || '峰谷未知';
        peak.classList.toggle('peak', value.pricing?.period === 'peak');
        stateText('[data-peak-detail]', showPeak ? `${value.pricing?.priceHint || ''} · ${value.pricing?.schedule || ''}` : '峰谷时段显示已关闭');
        const observed = { smooth: '顺畅', busy: '较忙', congested: '拥堵', offline: '不可达', error: '异常', unknown: '未知' }[value.observed] || value.observed;
        stateText('[data-account-detail]', `API ${value.available ? '可用' : '不可用'} · ${value.service?.description || '状态未知'} · 本机观测 ${observed}${value.latencyMs == null ? '' : `（${value.latencyMs} ms）`}`);
      } catch (error) { panel.querySelector('[data-balance]').textContent = '暂不可用'; stateText('[data-account-detail]', error.message, true); }
    };
    panel.querySelector('[data-refresh-account]').addEventListener('click', loadAccount);
    panel.querySelector('[data-account-show-peak]').addEventListener('change', async (event) => {
      currentPetSettings.showPeakStatus = event.target.checked;
      try { await request('desktop-pet:save-settings', { showPeakStatus: event.target.checked }); await loadAccount(); }
      catch (error) { stateText('[data-account-detail]', error.message, true); }
    });

    let runtimeCatalog = null;
    const syncRuntimeButtons = () => {
      const selected = panel.querySelector('[data-runtime-versions]').value;
      const installButton = panel.querySelector('[data-install-runtime]');
      const updateButton = panel.querySelector('[data-update-runtime]');
      installButton.disabled = !runtimeCatalog || selected === runtimeCatalog.active;
      installButton.textContent = selected === runtimeCatalog?.active ? '当前版本' : '安装所选版本';
      const upToDate = !runtimeCatalog || runtimeCatalog.active === runtimeCatalog.latest;
      updateButton.disabled = upToDate || Boolean(runtimeCatalog?.warning);
      updateButton.textContent = upToDate ? '已是最新版' : `更新到 ${runtimeCatalog.latest}`;
    };
    const loadVersions = async (announce = false) => {
      try {
        const value = await request('extensions:versions');
        runtimeCatalog = value;
        const installable = new Set(value.versions || []);
        const displayedVersions = [...new Set([value.active, ...(value.publishedVersions || []), ...(value.versions || [])])];
        panel.querySelector('[data-runtime-versions]').innerHTML = displayedVersions.map((version) => {
          const current = version === value.active;
          const latest = version === value.latest;
          const supported = installable.has(version);
          const suffix = [current ? '当前' : '', latest ? '最新' : '', !supported ? '历史版本，仅查看' : ''].filter(Boolean).join('、');
          return `<option value="${escapeHtml(version)}"${current ? ' selected' : ''}${!supported ? ' disabled' : ''}>${escapeHtml(version)}${suffix ? `（${suffix}）` : ''}</option>`;
        }).join('');
        const upToDate = value.active === value.latest;
        const tagSummary = Object.entries(value.distTags || {}).map(([tag, version]) => `${tag}=${version}`).join('、');
        const checkedTime = value.checkedAt ? new Date(value.checkedAt).toLocaleString('zh-CN', { hour12: false }) : '';
        stateText('[data-runtime-state]', `当前 ${value.active}（${value.activeMode === 'bundled' ? '客户端内置' : '已下载官方版'}）· 官方最新 ${value.latest}${value.warning ? ` · ${value.warning}` : announce ? (upToDate ? ' · 已是最新版' : ' · 发现可用更新') : ''}`, Boolean(value.warning));
        const history = (value.publishedVersions || []).slice(0, 4).join(' > ');
        stateText('[data-runtime-history]', value.warning ? '当前显示的是本机内置版本，联网后可重新核对。' : `官方标签：${tagSummary || '无'} · 最近发布：${history || value.latest}${checkedTime ? ` · 核对时间 ${checkedTime}` : ''}`);
        const historyList = (value.publishedVersions || []).map((version) => {
          const labels = [version === value.latest ? '最新版' : '', version === value.active ? '当前使用' : '', installable.has(version) ? '兼容安装' : '历史记录'].filter(Boolean);
          return `${version}${labels.length ? `（${labels.join('、')}）` : ''}`;
        }).join('　·　');
        stateText('[data-runtime-history-list]', historyList || '联网后显示 DeepSeek 官方完整发布历史。');
        syncRuntimeButtons();
      } catch (error) { stateText('[data-runtime-state]', error.message, true); }
    };
    panel.querySelector('[data-runtime-versions]').addEventListener('change', syncRuntimeButtons);
    panel.querySelector('[data-check-runtime]').addEventListener('click', async (event) => {
      const button = event.currentTarget; button.disabled = true; button.textContent = '检查中…';
      try { await loadVersions(true); }
      finally { button.disabled = false; button.textContent = '重新核对官方版本'; }
    });
    panel.querySelector('[data-install-runtime]').addEventListener('click', async (event) => {
      const button = event.currentTarget; const original = button.textContent; button.disabled = true; button.textContent = '安装中…';
      try { const version = panel.querySelector('[data-runtime-versions]').value; const result = await request('extensions:install-runtime', { version }, 600000); if (!result.canceled) stateText('[data-runtime-state]', `DeepSeek Harness ${version} 已安装，重启 DeepSeek yu 后生效。`); }
      catch (error) { stateText('[data-runtime-state]', error.message, true); }
      finally { button.disabled = false; button.textContent = original; syncRuntimeButtons(); }
    });
    panel.querySelector('[data-update-runtime]').addEventListener('click', async (event) => {
      const button = event.currentTarget; const version = runtimeCatalog?.latest;
      if (!version || version === runtimeCatalog.active) return;
      button.disabled = true; button.textContent = '更新中…';
      try { const result = await request('extensions:install-runtime', { version }, 600000); if (!result.canceled) stateText('[data-runtime-state]', `DeepSeek Harness 已更新到 ${version}，重启 DeepSeek yu 后生效。`); }
      catch (error) { stateText('[data-runtime-state]', error.message, true); }
      finally { button.disabled = false; syncRuntimeButtons(); }
    });

    loadPet().finally(loadAccount); loadVersions();
  };

  const renderVisionPanel = (panel) => {
    if (panel.dataset.ready === 'true') return;
    panel.dataset.ready = 'true';
    panel.innerHTML = `
      <div class="dsy-head"><div><h3>本地识图</h3><p>让 DeepSeek Harness 在电脑本地读取图片，再把文字描述交给 DeepSeek 继续处理。</p></div><span class="dsy-version">本地 · 隐私优先</span></div>
      <div class="dsy-grid">
        <section class="dsy-card wide"><h4 data-vision-model>SmolVLM 256M（本地轻量模型）</h4><div class="dsy-muted">模型仅在首次使用时下载；图片在电脑本地分析，不发送给第三方识图服务。</div><div data-vision-state class="dsy-state">正在读取模型状态…</div><div class="dsy-actions"><button class="dsy-button primary" data-prepare-vision>下载并启用</button>${mobileClient ? '' : '<button class="dsy-button" data-test-vision>选择图片测试</button><button class="dsy-button" data-open-model>打开模型目录</button>'}</div></section>
        <section class="dsy-card wide"><h4>使用方法</h4><div class="dsy-muted">在聊天输入框添加 PNG、JPG、WebP 或 GIF 图片并发送即可。Harness 会先调用内置本地视觉模型生成描述，再由当前 DeepSeek 模型回答；支持错误截图中的界面、对象和可读文字。</div><div class="dsy-warning">首次下载和首次加载需要一些时间并占用内存。模型缓存保留在本机，升级客户端不会删除。</div></section>
      </div>`;
    const stateElement = panel.querySelector('[data-vision-state]');
    const prepareButton = panel.querySelector('[data-prepare-vision]');
    const formatSize = (bytes) => bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(0)} MB` : bytes > 1024 ? `${(bytes / 1024).toFixed(0)} KB` : `${bytes || 0} B`;
    const loadVision = async () => {
      try {
        const value = await request('desktop-pet:get-settings');
        const vision = value.vision || {};
        const labels = { 'not-downloaded': '尚未下载', downloading: `正在下载 ${vision.progress || 0}%`, cached: '模型已下载', loading: '正在加载模型', ready: '模型已就绪', analyzing: '正在识别图片', error: '模型发生错误' };
        panel.querySelector('[data-vision-model]').textContent = vision.modelLabel || 'SmolVLM 256M（本地轻量模型）';
        stateElement.textContent = `${labels[vision.status] || vision.status || '状态未知'} · 缓存 ${formatSize(vision.size)}${vision.error ? ` · ${vision.error}` : ''}`;
        stateElement.classList.toggle('dsy-error', vision.status === 'error');
        prepareButton.textContent = vision.cached ? (vision.ready ? '重新加载' : '加载并启用') : '下载并启用';
        return vision;
      } catch (error) { stateElement.textContent = error.message; stateElement.classList.add('dsy-error'); return {}; }
    };
    prepareButton.addEventListener('click', async () => {
      prepareButton.disabled = true; prepareButton.textContent = '准备中…';
      const timer = setInterval(loadVision, 1000);
      try { await request('desktop-pet:prepare-vision', {}, 600000); await loadVision(); stateElement.textContent = '本地识图模型已准备完成，可以直接在聊天中添加图片。'; stateElement.classList.remove('dsy-error'); }
      catch (error) { stateElement.textContent = error.message; stateElement.classList.add('dsy-error'); }
      finally { clearInterval(timer); prepareButton.disabled = false; await loadVision(); }
    });
    panel.querySelector('[data-open-model]')?.addEventListener('click', () => request('desktop-pet:open-model-directory').catch((error) => { stateElement.textContent = error.message; stateElement.classList.add('dsy-error'); }));
    panel.querySelector('[data-test-vision]')?.addEventListener('click', async (event) => {
      const button = event.currentTarget; button.disabled = true; button.textContent = '请选择图片…';
      try { const result = await request('desktop-pet:choose-image', { question: '请解释这张图片的内容。' }, 600000); if (!result?.canceled) { stateElement.textContent = '图片已在本地识别，并发送到当前聊天。'; stateElement.classList.remove('dsy-error'); } }
      catch (error) { stateElement.textContent = error.message; stateElement.classList.add('dsy-error'); }
      finally { button.disabled = false; button.textContent = '选择图片测试'; await loadVision(); }
    });
    loadVision();
  };

  const renderMarketPanel = (panel) => {
    if (panel.dataset.ready === 'true') return;
    panel.dataset.ready = 'true';
    panel.innerHTML = `
      <div class="dsy-head"><div><h3>社区插件</h3><p>发现、验证、安装和卸载当前 web profile 的 Harness 插件。</p></div><span class="dsy-version">v1.1.3 正式版</span></div>
      <div class="dsy-grid">
        <section class="dsy-card wide"><div class="dsy-row" style="margin-top:0"><div><h4>已安装插件</h4><div class="dsy-muted">插件可以检查更新、启用、禁用、修复或卸载；挂载状态在重启 DeepSeek yu 后生效。</div></div><div class="dsy-actions"><button class="dsy-button" data-refresh-installed>刷新</button><button class="dsy-button primary" data-check-updates>检查更新</button></div></div><div data-installed-state class="dsy-state">正在读取…</div><div data-installed-list class="dsy-market-list"></div></section>
        <section class="dsy-card wide"><h4>插件市场</h4><div class="dsy-warning">聚合已验证目录、DSH Market 与 GitHub 的 dsh-plugin Topic。安装前会检查仓库根包；如果仓库是插件集合，会尝试按 README 改用真正可挂载的 npm 包。第三方插件可访问文件、命令和网络，请先查看源码。</div><div class="dsy-row"><input class="dsy-input" data-market-search placeholder="搜索插件名、仓库或标签"><div class="dsy-actions"><button class="dsy-button" data-open-topic>打开 GitHub Topic</button><button class="dsy-button primary" data-load-market>加载全部插件</button></div></div><div data-market-state class="dsy-state">点击“加载全部插件”聚合三个插件来源。</div><div data-market-list class="dsy-market-list"></div></section>
      </div>`;
    const stateText = (selector, text, error = false) => {
      const element = panel.querySelector(selector);
      element.textContent = text;
      element.classList.toggle('dsy-error', error);
    };
    let installed = [];
    let market = [];
    let marketCounts = {};
    const renderInstalled = () => {
      panel.querySelector('[data-installed-list]').innerHTML = installed.map((item, index) => {
        const status = item.bundle ? '<span class="dsy-badge official">已启用</span>'
          : item.bundleCapable ? '<span class="dsy-badge">已禁用</span>'
            : item.installed ? '<span class="dsy-badge unverified">需要修复</span>' : '<span class="dsy-badge unverified">安装不完整</span>';
        const updateStatus = item.updateAvailable
          ? `<span class="dsy-badge unverified">有更新 ${escapeHtml(item.latestVersion)}</span>`
          : item.updateChecked && !item.updateError ? '<span class="dsy-badge official">已是最新</span>' : '';
        const detail = item.bundle ? 'Harness 将在重启后加载这个 bundle'
          : item.bundleCapable ? '插件文件仍保留，但不加入 Harness 挂载列表'
            : '此包没有声明 dsh.bundle，不能直接启用';
        const control = item.bundleCapable
          ? `<button class="dsy-button" data-toggle="${index}">${item.bundle ? '禁用' : '启用'}</button>`
          : item.repairable ? `<button class="dsy-button primary" data-repair="${index}">修复</button>` : '';
        const updateControl = item.updateAvailable ? `<button class="dsy-button primary" data-update="${index}">更新</button>` : '';
        const updateDetail = item.updateError ? ` · 更新检查失败：${escapeHtml(item.updateError)}`
          : item.updateChecked ? ` · 最新 ${escapeHtml(item.latestVersion || item.version)}` : '';
        return `<div class="dsy-plugin"><div class="dsy-plugin-head"><div><div class="dsy-plugin-title"><strong>${escapeHtml(item.name)}</strong>${status}${updateStatus}</div><div class="dsy-muted">${escapeHtml(item.version || item.requested)} · ${escapeHtml(detail)}${updateDetail}</div></div><div class="dsy-actions">${updateControl}${control}<button class="dsy-button" data-remove="${index}">卸载</button></div></div>${item.description ? `<p>${escapeHtml(item.description)}</p>` : ''}</div>`;
      }).join('') || '<div class="dsy-muted">当前没有另外安装的社区插件。</div>';
      stateText('[data-installed-state]', `当前 ${installed.length} 个依赖 · 已启用 ${installed.filter((item) => item.bundle).length} 个 · 已禁用 ${installed.filter((item) => item.bundleCapable && !item.bundle).length} 个 · 待修复 ${installed.filter((item) => !item.bundleCapable).length} 个`);
      panel.querySelectorAll('[data-toggle]').forEach((button) => button.addEventListener('click', async () => {
        const item = installed[Number(button.dataset.toggle)];
        const enabled = !item.bundle;
        button.disabled = true; button.textContent = enabled ? '启用中…' : '禁用中…';
        try {
          await request('extensions:set-plugin-enabled', { name: item.name, enabled });
          await loadInstalled();
          stateText('[data-installed-state]', `${item.name} 已${enabled ? '启用' : '禁用'}，请重启 DeepSeek yu。`);
        } catch (error) { stateText('[data-installed-state]', error.message, true); }
        finally { button.disabled = false; button.textContent = enabled ? '启用' : '禁用'; }
      }));
      panel.querySelectorAll('[data-repair]').forEach((button) => button.addEventListener('click', async () => {
        const item = installed[Number(button.dataset.repair)];
        button.disabled = true; button.textContent = '修复中…';
        try {
          const result = await request('extensions:repair-plugin', { name: item.name }, 600000);
          if (!result.canceled) {
            await loadInstalled();
            stateText('[data-installed-state]', result.message || result.warning || '修复完成，请重启 DeepSeek yu。', Boolean(result.warning));
          }
        } catch (error) { stateText('[data-installed-state]', error.message, true); }
        finally { button.disabled = false; button.textContent = '修复'; }
      }));
      panel.querySelectorAll('[data-update]').forEach((button) => button.addEventListener('click', async () => {
        const item = installed[Number(button.dataset.update)];
        button.disabled = true; button.textContent = '更新中…';
        try {
          const result = await request('extensions:update-plugin', { name: item.name }, 600000);
          if (!result.canceled) { await loadInstalled(); stateText('[data-installed-state]', result.message || '更新完成。'); }
        } catch (error) { stateText('[data-installed-state]', error.message, true); }
        finally { button.disabled = false; button.textContent = '更新'; }
      }));
      panel.querySelectorAll('[data-remove]').forEach((button) => button.addEventListener('click', async () => {
        const item = installed[Number(button.dataset.remove)];
        button.disabled = true; button.textContent = '卸载中…';
        try {
          const result = await request('extensions:remove-plugin', { name: item.name }, 600000);
          if (!result.canceled) { await loadInstalled(); stateText('[data-installed-state]', result.restartRequired ? '卸载完成，请重启 DeepSeek yu。' : '未激活依赖已卸载。'); }
        } catch (error) { stateText('[data-installed-state]', error.message, true); }
        finally { button.disabled = false; button.textContent = '卸载'; }
      }));
    };
    const loadInstalled = async () => {
      try { const value = await request('extensions:installed'); installed = value.plugins || []; renderInstalled(); }
      catch (error) { stateText('[data-installed-state]', error.message, true); }
    };
    const renderMarket = () => {
      const query = panel.querySelector('[data-market-search]').value.trim().toLowerCase();
      const matched = market.filter((item) => !query || [item.name, item.repo, item.description, ...(item.tags || [])].join(' ').toLowerCase().includes(query));
      const items = matched.slice(0, query ? 160 : 100);
      panel.querySelector('[data-market-list]').innerHTML = items.map((item, index) => {
        const badge = item.official ? '<span class="dsy-badge official">官方条目</span>'
          : item.verified ? '<span class="dsy-badge">已验证</span>' : '<span class="dsy-badge unverified">未验证</span>';
        const sources = (item.catalogs || []).map((source) => `<span class="dsy-badge source">${escapeHtml(source)}</span>`).join('');
        return `<div class="dsy-plugin"><div class="dsy-plugin-head"><div><div class="dsy-plugin-title"><strong>${escapeHtml(item.name)}</strong>${badge}${sources}</div><div class="dsy-muted">${escapeHtml(item.repo)} · ★ ${item.stars ?? '—'}</div></div><div class="dsy-actions"><button class="dsy-button" data-source="${index}">源码</button><button class="dsy-button primary" data-install="${index}">安装</button></div></div><p>${escapeHtml(item.description)}</p></div>`;
      }).join('') || '<div class="dsy-muted">目录中没有匹配的插件。</div>';
      if (market.length) stateText('[data-market-state]', `聚合去重 ${marketCounts.total || market.length} 个 · DSH Market ${marketCounts.market || 0} · 已验证 ${marketCounts.verified || 0} · Topic 最新 ${marketCounts.live || 0} · 匹配 ${matched.length}${items.length < matched.length ? ` · 显示前 ${items.length} 个` : ''}`);
      panel.querySelectorAll('[data-source]').forEach((button) => button.addEventListener('click', () => request('extensions:open-source', { url: items[Number(button.dataset.source)].sourceUrl })));
      panel.querySelectorAll('[data-install]').forEach((button) => button.addEventListener('click', async () => {
        button.disabled = true; button.textContent = '检查兼容性…';
        try {
          const result = await request('extensions:install-plugin', { plugin: items[Number(button.dataset.install)] }, 600000);
          if (!result.canceled) {
            await loadInstalled();
            stateText('[data-market-state]', result.warning || (result.adapted ? `已自动选择兼容的 bundle ${result.packageName}，安装完成，请重启 DeepSeek yu。` : '安装并挂载完成，请重启 DeepSeek yu。'), Boolean(result.warning));
          }
        } catch (error) { stateText('[data-market-state]', error.message, true); }
        finally { button.disabled = false; button.textContent = '安装'; }
      }));
    };
    panel.querySelector('[data-refresh-installed]').addEventListener('click', loadInstalled);
    panel.querySelector('[data-check-updates]').addEventListener('click', async (event) => {
      const button = event.currentTarget; button.disabled = true; button.textContent = '检查中…';
      stateText('[data-installed-state]', '正在从插件来源检查最新版本…');
      try {
        const value = await request('extensions:check-updates', {}, 120000);
        installed = value.plugins || [];
        renderInstalled();
        const counts = value.counts || {};
        stateText('[data-installed-state]', counts.available
          ? `发现 ${counts.available} 个可用更新；请选择对应插件进行更新。`
          : `检查完成，${counts.current || 0} 个插件已是最新${counts.unavailable ? `，${counts.unavailable} 个暂时无法检查` : ''}。`, Boolean(counts.unavailable && !counts.current));
      } catch (error) { stateText('[data-installed-state]', error.message, true); }
      finally { button.disabled = false; button.textContent = '检查更新'; }
    });
    panel.querySelector('[data-market-search]').addEventListener('input', renderMarket);
    panel.querySelector('[data-open-topic]').addEventListener('click', () => request('extensions:open-topic').catch((error) => stateText('[data-market-state]', error.message, true)));
    panel.querySelector('[data-load-market]').addEventListener('click', async (event) => {
      const button = event.currentTarget; button.disabled = true; button.textContent = '加载中…';
      try { const value = await request('extensions:registry', {}, 120000); market = value.plugins || []; marketCounts = value.counts || {}; renderMarket(); if (value.warning) stateText('[data-market-state]', `${panel.querySelector('[data-market-state]').textContent} · ${value.warning}`); }
      catch (error) { stateText('[data-market-state]', error.message, true); }
      finally { button.disabled = false; button.textContent = '重新加载全部'; }
    });
    loadInstalled();
  };

  const installSettingsPlugin = () => {
    const settingsPanel = document.querySelector('.VOzbGW_panel');
    const navList = settingsPanel?.querySelector('.VOzbGW_navList');
    const options = settingsPanel?.querySelector('.VOzbGW_options');
    if (!navList || !options || (navList.querySelector('#deep-seek-yu-settings-nav') && navList.querySelector('#deep-seek-yu-vision-nav') && navList.querySelector('#deep-seek-yu-market-nav'))) return;
    if (!document.getElementById('deep-seek-yu-plugin-style')) {
      const style = document.createElement('style'); style.id = 'deep-seek-yu-plugin-style'; style.textContent = pluginCss; document.head.append(style);
    }
    const officialNavigation = [...navList.querySelectorAll('button')];
    if (!officialNavigation.length) return;
    const sourceIcon = officialNavigation.find((item) => item.textContent.trim() === '插件')?.querySelector('svg')
      || officialNavigation[0].querySelector('svg');
    const createNavigation = (id, text) => {
      const navigation = document.createElement('button');
      navigation.id = id;
      navigation.type = 'button';
      navigation.className = officialNavigation[0].className.replace(/\bVOzbGW_active\b/g, '').trim();
      navigation.setAttribute('aria-label', text);
      if (sourceIcon) navigation.append(sourceIcon.cloneNode(true));
      const labelElement = officialNavigation[0].querySelector('span')?.cloneNode(false) || document.createElement('span');
      labelElement.textContent = text;
      navigation.append(labelElement);
      return navigation;
    };
    const navigation = createNavigation('deep-seek-yu-settings-nav', 'DeepSeek yu');
    const visionNavigation = createNavigation('deep-seek-yu-vision-nav', '本地识图');
    const marketNavigation = createNavigation('deep-seek-yu-market-nav', '社区插件');
    const panel = Object.assign(document.createElement('div'), { id: 'deep-seek-yu-plugin-panel' });
    const visionPanel = Object.assign(document.createElement('div'), { id: 'deep-seek-yu-vision-panel' });
    const marketPanel = Object.assign(document.createElement('div'), { id: 'deep-seek-yu-market-panel' });
    const customNavigations = [navigation, visionNavigation, marketNavigation];
    const customPanels = [panel, visionPanel, marketPanel];
    const activate = (selectedNavigation, selectedPanel, render) => {
      officialNavigation.forEach((item) => { item.classList.remove('VOzbGW_active'); item.removeAttribute('aria-current'); });
      customNavigations.forEach((item) => { item.classList.toggle('VOzbGW_active', item === selectedNavigation); item.removeAttribute('aria-current'); });
      selectedNavigation.setAttribute('aria-current', 'true');
      [...options.children].forEach((item) => {
        item.classList.toggle('dsy-native-hidden', item !== selectedPanel);
      });
      if (!selectedPanel.isConnected) options.append(selectedPanel);
      selectedPanel.classList.remove('dsy-native-hidden');
      render(selectedPanel);
    };
    navigation.addEventListener('click', () => activate(navigation, panel, renderPluginPanel));
    visionNavigation.addEventListener('click', () => activate(visionNavigation, visionPanel, renderVisionPanel));
    marketNavigation.addEventListener('click', () => activate(marketNavigation, marketPanel, renderMarketPanel));
    officialNavigation.forEach((item) => item.addEventListener('click', () => {
      customNavigations.forEach((candidate) => { candidate.classList.remove('VOzbGW_active'); candidate.removeAttribute('aria-current'); });
      [...options.children].forEach((candidate) => {
        candidate.classList.remove('dsy-native-hidden');
      });
      customPanels.forEach((candidate) => candidate.remove());
    }));
    navList.append(navigation, visionNavigation, marketNavigation);
  };

  new MutationObserver(() => { installPetEntry(); installSidebarBalance(); installSettingsPlugin(); }).observe(document.documentElement, { childList: true, subtree: true });
  installPetEntry();
  installSidebarBalance();
  installSettingsPlugin();
  window.__dshDesktopPetBridgeInstalled = true;
})();
