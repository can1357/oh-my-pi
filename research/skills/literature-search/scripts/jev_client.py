"""TypeSafe Jev (System One) client - stdlib HTTP, rate-limit-aware retries.

One endpoint: POST https://api.typesafe.ai/v1/systemone with {state, model,
questions}; answers come back as typed Noul/Choice/Score distributions.
Retries 429/5xx/timeouts up to 4 attempts with exponential backoff honoring a
numeric Retry-After; notices go to stderr only so stdout stays parseable
(same policy as _http.py). The API key is resolved from TYPESAFE_API_KEY or
~/.research-harness/config.env and is never printed or stored.
"""
import json
import os
import pathlib
import sys
import time
import urllib.error
import urllib.request

API_URL = "https://api.typesafe.ai/v1/systemone"
MODELS_URL = "https://api.typesafe.ai/v1/models"
CONFIG_ENV = pathlib.Path.home() / ".research-harness" / "config.env"
RETRY_STATUSES = frozenset({429, 500, 502, 503, 504})
MAX_ATTEMPTS = 4
BACKOFF_CAP = 60.0


class JevError(Exception):
    """Base error for Jev API failures (unreachable, unexpected status)."""


class JevUsageError(JevError):
    """400/422 - the request itself is invalid (model, questions, schema)."""


class JevAuthError(JevError):
    """401/403 - missing or rejected API key."""


def resolve_key(config_path=None):
    """API key from TYPESAFE_API_KEY, else a KEY=value line in config.env."""
    env = os.environ.get("TYPESAFE_API_KEY")
    if env:
        return env
    path = pathlib.Path(config_path) if config_path else CONFIG_ENV
    if not path.exists():
        return None
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line.startswith("TYPESAFE_API_KEY="):
            return line.split("=", 1)[1].strip().strip('"').strip("'") or None
    return None


def _detail(body_bytes):
    """Human-readable message out of an error body, whatever shape it has."""
    try:
        payload = json.loads(body_bytes)
    except ValueError:
        return (body_bytes or b"").decode(errors="replace")
    detail = payload.get("detail", payload) if isinstance(payload, dict) else payload
    if isinstance(detail, dict):
        return detail.get("message") or json.dumps(detail)
    return str(detail)


def _post(url, payload, api_key, timeout):
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(), method="POST",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
    )
    last_err = None
    for attempt in range(MAX_ATTEMPTS):
        retry_after = None
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            body = e.read()
            if e.code in (400, 422):
                raise JevUsageError(_detail(body)) from None
            if e.code in (401, 403):
                raise JevAuthError(f"Jev rejected the API key (HTTP {e.code})") from None
            if e.code not in RETRY_STATUSES:
                raise JevError(f"Jev API HTTP {e.code}: {_detail(body)[:200]}") from None
            last_err = e
            retry_after = e.headers.get("Retry-After")
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            last_err = e
        if attempt == MAX_ATTEMPTS - 1:
            break
        delay = min(3.0 * 3**attempt, BACKOFF_CAP)
        if retry_after:
            try:
                delay = min(max(delay, float(retry_after)), BACKOFF_CAP)
            except ValueError:
                pass
        print(f"jev_client: {last_err}; retry {attempt + 1}/{MAX_ATTEMPTS - 1} in {delay:.0f}s",
              file=sys.stderr)
        time.sleep(delay)
    raise JevError(f"Jev API unreachable after {MAX_ATTEMPTS} attempts: {last_err}")


def fan_out(state, questions, api_key, model="jev-latest", timeout=90):
    """One call, many questions. Returns the parsed response ('answers', 'model')."""
    return _post(API_URL, {"state": state, "model": model, "questions": questions},
                 api_key, timeout)


def list_models(api_key, timeout=30):
    """GET /v1/models -> list of model names (used by research doctor)."""
    req = urllib.request.Request(MODELS_URL, headers={"Authorization": f"Bearer {api_key}"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return [m["name"] for m in json.loads(resp.read())["models"]]
