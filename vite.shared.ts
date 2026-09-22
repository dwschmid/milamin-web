// Shared Vite building blocks for both apps: the package
// aliases (matching tsconfig paths) and the cross-origin-isolation headers
// the threaded sparse solver needs. Each app's vite.config.ts imports these
// by relative path.
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import type { Plugin } from 'vite';
import type { ServerResponse, IncomingMessage } from 'node:http';

const repoRoot = resolve(new URL('.', import.meta.url).pathname);

export const sharedAliases = {
  '@fem': resolve(repoRoot, 'packages/fem-core/src'),
  '@viz': resolve(repoRoot, 'packages/viz/src'),
  '@ana': resolve(repoRoot, 'packages/analytic/src'),
};

/** Keep notices with the actual browser distribution, including standalone Folder builds. */
export function distributionNotices(): Plugin {
  const notices = [
    ['Project (GPL-2.0)', 'LICENSE'],
    ['Fonts (OFL-1.1)', 'apps/milamin/src/fonts/OFL.txt'],
    ['Triangle mesher: separate terms', 'packages/fem-core/wasm-src/triangle/README'],
    ['FOLDER analytical growth rates', 'apps/folder/src/LICENSE-folder-growth-rates.txt'],
    ['KaTeX', 'node_modules/katex/LICENSE'],
    ['highlight.js', 'node_modules/highlight.js/LICENSE'],
  ];
  return {
    name: 'distribution-notices',
    generateBundle() {
      const source = notices.map(([title, path]) =>
        `${title}\n${'='.repeat(title.length)}\n\n${readFileSync(resolve(repoRoot, path), 'utf8')}\n`,
      ).join('\n');
      this.emitFile({ type: 'asset', fileName: 'THIRD-PARTY-NOTICES.txt', source });
    },
  };
}

/**
 * COOP/COEP so pages get SharedArrayBuffer for the threaded sparse-solver
 * build (spchol-mt). The milamin applications page opts out: its Vimeo
 * embeds are cross-origin iframes that COEP would block. Production serves
 * the same headers from apps/milamin/public/_headers; this plugin mirrors
 * them for `vite dev` and `vite preview`.
 */
export function coopCoep(): Plugin {
  const setHeaders = (req: IncomingMessage, res: ServerResponse) => {
    if (!(req.url || '').includes('applications')) {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    }
  };
  return {
    name: 'coop-coep',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        setHeaders(req, res);
        next();
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        setHeaders(req, res);
        next();
      });
    },
  };
}

/** Options every app config shares. */
export const sharedConfig = {
  base: './' as const,
  // the emscripten pthread module (spchol-mt.js) uses top-level await, which
  // the default iife worker bundle cannot represent
  worker: { format: 'es' as const },
  server: {
    // /mnt/d is a Windows-mounted drive; inotify events don't propagate
    // reliably under WSL2, so poll or the dev server serves stale modules
    watch: { usePolling: true, interval: 300 },
  },
};
