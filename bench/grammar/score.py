#!/usr/bin/env python3
"""Score a proofreading run on a CWEB sample with ERRANT 3.0.0.

    bench/grammar/.venv/bin/python bench/grammar/score.py --split dev --label v1

Gold edits are made from the two annotators' corrections with the same ERRANT and spaCy versions as the
hypothesis (errant_parallel), so both are tokenised the same way. Reports span-based correction precision,
recall and F0.5 (errant_compare's default), span-based detection, a 95% bootstrap interval, the false-alarm rate on
sentences neither annotator changed, and a per-type table. Writes results/<label>-<split>.json and .md.
"""
import argparse
import json
import math
import os
import random
import subprocess
from collections import Counter

from errant.commands import compare_m2 as C

HERE = os.path.dirname(os.path.abspath(__file__))
BIN = os.path.join(HERE, '.venv', 'bin')
DATA = os.path.join(HERE, 'data')


def run(cmd):
    r = subprocess.run(cmd, check=True, capture_output=True, text=True)
    return r.stdout


def parallel(orig, cors, out):
    # Written to a temporary name and renamed, so a failed run never leaves a partial file that looks finished.
    if not os.path.exists(out):
        run([os.path.join(BIN, 'errant_parallel'), '-orig', orig, '-cor', *cors, '-out', out + '.tmp'])
        os.replace(out + '.tmp', out)
    return out


def eval_args(detect=False):
    return argparse.Namespace(beta=0.5, verbose=False, dt=False, ds=detect, cs=not detect, cse=False,
                              single=False, multi=False, filt=[], cat=None)


def per_sentence(hyp_m2, ref_m2, detect=False):
    """errant_compare's own loop, keeping each sentence's best TP/FP/FN (same choice of annotator)."""
    args = eval_args(detect)
    hyp = open(hyp_m2).read().strip().split('\n\n')
    ref = open(ref_m2).read().strip().split('\n\n')
    assert len(hyp) == len(ref), (len(hyp), len(ref))
    best = Counter({'tp': 0, 'fp': 0, 'fn': 0})
    rows = []
    for i, (h, r) in enumerate(zip(hyp, ref)):
        hd = C.process_edits(C.simplify_edits(h), args)
        rd = C.process_edits(C.simplify_edits(r), args)
        counts, _ = C.evaluate_edits(hd, rd, best, i, h[2:].split('\nA')[0], args)
        best += Counter(counts)
        rows.append((counts['tp'], counts['fp'], counts['fn']))
    return rows


def prf(tp, fp, fn, beta=0.5):
    p = tp / (tp + fp) if tp + fp else 1.0
    r = tp / (tp + fn) if tp + fn else 1.0
    f = (1 + beta ** 2) * p * r / (beta ** 2 * p + r) if p + r else 0.0
    return p, r, f


def bootstrap(rows, n=2000, seed=20261117):
    rnd = random.Random(seed)
    stats = []
    k = len(rows)
    for _ in range(n):
        tp = fp = fn = 0
        for _ in range(k):
            a, b, c = rows[rnd.randrange(k)]
            tp += a; fp += b; fn += c
        stats.append(prf(tp, fp, fn))
    out = {}
    for j, name in enumerate(['precision', 'recall', 'f05']):
        v = sorted(s[j] for s in stats)
        out[name] = [round(v[int(0.025 * n)], 4), round(v[int(0.975 * n) - 1], 4)]
    return out


