#!/usr/bin/env python3
"""Score the version 6 corpus (and the owner's 5 texts) with free open-source AI-text detectors, locally.

Detectors (licence read on each model card, pinned to a commit, safetensors only, no trust_remote_code, standard
transformers classes, no custom code):
  fakespot  fakespot-ai/roberta-base-ai-text-detection-v1   Apache-2.0  RoBERTa-base, 2 labels (0 Human, 1 AI)
  tabularis tabularisai/ai-text-detection                   MIT         ModernBERT-base, 512 tokens, class 1 = AI, NFKC first (the card's recipe)
  rasbt     rasbt/ai-text-detector-modernbert               Apache-2.0  ModernBERT-base, temperature 1.566, class 1 = AI (detector-config.json)
Left out on purpose: desklib/ai-text-detector-v1.01 and tropa-mini (a custom model class), SuperAnnotate/ai-detector
(a custom class and the SAIPL copyleft licence), yaful/MAGE and TrustSafeAI/RADAR (pytorch_model.bin only, no safetensors).

No text leaves this computer: after the one-off model download the run is local; result files hold ids, labels and scores only.

  PY=<ready venv>/bin/python
  $PY -I bench/v6/compare/score.py --splits dev,owner        scores dev and the owner's tests -> TEAM/compare-dev.json
  $PY -I bench/v6/compare/score.py --splits holdout          scores the holdout ONCE      -> TEAM/compare-holdout.json
  $PY -I bench/v6/compare/score.py --selftest                three inline strings
Scores are cached per text id and model in bench/data/v6/compare/scores-<short>.json, so nothing is scored twice.
"""
import json
import math
import os
import sys
import unicodedata
import re

TEAM = "/tmp/lectern-sessions/5ae58c7f-e18b-489a-9c97-a66cd37bbd2d/scratchpad/team-v6"
os.environ.setdefault("HF_HOME", os.path.join(TEAM, "hf"))
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".."))
DATA = os.path.join(ROOT, "bench", "data", "v6")
CACHE = os.path.join(DATA, "compare")
FILES = ["config.json", "model.safetensors", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json",
         "vocab.json", "merges.txt", "detector-config.json"]

MODELS = {
    "fakespot": dict(id="fakespot-ai/roberta-base-ai-text-detection-v1", rev="f9cdb14d1f8b105f597d80fa7b56f20c6ea0e9db", licence="Apache-2.0", maxlen=512, ai=1, temp=1.0, nfkc=False),
    "tabularis": dict(id="tabularisai/ai-text-detection", rev="4bf4a146a66df346e5b54e4b5ebda3fee1a19a86", licence="MIT", maxlen=512, ai=1, temp=1.0, nfkc=True),
    "rasbt": dict(id="rasbt/ai-text-detector-modernbert", rev="a6efd4bf6ecd852f332b2569ae0f98cae13b7985", licence="Apache-2.0", maxlen=8192, ai=1, temp=1.566228609277514, nfkc=False),
}


def normalize(t):
    t = unicodedata.normalize("NFKC", t)
    t = re.compile("[​-‏⁠﻿­]").sub("", t)
    return re.sub(r"\s+", " ", t).strip()


def load(short):
    import torch
    from huggingface_hub import snapshot_download
    from transformers import AutoModelForSequenceClassification, AutoTokenizer

    m = MODELS[short]
    path = snapshot_download(m["id"], revision=m["rev"], allow_patterns=FILES)
    try:
        tok = AutoTokenizer.from_pretrained(path)
    except ValueError:
        # tokenizer_config names a newer tokenizer class ("TokenizersBackend"); the fast tokenizer file itself is standard
        from transformers import PreTrainedTokenizerFast
        cfg = json.load(open(os.path.join(path, "tokenizer_config.json")))
        kw = {k: cfg[k] for k in ("cls_token", "sep_token", "pad_token", "unk_token", "mask_token", "bos_token", "eos_token") if isinstance(cfg.get(k), str)}
        tok = PreTrainedTokenizerFast(tokenizer_file=os.path.join(path, "tokenizer.json"), **kw)
    model = AutoModelForSequenceClassification.from_pretrained(path, use_safetensors=True, trust_remote_code=False).eval()
    return tok, model, torch


