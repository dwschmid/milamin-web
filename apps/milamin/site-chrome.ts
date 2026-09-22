// Vite plugin: the site header (brand, menu with dropdowns) and footer are one
// piece of markup, injected into every page at `<!-- site:header -->` and
// `<!-- site:footer -->` during dev and build. The menu marks the current page
// (and the section a subpage belongs to) from the page's filename, so no
// JavaScript is needed for the chrome itself. Styles: src/site.css.
import type { Plugin } from 'vite';
import { relative, dirname, sep } from 'node:path';

interface Item {
  href: string;
  label: string;
  sub?: Array<{ href: string; label: string; secondary?: boolean }>;
}

const MENU: Item[] = [
  { href: 'million.html', label: 'Million A Minute' },
  { href: 'bench.html', label: 'Benchmark' },
  {
    href: 'playground.html',
    label: 'Apps',
    sub: [
      { href: 'playground.html', label: 'Playground' },
      { href: 'folder/', label: 'Folder' },
    ],
  },
  {
    href: 'original.html',
    label: 'Original MILAMIN',
    sub: [
      { href: 'original.html', label: 'The package (2008)' },
      { href: 'applications.html', label: 'Applications gallery' },
      { href: 'notes.html', label: 'Technical notes' },
      { href: 'downloads.html', label: 'Downloads' },
      { href: 'citations.html', label: 'Citations' },
    ],
  },
  {
    href: 'about/',
    label: 'About',
    sub: [
      { href: 'about/', label: 'About MilAMin' },
      { href: 'about/how.html', label: 'How it works' },
      { href: 'about/licenses.html', label: 'Components and licenses' },
      { href: 'about/note.html', label: 'A personal note' },
    ],
  },
];

// the 1e6/1 road sign as a crisp vector mark
// (same drawing as public/favicon.svg: thin ring, numerals as large as the
// disc allows, so it still reads at 38 px)
const MARK = `<svg viewBox="0 0 64 64" aria-hidden="true">
  <circle cx="32" cy="32" r="29" fill="#fff" stroke="#c8102e" stroke-width="4"/>
  <text x="32" y="30" text-anchor="middle" font-family="Schibsted Grotesk, Arial Black, Arial, sans-serif" font-weight="700" font-size="24" fill="#111">1e6</text>
  <rect x="12" y="33.5" width="40" height="4" fill="#111"/>
  <text x="32" y="57" text-anchor="middle" font-family="Schibsted Grotesk, Arial Black, Arial, sans-serif" font-weight="700" font-size="24" fill="#111">1</text>
</svg>`;

function header(page: string, root: string): string {
  const items = MENU.map((it) => {
    const here = it.href === page || it.sub?.some((s) => s.href === page);
    if (!it.sub) {
      return `<li><a href="${root}${it.href}"${here ? ' aria-current="page"' : ''}>${it.label}</a></li>`;
    }
    const id = `sub-${it.href.replace('.html', '')}`;
    const subs = it.sub
      .map(
        (s) =>
          `<li${s.secondary ? ' class="is-secondary"' : ''}><a href="${root}${s.href}"${
            s.href === page ? ' aria-current="page"' : ''
          }>${s.label}</a></li>`,
      )
      .join('\n            ');
    return `<li class="has-sub${here ? ' is-here' : ''}">
          <input type="checkbox" id="${id}" class="sub-cb">
          <a href="${root}${it.href}">${it.label} <span class="caret" aria-hidden="true">&#9662;</span></a>
          <label class="sub-toggle" for="${id}"><span class="caret" aria-hidden="true">&#9662;</span><span class="vis-hidden">Show ${it.label} pages</span></label>
          <ul class="subnav">
            ${subs}
          </ul>
        </li>`;
  }).join('\n        ');
  return `<header class="site-header">
  <div class="wrap nav">
    <a class="brand" href="${root}index.html" aria-label="MilAMin home">
      ${MARK}
      <b>MilAMin</b><span>Million A Minute</span>
    </a>
    <label class="nav-burger" for="nav-toggle">Menu</label>
    <input type="checkbox" id="nav-toggle" aria-label="Toggle navigation">
    <ul class="nav-links">
        ${items}
    </ul>
  </div>
</header>`;
}

