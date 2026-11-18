# Extract candidate documents from a local copy of DACTYL's validation split (a parquet file) for bench/review/build.js.
# Needs pyarrow (for example: python3 -m venv venv && venv/bin/pip install pyarrow). Run:
#   venv/bin/python bench/review/extract-dactyl.py bench/data/review/raw/dactyl-validation.parquet bench/data/review/raw/dactyl-validation-150-700.json
# Keeps three domains (student_essays, abstracts, news), drops the continued-pre-training adversarial generators ("apollo"),
# keeps 150-700 words. The split is DACTYL's own validation split, which no Lectern model was trained or tested on.
import json
import re
import sys

import pyarrow.parquet as pq

src, dst = sys.argv[1], sys.argv[2]
words = lambda s: len(re.findall(r"[^\W_]+(?:['’\-][^\W_]+)*", s))
out = []
for r in pq.read_table(src, columns=['id', 'text', 'domain', 'model', 'category_info', 'target']).to_pylist():
    if r['domain'] not in ('student_essays', 'abstracts', 'news') or 'apollo' in r['model']:
        continue
    n = words(r['text'])
    if 150 <= n <= 700:
        out.append({'id': r['id'], 'text': r['text'], 'domain': r['domain'], 'model': r['model'], 'target': r['target'], 'category_info': r['category_info'], 'words': n})
json.dump(out, open(dst, 'w'))
print(len(out), 'documents written')
