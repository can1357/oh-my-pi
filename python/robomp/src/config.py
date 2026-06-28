"""Env-driven configuration for roboomp."""

from __future__ import annotations

import random
from functools import cache
from pathlib import Path
from typing import Literal

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

ThinkingLevel = Literal["off", "low", "medium", "high", "xhigh"]


class Settings(BaseSettings):
    """Strongly-typed runtime configuration.

    Loaded from process env, optionally pre-populated by `.env`.
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # GitHub
    # `github_token` is REQUIRED on the gh-proxy side (it holds the PAT) and
    # OPTIONAL on the orchestrator side when `gh_proxy_url` is configured —
    # the orchestrator then talks to gh-proxy over HMAC RPC and never sees
    # the PAT. Validated end-to-end in `_validate_proxy_or_pat` below.
    github_token: SecretStr | None = Field(None, alias="GITHUB_TOKEN")
    github_webhook_secret: SecretStr = Field(..., alias="GITHUB_WEBHOOK_SECRET")
    bot_login: str = Field(..., alias="ROBOMP_BOT_LOGIN")
    git_author_name: str | None = Field(None, alias="ROBOMP_GIT_AUTHOR_NAME")
    git_author_email: str = Field(..., alias="ROBOMP_GIT_AUTHOR_EMAIL")
    repo_allowlist_raw: str = Field("", alias="ROBOMP_REPO_ALLOWLIST")
    pr_review_enabled: bool = Field(True, alias="ROBOMP_PR_REVIEW_ENABLED")
    # PR review trigger. "open" (default) reviews incoming PRs on
    # opened/reopened/ready_for_review. "vouched_label" DEFERS review until the
    # vouch GitHub Action labels the PR `vouch_review_label`, so robomp reviews
    # only PRs that survive the vouch gate. `pr_review_enabled` remains the
    # master switch (False disables review under either trigger).
    pr_review_trigger: Literal["open", "vouched_label"] = Field("open", alias="ROBOMP_PR_REVIEW_TRIGGER")
    vouch_review_label: str = Field("vouched", alias="ROBOMP_VOUCH_REVIEW_LABEL")
    # In vouched_label mode, only `labeled` events from this actor trigger a
    # review, so a manual label by a triage/maintainer cannot bypass the gate.
    # Default is the actor for the stock GITHUB_TOKEN; set to your App's bot
    # login (e.g. "vouch-bot[bot]") if the vouch workflow labels via an App.
    vouch_review_labeler: str = Field("github-actions[bot]", alias="ROBOMP_VOUCH_REVIEW_LABELER")

    # gh-proxy. Set BOTH to route GitHub through the proxy; leave both empty
    # to keep PAT-on-orchestrator behavior. Mixing the two (PAT + proxy) is
    # rejected to prevent silent fallback to direct GitHub access.
    gh_proxy_url: str | None = Field(None, alias="ROBOMP_GH_PROXY_URL")
    gh_proxy_hmac_key: SecretStr | None = Field(None, alias="ROBOMP_GH_PROXY_HMAC_KEY")
    # Bind address for `python -m robomp.proxy serve`. Internal-only by
    # default; gh-proxy never exposes a host port.
    gh_proxy_bind_host: str = Field("0.0.0.0", alias="ROBOMP_GH_PROXY_BIND_HOST")
    gh_proxy_bind_port: int = Field(8081, alias="ROBOMP_GH_PROXY_BIND_PORT")

    # gh-proxy: maximum request body size (bytes). Bodies larger than this
    # are rejected with 413 BEFORE the proxy reads them into memory. Tight
    # by design — every typed endpoint payload fits in a few KB.
    gh_proxy_max_body_bytes: int = Field(1 << 20, alias="ROBOMP_GH_PROXY_MAX_BODY_BYTES")
    # Hard wall-clock budget (seconds) for a single git subprocess invoked
    # by gh-proxy. Bounds how long a hung git can pin a request handler.
    gh_proxy_git_timeout_seconds: float = Field(60.0, alias="ROBOMP_GH_PROXY_GIT_TIMEOUT_SECONDS")

    # Model selection
    model: str = Field("anthropic/claude-sonnet-4-6", alias="ROBOMP_MODEL")
    provider: str | None = Field(None, alias="ROBOMP_PROVIDER")
    thinking_level: ThinkingLevel = Field("high", alias="ROBOMP_THINKING")

    # Runtime
    max_concurrency: int = Field(8, alias="ROBOMP_MAX_CONCURRENCY")
    task_timeout_seconds: float = Field(2400.0, alias="ROBOMP_TASK_TIMEOUT_SECONDS")
    task_timeout_hard_grace_seconds: float = Field(60.0, alias="ROBOMP_TASK_TIMEOUT_HARD_GRACE_SECONDS")
    request_timeout_seconds: float = Field(120.0, alias="ROBOMP_REQUEST_TIMEOUT_SECONDS")

    # Automatic retry of transiently-failed events. When an event handler
    # raises (and it isn't an operator cancel or a shutdown interrupt), the
    # dispatcher re-queues the delivery with escalating backoff instead of
    # giving up, so ephemeral failures (git fetch timeouts, upstream 5xx/429,
    # flaky RPC startup) self-heal. After `event_max_retries` retries the row
    # stays `failed`. `event_retry_delays_seconds` is a comma-separated backoff
    # schedule: the Nth retry waits the Nth value (last value repeats), jittered.
    # Set `event_max_retries=0` to restore fail-fast behavior.
    event_max_retries: int = Field(3, alias="ROBOMP_EVENT_MAX_RETRIES")
    event_retry_delays_raw: str = Field("30,120,600", alias="ROBOMP_EVENT_RETRY_DELAYS_SECONDS")
    # Premature-end reminder. When a `triage_issue` turn ends without the
    # agent having reached a terminal tool (`gh_open_pr`,
    # `mark_unable_to_reproduce`, `abort_task`) for a `bug`/`documentation`
    # classification, the driver sends up to this many "you stopped before
    # opening a PR — continue" reminder prompts into the same omp session.
    # Set to 0 to disable.
    task_completion_max_reminders: int = Field(2, alias="ROBOMP_TASK_COMPLETION_MAX_REMINDERS")
    omp_command: str = Field("omp", alias="ROBOMP_OMP_COMMAND")

    # Graceful shutdown (Phase B). On SIGTERM the dispatcher stops claiming
    # new work, then waits up to `drain` seconds for in-flight events to
    # complete cleanly; any still running after that get their omp
    # subprocess killed and the row left in `running` so it requeues on
    # next start. Sum of both MUST stay below the compose `stop_grace_period`.
    shutdown_drain_timeout_seconds: float = Field(25.0, alias="ROBOMP_SHUTDOWN_DRAIN_TIMEOUT_SECONDS")
    shutdown_kill_timeout_seconds: float = Field(5.0, alias="ROBOMP_SHUTDOWN_KILL_TIMEOUT_SECONDS")

    # Paths
    workspace_root: Path = Field(Path("./data/workspaces"), alias="ROBOMP_WORKSPACE_ROOT")
    sqlite_path: Path = Field(Path("./data/robomp.sqlite"), alias="ROBOMP_SQLITE_PATH")
    log_dir: Path = Field(Path("./data/logs"), alias="ROBOMP_LOG_DIR")

    # Server
    bind_host: str = Field("0.0.0.0", alias="ROBOMP_BIND_HOST")
    bind_port: int = Field(8080, alias="ROBOMP_BIND_PORT")

    # Dev-only replay header value; if empty, /replay is disabled
    replay_token: SecretStr | None = Field(None, alias="ROBOMP_REPLAY_TOKEN")

    # Per-submitter rate limiting. `window_seconds` defines the rolling window;
    # `default` is the per-window cap for unknown/first-time submitters;
    # `contributor` is the cap for accounts whose GitHub author_association is
    # `CONTRIBUTOR` (i.e. already has a merged PR). `unlimited_raw` is a
    # comma-separated allowlist of logins that bypass the limiter entirely;
    # accounts with author_association OWNER/MEMBER/COLLABORATOR also bypass.
    rate_limit_window_seconds: float = Field(3600.0, alias="ROBOMP_RATE_LIMIT_WINDOW_SECONDS")
    rate_limit_default: int = Field(3, alias="ROBOMP_RATE_LIMIT_DEFAULT")
    rate_limit_contributor: int = Field(10, alias="ROBOMP_RATE_LIMIT_CONTRIBUTOR")
    rate_limit_unlimited_raw: str = Field("", alias="ROBOMP_RATE_LIMIT_UNLIMITED")
    # Logins (comma-separated, `@` prefix optional, case-insensitive) whose `@bot_login`
    # mentions are treated as authoritative directives. These accounts also
    # bypass rate limiting regardless of `author_association`.
    maintainer_logins_raw: str = Field("", alias="ROBOMP_MAINTAINER_LOGINS")
    # Bot logins (e.g. chatgpt-codex-connector) whose comments/reviews are
    # treated as authoritative directives without requiring an `@bot` mention.
    # Comma-separated; `@` prefix optional.
    reviewer_bots_raw: str = Field("", alias="ROBOMP_REVIEWER_BOTS")

    # Question auto-close. When the bot answers an issue classified as
    # `question`, the comment is suffixed with a 👎-to-keep-open prompt and a
    # row is scheduled in `pending_closures`. The scheduler closes the issue
    # after `question_autoclose_hours` unless the issue author downvoted the
    # comment, a human follow-up arrived, or the issue was closed externally.
    # Set `question_autoclose_enabled=False` (or hours <= 0) to disable.
    question_autoclose_enabled: bool = Field(True, alias="ROBOMP_QUESTION_AUTOCLOSE_ENABLED")
    question_autoclose_hours: float = Field(4.0, alias="ROBOMP_QUESTION_AUTOCLOSE_HOURS")
    question_autoclose_scan_seconds: float = Field(60.0, alias="ROBOMP_QUESTION_AUTOCLOSE_SCAN_SECONDS")

    # pi-natives build-output cache. Hardlinks pre-built
    # `packages/natives/native/*.node` (and its companions) into new
    # workspaces keyed by the git tree-hashes of inputs that determine the
    # build output. Misses are captured automatically when a task that
    # finishes successfully has fresh artifacts. Disable to fall back to
    # per-workspace builds.
    natives_cache_enabled: bool = Field(True, alias="ROBOMP_NATIVES_CACHE_ENABLED")
    natives_cache_root: Path = Field(Path("/data/cache/pi-natives"), alias="ROBOMP_NATIVES_CACHE_ROOT")
    natives_cache_max_entries_per_repo: int = Field(8, alias="ROBOMP_NATIVES_CACHE_MAX_ENTRIES_PER_REPO")
    natives_cache_max_bytes: int = Field(4 * 1024**3, alias="ROBOMP_NATIVES_CACHE_MAX_BYTES")
    natives_cache_gc_interval_seconds: float = Field(3600.0, alias="ROBOMP_NATIVES_CACHE_GC_INTERVAL_SECONDS")

    @field_validator("bot_login", mode="after")
    @classmethod
    def _require_bot_login(cls, value: str) -> str:
        cleaned = value.strip().removeprefix("@").lower()
        if cleaned.endswith("[bot]"):
            cleaned = cleaned[:-5]
        if not cleaned:
            raise ValueError("ROBOMP_BOT_LOGIN must be a non-empty GitHub login")
        return cleaned

    @field_validator("replay_token", mode="before")
    @classmethod
    def _blank_replay_disables(cls, value: object) -> object:
        # Treat empty/whitespace strings as 'disabled'. Without this, an empty
        # ROBOMP_REPLAY_TOKEN becomes SecretStr("") which the server would
        # happily compare against an empty X-Robomp-Replay-Token header.
        if isinstance(value, str) and not value.strip():
            return None
        if hasattr(value, "get_secret_value"):
            inner = value.get_secret_value()  # type: ignore[attr-defined]
            if isinstance(inner, str) and not inner.strip():
                return None
        return value

    @field_validator("github_token", mode="before")
    @classmethod
    def _blank_token_disables(cls, value: object) -> object:
        """Treat empty/whitespace `GITHUB_TOKEN` as 'unset' so proxy-only
        deployments don't have to remove the env var."""
        if isinstance(value, str) and not value.strip():
            return None
        if hasattr(value, "get_secret_value"):
            inner = value.get_secret_value()  # type: ignore[attr-defined]
            if isinstance(inner, str) and not inner.strip():
                return None
        return value

    @field_validator("gh_proxy_url", mode="before")
    @classmethod
    def _blank_proxy_url_disables(cls, value: object) -> object:
        if isinstance(value, str) and not value.strip():
            return None
        return value

    @field_validator("gh_proxy_hmac_key", mode="before")
    @classmethod
    def _blank_proxy_key_disables(cls, value: object) -> object:
        if isinstance(value, str) and not value.strip():
            return None
        if hasattr(value, "get_secret_value"):
            inner = value.get_secret_value()  # type: ignore[attr-defined]
            if isinstance(inner, str) and not inner.strip():
                return None
        return value

    @model_validator(mode="after")
    def _validate_proxy_or_pat(self) -> Settings:
        """Enforce mutual exclusion between PAT and proxy mode.

        - Both set → reject (silent fallback to direct GitHub would defeat
          the isolation goal).
        - Proxy URL set but no HMAC key (or vice versa) → reject (gh-proxy
          would either be unauthenticated or unreachable).
        - Neither set → also reject; SOMETHING needs to talk to GitHub.
        """
        has_token = self.github_token is not None
        has_url = bool(self.gh_proxy_url)
        has_key = self.gh_proxy_hmac_key is not None
        if has_token and has_url:
            raise ValueError(
                "GITHUB_TOKEN and ROBOMP_GH_PROXY_URL are mutually exclusive — "
                "set ONE to choose between direct-PAT and gh-proxy modes."
            )
        if has_url != has_key:
            raise ValueError(
                "ROBOMP_GH_PROXY_URL and ROBOMP_GH_PROXY_HMAC_KEY must both be set together (or both empty)."
            )
        if not has_token and not has_url:
            raise ValueError(
                "no GitHub access configured: set GITHUB_TOKEN, or set "
                "ROBOMP_GH_PROXY_URL + ROBOMP_GH_PROXY_HMAC_KEY to use gh-proxy."
            )
        return self

    @field_validator("repo_allowlist_raw", mode="before")
    @classmethod
    def _coerce_allowlist(cls, v: object) -> str:
        if v is None:
            return ""
        if isinstance(v, str):
            return v
        if isinstance(v, (list, tuple)):
            return ",".join(str(item) for item in v)
        return str(v)

    @property
    def repo_allowlist(self) -> frozenset[str]:
        items = [piece.strip().lower() for piece in self.repo_allowlist_raw.split(",")]
        return frozenset(item for item in items if item)

    @field_validator("rate_limit_unlimited_raw", mode="before")
    @classmethod
    def _coerce_unlimited(cls, v: object) -> str:
        if v is None:
            return ""
        if isinstance(v, str):
            return v
        if isinstance(v, (list, tuple)):
            return ",".join(str(item) for item in v)
        return str(v)

    @property
    def rate_limit_unlimited(self) -> frozenset[str]:
        items = [piece.strip().lstrip("@").lower() for piece in self.rate_limit_unlimited_raw.split(",")]
        return frozenset(item for item in items if item)

    @field_validator("maintainer_logins_raw", mode="before")
    @classmethod
    def _coerce_maintainers(cls, v: object) -> str:
        if v is None:
            return ""
        if isinstance(v, str):
            return v
        if isinstance(v, (list, tuple)):
            return ",".join(str(item) for item in v)
        return str(v)

    @field_validator("reviewer_bots_raw", mode="before")
    @classmethod
    def _coerce_reviewer_bots(cls, v: object) -> str:
        if v is None:
            return ""
        if isinstance(v, str):
            return v
        if isinstance(v, (list, tuple)):
            return ",".join(str(item) for item in v)
        return str(v)

    @property
    def reviewer_bots(self) -> frozenset[str]:
        items = [piece.strip().lstrip("@").lower() for piece in self.reviewer_bots_raw.split(",")]
        return frozenset(item for item in items if item)

    @property
    def maintainer_logins(self) -> frozenset[str]:
        items = [
            piece.strip().lstrip("@").lower().removesuffix("[bot]")
            for piece in self.maintainer_logins_raw.split(",")
        ]
        return frozenset(item for item in items if item)

    def allows(self, full_name: str) -> bool:
        return full_name.lower() in self.repo_allowlist

    @property
    def model_pool(self) -> tuple[str, ...]:
        """ROBOMP_MODEL may be a single id or a comma-separated list; this
        returns the parsed pool (always non-empty)."""
        items = [piece.strip() for piece in self.model.split(",") if piece.strip()]
        return tuple(items) or (self.model,)

    def pick_model(self) -> str:
        """Random selection from the pool (uniform). One-element pools return that one."""
        return random.choice(self.model_pool)

    @field_validator("event_retry_delays_raw", mode="before")
    @classmethod
    def _coerce_retry_delays(cls, v: object) -> str:
        if v is None:
            return ""
        if isinstance(v, (list, tuple)):
            return ",".join(str(item) for item in v)
        return str(v)

    @property
    def event_retry_delays(self) -> tuple[float, ...]:
        """Parsed backoff schedule in seconds; always non-empty."""
        vals: list[float] = []
        for piece in self.event_retry_delays_raw.split(","):
            piece = piece.strip()
            if not piece:
                continue
            try:
                seconds = float(piece)
            except ValueError:
                continue
            if seconds >= 0:
                vals.append(seconds)
        return tuple(vals) or (30.0,)

    def retry_delay_seconds(self, retry_index: int) -> float:
        """Backoff before the `retry_index`-th retry (1-based), with jitter.

        Clamps to the last configured delay; applies ±20% jitter so a
        fleet-wide outage doesn't replay every event in lockstep.
        """
        delays = self.event_retry_delays
        idx = min(max(retry_index, 1), len(delays)) - 1
        return delays[idx] * (0.8 + random.random() * 0.4)

    @property
    def resolved_author_name(self) -> str:
        """Falls back to bot_login if ROBOMP_GIT_AUTHOR_NAME isn't set."""
        return (self.git_author_name or self.bot_login).strip()

    def ensure_paths(self) -> None:
        for path in (self.workspace_root, self.sqlite_path.parent, self.log_dir):
            path.mkdir(parents=True, exist_ok=True)


@cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]


def reset_settings_cache() -> None:
    """Invalidate the cached settings (tests)."""
    get_settings.cache_clear()


class _ProxyEnvLoader(BaseSettings):
    """Minimal env loader for `python -m robomp.proxy serve`.

    Validates only the fields the gh-proxy container actually needs
    (PAT, HMAC key, bind address, paths). Keeping this separate from the
    orchestrator-mode `Settings()` ctor avoids dragging in
    `_validate_proxy_or_pat` and friends, which would reject a perfectly
    valid proxy deployment (no webhook secret, no bot_login, no proxy URL)
    before `serve()` can give a specific error.
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    github_token: SecretStr = Field(..., alias="GITHUB_TOKEN")
    gh_proxy_hmac_key: SecretStr = Field(..., alias="ROBOMP_GH_PROXY_HMAC_KEY")
    gh_proxy_bind_host: str = Field("0.0.0.0", alias="ROBOMP_GH_PROXY_BIND_HOST")
    gh_proxy_bind_port: int = Field(8081, alias="ROBOMP_GH_PROXY_BIND_PORT")
    workspace_root: Path = Field(Path("./data/workspaces"), alias="ROBOMP_WORKSPACE_ROOT")
    log_dir: Path = Field(Path("./data/logs"), alias="ROBOMP_LOG_DIR")
    gh_proxy_max_body_bytes: int = Field(1 << 20, alias="ROBOMP_GH_PROXY_MAX_BODY_BYTES")
    gh_proxy_git_timeout_seconds: float = Field(60.0, alias="ROBOMP_GH_PROXY_GIT_TIMEOUT_SECONDS")

    @field_validator("github_token", "gh_proxy_hmac_key", mode="before")
    @classmethod
    def _reject_blank(cls, value: object) -> object:
        if isinstance(value, str) and not value.strip():
            raise ValueError("must be a non-empty string")
        if hasattr(value, "get_secret_value"):
            inner = value.get_secret_value()  # type: ignore[attr-defined]
            if isinstance(inner, str) and not inner.strip():
                raise ValueError("must be a non-empty string")
        return value


def load_proxy_settings() -> Settings:
    """Build a `Settings` instance suitable for the gh-proxy process.

    Only the env vars the proxy actually consumes are required; the
    orchestrator-only fields (webhook secret, bot_login, …) are set to
    inert placeholders since `proxy.server` never reads them. Skips the
    `Settings()` cross-field validator (which presumes orchestrator
    semantics) by routing through `model_construct`.
    """
    loader = _ProxyEnvLoader()  # type: ignore[call-arg]
    return Settings.model_construct(
        github_token=loader.github_token,
        github_webhook_secret=SecretStr(""),
        bot_login="gh-proxy",
        git_author_email="gh-proxy@invalid",
        gh_proxy_url=None,
        gh_proxy_hmac_key=loader.gh_proxy_hmac_key,
        gh_proxy_bind_host=loader.gh_proxy_bind_host,
        gh_proxy_bind_port=loader.gh_proxy_bind_port,
        workspace_root=loader.workspace_root,
        log_dir=loader.log_dir,
        gh_proxy_max_body_bytes=loader.gh_proxy_max_body_bytes,
        gh_proxy_git_timeout_seconds=loader.gh_proxy_git_timeout_seconds,
    )
