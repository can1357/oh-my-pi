# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow"]
# ///
"""exp12: context-window arbitrage measurement.

(a) chars per input token: optical pages vs plain text (mined from optimal-* runs
    + targeted probes at image sizes 1568/1024/768);
(b) TPM accounting: do image tokens dodge text-token throttles? (rate-limit headers
    captured around text-heavy vs image-heavy requests);
(c) risk: break-even repricing multiple at which the arbitrage dies.

Measurement + writeup, no F1 chase. Outputs results/exp12-arbitrage/
{measurements.json, probes.json, report.md}.
"""

import argparse
import base64
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import squad  # noqa: E402
from bdf import capacity, render  # noqa: E402
from providers import load_env_key  # noqa: E402
from run import CACHE, FONTS, RESULTS, TEXT_CHUNK, sha8  # noqa: E402

OUT = RESULTS / "exp12-arbitrage"
SIZES = (1568, 1024, 768)
PROBE_MODELS = ("gpt-5.5", "google/gemini-3.5-flash")
PRICES = {"gpt-5.5": (2.0, 16.0), "google/gemini-3.5-flash": (0.6, 4.0)}
INSTR = "Reply with exactly: OK"

# ---------------------------------------------------------------- part A: mine

MINE_DIRS = (
    "optimal-combined",
    "optimal-gpt55",
    "optimal-gemini",
    "optimal-fable",
    "optimal-opus",
    "optimal-kimi",
    "optimal-glm",
)


def cond_budget(cond: str) -> int | None:
    """chars per chunk for a condition; None when chars/token is undefined (summaries)."""
    if cond == "text":
        return TEXT_CHUNK
    if cond.startswith("img-"):
        font = cond.split("-")[1]
        return capacity(FONTS[font], 1568)[2]
    return None  # compact / handoff carry a generated summary, not the raw chars


def mine() -> tuple[list[dict], dict]:
    """Per (model, cond): sum carrier chars and total qa input tokens over chunks.

    Also returns per-chunk (chars, tok) detail for the carrier estimation in derive().
    """
    flows = {}
    paras = squad.load_paragraphs(CACHE)
    for length in (50, 150, 250):
        flows[length] = squad.build_flow(paras[:length])[0]

    seen: set[tuple] = set()
    agg: dict[tuple[str, str], dict] = {}
    detail: dict[str, dict[str, list]] = {}
    for d in MINE_DIRS:
        path = RESULTS / d / "records.jsonl"
        if not path.exists():
            continue
        for line in path.read_text().splitlines():
            r = json.loads(line)
            if "usage" not in r:
                continue
            budget = cond_budget(r["cond"])
            if budget is None or r["length"] not in flows:
                continue
            key = (r["model"], r["cond"], r["length"], r["chunk"])
            if key in seen:
                continue  # combined is a merge of the per-model dirs
            seen.add(key)
            qa = next((u for u in r["usage"] if u["phase"] == "qa"), None)
            if qa is None:
                continue
            tok = qa["in"] + qa["cache_r"] + qa["cache_w"]
            chars = min(r["chunk"] + budget, len(flows[r["length"]])) - r["chunk"]
            cell = agg.setdefault(
                (r["model"], r["cond"]), {"chars": 0, "tok_in": 0, "chunks": 0}
            )
            cell["chars"] += chars
            cell["tok_in"] += tok
            cell["chunks"] += 1
            detail.setdefault(r["model"], {}).setdefault(r["cond"], []).append(
                (chars, tok)
            )
    rows = []
    for (model, cond), c in sorted(agg.items()):
        rows.append(
            {
                "model": model,
                "cond": cond,
                "chunks": c["chunks"],
                "chars": c["chars"],
                "tok_in_total": c["tok_in"],
                "chars_per_tok": round(c["chars"] / c["tok_in"], 3),
            }
        )
    return rows, detail


# ------------------------------------------------------------- part B: probes
# Own POST so we can read rate-limit headers (providers._post discards them).

OPENAI_URL = "https://api.openai.com/v1/responses"
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
RL_PREFIXES = ("x-ratelimit", "ratelimit", "retry-after")


def post_h(url: str, body: dict, headers: dict, retries: int = 4) -> tuple[dict, dict]:
    payload = json.dumps(body).encode()
    req = urllib.request.Request(
        url, data=payload, headers={"content-type": "application/json", **headers}
    )
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=600) as resp:
                rl = {
                    k.lower(): v
                    for k, v in resp.headers.items()
                    if k.lower().startswith(RL_PREFIXES)
                }
                return json.load(resp), rl
        except urllib.error.HTTPError as err:
            detail = err.read().decode(errors="replace")[:300]
            if err.code in (408, 429, 500, 502, 503, 529) and attempt < retries:
                wait = 2.0 * 2**attempt
                print(f"  HTTP {err.code}, retrying in {wait:.0f}s: {detail[:120]}")
                time.sleep(wait)
                continue
            raise SystemExit(f"API error {err.code} ({url}): {detail}") from err
    raise AssertionError("unreachable")


