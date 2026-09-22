import './site';

interface Work {
  title: string | null;
  year: number | null;
  doi: string | null;
  authors: string[];
  venue: string | null;
  /** a book whose chapters cite the paper, collapsed into one entry */
  chapters?: number;
}

const $ = (id: string) => document.getElementById(id)!;

function shortAuthors(a: string[]): string {
  if (a.length === 0) return 'Unknown authors';
  if (a.length <= 3) return a.join(', ');
  return `${a[0]} et al.`;
}

function render(works: Work[], filter: string) {
  const q = filter.trim().toLowerCase();
  const hit = (w: Work) =>
    !q ||
    (w.title ?? '').toLowerCase().includes(q) ||
    (w.venue ?? '').toLowerCase().includes(q) ||
    w.authors.some((a) => a.toLowerCase().includes(q));
  const shown = works.filter(hit);

  $('filter-count').textContent = q ? `${shown.length} of ${works.length}` : '';

  const byYear = new Map<number, Work[]>();
  for (const w of shown) {
    const y = w.year ?? 0;
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y)!.push(w);
  }
  const years = [...byYear.keys()].sort((a, b) => b - a);

  const frag = document.createDocumentFragment();
  for (const y of years) {
    const h = document.createElement('h2');
    h.className = 'cite-year';
    h.textContent = y ? String(y) : 'Undated';
    frag.appendChild(h);
    const ul = document.createElement('ul');
    ul.className = 'cite-list';
    for (const w of byYear.get(y)!) {
      const li = document.createElement('li');
      const authors = document.createElement('span');
      authors.className = 'cite-authors';
      authors.textContent = shortAuthors(w.authors) + '. ';
      li.appendChild(authors);
      if (w.doi) {
        const a = document.createElement('a');
        a.href = `https://doi.org/${w.doi}`;
        a.textContent = w.title ?? w.doi;
        li.appendChild(a);
      } else {
        li.appendChild(document.createTextNode(w.title ?? 'Untitled'));
      }
      if (w.venue || w.chapters) {
        const v = document.createElement('span');
        v.className = 'cite-venue';
        const book = w.chapters ? `book, ${w.chapters} chapters cite the paper` : '';
        v.textContent = ` — ${[w.venue, book].filter(Boolean).join(', ')}`;
        li.appendChild(v);
      }
      ul.appendChild(li);
    }
    frag.appendChild(ul);
  }
  const list = $('list');
  list.replaceChildren(frag);
}

function drawChart(works: Work[]) {
  const counts = new Map<number, number>();
  for (const w of works) if (w.year) counts.set(w.year, (counts.get(w.year) ?? 0) + 1);
  const years = [...counts.keys()].sort((a, b) => a - b);
  if (!years.length) return;
  const max = Math.max(...counts.values());
  const chart = $('chart');
  for (let y = years[0]; y <= years[years.length - 1]; y++) {
    const n = counts.get(y) ?? 0;
    const col = document.createElement('div');
    col.className = 'cite-bar';
    col.title = `${y}: ${n}`;
    const bar = document.createElement('div');
    bar.className = 'cite-bar-fill';
    bar.style.height = `${Math.round((n / max) * 100)}%`;
    col.appendChild(bar);
    const lab = document.createElement('span');
    lab.textContent = y % 5 === 0 ? String(y) : '';
    col.appendChild(lab);
    chart.appendChild(col);
  }
}

fetch('./data/citations.json')
  .then((r) => r.json())
  .then((works: Work[]) => {
    const years = works.map((w) => w.year).filter((y): y is number => y != null);
    $('stats').textContent =
      `${works.length} works from ${Math.min(...years)} to ${Math.max(...years)}`;
    drawChart(works);
    render(works, '');
    const input = $('filter') as HTMLInputElement;
    input.addEventListener('input', () => render(works, input.value));
  })
  .catch(() => {
    $('stats').textContent = 'could not load citation data';
  });