def score_texts(short, texts, tok, model, torch):
    """AI probability per text: windows of at most maxlen tokens, token-weighted mean over windows."""
    m = MODELS[short]
    out = []
    for t in texts:
        t = normalize(t) if m["nfkc"] else t
        enc = tok(t, truncation=True, max_length=m["maxlen"], stride=0, return_overflowing_tokens=True, padding=False, return_tensors=None)
        ids = enc["input_ids"]
        tot = 0.0
        n = 0
        for w in ids:
            x = torch.tensor([w])
            with torch.inference_mode():
                logits = model(input_ids=x, attention_mask=torch.ones_like(x)).logits.float() / m["temp"]
            p = logits.softmax(dim=-1)[0, m["ai"]].item()
            tot += p * len(w)
            n += len(w)
        out.append(tot / max(n, 1))
    return out


def cached(short):
    f = os.path.join(CACHE, "scores-%s.json" % short)
    try:
        return json.load(open(f))
    except Exception:
        return {}


def save(short, d):
    os.makedirs(CACHE, exist_ok=True)
    json.dump(d, open(os.path.join(CACHE, "scores-%s.json" % short), "w"))


def wilson(k, n, z=1.96):
    if n == 0:
        return [None, None]
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return [round(max(0, c - h), 4), round(min(1, c + h), 4)]


def auroc(pos, neg):
    """Mann-Whitney AUROC with ties counted half; pos = AI scores, neg = human scores."""
    if not pos or not neg:
        return None
    allv = sorted([(v, 1) for v in pos] + [(v, 0) for v in neg])
    ranks = [0.0] * len(allv)
    i = 0
    while i < len(allv):
        j = i
        while j + 1 < len(allv) and allv[j + 1][0] == allv[i][0]:
            j += 1
        for k in range(i, j + 1):
            ranks[k] = (i + j) / 2 + 1
        i = j + 1
    rp = sum(r for r, (v, l) in zip(ranks, allv) if l == 1)
    return round((rp - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg)), 4)


def line_for(human, max_rate=0.05):
    """Lowest threshold t (flag when score >= t) that flags at most max_rate of the human scores."""
    hs = sorted(human, reverse=True)
    allowed = int(math.floor(max_rate * len(hs)))
    if allowed >= len(hs):
        return 0.0
    # the (allowed+1)-th highest human score must stay below the line
    ref = hs[allowed]
    return round(math.nextafter(ref, 1.0), 6)


def rate(flags):
    k, n = sum(flags), len(flags)
    return dict(k=k, n=n, rate=round(k / n, 4) if n else None, wilson95=wilson(k, n))


def summarize(rows, scores, line):
    """rows: corpus rows (no text needed); scores: id -> probability."""
    r = {}
    ai = [x for x in rows if x["label"] == "ai"]
    hu = [x for x in rows if x["label"] == "human"]
    r["n"] = dict(ai=len(ai), human=len(hu))
    r["auroc"] = auroc([scores[x["id"]] for x in ai], [scores[x["id"]] for x in hu])
    for name, thr in (("default_0.5", 0.5), ("dev_line", line)):
        if thr is None:
            continue
        o = dict(threshold=thr)
        o["ai_flagged"] = rate([scores[x["id"]] >= thr for x in ai])
        o["human_flagged"] = rate([scores[x["id"]] >= thr for x in hu])
        o["human_nonnative_flagged"] = rate([scores[x["id"]] >= thr for x in hu if x.get("nonNative")])
        o["human_wikipedia_flagged"] = rate([scores[x["id"]] >= thr for x in hu if str(x["source"]).startswith("wikipedia")])
        o["ai_by_writer"] = {w: rate([scores[x["id"]] >= thr for x in ai if x["writer"] == w]) for w in sorted({x["writer"] for x in ai})}
        o["ai_by_genre"] = {g: rate([scores[x["id"]] >= thr for x in ai if x["genre"] == g]) for g in sorted({x["genre"] for x in ai})}
        o["ai_new_v6_only"] = rate([scores[x["id"]] >= thr for x in ai if x.get("origin") == "new"])
        r[name] = o
    return r