def png_b64(path: Path) -> str:
    return base64.b64encode(path.read_bytes()).decode()


def probe_call(model: str, keys: dict, blocks: list[dict]) -> tuple[dict, dict]:
    """One user message of blocks -> (normalized usage, rate-limit headers)."""
    if model.startswith("gpt-"):
        content = []
        for b in blocks:
            if "text" in b:
                content.append({"type": "input_text", "text": b["text"]})
            else:
                content.append(
                    {
                        "type": "input_image",
                        "image_url": f"data:image/png;base64,{png_b64(b['image_path'])}",
                        "detail": "original",
                    }
                )
        body = {
            "model": model,
            "input": [{"role": "user", "content": content}],
            "max_output_tokens": 512,
            "store": False,
        }
        out, rl = post_h(
            OPENAI_URL, body, {"authorization": f"Bearer {keys['openai']}"}
        )
        u = out.get("usage", {})
        cached = (u.get("input_tokens_details") or {}).get("cached_tokens", 0)
        usage = {
            "in": u.get("input_tokens", 0),
            "cached": cached,
            "out": u.get("output_tokens", 0),
        }
        return usage, rl
    content = []
    for b in blocks:
        if "text" in b:
            content.append({"type": "text", "text": b["text"]})
        else:
            content.append(
                {
                    "type": "image_url",
                    "image_url": {
                        "url": f"data:image/png;base64,{png_b64(b['image_path'])}"
                    },
                }
            )
    body = {
        "model": model,
        "messages": [{"role": "user", "content": content}],
        "max_tokens": 512,
    }
    out, rl = post_h(
        OPENROUTER_URL, body, {"authorization": f"Bearer {keys['openrouter']}"}
    )
    u = out.get("usage", {})
    usage = {
        "in": u.get("prompt_tokens", 0),
        "cached": (u.get("prompt_tokens_details") or {}).get("cached_tokens", 0),
        "out": u.get("completion_tokens", 0),
    }
    return usage, rl


def probe_pngs(flow: str) -> dict[int, Path]:
    pngs = {}
    for size in SIZES:
        cols, rows, cap = capacity(FONTS["6x10"], size)
        text = flow[:cap]
        png = CACHE / f"exp12-6x10-sent-{size}-{sha8(text, str(size))}.png"
        if not png.exists() or png.stat().st_size == 0:
            tmp = png.with_suffix(".tmp.png")
            render(text, FONTS["6x10"], CACHE, size, "sent").save(tmp)
            tmp.replace(png)
        pngs[size] = png
    return pngs


def run_probes(keys: dict, flow: str) -> dict:
    """Per model: instr-only, full-page text, and 6x10 pages at SIZES.

    Sequence is deliberate (small, text-heavy, small, image-heavy ...) so the
    rate-limit header trail brackets each heavy request with a light one.
    """
    pngs = probe_pngs(flow)
    page_text = flow[:TEXT_CHUNK]
    out: dict = {"page_chars": len(page_text), "models": {}}
    for model in PROBE_MODELS:
        steps = [
            ("overhead-1", [{"text": INSTR}]),
            ("text-page", [{"text": INSTR}, {"text": page_text}]),
            ("overhead-2", [{"text": INSTR}]),
        ]
        steps += [
            (f"img-{s}", [{"text": INSTR}, {"image_path": pngs[s]}]) for s in SIZES
        ]
        rows = []
        for name, blocks in steps:
            usage, rl = probe_call(model, keys, blocks)
            row = {"step": name, "usage": usage, "ratelimit": rl, "t": time.time()}
            rows.append(row)
            print(
                f"  {model:>24} {name:<11} in={usage['in']:>6} (cached={usage['cached']}) "
                f"out={usage['out']:>5} rl-remaining-tokens={rl.get('x-ratelimit-remaining-tokens', '-')}"
            )
        out["models"][model] = rows
    return out


# --------------------------------------------------------- part C: derivation


def estimate_carriers(detail: dict, per_model_probed: dict) -> dict:
    """Carrier-only chars/token for the non-probed models, from mined per-chunk data.

    Per-chunk total = carrier + QA overhead (prompt + question block). Overhead is
    estimated as the mean (chunk_total - probe-measured carrier) over the two probed
    models -- the question blocks are identical across models, tokenizers differ by
    only a few %. Validation: applying the same estimate back to the probed models
    reproduces their probe-measured chars/text-token within ~2%.
    """
    overheads = []
    for model, d in per_model_probed.items():
        carrier = d["images"][1568]["image_tokens"]
        overheads += [tok - carrier for _, tok in detail[model]["img-6x10-sent"]]
    overhead = sum(overheads) / len(overheads)
    page = capacity(FONTS["6x10"], 1568)[2]
    est = {}
    for model, conds in detail.items():
        if "img-6x10-sent" not in conds or "text" not in conds:
            continue
        img_rows, text_rows = conds["img-6x10-sent"], conds["text"]
        img_tok = sum(t for _, t in img_rows) / len(img_rows) - overhead
        text_chars = sum(c for c, _ in text_rows)
        text_tok = sum(t for _, t in text_rows) - overhead * len(text_rows)
        cpt_img, cpt_text = page / img_tok, text_chars / text_tok
        est[model] = {
            "est_image_tokens_per_page": round(img_tok),
            "est_chars_per_img_tok": round(cpt_img, 3),
            "est_chars_per_text_tok": round(cpt_text, 3),
            "est_window_stretch": round(cpt_img / cpt_text, 3),
            "probed": model in per_model_probed,
        }
    return {"qa_overhead_tokens_est": round(overhead, 1), "models": est}


