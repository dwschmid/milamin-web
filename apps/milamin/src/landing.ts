import './site';
import hljs from 'highlight.js/lib/core';
import matlab from 'highlight.js/lib/languages/matlab';

// MATLAB syntax coloring for the code fragments on the recovered
// milamin.org pages (token colors in styles.css).
hljs.registerLanguage('matlab', matlab);
for (const pre of document.querySelectorAll<HTMLPreElement>('.archive pre')) {
  pre.innerHTML = hljs.highlight(pre.textContent ?? '', { language: 'matlab' }).value;
}

// Click a slider image to view it full size.
const openLightbox = (src: string, caption: string) => {
  const box = document.createElement('div');
  box.className = 'lightbox';
  const img = document.createElement('img');
  img.src = src;
  img.alt = caption;
  img.onload = () => {
    const s = Math.min(2, (window.innerWidth * 0.92) / img.naturalWidth,
      (window.innerHeight * 0.82) / img.naturalHeight);
    img.style.width = `${img.naturalWidth * s}px`;
  };
  const cap = document.createElement('p');
  cap.textContent = caption;
  box.append(img, cap);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };
  const close = () => {
    box.remove();
    document.removeEventListener('keydown', onKey);
  };
  box.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  document.body.appendChild(box);
};

// Static figures open in the lightbox too; the caption is the paragraph
// that follows the image.
for (const img of document.querySelectorAll<HTMLImageElement>('img.arch-fig')) {
  img.addEventListener('click', () => {
    const next = img.nextElementSibling;
    const caption = next instanceof HTMLParagraphElement ? next.textContent ?? '' : '';
    openLightbox(img.src, caption);
  });
}

// Figure sliders (the original site used the vslider WordPress plugin).
for (const slider of document.querySelectorAll<HTMLElement>('.arch-slider')) {
  const slides = Array.from(slider.querySelectorAll('figure'));
  if (slides.length < 2) continue;

  const dots = document.createElement('div');
  dots.className = 'slider-dots';
  const dotBtns = slides.map((_, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('aria-label', `Slide ${i + 1} of ${slides.length}`);
    dots.appendChild(b);
    return b;
  });

  let idx = Math.max(0, slides.findIndex((s) => s.classList.contains('active')));
  const show = (i: number) => {
    idx = (i + slides.length) % slides.length;
    slides.forEach((s, j) => s.classList.toggle('active', j === idx));
    dotBtns.forEach((d, j) => d.classList.toggle('active', j === idx));
  };

  let timer = window.setInterval(() => show(idx + 1), 5000);
  const goto = (i: number) => {
    window.clearInterval(timer);
    timer = window.setInterval(() => show(idx + 1), 5000);
    show(i);
  };

  dotBtns.forEach((d, i) => d.addEventListener('click', () => goto(i)));
  for (const [cls, label, step] of [
    ['slider-btn slider-prev', 'Previous slide', -1],
    ['slider-btn slider-next', 'Next slide', 1],
  ] as const) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.setAttribute('aria-label', label);
    b.textContent = step < 0 ? '‹' : '›';
    b.addEventListener('click', () => goto(idx + step));
    slider.appendChild(b);
  }
  slider.appendChild(dots);
  slider.addEventListener('mouseenter', () => window.clearInterval(timer));
  slider.addEventListener('mouseleave', () => {
    window.clearInterval(timer);
    timer = window.setInterval(() => show(idx + 1), 5000);
  });
  for (const fig of slides) {
    const img = fig.querySelector('img');
    img?.addEventListener('click', () =>
      openLightbox(img.src, fig.querySelector('figcaption')?.textContent ?? ''));
  }
  show(idx);
}