def wilson(x, n, z=1.96):
    if n == 0:
        return [0.0, 1.0]
    p = x / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return [round(max(0, c - h), 4), round(min(1, c + h), 4)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--split', default='dev')
    ap.add_argument('--label', default='v1')
    a = ap.parse_args()
    s = os.path.join(DATA, 'full' if a.split.startswith('full') else 'sample', a.split)
    hyp_txt = os.path.join(DATA, 'out', f'{a.label}-{a.split}.hyp')
    m2dir = os.path.join(DATA, 'm2')
    os.makedirs(m2dir, exist_ok=True)
    gold = parallel(s + '.source', [s + '.ann1', s + '.ann2'], os.path.join(m2dir, f'{a.split}.gold.m2'))
    hyp = parallel(s + '.source', [hyp_txt], os.path.join(m2dir, f'{a.label}-{a.split}.hyp.m2'))
    official = run([os.path.join(BIN, 'errant_compare'), '-hyp', hyp, '-ref', gold])
    by_type = run([os.path.join(BIN, 'errant_compare'), '-hyp', hyp, '-ref', gold, '-cat', '2'])
    rows = per_sentence(hyp, gold)
    det_rows = per_sentence(hyp, gold, detect=True)
    tp, fp, fn = (sum(r[j] for r in rows) for j in range(3))
    p, r, f = prf(tp, fp, fn)
    dtp, dfp, dfn = (sum(r[j] for r in det_rows) for j in range(3))
    dp, dr, df = prf(dtp, dfp, dfn)
    src = open(s + '.source').read().rstrip('\n').split('\n')
    a1 = open(s + '.ann1').read().rstrip('\n').split('\n')
    a2 = open(s + '.ann2').read().rstrip('\n').split('\n')
    hy = open(hyp_txt).read().rstrip('\n').split('\n')
    clean = [i for i in range(len(src)) if src[i] == a1[i] == a2[i]]
    alarms = sum(1 for i in clean if hy[i] != src[i])
    edited = sum(1 for i in range(len(src)) if hy[i] != src[i])
    result = {
        'split': a.split, 'label': a.label, 'sentences': len(src),
        'scorer': 'ERRANT 3.0.0 errant_compare, span-based correction (default) and detection; spaCy 3.8.7, en_core_web_sm 3.8.0',
        'correction': {'tp': tp, 'fp': fp, 'fn': fn, 'precision': round(p, 4), 'recall': round(r, 4), 'f05': round(f, 4), 'ci95': bootstrap(rows)},
        'detection': {'tp': dtp, 'fp': dfp, 'fn': dfn, 'precision': round(dp, 4), 'recall': round(dr, 4), 'f05': round(df, 4)},
        'falseAlarms': {'cleanSentences': len(clean), 'changedBySystem': alarms, 'rate': round(alarms / len(clean), 4) if clean else None, 'ci95': wilson(alarms, len(clean))},
        'sentencesChangedBySystem': edited,
        'errantCompare': official.strip(),
    }
    os.makedirs(os.path.join(HERE, 'results'), exist_ok=True)
    base = os.path.join(HERE, 'results', f'{a.label}-{a.split}')
    with open(base + '.json', 'w') as fh:
        json.dump(result, fh, indent=1)
    with open(base + '.md', 'w') as fh:
        c, d, fa = result['correction'], result['detection'], result['falseAlarms']
        fh.write(f"# Proofreader `{a.label}` on CWEB {a.split} ({len(src)} sentences)\n\n")
        fh.write(f"Scorer: {result['scorer']}. Gold: both CWEB annotators.\n\n")
        fh.write('| Measure | Value | 95% interval |\n|---|---|---|\n')
        fh.write(f"| Correction precision | {c['precision']:.1%} ({c['tp']} of {c['tp'] + c['fp']} edits) | {c['ci95']['precision'][0]:.1%} to {c['ci95']['precision'][1]:.1%} |\n")
        fh.write(f"| Correction recall | {c['recall']:.1%} ({c['tp']} of {c['tp'] + c['fn']} gold edits) | {c['ci95']['recall'][0]:.1%} to {c['ci95']['recall'][1]:.1%} |\n")
        fh.write(f"| Correction F0.5 | {c['f05']:.1%} | {c['ci95']['f05'][0]:.1%} to {c['ci95']['f05'][1]:.1%} |\n")
        fh.write(f"| Detection precision / recall / F0.5 | {d['precision']:.1%} / {d['recall']:.1%} / {d['f05']:.1%} | |\n")
        fh.write(f"| False alarms (sentences neither annotator changed, but the proofreader did) | {fa['changedBySystem']} of {fa['cleanSentences']} ({(fa['rate'] or 0):.1%}) | {fa['ci95'][0]:.1%} to {fa['ci95'][1]:.1%} |\n\n")
        fh.write('The interval resamples sentences (2,000 draws) and keeps errant_compare\'s choice of annotator per sentence.\n')
        fh.write('An edit that neither annotator made counts against precision even when it is a valid correction, so precision is a lower bound.\n\n')
        fh.write('## errant_compare\n\n```\n' + official.strip() + '\n```\n\n## By error type (errant_compare -cat 2)\n\n```\n' + by_type.strip() + '\n```\n')
    print(json.dumps({k: result[k] for k in ['correction', 'detection', 'falseAlarms', 'sentencesChangedBySystem']}, indent=1))


if __name__ == '__main__':
    main()