def derive(mined: list[dict], detail: dict, probes: dict) -> dict:
    page_chars = probes["page_chars"]
    caps = {s: capacity(FONTS["6x10"], s)[2] for s in SIZES}
    per_model = {}
    for model, rows in probes["models"].items():
        by = {r["step"]: r["usage"] for r in rows}
        overhead = min(by["overhead-1"]["in"], by["overhead-2"]["in"])
        text_tok = by["text-page"]["in"] - overhead
        img = {}
        for s in SIZES:
            itok = by[f"img-{s}"]["in"] - overhead
            img[s] = {
                "image_tokens": itok,
                "page_chars": caps[s],
                "chars_per_img_tok": round(caps[s] / itok, 3),
                "tok_per_megapixel": round(itok / (s * s / 1e6), 1),
            }
        cpt_text = page_chars / text_tok
        cpt_img = img[1568]["chars_per_img_tok"]
        stretch = cpt_img / cpt_text
        p_in = PRICES[model][0]
        per_model[model] = {
            "overhead_tokens": overhead,
            "text_tokens_per_page": text_tok,
            "chars_per_text_tok": round(cpt_text, 3),
            "images": img,
            "window_stretch_6x10_1568": round(stretch, 3),
            "chars_in_200k_window": {
                "text": int(200_000 * cpt_text),
                "img_6x10_1568": int(200_000 * cpt_img),
            },
            "breakeven_img_token_multiple": round(stretch, 3),
            "input_cost_per_mchar": {
                "text": round(p_in / cpt_text, 4),
                "img_6x10_1568": round(p_in / cpt_img, 4),
            },
        }
    return {
        "mined": mined,
        "probes": probes,
        "derived": per_model,
        "carrier_estimates": estimate_carriers(detail, per_model),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--fresh",
        action="store_true",
        help="re-run API probes even if probes.json exists",
    )
    ap.add_argument("--env", default="~/.env")
    args = ap.parse_args()

    OUT.mkdir(parents=True, exist_ok=True)
    CACHE.mkdir(exist_ok=True)

    mined, detail = mine()
    print(f"mined {len(mined)} (model, cond) cells from {', '.join(MINE_DIRS)}")
    for r in mined:
        print(
            f"  {r['model']:>24} {r['cond']:<18} chunks={r['chunks']:>2} chars={r['chars']:>7} "
            f"tok={r['tok_in_total']:>7} chars/tok={r['chars_per_tok']:>7.3f}"
        )

    probes_path = OUT / "probes.json"
    if probes_path.exists() and not args.fresh:
        probes = json.loads(probes_path.read_text())
        print("reusing probes.json (pass --fresh to re-run)")
    else:
        keys = {
            "openai": load_env_key("OPENAI_API_KEY", args.env),
            "openrouter": load_env_key("OPENROUTER_API_KEY", args.env),
        }
        # 150 paragraphs -> flow ~90k chars, so every probe page (incl. 1568px / 40716
        # chars) is completely full; image token cost is content-independent anyway
        # (verified: identical tok/megapixel at three different fill ratios).
        flow = squad.build_flow(squad.load_paragraphs(CACHE)[:150])[0]
        probes = run_probes(keys, flow)
        tmp = probes_path.with_suffix(".tmp.json")
        tmp.write_text(json.dumps(probes, indent=1))
        tmp.replace(probes_path)

    measurements = derive(mined, detail, probes)
    tmp = (OUT / "measurements.json").with_suffix(".tmp.json")
    tmp.write_text(json.dumps(measurements, indent=1))
    tmp.replace(OUT / "measurements.json")
    print(f"\nwrote {OUT}/measurements.json")
    for model, d in measurements["derived"].items():
        print(
            f"{model}: text {d['chars_per_text_tok']} c/t | img-1568 "
            f"{d['images'][1568 if 1568 in d['images'] else '1568']['chars_per_img_tok']} c/t | "
            f"stretch {d['window_stretch_6x10_1568']}x | breakeven {d['breakeven_img_token_multiple']}x"
        )


if __name__ == "__main__":
    main()
