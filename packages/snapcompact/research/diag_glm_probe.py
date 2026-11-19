# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow"]
# ///
"""Targeted glm-4.6v probes: routing A/B (OpenRouter vs Z.AI direct), per-image
token bill vs frame count, single deep-frame legibility.

Modes:
  smoke      tiny text-only call on both routes (verifies Z.AI endpoint/model id)
  bill       send first N frames + trivial ask, report prompt token bill (per route)
  frame      send ONE deep frame alone + targeted question + transcription ask
  ab         the original 21-frame stack + one failing question batch, both routes

  uv run diag_glm_probe.py --mode smoke
"""

import argparse
import base64
import json
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import squad  # noqa: E402
from mono_prod import SHAPES  # noqa: E402
from providers import load_env_key  # noqa: E402
from run import CACHE, sha8  # noqa: E402

ZAI_URL = "https://api.z.ai/api/coding/paas/v4/chat/completions"  # coding-plan endpoint; paas/v4 returns 1113 (no balance)
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"


def post(url: str, body: dict, key: str) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json", "authorization": f"Bearer {key}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=600) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return {"http_error": e.code, "body": e.read().decode()[:2000]}


def img_block(path: Path) -> dict:
    b64 = base64.b64encode(path.read_bytes()).decode()
    return {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}}


def complete(
    route: str,
    keys: dict,
    messages: list[dict],
    model_or: str,
    model_zai: str,
    max_tokens: int,
) -> dict:
    if route == "zai":
        body = {"model": model_zai, "messages": messages, "max_tokens": max_tokens}
        out = post(ZAI_URL, body, keys["zai"])
    else:
        body = {"model": model_or, "messages": messages, "max_tokens": max_tokens}
        out = post(OPENROUTER_URL, body, keys["openrouter"])
    if "http_error" in out:
        return out
    choice = (out.get("choices") or [{}])[0]
    msg = choice.get("message") or {}
    text = msg.get("content") or ""
    if isinstance(text, list):
        text = "".join(p.get("text", "") for p in text if isinstance(p, dict))
    return {
        "text": text,
        "reasoning_text_len": len(
            msg.get("reasoning_content") or msg.get("reasoning") or ""
        ),
        "usage": out.get("usage", {}),
        "finish": choice.get("finish_reason"),
        "provider": out.get("provider"),
        "model": out.get("model"),
    }


def frames_for(shape_name: str, chars: int) -> tuple[list[Path], str, int]:
    paras = squad.load_paragraphs(CACHE)
    flow, _ = squad.build_flow(paras, chars)
    shape = SHAPES[shape_name]
    frame_dir = (
        CACHE
        / f"prod-frames-{shape_name}-{sha8(flow, json.dumps(shape, sort_keys=True))}"
    )
    pngs = sorted(frame_dir.glob("page-*.png"))
    assert pngs, f"no frames in {frame_dir}; run mono_prod first"
    return pngs, flow, len(flow)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", required=True, choices=["smoke", "bill", "frame", "ab"])
    ap.add_argument("--route", default="both", choices=["openrouter", "zai", "both"])
    ap.add_argument("--shape", default="8on16-bw")
    ap.add_argument("--chars", type=int, default=400_000)
    ap.add_argument("--counts", default="1,4,12,21")
    ap.add_argument("--frame-idx", type=int, default=16)
    ap.add_argument("--question", default=None)
    ap.add_argument("--model-or", default="z-ai/glm-4.6v")
    ap.add_argument("--model-zai", default="glm-4.6v")
    ap.add_argument("--max-tokens", type=int, default=8192)
    ap.add_argument("--env", default="~/.env")
    args = ap.parse_args()

    keys = {
        "openrouter": load_env_key("OPENROUTER_API_KEY", args.env),
        "zai": load_env_key("ZAI_API_KEY", args.env),
    }
    routes = ["openrouter", "zai"] if args.route == "both" else [args.route]

    if args.mode == "smoke":
        for route in routes:
            msgs = [
                {
                    "role": "user",
                    "content": [{"type": "text", "text": "Reply with exactly: PONG"}],
                }
            ]
            r = complete(route, keys, msgs, args.model_or, args.model_zai, 1024)
            print(f"[{route}] {json.dumps(r, default=str)[:600]}")
        return

    pngs, flow, flow_len = frames_for(args.shape, args.chars)
    print(f"frames available: {len(pngs)} (flow {flow_len} chars)")

    if args.mode == "bill":
        for n in (int(x) for x in args.counts.split(",")):
            blocks = [
                {
                    "type": "text",
                    "text": f"You will see {n} images. Reply with exactly: OK",
                }
            ]
            blocks += [img_block(p) for p in pngs[:n]]
            msgs = [{"role": "user", "content": blocks}]
            for route in routes:
                r = complete(route, keys, msgs, args.model_or, args.model_zai, 2048)
                u = r.get("usage", {})
                pt = u.get("prompt_tokens", 0)
                print(
                    f"[{route}] n={n:>2} prompt_tokens={pt:>7} per_img={(pt / max(n, 1)):>8.1f} "
                    f"finish={r.get('finish')} provider={r.get('provider')} text={r.get('text', '')[:40]!r}"
                )
        return

    if args.mode == "frame":
        p = pngs[args.frame_idx]
        ask = "Transcribe the first 5 text lines of this image exactly."
        if args.question:
            ask += f"\nThen answer from the image text: {args.question}\nFormat: TRANSCRIPT lines, then ANSWER: <short answer or UNREADABLE>."
        msgs = [
            {"role": "user", "content": [{"type": "text", "text": ask}, img_block(p)]}
        ]
        for route in routes:
            r = complete(
                route, keys, msgs, args.model_or, args.model_zai, args.max_tokens
            )
            u = r.get("usage", {})
            print(
                f"\n[{route}] frame={p.name} prompt_tokens={u.get('prompt_tokens')} finish={r.get('finish')}"
            )
            print("\n".join("  | " + ln for ln in r.get("text", "").splitlines()[:12]))
        return

    if args.mode == "ab":
        # Re-issue the original failing batch (questions 16-20, all UNREADABLE via OR).
        paras = squad.load_paragraphs(CACHE)
        flow2, offsets = squad.build_flow(paras, args.chars)
        questions = squad.sample_chunk_questions(paras, offsets, 0, len(flow2), 25, 42)
        batch = questions[15:20]
        from mono_prod import SIZE

        shape = SHAPES[args.shape]
        cols = SIZE // shape["cellWidth"]
        rows = SIZE // shape["cellHeight"]
        from run import load_prompt

        preamble = load_prompt("qa-image-multi.md").format(
            k=len(pngs), cols=cols, rows=rows
        )
        q_block = "\n".join(f"{i + 1}. {q['q']}" for i, q in enumerate(batch))
        blocks = [{"type": "text", "text": preamble}]
        blocks += [img_block(p) for p in pngs]
        blocks += [
            {"type": "text", "text": "End of images."},
            {"type": "text", "text": q_block},
        ]
        msgs = [{"role": "user", "content": blocks}]
        for i, q in enumerate(batch):
            print(f"Q{i + 1}: {q['q']}  golds={q['golds']}")
        for route in routes:
            r = complete(
                route, keys, msgs, args.model_or, args.model_zai, args.max_tokens
            )
            u = r.get("usage", {})
            print(
                f"\n[{route}] prompt_tokens={u.get('prompt_tokens')} completion={u.get('completion_tokens')} "
                f"finish={r.get('finish')} provider={r.get('provider')}"
            )
            print("\n".join("  | " + ln for ln in r.get("text", "").splitlines()[:10]))


if __name__ == "__main__":
    main()
