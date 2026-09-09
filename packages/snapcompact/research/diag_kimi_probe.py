# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow"]
# ///
"""Kimi diagnosis probes: image-count token curve + last-frame readability,
via OpenRouter and Moonshot direct. New scratch file; touches no shared code.

Subcommands:
  models                 list Moonshot models (free-ish)
  tokens   --route X     prompt_tokens vs frame count K
  lastline --route X     transcribe first line of LAST frame at count K
"""

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from providers import _png_b64, _post, load_env_key  # noqa: E402
from run import CACHE  # noqa: E402

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
MOONSHOT_BASE = "https://api.moonshot.ai/v1"
OR_MODEL = "moonshotai/kimi-k2.6"

FRAME_DIR_GLOB = "prod-frames-8on16-bw-*"


def frames() -> list[Path]:
    dirs = sorted(CACHE.glob(FRAME_DIR_GLOB))
    for d in dirs:
        pngs = sorted(d.glob("page-*.png"))
        if len(pngs) == 21:  # the 400k-char production stack
            return pngs
    raise SystemExit("21-frame dir not found")


PROVIDER: str | None = None  # OpenRouter provider slug to pin, set from --provider


def chat(route: str, model: str, content: list[dict], max_tokens: int = 2048) -> dict:
    if route == "openrouter":
        url, key = OPENROUTER_URL, load_env_key("OPENROUTER_API_KEY")
    elif route == "fireworks":
        url, key = (
            "https://api.fireworks.ai/inference/v1/chat/completions",
            load_env_key("FIREWORKS_API_KEY"),
        )
    else:
        url, key = f"{MOONSHOT_BASE}/chat/completions", load_env_key("KIMI_API_KEY")
    body = {
        "model": model,
        "messages": [{"role": "user", "content": content}],
        "max_tokens": max_tokens,
    }
    if route == "openrouter" and PROVIDER:
        body["provider"] = {"order": [PROVIDER], "allow_fallbacks": False}
    out = _post(url, body, {"authorization": f"Bearer {key}", "user-agent": "diag/1.0"})
    choice = (out.get("choices") or [{}])[0]
    msg = choice.get("message") or {}
    text = msg.get("content") or ""
    if isinstance(text, list):
        text = "".join(p.get("text", "") for p in text if isinstance(p, dict))
    return {
        "text": text,
        "usage": out.get("usage", {}),
        "finish": choice.get("finish_reason"),
        "provider": out.get("provider"),
        "model": out.get("model"),
    }


def small_frames(px: int) -> list[Path]:
    """Downscaled copies of the 21 production frames (count-cap vs token-budget probe)."""
    from PIL import Image

    out_dir = CACHE / f"diag-kimi-small-{px}"
    out_dir.mkdir(exist_ok=True)
    outs = []
    for p in frames():
        q = out_dir / p.name
        if not q.exists():
            Image.open(p).resize((px, px), Image.LANCZOS).save(q)
        outs.append(q)
    return outs


def img_block(p: Path) -> dict:
    return {
        "type": "image_url",
        "image_url": {"url": f"data:image/png;base64,{_png_b64(p)}"},
    }


def cmd_models() -> None:
    import urllib.request

    key = load_env_key("KIMI_API_KEY")
    req = urllib.request.Request(
        f"{MOONSHOT_BASE}/models", headers={"authorization": f"Bearer {key}"}
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        out = json.loads(resp.read())
    for m in out.get("data", []):
        print(m.get("id"))


def cmd_tokens(
    route: str, model: str, counts: list[int], px: int | None = None
) -> None:
    pngs = small_frames(px) if px else frames()
    for k in counts:
        content = [
            {"type": "text", "text": f"This message has some images attached."},
            *(img_block(p) for p in pngs[:k]),
            {
                "type": "text",
                "text": "How many images are attached to this message? Reply with just the integer.",
            },
        ]
        try:
            r = chat(route, model, content)
        except Exception as e:  # noqa: BLE001
            print(f"K={k:>2} ERROR {e}")
            continue
        u = r["usage"]
        print(
            f"K={k:>2} prompt_tokens={u.get('prompt_tokens')} completion={u.get('completion_tokens')} "
            f"provider={r.get('provider')} finish={r['finish']} answer={r['text'].strip()[:80]!r}"
        )


def cmd_lastline(route: str, model: str, counts: list[int]) -> None:
    pngs = frames()
    for k in counts:
        content = [
            {
                "type": "text",
                "text": f"The attached {k} images contain text rendered in a monospace pixel font.",
            },
            *(img_block(p) for p in pngs[:k]),
            {
                "type": "text",
                "text": f"Transcribe the first 10 words on the FIRST text row of the LAST image (image {k}). "
                "If you cannot read it, reply exactly UNREADABLE.",
            },
        ]
        try:
            r = chat(route, model, content, max_tokens=4096)
        except Exception as e:  # noqa: BLE001
            print(f"K={k:>2} ERROR {e}")
            continue
        u = r["usage"]
        print(
            f"K={k:>2} prompt_tokens={u.get('prompt_tokens')} finish={r['finish']}\n     -> {r['text'].strip()[:200]!r}"
        )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["models", "tokens", "lastline"])
    ap.add_argument(
        "--px",
        type=int,
        default=None,
        help="downscale frames to this square size first",
    )
    ap.add_argument(
        "--route", default="openrouter", choices=["openrouter", "moonshot", "fireworks"]
    )
    ap.add_argument("--model", default=None)
    ap.add_argument("--counts", default="1,4,8,9,12,21")
    ap.add_argument("--provider", default=None)
    args = ap.parse_args()
    global PROVIDER
    PROVIDER = args.provider
    model = (
        args.model
        or {
            "openrouter": OR_MODEL,
            "fireworks": "accounts/fireworks/models/kimi-k2p6",
            "moonshot": "kimi-k2.6",
        }[args.route]
    )
    if args.cmd == "models":
        cmd_models()
    elif args.cmd == "tokens":
        cmd_tokens(args.route, model, [int(x) for x in args.counts.split(",")], args.px)
    else:
        cmd_lastline(args.route, model, [int(x) for x in args.counts.split(",")])


if __name__ == "__main__":
    main()
