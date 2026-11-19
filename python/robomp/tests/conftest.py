"""Common pytest fixtures."""

from __future__ import annotations

from pathlib import Path

import pytest

from robomp.config import Settings, reset_settings_cache
from robomp.dashboard import reset_index_cache, static_dir
from robomp.db import Database, close_database

# Minimum HTML the dashboard handler needs to render: `<title>` plus a script
# block carrying the `__ROBOMP_CONFIG__` sentinel. The real Vite-built bundle
# adds JS/CSS asset links; tests only care about the rendering contract.
_PLACEHOLDER_INDEX_HTML = (
    "<!doctype html>\n"
    '<html lang="en">\n'
    '  <head><meta charset="utf-8"><title>robomp</title></head>\n'
    "  <body>\n"
    '    <div id="app"></div>\n'
    '    <script id="robomp-config" type="application/json">__ROBOMP_CONFIG__</script>\n'
    "  </body>\n"
    "</html>\n"
)


@pytest.fixture(autouse=True, scope="session")
def _ensure_dashboard_bundle() -> None:
    """Guarantee a renderable dashboard bundle for the whole session.

    The real bundle is produced by `bun run web:build`; CI and fresh clones
    might not have run it yet. We only synthesise an `index.html` when one
    isn't already present, so a developer's locally-built bundle isn't
    clobbered by the test run.
    """
    directory = static_dir()
    index = directory / "index.html"
    if not index.exists():
        index.write_text(_PLACEHOLDER_INDEX_HTML, encoding="utf-8")
    reset_index_cache()


@pytest.fixture(autouse=True)
def _open_tmp_path_for_slot_traversal(tmp_path: Path) -> None:
    """Grant traverse (`+x`) on tmp_path's root-owned ancestors so slot
    subprocesses can reach the workspace.

    pytest's default ``tmp_path`` lives under ``/tmp/pytest-of-<user>/`` with
    mode ``0700``. On macOS dev that's irrelevant (no slot subprocess ever
    drops uid). On Linux+root the slot UID (e.g. 2001) is non-zero and
    every directory between ``/`` and the workspace needs at least the
    `o+x` bit or the slot's stat fails with EACCES. Adds `o+x` (NOT `o+r`)
    so directory contents stay private; only path-traversal is allowed.
    """
    import os
    import platform
    import stat

    if platform.system() != "Linux" or os.geteuid() != 0:
        return
    cursor = tmp_path.resolve()
    while cursor != cursor.parent:
        try:
            st = cursor.stat()
        except FileNotFoundError:
            break
        if not stat.S_ISDIR(st.st_mode):
            break
        if not (st.st_mode & 0o001):
            try:
                cursor.chmod(st.st_mode | 0o001)
            except PermissionError:
                break
        cursor = cursor.parent


def _baseline_env(tmp_path: Path) -> dict[str, str]:
    return {
        # Orchestrator-mode: no PAT in this container; talk to gh-proxy instead.
        "ROBOMP_GH_PROXY_URL": "http://gh-proxy.invalid:8081",
        "ROBOMP_GH_PROXY_HMAC_KEY": "test-hmac-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "GITHUB_WEBHOOK_SECRET": "test-webhook-secret",
        "ROBOMP_BOT_LOGIN": "robomp-bot",
        "ROBOMP_GIT_AUTHOR_NAME": "robomp-bot",
        "ROBOMP_GIT_AUTHOR_EMAIL": "robomp-bot@example.invalid",
        "ROBOMP_REPO_ALLOWLIST": "octo/widget",
        "ROBOMP_MODEL": "anthropic/claude-sonnet-4-5",
        "ROBOMP_THINKING": "high",
        "ROBOMP_WORKSPACE_ROOT": str(tmp_path / "workspaces"),
        "ROBOMP_SQLITE_PATH": str(tmp_path / "robomp.sqlite"),
        "ROBOMP_LOG_DIR": str(tmp_path / "logs"),
        # Production default is `/data/cache/pi-natives` (provisioned by the
        # container entrypoint). Tests need a writable, isolated path; we also
        # default-disable the cache so its background GC loop doesn't add
        # noise to event-dispatcher timing assertions. Tests that want the
        # cache flip `ROBOMP_NATIVES_CACHE_ENABLED=true` explicitly.
        "ROBOMP_NATIVES_CACHE_ROOT": str(tmp_path / "natives-cache"),
        "ROBOMP_NATIVES_CACHE_ENABLED": "false",
        # Same reasoning for the issue-index reconciler: its first tick would
        # spin connect-retries against the .invalid proxy URL inside server
        # tests. Tests that want it construct IssueIndexSync directly.
        "ROBOMP_ISSUE_INDEX_SYNC_SECONDS": "0",
    }


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> dict[str, str]:
    env = _baseline_env(tmp_path)
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    # Defensive: a stray `.env` or shell export must not flip us into PAT mode.
    # `monkeypatch.delenv` would let pydantic_settings fall back to the .env
    # file; setenv("") is what actually shadows the file value, and the
    # `_blank_token_disables` validator treats empty strings as unset.
    monkeypatch.setenv("GITHUB_TOKEN", "")
    monkeypatch.delenv("ROBOMP_PROVIDER", raising=False)
    monkeypatch.setenv("ROBOMP_REPLAY_TOKEN", "")
    reset_settings_cache()
    yield env
    reset_settings_cache()
    close_database()


@pytest.fixture
def proxy_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> dict[str, str]:
    """Baseline env for the gh-proxy container: holds the PAT, no proxy vars."""
    baseline = _baseline_env(tmp_path)
    baseline.pop("ROBOMP_GH_PROXY_URL", None)
    baseline.pop("ROBOMP_GH_PROXY_HMAC_KEY", None)
    baseline["GITHUB_TOKEN"] = "ghp_test_token_value_xxxxxxxxxxxxxxxx"
    for key, value in baseline.items():
        monkeypatch.setenv(key, value)
    # Same defense-in-depth as `env`: setenv("") rather than delenv so
    # pydantic_settings doesn't fall back to the on-disk `.env` file.
    monkeypatch.setenv("ROBOMP_GH_PROXY_URL", "")
    monkeypatch.setenv("ROBOMP_GH_PROXY_HMAC_KEY", "")
    monkeypatch.delenv("ROBOMP_PROVIDER", raising=False)
    monkeypatch.setenv("ROBOMP_REPLAY_TOKEN", "")
    reset_settings_cache()
    yield baseline
    reset_settings_cache()
    close_database()


@pytest.fixture
def settings(env: dict[str, str]) -> Settings:
    cfg = Settings()  # type: ignore[call-arg]
    cfg.ensure_paths()
    return cfg


@pytest.fixture
def db(tmp_path: Path) -> Database:
    path = tmp_path / "test.sqlite"
    database = Database(path)
    yield database
    database.close()
