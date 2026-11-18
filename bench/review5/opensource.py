#!/usr/bin/env python3
"""Score the review5 corpus with one open-source detector, locally.

Detector: openai-community/roberta-large-openai-detector (the "GPT-2 output detector" from
OpenAI, RoBERTa-large fine-tuned on GPT-2 1.5B output vs WebText; MIT licence; listed on the
RAID leaderboard as "RoBERTa-Large (GPT2)"). Not trained on HC3 or on Liang et al. data.
Old detector: it was trained on GPT-2 text, so on modern models it is a weak baseline.

Label mapping: logits index 0 = FAKE (AI), index 1 = REAL (human). Source: OpenAI's own
detector/server.py (`fake, real = probs...`); the Hugging Face config has no id2label.

Long texts: the model reads at most 510 tokens (its 512 positions minus <s> and </s>); the
reference server keeps only the first 510 tokens. We split every text into consecutive
510-token windows and report `ai_prob` as the token-weighted mean over windows. We also
report `ai_prob_first510` (the reference behaviour). Texts with fewer than 20 tokens are
still scored but `n_tokens` is saved so they can be dropped.

Safety: only model.safetensors is downloaded, use_safetensors=True, no trust_remote_code,
files stay under HF_HOME (default: the scratchpad folder below). No text leaves this machine
(after the one-off model download, HF_HUB_OFFLINE=1 can be set).

Run (from the Lectern folder):
  VENV=/tmp/lectern-sessions/82e5b932-35b1-4cac-91c3-1f4f1862de74/scratchpad/opensource
  $VENV/.venv/bin/python -I bench/review5/opensource.py            # score the corpus
  $VENV/.venv/bin/python -I bench/review5/opensource.py --selftest # three inline strings
"""
import json
import os
import sys

SCRATCH = "/tmp/lectern-sessions/82e5b932-35b1-4cac-91c3-1f4f1862de74/scratchpad/opensource"
os.environ.setdefault("HF_HOME", os.path.join(SCRATCH, "hf"))
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

MODEL_ID = "openai-community/roberta-large-openai-detector"
REVISION = "38f3e0ccf205e9c4e0b38ae9d75ec948141bf832"  # pinned commit on huggingface.co
SHORT = "roberta-large-openai"
WINDOW = 510
ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
CORPUS = os.path.join(ROOT, "bench", "data", "review5", "corpus.jsonl")
OUT = os.path.join(ROOT, "bench", "results", "review5-opensource-%s.json" % SHORT)

SELFTEST = [
    "The mitochondria is the powerhouse of the cell, and it is responsible for producing most of the chemical energy needed to power the cell's biochemical reactions.",
    "honestly i dont know why the bus was late again, we waited like forty minutes and then Dave just gave up and walked home in the rain lol",
    "In conclusion, it is important to note that climate change represents a multifaceted challenge that requires a comprehensive and collaborative approach across all sectors of society.",
]


def load():
    import torch
    from huggingface_hub import snapshot_download
    from transformers import AutoModelForSequenceClassification, AutoTokenizer

    path = snapshot_download(
        MODEL_ID,
        revision=REVISION,
        allow_patterns=["config.json", "model.safetensors", "vocab.json", "merges.txt",
                        "tokenizer.json", "tokenizer_config.json"],
    )
    tok = AutoTokenizer.from_pretrained(path, trust_remote_code=False)
    model = AutoModelForSequenceClassification.from_pretrained(
        path, use_safetensors=True, trust_remote_code=False)
    model.eval()
    return torch, tok, model


def score(torch, tok, model, text):
    ids = tok.encode(text, add_special_tokens=False)
    if not ids:
        return None
    chunks = [ids[i:i + WINDOW] for i in range(0, len(ids), WINDOW)]
    probs, weights = [], []
    with torch.no_grad():
        for ch in chunks:
            x = torch.tensor([[tok.bos_token_id] + ch + [tok.eos_token_id]])
            p = model(input_ids=x).logits.softmax(dim=-1)[0]
            probs.append(float(p[0]))  # index 0 = fake = AI
            weights.append(len(ch))
    mean = sum(p * w for p, w in zip(probs, weights)) / sum(weights)
    return {"ai_prob": round(mean, 6), "ai_prob_first510": round(probs[0], 6),
            "n_tokens": len(ids), "n_chunks": len(chunks)}


def main():
    selftest = "--selftest" in sys.argv[1:]
    if not selftest and not os.path.exists(CORPUS):
        print("corpus not found: %s" % CORPUS)
        return 2
    torch, tok, model = load()
    print("model %s revision %s" % (MODEL_ID, REVISION))
    if selftest:
        for t in SELFTEST:
            r = score(torch, tok, model, t)
            print("%.4f  (first %d chars: %s)" % (r["ai_prob"], 60, t[:60].replace("\n", " ")))
        return 0
    rows = []
    with open(CORPUS, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            o = json.loads(line)
            r = score(torch, tok, model, o["text"])
            row = {"id": o["id"], "label": o["label"]}
            row.update(r or {"ai_prob": None})
            rows.append(row)
            if len(rows) % 25 == 0:
                print("scored %d" % len(rows), flush=True)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"model": MODEL_ID, "revision": REVISION, "ai_label_index": 0,
                   "window_tokens": WINDOW,
                   "note": "ai_prob = token-weighted mean over 510-token windows; "
                           "ai_prob_first510 = reference-server behaviour",
                   "results": rows}, f, indent=1)
    print("wrote %s (%d texts)" % (OUT, len(rows)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
