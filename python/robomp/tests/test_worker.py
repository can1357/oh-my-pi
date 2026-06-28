"""Resume-aware behavior of `worker._run_rpc_blocking`.

These tests swap `robomp.worker.RpcClient` for a recording fake so we can
observe the `extra_args` and `set_todos` decisions the driver takes based on
whether the workspace's omp session directory already holds a JSONL transcript.
"""

from __future__ import annotations

import asyncio
import stat
from pathlib import Path
from types import SimpleNamespace

import pytest

from robomp import worker
from robomp.config import Settings
from robomp.git_ops import DirtyState


class _FakeRpcClient:
    instances: list[_FakeRpcClient] = []

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.set_todos_calls: list[list[dict]] = []
        self.get_todos_calls = 0
        self.stop_calls = 0
        self.mark_closed_calls: list[BaseException] = []
        _FakeRpcClient.instances.append(self)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def install_headless_ui(self) -> None:
        pass

    def on_tool_execution_end(self, _cb) -> None:
        pass

    def on_message_update(self, _cb) -> None:
        pass

    def stop(self) -> None:
        self.stop_calls += 1

    def _mark_closed(self, error: BaseException) -> None:
        self.mark_closed_calls.append(error)

    def set_todos(self, phases):
        self.set_todos_calls.append(phases)

    def get_todos(self):
        self.get_todos_calls += 1
        return ()

    def prompt_and_wait(self, prompt, timeout):
        if not hasattr(self, "prompts"):
            self.prompts: list[str] = []
        self.prompts.append(prompt)
        hook = getattr(self, "on_prompt", None)
        if hook is not None:
            hook(self, prompt)

        class _Turn:
            messages: list = []
            events: list = []
            assistant_text: str = "ok"
            assistant_message: dict | None = None

        return _Turn()


_SEEDED_PHASES = [
    {
        "id": "p1",
        "name": "Reproduce",
        "tasks": [
            {
                "id": "t1",
                "content": "do it",
                "status": "pending",
                "notes": "",
                "details": "",
            }
        ],
    }
]


def _make_inputs(
    tmp_path: Path, settings: Settings, *, session_has_jsonl: bool, slot_uid: int | None = None
) -> tuple[worker.TaskInputs, SimpleNamespace]:
    root = tmp_path / "workspace"
    root.mkdir()
    session_dir = root / "session"
    session_dir.mkdir()
    if session_has_jsonl:
        (session_dir / "foo.jsonl").write_text("{}\n", encoding="utf-8")
    repo_dir = root / "repo"
    repo_dir.mkdir()

    workspace = SimpleNamespace(
        root=root,
        session_dir=session_dir,
        repo_dir=repo_dir,
        branch="robomp/issue-1",
    )
    repo = SimpleNamespace(full_name="acme/widgets", owner="acme", name="widgets")
    issue = SimpleNamespace(repo="acme/widgets", number=1, title="bug")

    db = SimpleNamespace(set_event_model=lambda _did, _model: None, get_issue=lambda _key: None)
    github = SimpleNamespace()

    inputs = worker.TaskInputs(
        settings=settings,
        db=db,  # type: ignore[arg-type]
        github=github,  # type: ignore[arg-type]
        git_transport=SimpleNamespace(),  # type: ignore[arg-type]
        repo=repo,  # type: ignore[arg-type]
        issue=issue,  # type: ignore[arg-type]
        workspace=workspace,  # type: ignore[arg-type]
        delivery_id="d-test",
        attempts=0,
        slot_uid=slot_uid,
    )
    bindings = SimpleNamespace(
        workspace=workspace,
        repo=repo,
        issue=issue,
        issue_key=f"{repo.full_name}#{issue.number}",
        abort=None,
    )
    return inputs, bindings


@pytest.fixture(autouse=True)
def _reset_fake() -> None:
    _FakeRpcClient.instances.clear()


