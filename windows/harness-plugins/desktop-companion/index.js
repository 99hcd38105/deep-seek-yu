import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import z from '@deepseek-ai/schemastery';

export const name = 'deep-seek-yu-desktop-companion';
export const inject = ['webServer'];
export const Config = z.object({ enabled: z.boolean().default(true) });

const directory = path.dirname(fileURLToPath(import.meta.url));
const clientScript = fs.readFileSync(path.join(directory, 'client.js'));

export function apply(ctx, config) {
  if (config.enabled === false) return;
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/deep-seek-yu/desktop-companion.js',
    handler(req, res) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405);
        res.end();
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      res.end(req.method === 'HEAD' ? undefined : clientScript);
    },
  }), 'deep-seek-yu desktop companion client');
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'script-src', placement: 'body', src: '/deep-seek-yu/desktop-companion.js' });
  });
}
