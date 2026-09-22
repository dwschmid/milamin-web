// Every page entry imports this first: the shared viz stylesheet, then the
// MilAMin site chrome layered over it. The header and footer markup itself is
// injected at build time by site-chrome.ts (vite plugin), so pages are complete
// without JavaScript; this module only closes the mobile menu after a tap on a
// link, which pure CSS cannot do.
import '@viz/styles.css';
import './site.css';

const toggle = document.getElementById('nav-toggle') as HTMLInputElement | null;
if (toggle) {
  for (const a of document.querySelectorAll<HTMLAnchorElement>('.nav-links a')) {
    a.addEventListener('click', () => {
      toggle.checked = false;
    });
  }
}