@pytest.fixture(autouse=True)
def _patch_worker(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr("robomp.worker.RpcClient", _FakeRpcClient)
    monkeypatch.setattr("robomp.worker._AGENT_HOME_STAGE", tmp_path / "missing-agent-home-stage")
    monkeypatch.setattr("robomp.worker.host_tools.build", lambda _b: ())
    monkeypatch.setattr(
        "robomp.worker.persona.system_append",
        lambda *, repo, issue, workspace, bot_login: "SYS",
    )
    monkeypatch.setattr(
        "robomp.worker.persona.seed_phases",
        lambda _kind: [dict(p) for p in _SEEDED_PHASES],
    )


@pytest.mark.asyncio
async def test_run_task_sets_impl_authorized_from_directive(
    tmp_path: Path, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    inputs, _bindings = _make_inputs(tmp_path, settings, session_has_jsonl=False)
    captured: dict[str, bool] = {}

    monkeypatch.setattr(worker, "_build_prompt", lambda *args, **kwargs: "prompt")

    def fake_run_rpc_blocking(
        _inputs: worker.TaskInputs,
        *,
        task_kind: str,
        prompt: str,
        loop: asyncio.AbstractEventLoop,
        bindings: worker.ToolBindings,
        directive: worker.DirectiveInfo | None = None,
    ) -> str:
        del task_kind, prompt, loop, directive
        captured["impl_authorized"] = bindings.impl_authorized
        return "ok"

    monkeypatch.setattr(worker, "_run_rpc_blocking", fake_run_rpc_blocking)

    result = await worker.run_task(
        task_kind="triage_issue",
        inputs=inputs,
        directive=worker.DirectiveInfo(body="go ahead", author="can1357", authorizes_impl=True),
    )

    assert result == "ok"
    assert captured == {"impl_authorized": True}


@pytest.mark.asyncio
async def test_run_task_preserves_impl_authorized_when_resuming(
    tmp_path: Path, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    inputs, _bindings = _make_inputs(tmp_path, settings, session_has_jsonl=True)
    captured: dict[str, bool] = {}

    monkeypatch.setattr(worker, "_build_prompt", lambda *args, **kwargs: "prompt")

    def capture_build(bindings: worker.ToolBindings) -> tuple:
        captured["impl_authorized"] = bindings.impl_authorized
        return ()

    monkeypatch.setattr(worker.host_tools, "build", capture_build)

    result = await worker.run_task(
        task_kind="handle_comment",
        inputs=inputs,
        directive=worker.DirectiveInfo(body="go ahead", author="can1357", authorizes_impl=True),
    )

    assert result == "ok"
    assert captured == {"impl_authorized": True}
    assert _FakeRpcClient.instances[0].kwargs["extra_args"] == ("--continue",)


@pytest.mark.asyncio
async def test_run_rpc_passes_continue_when_session_jsonl_present(tmp_path: Path, settings: Settings) -> None:
    inputs, bindings = _make_inputs(tmp_path, settings, session_has_jsonl=True)
    loop = asyncio.new_event_loop()
    try:
        worker._run_rpc_blocking(
            inputs,
            task_kind="triage_issue",
            prompt="x",
            loop=loop,
            bindings=bindings,  # type: ignore[arg-type]
        )
    finally:
        loop.close()
    assert _FakeRpcClient.instances[0].kwargs["extra_args"] == ("--continue",)


@pytest.mark.asyncio
async def test_run_rpc_omits_continue_when_session_empty(
    tmp_path: Path, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    agent_home = tmp_path / "agent-home"
    agent_home.mkdir()
    monkeypatch.setattr(worker, "_AGENT_HOME", agent_home)

    inputs, bindings = _make_inputs(tmp_path, settings, session_has_jsonl=False)
    loop = asyncio.new_event_loop()
    try:
        worker._run_rpc_blocking(
            inputs,
            task_kind="triage_issue",
            prompt="x",
            loop=loop,
            bindings=bindings,  # type: ignore[arg-type]
        )
    finally:
        loop.close()
    assert _FakeRpcClient.instances[0].kwargs["extra_args"] == ()
    client_kwargs = _FakeRpcClient.instances[0].kwargs
    assert client_kwargs["env"]["HOME"] == str(agent_home)
    assert client_kwargs["env"]["GITHUB_TOKEN"] == ""
    assert client_kwargs["env"]["GITHUB_WEBHOOK_SECRET"] == ""
    assert client_kwargs["env"]["ROBOMP_REPLAY_TOKEN"] == ""
    assert client_kwargs["env"]["ROBOMP_GH_PROXY_HMAC_KEY"] == ""
    assert client_kwargs["user"] is None
    assert client_kwargs["group"] is None
    assert client_kwargs["extra_groups"] is None


def test_build_extra_env_stages_agent_home(tmp_path: Path, settings: Settings, monkeypatch: pytest.MonkeyPatch) -> None:
    stage_home = tmp_path / "agent-home-stage"
    agent_home = tmp_path / "agent-home"
    monkeypatch.setattr(worker, "_AGENT_HOME_STAGE", stage_home)
    monkeypatch.setattr(worker, "_AGENT_HOME", agent_home)

    agent_dir = stage_home / ".agent"
    agent_rules_dir = agent_dir / "rules"
    omp_agent_dir = stage_home / ".omp" / "agent"
    agent_rules_dir.mkdir(parents=True)
    omp_agent_dir.mkdir(parents=True)
    (agent_dir / "AGENTS.md").write_text("agent instructions\n", encoding="utf-8")
    (agent_rules_dir / "rule.md").write_text("rule\n", encoding="utf-8")
    (omp_agent_dir / "models.yml").write_text("models: []\n", encoding="utf-8")

    env = worker._build_extra_env(settings)

    assert env["HOME"] == str(agent_home)
    assert (agent_home / ".agent" / "AGENTS.md").is_file()
    assert (agent_home / ".agent" / "rules" / "rule.md").is_file()
    assert (agent_home / ".omp" / "agent" / "models.yml").is_file()
    assert (agent_home / ".agent").stat().st_mode & 0o777 == 0o755
    assert (agent_home / ".agent" / "AGENTS.md").stat().st_mode & 0o777 == 0o644
    assert (agent_home / ".agent" / "rules").stat().st_mode & 0o777 == 0o755
    assert (agent_home / ".agent" / "rules" / "rule.md").stat().st_mode & 0o777 == 0o644
    assert (agent_home / ".omp" / "agent").stat().st_mode & 0o777 == 0o755
    assert (agent_home / ".omp" / "agent" / "models.yml").stat().st_mode & 0o777 == 0o644


@pytest.mark.asyncio
async def test_run_rpc_omits_home_when_agent_home_absent(
    tmp_path: Path, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(worker, "_AGENT_HOME", tmp_path / "missing-agent-home")

    inputs, bindings = _make_inputs(tmp_path, settings, session_has_jsonl=False)
    loop = asyncio.new_event_loop()
    try:
        worker._run_rpc_blocking(
            inputs,
            task_kind="triage_issue",
            prompt="x",
            loop=loop,
            bindings=bindings,  # type: ignore[arg-type]
        )
    finally:
        loop.close()
    client_kwargs = _FakeRpcClient.instances[0].kwargs
    assert "HOME" not in client_kwargs["env"]
    assert client_kwargs["env"]["GITHUB_TOKEN"] == ""
    assert client_kwargs["env"]["GITHUB_WEBHOOK_SECRET"] == ""
    assert client_kwargs["env"]["ROBOMP_REPLAY_TOKEN"] == ""
    assert client_kwargs["env"]["ROBOMP_GH_PROXY_HMAC_KEY"] == ""


@pytest.mark.asyncio
async def test_run_rpc_uses_workspace_xdg_dirs_without_slot(tmp_path: Path, settings: Settings) -> None:
    inputs, bindings = _make_inputs(tmp_path, settings, session_has_jsonl=False, slot_uid=None)
    loop = asyncio.new_event_loop()
    try:
        worker._run_rpc_blocking(
            inputs,
            task_kind="triage_issue",
            prompt="x",
            loop=loop,
            bindings=bindings,  # type: ignore[arg-type]
        )
    finally:
        loop.close()

    env = _FakeRpcClient.instances[0].kwargs["env"]
    xdg_root = inputs.workspace.root / ".omp-xdg"
    for key in ("XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"):
        path = Path(env[key])
        assert path.is_relative_to(xdg_root)
        assert (path / "omp").is_dir()
    tmpdir = inputs.workspace.root / ".omp-tmp"
    assert env["TMPDIR"] == str(tmpdir)
    assert env["TMP"] == str(tmpdir)
    assert env["TEMP"] == str(tmpdir)
    assert env["GIT_CONFIG_COUNT"] == "1"
    assert env["GIT_CONFIG_KEY_0"] == "safe.directory"
    assert env["GIT_CONFIG_VALUE_0"] == str(inputs.workspace.repo_dir)
    assert env["GIT_AUTHOR_NAME"] == settings.resolved_author_name
    assert env["GIT_AUTHOR_EMAIL"] == settings.git_author_email
    assert env["GIT_COMMITTER_NAME"] == settings.resolved_author_name
    assert env["GIT_COMMITTER_EMAIL"] == settings.git_author_email
    assert tmpdir.is_dir()
    assert stat.S_IMODE(tmpdir.stat().st_mode) == 0o700


@pytest.mark.asyncio
async def test_run_rpc_uses_workspace_xdg_dirs_for_slot_without_chown(
    tmp_path: Path, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    chown_calls: list[tuple[Path, int, int]] = []
    monkeypatch.setattr("robomp.sandbox.platform.system", lambda: "Linux")
    monkeypatch.setattr("robomp.sandbox.os.geteuid", lambda: 0)
    monkeypatch.setattr("robomp.sandbox.os.chown", lambda path, uid, gid: chown_calls.append((Path(path), uid, gid)))

    inputs, bindings = _make_inputs(tmp_path, settings, session_has_jsonl=False, slot_uid=2001)
    loop = asyncio.new_event_loop()
    try:
        worker._run_rpc_blocking(
            inputs,
            task_kind="triage_issue",
            prompt="x",
            loop=loop,
            bindings=bindings,  # type: ignore[arg-type]
        )
    finally:
        loop.close()

    env = _FakeRpcClient.instances[0].kwargs["env"]
    for key in ("XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"):
        base = Path(env[key])
        assert base.is_dir()
        assert (base / "omp").is_dir()
    assert Path(env["BUN_INSTALL_CACHE_DIR"]).is_dir()
    assert chown_calls == []


@pytest.mark.asyncio
async def test_run_rpc_skips_set_todos_on_resumed_triage(tmp_path: Path, settings: Settings) -> None:
    inputs, bindings = _make_inputs(tmp_path, settings, session_has_jsonl=True)
    loop = asyncio.new_event_loop()
    try:
        worker._run_rpc_blocking(
            inputs,
            task_kind="triage_issue",
            prompt="x",
            loop=loop,
            bindings=bindings,  # type: ignore[arg-type]
        )
    finally:
        loop.close()
    assert _FakeRpcClient.instances[0].set_todos_calls == []


@pytest.mark.asyncio
async def test_run_rpc_seeds_todos_on_fresh_triage(tmp_path: Path, settings: Settings) -> None:
    inputs, bindings = _make_inputs(tmp_path, settings, session_has_jsonl=False)
    loop = asyncio.new_event_loop()
    try:
        worker._run_rpc_blocking(
            inputs,
            task_kind="triage_issue",
            prompt="x",
            loop=loop,
            bindings=bindings,  # type: ignore[arg-type]
        )
    finally:
        loop.close()
    calls = _FakeRpcClient.instances[0].set_todos_calls
    assert len(calls) == 1
    assert calls[0] == _SEEDED_PHASES


@pytest.mark.asyncio
async def test_run_rpc_merges_todos_on_followup_with_resume(tmp_path: Path, settings: Settings) -> None:
    inputs, bindings = _make_inputs(tmp_path, settings, session_has_jsonl=True)
    loop = asyncio.new_event_loop()
    try:
        worker._run_rpc_blocking(
            inputs,
            task_kind="handle_comment",
            prompt="x",
            loop=loop,
            bindings=bindings,  # type: ignore[arg-type]
        )
    finally:
        loop.close()
    client = _FakeRpcClient.instances[0]
    assert client.get_todos_calls == 1
    assert len(client.set_todos_calls) == 1
    assert len(client.set_todos_calls[0]) == len(_SEEDED_PHASES)


@pytest.mark.asyncio
async def test_run_rpc_passes_slot_uid_user_slot_group_and_omp_extra_group(tmp_path: Path, settings: Settings) -> None:
    inputs, bindings = _make_inputs(tmp_path, settings, session_has_jsonl=False, slot_uid=2001)
    loop = asyncio.new_event_loop()
    try:
        worker._run_rpc_blocking(
            inputs,
            task_kind="triage_issue",
            prompt="x",
            loop=loop,
            bindings=bindings,  # type: ignore[arg-type]
        )
    finally:
        loop.close()
    client_kwargs = _FakeRpcClient.instances[0].kwargs
    assert client_kwargs["user"] == 2001
    assert client_kwargs["group"] == 2001
    assert client_kwargs["extra_groups"] == ["omp"]


@pytest.mark.asyncio
async def test_run_rpc_arms_hard_timeout_timer(
    tmp_path: Path, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    timers = []

    class FakeTimer:
        def __init__(self, interval, function):
            self.interval = interval
            self.function = function
            self.daemon = False
            self.started = False
            self.cancelled = False
            timers.append(self)

        def start(self) -> None:
            self.started = True

        def cancel(self) -> None:
            self.cancelled = True

    monkeypatch.setattr("robomp.worker.threading.Timer", FakeTimer)
    settings.task_timeout_seconds = 3.0
    settings.task_timeout_hard_grace_seconds = 7.0
    inputs, bindings = _make_inputs(tmp_path, settings, session_has_jsonl=False)
    loop = asyncio.new_event_loop()
    try:
        worker._run_rpc_blocking(
            inputs,
            task_kind="triage_issue",
            prompt="x",
            loop=loop,
            bindings=bindings,  # type: ignore[arg-type]
        )
    finally:
        loop.close()

    assert len(timers) == 1
    timer = timers[0]
    assert timer.interval == 10.0
    assert timer.daemon is True
    assert timer.started is True
    assert timer.cancelled is True


@pytest.mark.asyncio
async def test_run_rpc_hard_timeout_stops_client_and_fails(
    tmp_path: Path, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    class FiringTimer:
        def __init__(self, interval, function):
            self.interval = interval
            self.function = function
            self.daemon = False
            self.cancelled = False

        def start(self) -> None:
            self.function()

        def cancel(self) -> None:
            self.cancelled = True

    monkeypatch.setattr("robomp.worker.threading.Timer", FiringTimer)
    inputs, bindings = _make_inputs(tmp_path, settings, session_has_jsonl=False)
    loop = asyncio.new_event_loop()
    try:
        with pytest.raises(TimeoutError, match="hard timeout"):
            worker._run_rpc_blocking(
                inputs,
                task_kind="triage_issue",
                prompt="x",
                loop=loop,
                bindings=bindings,  # type: ignore[arg-type]
            )
    finally:
        loop.close()

    fake = _FakeRpcClient.instances[0]
    assert fake.stop_calls == 1
    # `_cancel_hook` (used by both manual cancel and hard timeout) MUST also call
    # `_mark_closed` to unblock `_wait_for_agent_end` — `stop()` alone leaves
    # `_closed_error` unset (omp_rpc bug), so the worker would hang otherwise.
    assert len(fake.mark_closed_calls) == 1
    from omp_rpc import RpcProcessExitError

    assert isinstance(fake.mark_closed_calls[0], RpcProcessExitError)


@pytest.mark.asyncio
async def test_run_rpc_cancel_hook_stops_and_marks_closed(
    tmp_path: Path, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The cancel hook registered with `register_cancel_hook` must call both
    `client.stop()` AND `client._mark_closed()`. The latter is the workaround for
    an upstream omp_rpc bug where `stop()` does not set `_closed_error`, leaving
    `_wait_for_agent_end` blocked until timeout."""
    captured: list = []
    monkeypatch.setattr("robomp.worker.register_cancel_hook", lambda hook: captured.append(hook))
    monkeypatch.setattr("robomp.worker.unregister_cancel_hook", lambda: None)

    inputs, bindings = _make_inputs(tmp_path, settings, session_has_jsonl=False)
    loop = asyncio.new_event_loop()
    try:
        worker._run_rpc_blocking(
            inputs,
            task_kind="triage_issue",
            prompt="x",
            loop=loop,
            bindings=bindings,  # type: ignore[arg-type]
        )
    finally:
        loop.close()

    assert len(captured) == 1
    hook = captured[0]
    fake = _FakeRpcClient.instances[0]
    pre_stop = fake.stop_calls
    hook()  # Simulate the API/worker firing the cancel
    assert fake.stop_calls == pre_stop + 1
    assert len(fake.mark_closed_calls) == 1
    from omp_rpc import RpcProcessExitError

    assert isinstance(fake.mark_closed_calls[0], RpcProcessExitError)
    assert "cancelled by operator" in str(fake.mark_closed_calls[0])


class _ClassifiedRow:
    """Stand-in for `db.IssueRow` carrying just `.classification`."""

    def __init__(self, classification: str | None) -> None:
        self.classification = classification


def _make_inputs_with_classification(
    tmp_path: Path,
    settings: Settings,
    *,
    classification: str | None,
) -> tuple[worker.TaskInputs, SimpleNamespace]:
    inputs, bindings = _make_inputs(tmp_path, settings, session_has_jsonl=True)
    row = _ClassifiedRow(classification) if classification else None
    inputs.db.get_issue = lambda _key: row  # type: ignore[attr-defined]
    bindings.db = inputs.db  # tools_called check uses inputs.db.get_issue
    return inputs, bindings


@pytest.mark.asyncio
async def test_run_rpc_sends_reminder_when_pr_class_quits_early(tmp_path: Path, settings: Settings) -> None:
    """`bug` classified turn that never calls a terminal tool gets a reminder."""
    inputs, bindings = _make_inputs_with_classification(tmp_path, settings, classification="bug")
    loop = asyncio.new_event_loop()
    try:
        worker._run_rpc_blocking(
            inputs,
            task_kind="triage_issue",
            prompt="kickoff",
            loop=loop,
            bindings=bindings,  # type: ignore[arg-type]
        )
    finally:
        loop.close()
    fake = _FakeRpcClient.instances[0]
    # kickoff + 2 reminders (default ROBOMP_TASK_COMPLETION_MAX_REMINDERS=2)
    assert len(fake.prompts) == 1 + settings.task_completion_max_reminders
    assert fake.prompts[0] == "kickoff"
    assert all("terminal action" in p.lower() or "open the pr" in p.lower() for p in fake.prompts[1:])


@pytest.mark.asyncio
async def test_run_rpc_stops_reminding_after_terminal_tool(tmp_path: Path, settings: Settings) -> None:
    """A reminder turn that fires `gh_open_pr` halts the loop."""
    inputs, bindings = _make_inputs_with_classification(tmp_path, settings, classification="bug")

    # First turn returns with no terminal tool; first reminder causes the
    # agent to "call" gh_open_pr — simulated by mutating the worker's
    # tools_called set via the on_prompt hook on the next prompt.
    def _on_prompt(client: _FakeRpcClient, prompt: str) -> None:
        if len(client.prompts) == 2:  # this is the first reminder
            # Mimic a tool_end firing during the reminder turn by writing
            # into the closure set the driver tracks. We can't reach it
            # directly; instead trip the abort path? No — use the public
            # contract: tool_end fires through on_tool_execution_end. The
            # driver registers the callback before prompt_and_wait, so we
            # replay it here.
            for cb in client._tool_end_callbacks:
                cb(SimpleNamespace(tool_name="gh_open_pr", result={}))

    # Capture the registered tool_end callback on the fake.
    original_on_tool_end = _FakeRpcClient.on_tool_execution_end

    def _record_tool_end(self, cb) -> None:
        self._tool_end_callbacks = getattr(self, "_tool_end_callbacks", [])
        self._tool_end_callbacks.append(cb)

    _FakeRpcClient.on_tool_execution_end = _record_tool_end  # type: ignore[assignment]
    try:
        _FakeRpcClient.on_prompt = staticmethod(_on_prompt)  # type: ignore[attr-defined]
        loop = asyncio.new_event_loop()
        try:
            worker._run_rpc_blocking(
                inputs,
                task_kind="triage_issue",
                prompt="kickoff",
                loop=loop,
                bindings=bindings,  # type: ignore[arg-type]
            )
        finally:
            loop.close()
    finally:
        _FakeRpcClient.on_tool_execution_end = original_on_tool_end  # type: ignore[assignment]
        delattr(_FakeRpcClient, "on_prompt")

    fake = _FakeRpcClient.instances[0]
    # kickoff + 1 reminder; second reminder NOT sent because gh_open_pr fired.
    assert len(fake.prompts) == 2, fake.prompts


@pytest.mark.asyncio
async def test_run_rpc_skips_reminder_for_non_pr_classification(tmp_path: Path, settings: Settings) -> None:
    """`question` classified turns are not enforced — no reminder."""
    inputs, bindings = _make_inputs_with_classification(tmp_path, settings, classification="question")
    loop = asyncio.new_event_loop()
    try:
        worker._run_rpc_blocking(
            inputs,
            task_kind="triage_issue",
            prompt="kickoff",
            loop=loop,
            bindings=bindings,  # type: ignore[arg-type]
        )
    finally:
        loop.close()
    fake = _FakeRpcClient.instances[0]
    assert len(fake.prompts) == 1


@pytest.mark.asyncio
async def test_run_rpc_skips_reminder_when_unclassified(tmp_path: Path, settings: Settings) -> None:
    """No classification (agent quit before classify_issue) → no reminder."""
    inputs, bindings = _make_inputs_with_classification(tmp_path, settings, classification=None)
    loop = asyncio.new_event_loop()
    try:
        worker._run_rpc_blocking(
            inputs,
            task_kind="triage_issue",
            prompt="kickoff",
            loop=loop,
            bindings=bindings,  # type: ignore[arg-type]
        )
    finally:
        loop.close()
    fake = _FakeRpcClient.instances[0]
    assert len(fake.prompts) == 1


@pytest.mark.asyncio
async def test_run_rpc_review_pr_reminds_until_submit_pr_review(tmp_path: Path, settings: Settings) -> None:
    inputs, bindings = _make_inputs(tmp_path, settings, session_has_jsonl=False)
    loop = asyncio.new_event_loop()
    try:
        worker._run_rpc_blocking(
            inputs,
            task_kind="review_pr",
            prompt="kickoff",
            loop=loop,
            bindings=bindings,  # type: ignore[arg-type]
        )
    finally:
        loop.close()
    fake = _FakeRpcClient.instances[0]
    assert len(fake.prompts) == 1 + settings.task_completion_max_reminders
    assert fake.prompts[0] == "kickoff"
    assert all("submit_pr_review" in p for p in fake.prompts[1:])
    assert all("gh_open_pr" not in p for p in fake.prompts[1:])


@pytest.mark.asyncio
async def test_run_rpc_review_pr_stops_after_submit_without_dirty_probe(
    tmp_path: Path, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    inputs, bindings = _make_inputs(tmp_path, settings, session_has_jsonl=False)

    def _probe(_workspace, _slot_uid):  # type: ignore[no-untyped-def]
        raise AssertionError("review_pr must not run dirty-state probes")

    monkeypatch.setattr(worker, "_probe_workspace_dirty", _probe)
    original_on_tool_end = _FakeRpcClient.on_tool_execution_end

    def _record_tool_end(self, cb) -> None:
        self._tool_end_callbacks = getattr(self, "_tool_end_callbacks", [])
        self._tool_end_callbacks.append(cb)

    def _on_prompt(client: _FakeRpcClient, _prompt: str) -> None:
        for cb in client._tool_end_callbacks:
            cb(SimpleNamespace(tool_name="submit_pr_review", result={}))

    _FakeRpcClient.on_tool_execution_end = _record_tool_end  # type: ignore[assignment]
    try:
        _FakeRpcClient.on_prompt = staticmethod(_on_prompt)  # type: ignore[attr-defined]
        loop = asyncio.new_event_loop()
        try:
            worker._run_rpc_blocking(
                inputs,
                task_kind="review_pr",
                prompt="kickoff",
                loop=loop,
                bindings=bindings,  # type: ignore[arg-type]
            )
        finally:
            loop.close()
    finally:
        _FakeRpcClient.on_tool_execution_end = original_on_tool_end  # type: ignore[assignment]
        delattr(_FakeRpcClient, "on_prompt")

    fake = _FakeRpcClient.instances[0]
    assert fake.prompts == ["kickoff"]


# ---------------------------------------------------------------------------
# Dirty-state watchdog
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_run_rpc_sends_dirty_state_reminder_when_worktree_has_unpushed_work(
    tmp_path: Path, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Agent ended its turn with unpushed commits → reminder fires; clean → loop exits."""
    inputs, bindings = _make_inputs(tmp_path, settings, session_has_jsonl=False)
    dirty = DirtyState(uncommitted=2, unpushed=1, summary="Unpushed commits (1):\nabc1234 wip")
    clean = DirtyState(uncommitted=0, unpushed=0, summary="")
    states = iter([dirty, clean])
    monkeypatch.setattr(worker, "_probe_workspace_dirty", lambda _ws, _slot: next(states, clean))

    loop = asyncio.new_event_loop()
    try:
        worker._run_rpc_blocking(
            inputs,
            task_kind="handle_comment",
            prompt="kickoff",
            loop=loop,
            bindings=bindings,  # type: ignore[arg-type]
        )
    finally:
        loop.close()

    fake = _FakeRpcClient.instances[0]
    assert len(fake.prompts) == 2, fake.prompts
    reminder = fake.prompts[1]
    assert "Unpushed commits" in reminder
    assert "abc1234" in reminder
    assert "{{" not in reminder, "template placeholder leaked"


@pytest.mark.asyncio
async def test_run_rpc_skips_dirty_state_reminder_when_worktree_is_clean(
    tmp_path: Path, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Clean worktree at end of turn → no extra prompts."""
    inputs, bindings = _make_inputs(tmp_path, settings, session_has_jsonl=False)
    monkeypatch.setattr(
        worker,
        "_probe_workspace_dirty",
        lambda _ws, _slot: DirtyState(uncommitted=0, unpushed=0, summary=""),
    )

    loop = asyncio.new_event_loop()
    try:
        worker._run_rpc_blocking(
            inputs,
            task_kind="handle_comment",
            prompt="kickoff",
            loop=loop,
            bindings=bindings,  # type: ignore[arg-type]
        )
    finally:
        loop.close()

    fake = _FakeRpcClient.instances[0]
    assert len(fake.prompts) == 1


@pytest.mark.asyncio
async def test_run_rpc_caps_dirty_state_reminders_at_budget(
    tmp_path: Path, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Persistently dirty workspace must not loop past the reminder budget."""
    inputs, bindings = _make_inputs(tmp_path, settings, session_has_jsonl=False)
    dirty = DirtyState(uncommitted=1, unpushed=0, summary="Uncommitted changes (1):\n?? oops.txt")
    monkeypatch.setattr(worker, "_probe_workspace_dirty", lambda _ws, _slot: dirty)

    loop = asyncio.new_event_loop()
    try:
        worker._run_rpc_blocking(
            inputs,
            task_kind="handle_comment",
            prompt="kickoff",
            loop=loop,
            bindings=bindings,  # type: ignore[arg-type]
        )
    finally:
        loop.close()

    fake = _FakeRpcClient.instances[0]
    # kickoff + N reminders, capped at the configured budget (default 2).
    assert len(fake.prompts) == 1 + settings.task_completion_max_reminders


# ---------------------------------------------------------------------------
# Natives-cache capture-on-success
# ---------------------------------------------------------------------------


class _RecordingNativesCache:
    """Test double for `NativesCache`: records `capture` calls, optionally
    raises so we can verify exception swallowing."""

    def __init__(self, *, raise_on_capture: bool = False) -> None:
        self.capture_calls: list[tuple[str, str, Path]] = []
        self.raise_on_capture = raise_on_capture

    def capture(self, repo: str, key: str, native_dir: Path, **_kwargs) -> Path | None:
        self.capture_calls.append((repo, key, native_dir))
        if self.raise_on_capture:
            raise RuntimeError("simulated cache failure")
        return native_dir


def _make_capture_inputs(
    tmp_path: Path,
    settings: Settings,
    *,
    cache: _RecordingNativesCache | None,
    with_native_artifacts: bool,
) -> worker.TaskInputs:
    """Build a `TaskInputs` whose workspace optionally has built natives."""
    inputs, _ = _make_inputs(tmp_path, settings, session_has_jsonl=False)
    # Replace the SimpleNamespace workspace with one carrying the fields
    # `_capture_natives_cache` needs (workspace_key + repo_full_name).
    ws = SimpleNamespace(
        root=inputs.workspace.root,
        session_dir=inputs.workspace.session_dir,
        repo_dir=inputs.workspace.repo_dir,
        branch=inputs.workspace.branch,
        workspace_key="acme__widgets__1",
        repo_full_name="acme/widgets",
    )
    if with_native_artifacts:
        native_dir = ws.repo_dir / "packages" / "natives" / "native"
        native_dir.mkdir(parents=True)
        (native_dir / "pi_natives.linux-arm64.node").write_bytes(b"ELFx")
        (native_dir / "index.d.ts").write_text("")
        (native_dir / "index.js").write_text("")
        (native_dir / "embedded-addon.js").write_text("")
    return worker.TaskInputs(
        settings=settings,
        db=inputs.db,
        github=inputs.github,
        git_transport=inputs.git_transport,
        repo=inputs.repo,
        issue=inputs.issue,
        workspace=ws,  # type: ignore[arg-type]
        delivery_id=inputs.delivery_id,
        attempts=inputs.attempts,
        slot_uid=inputs.slot_uid,
        natives_cache=cache,  # type: ignore[arg-type]
    )


def test_capture_natives_cache_no_op_without_cache(tmp_path: Path, settings: Settings) -> None:
    inputs = _make_capture_inputs(tmp_path, settings, cache=None, with_native_artifacts=True)
    # Just must not raise.
    worker._capture_natives_cache(inputs)


def test_capture_natives_cache_skips_without_artifacts(tmp_path: Path, settings: Settings) -> None:
    cache = _RecordingNativesCache()
    inputs = _make_capture_inputs(tmp_path, settings, cache=cache, with_native_artifacts=False)
    worker._capture_natives_cache(inputs)
    # No artifacts → no key compute, no capture.
    assert cache.capture_calls == []


def test_capture_natives_cache_swallows_key_compute_failure(
    tmp_path: Path, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    cache = _RecordingNativesCache()
    inputs = _make_capture_inputs(tmp_path, settings, cache=cache, with_native_artifacts=True)
    # Repo dir is not a git repo → natives_compute_key raises.
    # Already true for the SimpleNamespace workspace (repo_dir is plain tmp dir).
    worker._capture_natives_cache(inputs)
    assert cache.capture_calls == []


def test_capture_natives_cache_swallows_capture_exception(
    tmp_path: Path, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    cache = _RecordingNativesCache(raise_on_capture=True)
    inputs = _make_capture_inputs(tmp_path, settings, cache=cache, with_native_artifacts=True)
    # Bypass git: stub the key compute so capture is reached.
    monkeypatch.setattr(worker, "natives_compute_key", lambda _repo_dir: "deadbeef")
    # Must not propagate the RuntimeError.
    worker._capture_natives_cache(inputs)
    assert len(cache.capture_calls) == 1


def test_capture_natives_cache_records_on_success(
    tmp_path: Path, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    cache = _RecordingNativesCache()
    inputs = _make_capture_inputs(tmp_path, settings, cache=cache, with_native_artifacts=True)
    monkeypatch.setattr(worker, "natives_compute_key", lambda _repo_dir: "cafef00d")
    worker._capture_natives_cache(inputs)
    assert len(cache.capture_calls) == 1
    repo, key, native_dir = cache.capture_calls[0]
    assert repo == "acme/widgets"
    assert key == "cafef00d"
    assert native_dir == inputs.workspace.repo_dir / "packages" / "natives" / "native"
