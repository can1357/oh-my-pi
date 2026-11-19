"""Provider-neutral LLM client: Anthropic Messages + OpenAI Responses.

Neutral message shape: [{"role": str, "content": [block, ...]}] where block is
  {"text": str}                      - text block
  {"image_path": Path, "cache": bool} - PNG by path; cache marks the prompt-cache
                                        breakpoint (Anthropic only; OpenAI caches
                                        automatically)

Normalized usage: {"in", "out", "cache_w", "cache_r", "reasoning"}.
"""

import base64
import json
import time
import urllib.error
import urllib.request
from pathlib import Path

ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
OPENAI_URL = "https://api.openai.com/v1/responses"
ANTHROPIC_VERSION = "2023-06-01"


def load_env_key(var: str, env_path: str = "~/.env") -> str:
    """Last assignment wins (mirrors shell sourcing)."""
    key = None
    for line in Path(env_path).expanduser().read_text().splitlines():
        line = line.strip()
        if line.startswith("export "):
            line = line[len("export ") :]
        if line.startswith(f"{var}="):
            key = line.split("=", 1)[1].strip().strip("'\"")
    if not key:
        raise SystemExit(f"no {var} in {env_path}")
    return key


def _post(url: str, body: dict, headers: dict, retries: int = 4) -> dict:
    payload = json.dumps(body).encode()
    req = urllib.request.Request(
        url, data=payload, headers={"content-type": "application/json", **headers}
    )
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=600) as resp:
                raw = resp.read()
            return json.loads(raw)
        except urllib.error.HTTPError as err:
            detail = err.read().decode(errors="replace")[:500]
            if err.code in (408, 429, 500, 502, 503, 529) and attempt < retries:
                wait = 2.0 * 2**attempt
                print(f"  HTTP {err.code}, retrying in {wait:.0f}s: {detail[:120]}")
                time.sleep(wait)
                continue
            raise SystemExit(f"API error {err.code} ({url}): {detail}") from err
        except (json.JSONDecodeError, TimeoutError, urllib.error.URLError) as err:
            if attempt < retries:
                wait = 2.0 * 2**attempt
                print(f"  bad response ({type(err).__name__}), retrying in {wait:.0f}s")
                time.sleep(wait)
                continue
            raise
    raise AssertionError("unreachable")


def _png_b64(path: Path) -> str:
    return base64.b64encode(path.read_bytes()).decode()


# --- Anthropic ---


def _anthropic_blocks(blocks: list[dict]) -> list[dict]:
    out = []
    for b in blocks:
        if "text" in b:
            item: dict = {"type": "text", "text": b["text"]}
        else:
            item = {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": "image/png",
                    "data": _png_b64(b["image_path"]),
                },
            }
        if b.get("cache"):
            item["cache_control"] = {"type": "ephemeral"}
        out.append(item)
    return out


def _anthropic_complete(
    api_key: str,
    model: str,
    messages: list[dict],
    system: str | None,
    max_tokens: int,
    effort: str | None,
) -> tuple[str, dict, str]:
    body: dict = {
        "model": model,
        "max_tokens": max_tokens,
        "messages": [
            {"role": m["role"], "content": _anthropic_blocks(m["content"])}
            for m in messages
        ],
    }
    if system:
        body["system"] = system
    headers = {"x-api-key": api_key, "anthropic-version": ANTHROPIC_VERSION}
    if effort:
        body["output_config"] = {"effort": effort}
        headers["anthropic-beta"] = "effort-2025-11-24"
    out = _post(ANTHROPIC_URL, body, headers)
    text = "".join(b.get("text", "") for b in out["content"] if b.get("type") == "text")
    u = out.get("usage", {})
    usage = {
        "in": u.get("input_tokens", 0),
        "out": u.get("output_tokens", 0),
        "cache_w": u.get("cache_creation_input_tokens", 0),
        "cache_r": u.get("cache_read_input_tokens", 0),
        "reasoning": (u.get("output_tokens_details") or {}).get("thinking_tokens", 0),
    }
    return text, usage, out.get("stop_reason", "")


# --- OpenAI (Responses API) ---


def _openai_content(blocks: list[dict], role: str) -> list[dict]:
    text_type = "output_text" if role == "assistant" else "input_text"
    out = []
    for b in blocks:
        if "text" in b:
            out.append({"type": text_type, "text": b["text"]})
        else:
            out.append(
                {
                    "type": "input_image",
                    "image_url": f"data:image/png;base64,{_png_b64(b['image_path'])}",
                    "detail": "original",
                }
            )
    return out


def _openai_usage(out: dict) -> dict:
    u = out.get("usage", {})
    cached = (u.get("input_tokens_details") or {}).get("cached_tokens", 0)
    return {
        "in": u.get("input_tokens", 0) - cached,
        "out": u.get("output_tokens", 0),
        "cache_w": 0,
        "cache_r": cached,
        "reasoning": (u.get("output_tokens_details") or {}).get("reasoning_tokens", 0),
    }


