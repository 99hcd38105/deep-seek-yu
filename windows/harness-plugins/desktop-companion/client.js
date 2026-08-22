(() => {
  if (window.__dshDesktopPetBridgeInstalled) return;
  const actions = [];
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
    button.title = '显示桌宠（Harness 插件）';
    button.setAttribute('aria-label', button.title);
    button.style.cssText = 'width:30px;height:30px;margin-left:4px;border:0;border-radius:9px;background:transparent;color:#64748b;font-size:18px;cursor:pointer;';
    button.addEventListener('click', () => actions.push({ type: 'show-pet' }));
    addButton.insertAdjacentElement('afterend', button);
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
  new MutationObserver(installPetEntry).observe(document.documentElement, { childList: true, subtree: true });
  installPetEntry();
  window.__dshDesktopPetBridgeInstalled = true;
})();
