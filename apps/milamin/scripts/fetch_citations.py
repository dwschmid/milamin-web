#!/usr/bin/env python3
"""Refresh public/data/citations.json: all works citing the MILAMIN paper
(Dabrowski, Krotkiewski & Schmid 2008, doi:10.1029/2007GC001719), fetched
from the OpenAlex API and cleaned. Run: npm run citations

Cleaning, because OpenAlex counts things a reader would not:
- review comments and replies on Copernicus journals (type peer-review or
  paratext, titles like "Reply on RC1") are dropped;
- book chapters are collapsed into one entry per book (the textbook whose
  every chapter cites the paper counted as 26 works); the book's own record
  is kept when its DOI is the prefix of the chapters' DOIs, else the first
  chapter stands in for the book; the entry notes how many chapters;
- preprint/published duplicates (same title) keep the published version.
"""
import json
import os
import re
import time
import urllib.request
from collections import defaultdict

MILAMIN = 'W1508381481'  # OpenAlex ID of the 2008 G-cubed paper
OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'data', 'citations.json')

raw, cursor = [], '*'
while cursor:
    url = (
        'https://api.openalex.org/works?filter=cites:' + MILAMIN +
        '&per-page=200&cursor=' + cursor +
        '&select=title,publication_year,doi,authorships,primary_location,type'
    )
    with urllib.request.urlopen(url) as r:
        d = json.load(r)
    for w in d['results']:
        loc = w.get('primary_location') or {}
        raw.append({
            'title': w.get('title'),
            'year': w.get('publication_year'),
            'doi': (w.get('doi') or '').replace('https://doi.org/', '') or None,
            'authors': [a['author']['display_name'] for a in w.get('authorships', [])],
            'venue': (loc.get('source') or {}).get('display_name'),
            'type': w.get('type'),
        })
    cursor = d['meta'].get('next_cursor')
    if not d['results']:
        break
    time.sleep(0.3)
print(f'{len(raw)} citing records from OpenAlex')
if os.environ.get('CITATIONS_RAW'):
    json.dump(raw, open(os.environ['CITATIONS_RAW'], 'w'), indent=1, ensure_ascii=False)

# 1. book chapters, front matter, indexes -> one entry per book: anything whose
#    DOI is the book's DOI plus a suffix belongs to the book (OpenAlex records
#    every chapter of a textbook that cites the paper as a citing work)
books = [w for w in raw if w['type'] == 'book' and w['doi']]
works = []
collapsed = 0
for w in raw:
    parent = next((b for b in books if w is not b and w['doi'] and w['doi'].startswith(b['doi'] + '.')), None)
    if parent is not None:
        parent['chapters'] = parent.get('chapters', 0) + 1
        collapsed += 1
        continue
    works.append(w)
print(f'  collapsed {collapsed} book chapters into {sum(1 for b in books if b.get("chapters"))} books')

# 2. review comments (Copernicus interactive discussion) and leftover paratext;
#    published comments in journals are articles and stay
NOISE_TYPES = ('peer-review', 'paratext', 'other')
dropped = [w for w in works if w['type'] in NOISE_TYPES]
works = [w for w in works if w['type'] not in NOISE_TYPES]
print(f'  dropped {len(dropped)} review comments / paratext: ' + '; '.join((w['title'] or '?')[:40] for w in dropped))

# 3. preprint / published duplicates: same title within two years, keep the
#    published one (the two editions of a book, ten years apart, are both kept)
def norm(s):
    return re.sub(r'\W+', ' ', (s or '').lower()).strip()

PREPRINT = re.compile(r'(egusphere|essoar|arxiv|10\.31223|10\.5194/[a-z]+d?-20\d\d-\d+$|10\.5194/[a-z]+d-)', re.I)
def is_preprint(w):
    return w['type'] == 'preprint' or bool(PREPRINT.search(w['doi'] or ''))
works.sort(key=lambda w: (is_preprint(w), w['venue'] is None, -(w['year'] or 0)))
kept = []
dupes = 0
for w in works:
    twin = next((k for k in kept if norm(k['title']) == norm(w['title']) and norm(w['title']) and abs((k['year'] or 0) - (w['year'] or 0)) <= 2), None)
    if twin is None:
        kept.append(w)
    else:
        dupes += 1
print(f'  merged {dupes} preprint/published duplicates')
works = kept

for w in works:
    w.pop('type', None)
works.sort(key=lambda w: (-(w['year'] or 0), (w['authors'][0] if w['authors'] else '')))
with open(OUT, 'w') as f:
    json.dump(works, f, indent=1, ensure_ascii=False)
print(f'{len(works)} citing works written to {os.path.relpath(OUT)}')