def main():
    arg = lambda n, d=None: sys.argv[sys.argv.index("--" + n) + 1] if "--" + n in sys.argv else d
    names = [s for s in arg("models", ",".join(MODELS)).split(",") if s]
    if "--selftest" in sys.argv:
        tests = ["The mitochondrion is an organelle found in the cells of most eukaryotes, where it generates most of the cell's supply of adenosine triphosphate.",
                 "honestly i dont know why the bus was late again, we waited like forty minutes and then Dave just gave up and walked home in the rain lol",
                 "In conclusion, it is important to note that climate change represents a multifaceted challenge that requires a comprehensive approach."]
        for s in names:
            tok, model, torch = load(s)
            print(s, [round(v, 3) for v in score_texts(s, tests, tok, model, torch)])
        return
    splits = [s for s in arg("splits", "dev,owner").split(",") if s]
    if "holdout" in splits and len(splits) > 1:
        sys.exit("Score the holdout on its own run (splits=holdout), never together with dev.")
    corpus = [json.loads(l) for l in open(os.path.join(DATA, "corpus.jsonl")) if l.strip()]
    if "holdout" in splits:
        import hashlib
        want = {}
        for l in open(os.path.join(DATA, "holdout.sha256")):
            parts = l.split()
            if len(parts) >= 2 and len(parts[0]) == 64 and not parts[1].startswith("HOLDOUT"):
                want[parts[1]] = parts[0]
        have = {x["id"]: hashlib.sha256(x["text"].encode()).hexdigest() for x in corpus if x["split"] == "holdout"}
        if want != have:
            sys.exit("The holdout texts do not match bench/data/v6/holdout.sha256; stopping.")
    sel = []
    for sp in splits:
        if sp == "owner":
            for l in open(os.path.join(TEAM, "owner-tests.jsonl")):
                if l.strip():
                    o = json.loads(l)
                    sel.append(dict(id=o["id"], label=o["label"], writer=o.get("writer", "owner"), source="owner", genre="owner", nonNative=False, text=o["text"], split="owner", origin="owner"))
        else:
            sel += [x for x in corpus if x["split"] == sp]
    out = dict(version=6, splits=splits, models={}, note="Detector flags use each model's own 0.5 line; the dev line is the lowest line that flags at most 5% of human dev texts.")
    for s in names:
        cache = cached(s)
        need = [x for x in sel if x["id"] not in cache]
        if need:
            tok, model, torch = load(s)
            sc = score_texts(s, [x["text"] for x in need], tok, model, torch)
            for x, v in zip(need, sc):
                cache[x["id"]] = v
            save(s, cache)
        m = MODELS[s]
        entry = dict(model=m["id"], revision=m["rev"], licence=m["licence"], scored_now=len(need))
        for sp in splits:
            rows = [x for x in sel if x["split"] == sp]
            sc = {x["id"]: cache[x["id"]] for x in rows}
            if sp == "dev":
                hu = [sc[x["id"]] for x in rows if x["label"] == "human"]
                line = line_for(hu)
                entry["dev_line"] = line
                entry["dev"] = summarize(rows, sc, line)
            elif sp == "holdout":
                dev_scores = {x["id"]: cache[x["id"]] for x in corpus if x["split"] == "dev" and x["id"] in cache}
                devhu = [dev_scores[x["id"]] for x in corpus if x["split"] == "dev" and x["label"] == "human" and x["id"] in dev_scores]
                line = line_for(devhu) if devhu else None
                entry["dev_line"] = line
                entry["holdout"] = summarize(rows, sc, line)
            else:
                entry["owner"] = dict(scores={x["id"]: round(sc[x["id"]], 4) for x in rows}, labels={x["id"]: x["label"] for x in rows},
                                      flagged_at_default={x["id"]: sc[x["id"]] >= 0.5 for x in rows}, dev_line=entry.get("dev_line"))
        out["models"][s] = entry
    dest = os.path.join(TEAM, "compare-holdout.json" if splits == ["holdout"] else "compare-dev.json")
    json.dump(out, open(dest, "w"), indent=1)
    print("written", dest)


if __name__ == "__main__":
    main()
