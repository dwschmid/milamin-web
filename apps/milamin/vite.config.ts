import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { coopCoep, distributionNotices, sharedAliases, sharedConfig } from '../../vite.shared';
import { siteChrome } from './site-chrome';

export default defineConfig({
  root: __dirname,
  ...sharedConfig,
  plugins: [coopCoep(), siteChrome(), distributionNotices()],
  resolve: { alias: sharedAliases },
  build: {
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        citations: resolve(__dirname, 'citations.html'),
        applications: resolve(__dirname, 'applications.html'),
        notes: resolve(__dirname, 'notes.html'),
        original: resolve(__dirname, 'original.html'),
        downloads: resolve(__dirname, 'downloads.html'),
        bench: resolve(__dirname, 'bench.html'),
        million: resolve(__dirname, 'million.html'),
        playground: resolve(__dirname, 'playground.html'),
        convergence: resolve(__dirname, 'convergence.html'),
        about: resolve(__dirname, 'about/index.html'),
        how: resolve(__dirname, 'about/how.html'),
        note: resolve(__dirname, 'about/note.html'),
        licenses: resolve(__dirname, 'about/licenses.html'),
      },
    },
  },
});
