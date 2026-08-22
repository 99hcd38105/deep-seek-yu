import { _electron as electron } from 'playwright';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const testUserData = await mkdtemp(path.join(os.tmpdir(), 'dsy-mobile-ui-'));
await mkdir(path.join(testUserData, 'dsh-home'), { recursive: true });
await writeFile(path.join(testUserData, 'dsh-home', '.credentials.yaml'),
  'version: 1\nrefs:\n  DEEPSEEK_API_KEY: "test-key-not-used"\n');
const launchOptions = { env: { ...process.env, DSH_TEST_USER_DATA: testUserData } };
const application = process.env.DSH_TEST_EXECUTABLE
  ? await electron.launch({ ...launchOptions, executablePath: process.env.DSH_TEST_EXECUTABLE })
  : await electron.launch({ ...launchOptions, args: ['.'] });

try {
  await application.firstWindow({ timeout: 120000 });
  const main = await (async () => {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const window = application.windows().find((item) => item.url().startsWith('http://127.0.0.1:'));
      if (window) return window;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('Harness main window did not appear.');
  })();
  await main.waitForFunction(() => window.__dshDesktopPetBridgeInstalled === true, null, { timeout: 60000 });
  await application.evaluate(({ dialog, clipboard, Menu }) => {
    dialog.showMessageBox = async () => ({ response: 0 });
    clipboard.clear();
    const mobile = Menu.getApplicationMenu().items.find((item) => item.label === '手机连接');
    const open = mobile?.submenu?.items.find((item) => item.label === '开启手机连接');
    if (!open) throw new Error('手机连接菜单不可用。');
    open.click();
  });
  const mobileUrl = await (async () => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const value = await application.evaluate(({ clipboard }) => clipboard.readText());
      if (/^http:\/\/[^/]+:\d+\/\?token=/.test(value)) return value;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error('手机连接地址未生成。');
  })();
  await application.evaluate(({ BrowserWindow }, url) => {
    globalThis.__deepSeekYuMobileTestWindow = new BrowserWindow({
      width: 390, height: 844, show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    globalThis.__deepSeekYuMobileTestWindow.loadURL(url);
  }, mobileUrl);
  const mobile = await (async () => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const window = application.windows().find((item) => item !== main && item.url().startsWith('http://'));
      if (window) return window;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error('手机测试窗口未出现。');
  })();
  await mobile.locator('#dsy-mobile-nav').waitFor({ timeout: 60000 });
  const onboarding = mobile.getByRole('button', { name: '继续', exact: true });
  if (await onboarding.waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false)) {
    await onboarding.click();
    await onboarding.waitFor({ state: 'hidden', timeout: 15000 });
  }
  if (await mobile.locator('#dsy-mobile-nav button').count() !== 5) throw new Error('手机底部导航不完整。');
  const geometry = await mobile.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  if (geometry.scrollWidth > geometry.width + 2) throw new Error(`手机页面横向溢出：${JSON.stringify(geometry)}`);
  await mobile.locator('[data-mobile-nav="plugin"]').click();
  const panel = mobile.locator('#deep-seek-yu-plugin-panel');
  await panel.waitFor({ timeout: 30000 });
  await panel.locator('[data-pet-state]').filter({ hasNotText: '正在读取' }).waitFor({ timeout: 30000 });
  await panel.locator('[data-runtime-state]').filter({ hasText: '0.1.1-rc.2' }).waitFor({ timeout: 60000 });
  const panelBox = await panel.boundingBox();
  const panelVisibility = await panel.evaluate((element) => ({
    hidden: element.hidden, display: getComputedStyle(element).display,
    visibility: getComputedStyle(element).visibility,
  }));
  const ancestors = await panel.evaluate((element) => {
    const result = [];
    for (let node = element; node && result.length < 14; node = node.parentElement) {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      result.push({ tag: node.tagName, className: node.className, x: rect.x, width: rect.width,
        display: style.display, position: style.position, transform: style.transform, inline: node.getAttribute('style') });
    }
    return result;
  });
  if (!panelBox || panelBox.x < -2 || panelBox.x + panelBox.width > geometry.width + 2
    || panelBox.y >= 844 || panelBox.height < 100 || panelVisibility.hidden || panelVisibility.display === 'none') {
    const shellState = await panel.evaluate(() => ({ bodyClass: document.body.className,
      supportsHas: CSS.supports('selector(:has(*))'), bodyHasPanel: document.body.matches(':has(.VOzbGW_panel)') }));
    throw new Error(`手机插件页没有显示在可视区域：${JSON.stringify({ panelBox, panelVisibility, shellState, ancestors })}`);
  }
  if (process.argv[2]) await mobile.screenshot({ path: path.resolve(process.argv[2]), fullPage: false });
  process.stdout.write(`mobile UI test passed: ${JSON.stringify({ ...geometry, panelBox })}\n`);
} finally {
  await application.close();
  await rm(testUserData, { recursive: true, force: true });
}
