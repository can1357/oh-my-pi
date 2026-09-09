"""Minimal Anthropic Messages API client. Key from ~/.env, no SDK."""

import base64
import json
import time
import urllib.error
import urllib.request
from pathlib import Path

API_URL = "https://api.anthropic.com/v1/messages"
API_VERSION = "2023-06-01"


def load_api_key(env_path: str = "~/.env") -> str:
    """Last ANTHROPIC_API_KEY assignment wins (mirrors shell sourcing)."""
    key = None
    for line in Path(env_path).expanduser().read_text().splitlines():
        line = line.strip()
        if line.startswith("export "):
            line = line[len("export ") :]
        if line.startswith("ANTHROPIC_API_KEY="):
            key = line.split("=", 1)[1].strip().strip("'\"")
    if not key:
        raise SystemExit(f"no ANTHROPIC_API_KEY in {env_path}")
    return key


def image_block(png_path: Path) -> dict:
    data = base64.b64encode(png_path.read_bytes()).decode()
    return {
        "type": "image",
        "source": {"type": "base64", "media_type": "image/png", "data": data},
    }


def complete(
    api_key: str,
    model: str,
    messages: list[dict],
    system: str | None = None,
    max_tokens: int = 8192,
    effort: str | None = None,
    retries: int = 4,
) -> tuple[str, dict, str]:
    """Returns (joined text content, usage dict, stop_reason).

    effort: adaptive-thinking effort (low|medium|high|xhigh|max); None = provider default.
    """
    body: dict = {"model": model, "max_tokens": max_tokens, "messages": messages}
    if system:
        body["system"] = system
    if effort:
        body["output_config"] = {"effort": effort}
    payload = json.dumps(body).encode()
    headers = {
        "content-type": "application/json",
        "x-api-key": api_key,
        "anthropic-version": API_VERSION,
    }
    if effort:
        headers["anthropic-beta"] = "effort-2025-11-24"
    req = urllib.request.Request(API_URL, data=payload, headers=headers)
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=300) as resp:
                out = json.load(resp)
            text = "".join(
                b.get("text", "") for b in out["content"] if b.get("type") == "text"
            )
            return text, out.get("usage", {}), out.get("stop_reason", "")
        except urllib.error.HTTPError as err:
            detail = err.read().decode(errors="replace")[:500]
            if err.code in (429, 500, 502, 503, 529) and attempt < retries:
                wait = 2.0 * 2**attempt
                print(f"  HTTP {err.code}, retrying in {wait:.0f}s: {detail[:120]}")
                time.sleep(wait)
                continue
            raise SystemExit(f"API error {err.code}: {detail}") from err
    raise AssertionError("unreachable")
