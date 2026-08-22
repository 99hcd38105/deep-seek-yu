import http from 'node:http';
import net from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

const token = args.get('--token');
const allowedPrefix = args.get('--allowed-prefix');
const listenPort = Number(args.get('--port'));
const upstreamPort = Number(args.get('--upstream-port'));
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultApkPath = path.resolve(scriptDirectory, '..', 'deep-seek-yu', 'release', 'deep-seek-yu-Android.apk');
const apkPath = args.get('--apk') || defaultApkPath;
const upstreamHost = '127.0.0.1';

if (!token || token.length < 24) {
  throw new Error('A strong --token value is required.');
}

if (!allowedPrefix) {
  throw new Error('--allowed-prefix is required.');
}

if (!Number.isInteger(listenPort) || listenPort < 1024 || listenPort > 65535) {
  throw new Error('A valid --port value is required.');
}

if (!Number.isInteger(upstreamPort) || upstreamPort < 1024 || upstreamPort > 65535) {
  throw new Error('A valid --upstream-port value is required.');
}

function normalizeAddress(address = '') {
  return address.startsWith('::ffff:') ? address.slice(7) : address;
}

function isAllowedAddress(address) {
  const normalized = normalizeAddress(address);
  return normalized === '127.0.0.1' || normalized === '::1' || normalized.startsWith(allowedPrefix);
}

function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.from(left || '');
  const rightBuffer = Buffer.from(right || '');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) {
      return decodeURIComponent(part.slice(separator + 1).trim());
    }
  }
  return '';
}

function authenticate(request) {
  const requestUrl = new URL(request.url || '/', 'http://gateway.local');
  const queryToken = requestUrl.searchParams.get('token') || '';
  const cookieToken = readCookie(request.headers.cookie, 'dsh_mobile_access');
  return {
    queryAccepted: constantTimeEqual(queryToken, token),
    cookieAccepted: constantTimeEqual(cookieToken, token),
  };
}

const pendingControlRequests = new Map();
let controlSequence = 0;

process.on('message', (message) => {
  if (message?.type !== 'mobile-control-result' || typeof message.id !== 'string') return;
  const pending = pendingControlRequests.get(message.id);
  if (!pending) return;
  pendingControlRequests.delete(message.id);
  clearTimeout(pending.timer);
  if (message.error) pending.reject(new Error(String(message.error)));
  else pending.resolve(message.result);
});

function requestDesktopControl(action) {
  return new Promise((resolve, reject) => {
    if (typeof process.send !== 'function') {
      reject(new Error('电脑客户端控制通道尚未就绪。'));
      return;
    }
    const id = `mobile-${Date.now()}-${++controlSequence}`;
    const timer = setTimeout(() => {
      pendingControlRequests.delete(id);
      reject(new Error('电脑端操作超时，请确认客户端仍在运行。'));
    }, 600000);
    pendingControlRequests.set(id, { resolve, reject, timer });
    process.send({ type: 'mobile-control', id, action });
  });
}

function readJsonBody(request, maximumBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    request.on('data', (chunk) => {
      length += chunk.length;
      if (length > maximumBytes) {
        reject(new Error('请求内容过大。'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new Error('请求格式无效。')); }
    });
    request.on('error', reject);
  });
}

