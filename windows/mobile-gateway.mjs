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
const defaultApkPath = path.resolve(scriptDirectory, '..', 'deepseek-harness-apps', 'release', 'DeepSeek-Harness-Android.apk');
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

function deny(response, status, message) {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(`<!doctype html><meta name="viewport" content="width=device-width"><title>DeepSeek Harness</title><style>body{font:16px system-ui;margin:3rem auto;max-width:34rem;padding:0 1rem;color:#202124}code{background:#f3f4f6;padding:.2rem .4rem;border-radius:.35rem}</style><h1>无法访问</h1><p>${message}</p>`);
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

const mobileCompatibilityScript = `<script id="dsh-mobile-compat">(()=>{const c=globalThis.crypto||(globalThis.crypto={});if(typeof c.randomUUID!=="function"){Object.defineProperty(c,"randomUUID",{configurable:true,value:()=>{const b=new Uint8Array(16);if(typeof c.getRandomValues==="function")c.getRandomValues(b);else for(let i=0;i<b.length;i++)b[i]=Math.floor(Math.random()*256);b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;const h=Array.from(b,x=>x.toString(16).padStart(2,"0"));return h.slice(0,4).join("")+"-"+h.slice(4,6).join("")+"-"+h.slice(6,8).join("")+"-"+h.slice(8,10).join("")+"-"+h.slice(10).join("")}})}globalThis.__dshMobileCompat=true})();</script>`;

const mobileStyle = `<style id="dsh-mobile-style">
@media (max-width:720px){
  *,*::before,*::after{box-sizing:border-box}
  html,body,#root{width:100%;max-width:100%;height:100%;overflow:hidden}
  body{font-family:Inter,"Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif;-webkit-tap-highlight-color:transparent}
  button,input,textarea,select{font:inherit}

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
      ? original.replace(/<head(\s[^>]*)?>/i, (match) => `${match}${mobileCompatibilityScript}${mobileStyle}`)
      : `${mobileCompatibilityScript}${mobileStyle}${original}`;
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
      'content-disposition': 'attachment; filename="DeepSeek-Harness-Android.apk"',
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
  console.log(`DeepSeek Harness mobile gateway: http://0.0.0.0:${listenPort}`);
});