const footer = (root: string) => `<footer class="site-footer">
  <div class="wrap">
    <div class="footer-inner">
      <div>
        <h4>MilAMin</h4>
        <p>Fast finite element solver. The 2008 MATLAB package by Dabrowski, Krotkiewski and Schmid, and its browser revival.</p>
        <p class="fine">Everything computes in your browser. No server, no installation, no data leaves your machine.</p>
      </div>
      <div>
        <h4>Browser MilAMin</h4>
        <ul>
          <li><a href="${root}million.html">Million A Minute</a></li>
          <li><a href="${root}bench.html">Benchmark</a></li>
          <li><a href="${root}playground.html">Playground</a></li>
          <li><a href="${root}folder/">Folder</a></li>
          <li><a href="${root}about/how.html">How it works</a></li>
          <li><a href="${root}about/licenses.html">Components and licenses</a></li>
          <li><a href="https://github.com/dwschmid/milamin-web">Source code on GitHub ↗</a></li>
        </ul>
      </div>
      <div>
        <h4>Original MILAMIN</h4>
        <ul>
          <li><a href="${root}original.html">The package (2008)</a></li>
          <li><a href="${root}applications.html">Applications gallery</a></li>
          <li><a href="${root}notes.html">Technical notes</a></li>
          <li><a href="${root}downloads.html">Downloads</a></li>
          <li><a href="${root}citations.html">Citations</a></li>
          <li><a href="https://doi.org/10.1029/2007GC001719">The 2008 paper ↗</a></li>
          <li><a href="https://sourceforge.net/projects/milamin/files/">Sources on SourceForge ↗</a></li>
        </ul>
      </div>
    </div>
  </div>
</footer>`;

export interface ChromeOptions {
  /** path from the app's pages to the MilAMin root ('./' for MilAMin itself,
   *  '../' for an app that lives in a subdirectory such as folder/) */
  root?: string;
  /** menu id of the page when it is not the html filename (e.g. 'folder/') */
  page?: string;
}

export function siteChrome(opts: ChromeOptions = {}): Plugin {
  let appRoot = '';
  return {
    name: 'milamin-site-chrome',
    configResolved(config) {
      appRoot = config.root;
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        // the page's path inside the app ('about/how.html'; a directory's
        // index is the directory, 'about/'), and the way back to the app root
        const rel = relative(appRoot, ctx.filename).split(sep).join('/');
        const pageId = rel.endsWith('index.html') ? rel.slice(0, -'index.html'.length) : rel;
        const depth = dirname(rel) === '.' ? 0 : dirname(rel).split('/').length;
        const page = opts.page ?? pageId;
        const root = opts.root ?? (depth ? '../'.repeat(depth) : './');
        return {
          html: html
            .replace('<!-- site:header -->', header(page, root))
            .replace('<!-- site:footer -->', footer(root)),
          // the 1e6/1 road sign as favicon. PNGs per size rather than one SVG:
          // the fraction does not read in a browser tab, so the 16 and 32 px
          // tab icons are the ring with "1e6" alone (public/favicon-tab.svg);
          // the 180 and 192 px app icons carry the full mark (public/favicon.svg).
          tags: [
            { tag: 'link', attrs: { rel: 'icon', type: 'image/png', sizes: '16x16', href: `${root}favicon-16.png` }, injectTo: 'head' },
            { tag: 'link', attrs: { rel: 'icon', type: 'image/png', sizes: '32x32', href: `${root}favicon-32.png` }, injectTo: 'head' },
            { tag: 'link', attrs: { rel: 'icon', type: 'image/png', sizes: '192x192', href: `${root}icon-192.png` }, injectTo: 'head' },
            { tag: 'link', attrs: { rel: 'apple-touch-icon', href: `${root}apple-touch-icon.png` }, injectTo: 'head' },
          ],
        };
      },
    },
  };
}