def _openai_output_text(out: dict) -> str:
    parts = []
    for item in out.get("output", []):
        if item.get("type") == "message":
            for c in item.get("content", []):
                if c.get("type") == "output_text":
                    parts.append(c.get("text", ""))
    return "".join(parts)


def _openai_complete(
    api_key: str,
    model: str,
    messages: list[dict],
    system: str | None,
    max_tokens: int,
    effort: str | None,
    extra_input_items: list[dict] | None = None,
) -> tuple[str, dict, str]:
    input_items: list[dict] = list(extra_input_items or [])
    input_items += [
        {"role": m["role"], "content": _openai_content(m["content"], m["role"])}
        for m in messages
    ]
    body: dict = {
        "model": model,
        "input": input_items,
        "max_output_tokens": max_tokens,
        "store": False,
    }
    if system:
        body["instructions"] = system
    if effort:
        body["reasoning"] = {"effort": "high" if effort in ("xhigh", "max") else effort}
    out = _post(OPENAI_URL, body, {"authorization": f"Bearer {api_key}"})
    status = out.get("status", "")
    stop = (
        "max_tokens"
        if (out.get("incomplete_details") or {}).get("reason") == "max_output_tokens"
        else status
    )
    return _openai_output_text(out), _openai_usage(out), stop


def openai_compact(
    api_key: str, model: str, messages: list[dict]
) -> tuple[list[dict], dict]:
    """POST /responses/compact: returns (compacted output items, usage)."""
    body = {
        "model": model,
        "input": [
            {"role": m["role"], "content": _openai_content(m["content"], m["role"])}
            for m in messages
        ],
    }
    out = _post(f"{OPENAI_URL}/compact", body, {"authorization": f"Bearer {api_key}"})
    return out.get("output", []), _openai_usage(out)


# --- OpenRouter (chat completions) ---

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"


def _openrouter_complete(
    api_key: str,
    model: str,
    messages: list[dict],
    system: str | None,
    max_tokens: int,
    effort: str | None,
) -> tuple[str, dict, str]:
    def content(blocks: list[dict]) -> list[dict]:
        out = []
        for b in blocks:
            if "text" in b:
                out.append({"type": "text", "text": b["text"]})
            else:
                out.append(
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:image/png;base64,{_png_b64(b['image_path'])}"
                        },
                    }
                )
        return out

    chat_messages = [
        {"role": m["role"], "content": content(m["content"])} for m in messages
    ]
    if system:
        chat_messages.insert(0, {"role": "system", "content": system})
    body: dict = {"model": model, "messages": chat_messages, "max_tokens": max_tokens}
    if effort == "none":
        body["reasoning"] = {
            "enabled": False
        }  # OpenRouter's disable switch; effort "none" is not a valid level
    elif effort:
        body["reasoning"] = {"effort": "high" if effort in ("xhigh", "max") else effort}
    out = _post(OPENROUTER_URL, body, {"authorization": f"Bearer {api_key}"})
    choice = (out.get("choices") or [{}])[0]
    text = (choice.get("message") or {}).get("content") or ""
    if isinstance(text, list):  # some providers return content parts
        text = "".join(p.get("text", "") for p in text if isinstance(p, dict))
    u = out.get("usage", {})
    usage = {
        "in": u.get("prompt_tokens", 0)
        - (u.get("prompt_tokens_details") or {}).get("cached_tokens", 0),
        "out": u.get("completion_tokens", 0),
        "cache_w": 0,
        "cache_r": (u.get("prompt_tokens_details") or {}).get("cached_tokens", 0),
        "reasoning": (u.get("completion_tokens_details") or {}).get(
            "reasoning_tokens", 0
        ),
    }
    stop = (
        "max_tokens"
        if choice.get("finish_reason") == "length"
        else (choice.get("finish_reason") or "")
    )
    return text, usage, stop


# --- dispatch ---


def is_openai(model: str) -> bool:
    return model.startswith(("gpt-", "o3", "o4", "codex"))


def is_openrouter(model: str) -> bool:
    return "/" in model


def llm_complete(
    api_keys: dict[str, str],
    model: str,
    messages: list[dict],
    system: str | None = None,
    max_tokens: int = 16384,
    effort: str | None = None,
    extra_input_items: list[dict] | None = None,
) -> tuple[str, dict, str]:
    """Returns (text, normalized usage, stop). stop == "max_tokens" means truncated."""
    if is_openrouter(model):
        if extra_input_items:
            raise ValueError(
                "extra_input_items is OpenAI-only (compacted window replay)"
            )
        return _openrouter_complete(
            api_keys["openrouter"], model, messages, system, max_tokens, effort
        )
    if is_openai(model):
        return _openai_complete(
            api_keys["openai"],
            model,
            messages,
            system,
            max_tokens,
            effort,
            extra_input_items,
        )
    if extra_input_items:
        raise ValueError("extra_input_items is OpenAI-only (compacted window replay)")
    return _anthropic_complete(
        api_keys["anthropic"], model, messages, system, max_tokens, effort
    )