function jsonResponse(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

function deny(response, status, message) {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(`<!doctype html><meta name="viewport" content="width=device-width"><title>DeepSeek yu</title><style>body{font:16px system-ui;margin:3rem auto;max-width:34rem;padding:0 1rem;color:#202124}code{background:#f3f4f6;padding:.2rem .4rem;border-radius:.35rem}</style><h1>无法访问</h1><p>${message}</p>`);
}

function forwardedHeaders(request) {
  const headers = { ...request.headers, host: `${upstreamHost}:${upstreamPort}` };
  delete headers['accept-encoding'];
  delete headers['x-forwarded-for'];
  delete headers['x-forwarded-host'];
  delete headers['x-forwarded-proto'];
  if (headers.origin) headers.origin = `http://${upstreamHost}:${upstreamPort}`;
  return headers;
}

const mobileCompatibilityScript = `<script id="dsh-mobile-compat">(()=>{globalThis.__dshMobileClient=true;const c=globalThis.crypto||(globalThis.crypto={});if(typeof c.randomUUID!=="function"){Object.defineProperty(c,"randomUUID",{configurable:true,value:()=>{const b=new Uint8Array(16);if(typeof c.getRandomValues==="function")c.getRandomValues(b);else for(let i=0;i<b.length;i++)b[i]=Math.floor(Math.random()*256);b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;const h=Array.from(b,x=>x.toString(16).padStart(2,"0"));return h.slice(0,4).join("")+"-"+h.slice(4,6).join("")+"-"+h.slice(6,8).join("")+"-"+h.slice(8,10).join("")+"-"+h.slice(10).join("")}})}globalThis.__dshMobileCompat=true})();</script>`;

const mobileShellScript = `<script id="dsh-mobile-shell">(()=>{
  let settingsWasOpen=false;
  const text=(element)=>[element?.getAttribute?.('aria-label'),element?.getAttribute?.('title'),element?.textContent].filter(Boolean).join(' ').trim();
  const buttons=()=>[...document.querySelectorAll('button,[role="button"]')];
  const findButton=(pattern,scope=document)=>[...scope.querySelectorAll('button,[role="button"]')].find((item)=>pattern.test(text(item)));
  const closeSidebar=()=>{document.body?.classList.remove('dsy-mobile-sidebar-open');document.querySelector('#dsy-mobile-scrim')?.setAttribute('hidden','');};
  const openSidebar=()=>{document.body?.classList.add('dsy-mobile-sidebar-open');document.querySelector('#dsy-mobile-scrim')?.removeAttribute('hidden');};
  const clickSettings=()=>{closeSidebar();document.body?.classList.add('dsy-mobile-settings-open');const button=document.querySelector('.hHd-Xa_settingsArea button')||findButton(/^(设置|settings)$/i);button?.click();};
  const openPlugin=()=>{clickSettings();let attempts=0;const timer=setInterval(()=>{attempts+=1;const own=document.getElementById('deep-seek-yu-settings-nav')||findButton(/^DeepSeek yu$/i,document.querySelector('.VOzbGW_panel')||document);if(own){clearInterval(timer);own.click();}else if(attempts>=50)clearInterval(timer);},100);};
  const install=()=>{
    if(!document.body||document.querySelector('#dsy-mobile-nav'))return;
    const nav=document.createElement('nav');nav.id='dsy-mobile-nav';nav.setAttribute('aria-label','手机导航');
    nav.innerHTML='<button data-mobile-nav="sessions"><span>☰</span><small>会话</small></button><button data-mobile-nav="new"><span>＋</span><small>新建</small></button><button class="active" data-mobile-nav="chat"><span>●</span><small>聊天</small></button><button data-mobile-nav="plugin"><span>◇</span><small>插件</small></button><button data-mobile-nav="settings"><span>⚙</span><small>设置</small></button>';
    const scrim=document.createElement('button');scrim.id='dsy-mobile-scrim';scrim.type='button';scrim.setAttribute('aria-label','关闭会话列表');scrim.hidden=true;
    document.body.append(scrim,nav);scrim.addEventListener('click',closeSidebar);
    nav.addEventListener('click',(event)=>{const item=event.target.closest('[data-mobile-nav]');if(!item)return;nav.querySelectorAll('button').forEach((button)=>button.classList.toggle('active',button===item));const action=item.dataset.mobileNav;if(action==='sessions')openSidebar();if(action==='chat')closeSidebar();if(action==='new'){closeSidebar();(document.querySelector('.hHd-Xa_newSession')||findButton(/新会话|new session/i))?.click();}if(action==='settings')clickSettings();if(action==='plugin')openPlugin();});
    document.addEventListener('click',(event)=>{if(document.body.classList.contains('dsy-mobile-sidebar-open')&&event.target.closest('.pI_x6G_sidebarCol [role="treeitem"]'))closeSidebar();},true);
    let startX=0,startY=0;document.addEventListener('touchstart',(event)=>{const point=event.touches[0];startX=point?.clientX||0;startY=point?.clientY||0;},{passive:true});document.addEventListener('touchend',(event)=>{const point=event.changedTouches[0];if(!point)return;const dx=point.clientX-startX,dy=Math.abs(point.clientY-startY);if(dy<70&&dx>80&&startX<28)openSidebar();if(dy<70&&dx<-80&&document.body.classList.contains('dsy-mobile-sidebar-open'))closeSidebar();},{passive:true});
    const viewport=globalThis.visualViewport;const keyboard=()=>document.body.classList.toggle('dsy-mobile-keyboard',Boolean(viewport&&viewport.height<innerHeight*.72));viewport?.addEventListener('resize',keyboard);keyboard();
  };
  globalThis.__dshMobileShellClose=closeSidebar;
  const synchronize=()=>{install();const panel=document.querySelector('.VOzbGW_panel');const sidebar=document.querySelector('.pI_x6G_sidebarCol');if(panel){settingsWasOpen=true;document.body?.classList.add('dsy-mobile-settings-open');sidebar?.style.setProperty('transition','none','important');sidebar?.style.setProperty('transform','none','important');sidebar?.style.setProperty('width','100vw','important');sidebar?.style.setProperty('overflow','visible','important');}else if(settingsWasOpen){settingsWasOpen=false;document.body?.classList.remove('dsy-mobile-settings-open');sidebar?.style.removeProperty('transition');sidebar?.style.removeProperty('transform');sidebar?.style.removeProperty('width');sidebar?.style.removeProperty('overflow');}};
  addEventListener('DOMContentLoaded',synchronize,{once:true});new MutationObserver(synchronize).observe(document.documentElement,{childList:true,subtree:true});synchronize();
})();</script>`;

const mobileStyle = `<style id="dsh-mobile-style">
@media (max-width:720px){
  *,*::before,*::after{box-sizing:border-box}
  html,body,#root{width:100%;max-width:100%;height:100%;overflow:hidden}
  body{font-family:Inter,"Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif;-webkit-tap-highlight-color:transparent;overscroll-behavior:none}
  button,input,textarea,select{font:inherit}textarea,input{font-size:16px!important}

  /* Mobile shell: a full-width chat area, an off-canvas session drawer and bottom navigation. */
  .pI_x6G_frame{grid-template-columns:0 minmax(0,1fr) 0!important;padding-bottom:64px!important;transition:none!important}
  .pI_x6G_centerCol{width:100vw!important;min-width:0!important}
  .pI_x6G_sidebarCol{position:fixed!important;z-index:72!important;left:0!important;top:0!important;bottom:64px!important;width:min(88vw,360px)!important;transform:translateX(-105%)!important;transition:transform .22s ease!important;box-shadow:0 18px 50px rgba(15,23,42,.22)!important;border-right:0!important;overflow:hidden!important}
  body.dsy-mobile-sidebar-open .pI_x6G_sidebarCol{transform:translateX(0)!important}
  body.dsy-mobile-settings-open .pI_x6G_sidebarCol{transform:none!important;transition:none!important;width:100vw!important;bottom:0!important;overflow:visible!important}
  body:has(.VOzbGW_panel) .pI_x6G_sidebarCol,.pI_x6G_sidebarCol:has(.VOzbGW_panel){transform:none!important;transition:none!important;width:100vw!important;bottom:0!important;overflow:visible!important}
  body.dsy-mobile-settings-open #dsy-mobile-nav,body.dsy-mobile-settings-open #dsy-mobile-scrim{display:none!important}
  body:has(.VOzbGW_panel) #dsy-mobile-nav,body:has(.VOzbGW_panel) #dsy-mobile-scrim{display:none!important}
  body.dsy-mobile-settings-open .VOzbGW_overlay{position:fixed!important;inset:0!important;width:100vw!important;height:100dvh!important;max-width:none!important;margin:0!important;transform:none!important}
  .pI_x6G_handle{display:none!important}
  .pI_x6G_frame:not([data-details-collapsed]) .pI_x6G_detailsCol{position:fixed!important;z-index:76!important;inset:0 0 64px 0!important;width:100vw!important;display:block!important;background:var(--dsw-alias-bg-base,#fff)!important;overflow:auto!important}
  #dsy-mobile-scrim{position:fixed;z-index:70;inset:0 0 64px 0;border:0;background:rgba(15,23,42,.35);backdrop-filter:blur(2px)}
  #dsy-mobile-scrim[hidden]{display:none}
  #dsy-mobile-nav{position:fixed;z-index:80;left:0;right:0;bottom:0;height:64px;padding:4px max(8px,env(safe-area-inset-right)) max(4px,env(safe-area-inset-bottom)) max(8px,env(safe-area-inset-left));display:grid;grid-template-columns:repeat(5,1fr);align-items:center;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#fff) 94%,transparent);border-top:1px solid var(--dsw-alias-border-l1,#e5e7eb);box-shadow:0 -8px 28px rgba(15,23,42,.06)}
  #dsy-mobile-nav button{height:52px;min-width:0;border:0;border-radius:13px;color:var(--dsw-alias-label-tertiary,#64748b);background:transparent;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;padding:2px}
  #dsy-mobile-nav button span{font-size:19px;line-height:22px}#dsy-mobile-nav button small{font-size:10px;line-height:14px;white-space:nowrap}
  #dsy-mobile-nav button.active{color:var(--dsw-alias-state-business-primary,#2563eb);background:var(--dsw-alias-interactive-bg-hover,#eff6ff)}
  body.dsy-mobile-keyboard #dsy-mobile-nav{display:none}body.dsy-mobile-keyboard .pI_x6G_frame{padding-bottom:0!important}body.dsy-mobile-keyboard .pI_x6G_sidebarCol{bottom:0!important}

  .hHd-Xa_root{padding:8px 12px 10px!important}.hHd-Xa_root.hHd-Xa_collapsed{padding:8px 12px 10px!important}
  .hHd-Xa_logoRow{height:52px!important;margin-bottom:4px!important}.hHd-Xa_newSession{height:44px!important;border-radius:14px!important;margin-bottom:8px!important}
  .qDHVXG_list{padding-bottom:28px!important}.qDHVXG_sectionHeader{height:42px!important}.qDHVXG_iconButton,.qDHVXG_searchButton{width:40px!important;height:40px!important}

  [data-slot="conversation.composer.bar"]{margin:0 10px 8px!important;border-radius:18px!important;max-width:calc(100vw - 20px)!important}
  [data-chat-flow-kind]{max-width:100%!important;padding-inline:12px!important}

  /* Keep the conversation controls compact and usable on narrow screens. */
  .hHd-Xa_iconButton,.hHd-Xa_newSession,.qDHVXG_iconButton,.qDHVXG_searchButton,.VOzbGW_trigger{min-width:40px!important;min-height:40px!important}
  .uV2eYG_row,.uV2eYG_tools,.uV2eYG_trailing{display:flex!important;align-items:center!important;min-width:0!important;gap:4px!important}
  .uV2eYG_tools{flex:0 0 auto!important}
  .uV2eYG_trailing{flex:1 1 auto!important;justify-content:flex-end!important}
  .uV2eYG_modes{width:40px!important;min-width:40px!important;overflow:hidden!important}
  ._7KE1Ra_root{min-width:0!important;max-width:calc(100vw - 220px)!important}
  ._7KE1Ra_trigger{max-width:100%!important;min-width:0!important;overflow:hidden!important;white-space:nowrap!important;text-overflow:ellipsis!important}
  .Sh0Q9G_trigger{max-width:40px!important;min-width:40px!important;padding-inline:8px!important;overflow:hidden!important}
  .Sh0Q9G_triggerLabel,.Sh0Q9G_chevron{display:none!important}
  .uV2eYG_add,.uV2eYG_primary{min-width:40px!important;min-height:40px!important}
  .ydkMvW_close{position:fixed!important;top:max(8px,env(safe-area-inset-top))!important;right:8px!important;left:auto!important;z-index:30!important}

  /* A simple full-screen settings sheet with horizontal category tabs. */
  .VOzbGW_panel{position:fixed!important;inset:0!important;width:100vw!important;height:100dvh!important;max-width:none!important;max-height:none!important;margin:0!important;border-radius:0!important;display:flex!important;flex-direction:column!important;overflow:hidden!important}
  .VOzbGW_nav{flex:0 0 auto!important;width:100%!important;height:auto!important;min-width:0!important;min-height:0!important;padding:0 12px 8px!important;border-right:0!important;border-bottom:1px solid rgba(127,127,127,.18)!important}
  .VOzbGW_navTitle{height:52px!important;padding:0 4px!important;display:flex!important;align-items:center!important;font-size:18px!important;font-weight:650!important}
  .VOzbGW_navList{display:flex!important;flex-direction:row!important;align-items:center!important;gap:4px!important;width:100%!important;height:40px!important;overflow-x:auto!important;overflow-y:hidden!important;scrollbar-width:none!important;overscroll-behavior-inline:contain!important}
  .VOzbGW_navList::-webkit-scrollbar{display:none!important}
  .VOzbGW_navCell{flex:0 0 auto!important;width:auto!important;min-width:auto!important;height:40px!important;padding:0 12px!important;border-radius:10px!important;white-space:nowrap!important}
  .VOzbGW_navIcon{flex:0 0 auto!important}
  .VOzbGW_content{position:relative!important;flex:1 1 auto!important;width:100%!important;min-width:0!important;min-height:0!important;display:flex!important;flex-direction:column!important;overflow:hidden!important}
  .VOzbGW_header{position:fixed!important;top:max(4px,env(safe-area-inset-top))!important;right:8px!important;z-index:5!important;width:44px!important;height:44px!important;padding:0!important;background:transparent!important;border:0!important}
  .VOzbGW_actions{display:none!important}
  .VOzbGW_close{width:44px!important;height:44px!important;border-radius:12px!important}
  .VOzbGW_options{flex:1 1 auto!important;width:100%!important;min-width:0!important;min-height:0!important;margin:0!important;padding:10px 18px max(28px,env(safe-area-inset-bottom))!important;overflow-x:hidden!important;overflow-y:auto!important;overscroll-behavior-y:contain!important}
  .VOzbGW_options>*{max-width:100%!important}
  .VOzbGW_options [class$="_row"]{width:100%!important;min-width:0!important;display:grid!important;grid-template-columns:minmax(0,1fr) auto!important;align-items:center!important;gap:10px 14px!important;padding:15px 0!important}
  .VOzbGW_options [class$="_rowText"]{min-width:0!important;max-width:none!important}
  .VOzbGW_options [class$="_title"]{line-height:1.35!important;word-break:normal!important}
  .VOzbGW_options [class$="_desc"]{max-width:100%!important;line-height:1.5!important;white-space:normal!important;word-break:normal!important;overflow-wrap:anywhere!important}
  .VOzbGW_options [class$="_selector"]{justify-self:end!important;max-width:150px!important;min-height:40px!important;margin:0!important}
  ._8HJdBW_group{width:100%!important;min-width:0!important}
  ._8HJdBW_cubeRow{display:grid!important;grid-template-columns:repeat(3,minmax(0,1fr))!important;gap:8px!important;width:100%!important}
  ._8HJdBW_themeCube{width:100%!important;min-width:0!important;height:72px!important;margin:0!important}
  html body #deep-seek-yu-plugin-panel{max-height:none!important;overflow:visible!important;padding:4px 0 36px!important}
  html body #deep-seek-yu-plugin-panel .dsy-card{padding:15px!important;border-radius:16px!important}
  html body #deep-seek-yu-plugin-panel .dsy-button,html body #deep-seek-yu-plugin-panel .dsy-select,html body #deep-seek-yu-plugin-panel .dsy-input{min-height:44px!important}
  html body #deep-seek-yu-plugin-panel .dsy-actions{width:100%!important}html body #deep-seek-yu-plugin-panel .dsy-actions>*{flex:1 1 auto!important}
  html body #deep-seek-yu-plugin-panel .dsy-range{width:min(56vw,220px)!important}
}
@media (max-width:380px){
  .VOzbGW_nav{padding-inline:10px!important}
  .VOzbGW_navCell{padding-inline:10px!important}
  .VOzbGW_options{padding-inline:14px!important}
  .VOzbGW_options [class$="_row"]{grid-template-columns:minmax(0,1fr)!important}
  .VOzbGW_options [class$="_selector"]{justify-self:start!important;max-width:100%!important}
}
</style>`;

function forwardUpstreamResponse(upstreamResponse, response) {
  const contentType = String(upstreamResponse.headers['content-type'] || '');
  if (!contentType.toLowerCase().includes('text/html')) {
    response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
    return;
  }

  const chunks = [];
  upstreamResponse.on('data', (chunk) => chunks.push(chunk));
  upstreamResponse.on('end', () => {
    const original = Buffer.concat(chunks).toString('utf8');
    const patched = /<head(?:\s[^>]*)?>/i.test(original)
      ? original.replace(/<head(\s[^>]*)?>/i, (match) => `${match}${mobileCompatibilityScript}${mobileShellScript}${mobileStyle}`)
      : `${mobileCompatibilityScript}${mobileShellScript}${mobileStyle}${original}`;
    const headers = { ...upstreamResponse.headers };
    delete headers['content-encoding'];
    delete headers.etag;
    headers['content-length'] = String(Buffer.byteLength(patched));
    headers['cache-control'] = 'no-store';
    response.writeHead(upstreamResponse.statusCode || 502, headers);
    response.end(patched);
  });
}

const server = http.createServer((request, response) => {
  if (!isAllowedAddress(request.socket.remoteAddress)) {
    deny(response, 403, '此网关只允许当前可信局域网访问。');
    return;
  }

  const auth = authenticate(request);
  const requestUrl = new URL(request.url || '/', 'http://gateway.local');
  if (requestUrl.pathname === '/download/android') {
    if (!auth.queryAccepted && !auth.cookieAccepted) {
      deny(response, 401, '请使用电脑生成的 Android 安装链接重新进入。');
      return;
    }
    if (!existsSync(apkPath)) {
      deny(response, 404, 'Android 安装包尚未生成。');
      return;
    }
    response.writeHead(200, {
      'content-type': 'application/vnd.android.package-archive',
      'content-length': String(statSync(apkPath).size),
      'content-disposition': 'attachment; filename="deep-seek-yu-Android.apk"',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    createReadStream(apkPath).pipe(response);
    return;
  }
  if (auth.queryAccepted) {
    response.writeHead(302, {
      location: '/',
      'set-cookie': `dsh_mobile_access=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    });
    response.end();
    return;
  }

  if (!auth.cookieAccepted) {
    deny(response, 401, '请使用电脑生成的手机访问链接重新进入。');
    return;
  }

  if (requestUrl.pathname === '/deep-seek-yu/mobile-control') {
    if (request.method !== 'POST') {
      jsonResponse(response, 405, { error: '只允许 POST 请求。' });
      return;
    }
    readJsonBody(request).then(async (action) => {
      try { jsonResponse(response, 200, { result: await requestDesktopControl(action) }); }
      catch (error) { jsonResponse(response, 500, { error: String(error?.message || error).slice(0, 500) }); }
    }).catch((error) => jsonResponse(response, 400, { error: error.message }));
    return;
  }

  const upstreamRequest = http.request({
    hostname: upstreamHost,
    port: upstreamPort,
    method: request.method,
    path: request.url,
    headers: forwardedHeaders(request),
  }, (upstreamResponse) => {
    forwardUpstreamResponse(upstreamResponse, response);
  });

  upstreamRequest.on('error', () => deny(response, 502, 'Harness 服务暂时不可用，请在电脑上重新启动客户端。'));
  request.pipe(upstreamRequest);
});

server.on('upgrade', (request, socket, head) => {
  if (!isAllowedAddress(request.socket.remoteAddress) || !authenticate(request).cookieAccepted) {
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    return;
  }

  const upstream = net.createConnection({ host: upstreamHost, port: upstreamPort }, () => {
    const lines = [`${request.method} ${request.url} HTTP/${request.httpVersion}`];
    const headers = forwardedHeaders(request);
    for (const [name, value] of Object.entries(headers)) {
      if (Array.isArray(value)) {
        for (const item of value) lines.push(`${name}: ${item}`);
      } else if (value !== undefined) {
        lines.push(`${name}: ${value}`);
      }
    }
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });

  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

server.listen(listenPort, '0.0.0.0', () => {
  console.log(`DeepSeek yu mobile gateway: http://0.0.0.0:${listenPort}`);
});
