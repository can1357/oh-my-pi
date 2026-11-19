# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow"]
# ///
"""Kimi K2.6 resolution billing probe (KimiK26Bench scratch file).

Resizes one production 8on16-bw frame to candidate square sizes and records
prompt_tokens per route. Per the MoonViT patch rule (patch 14, 2x2 merge =>
28px/token side), an SxS image should bill ~ceil(S/28)^2 tokens. A bill far
below that means the provider silently downscaled.

  uv run --with pillow python bench_kimi_probe.py --route openrouter
  uv run --with pillow python bench_kimi_probe.py --route fireworks
"""

import argparse
import math
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from providers import _png_b64, _post, load_env_key  # noqa: E402
from run import CACHE  # noqa: E402

ROUTES = {
    "openrouter": (
        "https://openrouter.ai/api/v1/chat/completions",
        "OPENROUTER_API_KEY",
        "moonshotai/kimi-k2.6",
    ),
    "fireworks": (
        "https://api.fireworks.ai/inference/v1/chat/completions",
        "FIREWORKS_API_KEY",
        "accounts/fireworks/models/kimi-k2p6",
    ),
}


def source_frame() -> Path:
    for d in sorted(CACHE.glob("prod-frames-8on16-bw-*")):
        pngs = sorted(d.glob("page-*.png"))
        if pngs:
            return pngs[0]
    raise SystemExit("no production 8on16-bw frame found in cache")


def frame_at(px: int) -> Path:
    from PIL import Image

    out_dir = CACHE / "bench-kimi-probe"
    out_dir.mkdir(exist_ok=True)
    q = out_dir / f"frame-{px}.png"
    if not q.exists():
        Image.open(source_frame()).resize((px, px), Image.LANCZOS).save(q)
    return q


def ask(route: str, content: list[dict]) -> dict:
    url, key_var, model = ROUTES[route]
    body = {
        "model": model,
        "messages": [{"role": "user", "content": content}],
        "max_tokens": 64,
    }
    out = _post(
        url,
        body,
        {"authorization": f"Bearer {load_env_key(key_var)}", "user-agent": "bench/1.0"},
    )
    choice = (out.get("choices") or [{}])[0]
    return {
        "usage": out.get("usage", {}),
        "provider": out.get("provider"),
        "finish": choice.get("finish_reason"),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--route", default="openrouter", choices=sorted(ROUTES))
    ap.add_argument("--sizes", default="1568,1792,2048,2240,2560,3136")
    args = ap.parse_args()

    tail = {"type": "text", "text": "Reply with the single word OK."}
    base = ask(args.route, [tail])["usage"].get("prompt_tokens", 0)
    print(f"route={args.route} text-only prompt_tokens={base}")
    for px in (int(s) for s in args.sizes.split(",")):
        img = {
            "type": "image_url",
            "image_url": {"url": f"data:image/png;base64,{_png_b64(frame_at(px))}"},
        }
        try:
            r = ask(args.route, [img, tail])
        except SystemExit as e:
            print(f"px={px:>4} ERROR {e}")
            continue
        tok = r["usage"].get("prompt_tokens", 0) - base
        side = math.ceil(px / 28)
        expect = side * side
        verdict = "linear" if tok >= 0.92 * expect else "DOWNSCALED"
        print(
            f"px={px:>4} frame_tokens={tok:>6} expect~{expect:>6} ({side}^2) ratio={tok / expect:.2f} "
            f"{verdict} provider={r.get('provider')}"
        )


if __name__ == "__main__":
    main()
