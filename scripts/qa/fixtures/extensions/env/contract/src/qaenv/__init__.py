
import functools
import json
import omp
import omp.env as env


def report_errors(function):
    @functools.wraps(function)
    async def wrapped():
        try:
            return await function()
        except BaseException as error:
            raise AssertionError(f"{type(error).__name__}: {error}") from error
    return wrapped


@omp.tool(
    kind="hard",
    effects=omp.Effects(
        documents=omp.DocEffects(read=True, write_globs=("**",)),
        exec=omp.ExecEffects(commands=("*",), network=False),
    ),
)
@report_errors
async def hello() -> dict:
    info = env.info()
    assert isinstance(info, env.EnvInfo)
    assert env.has(env.Capability.DOC_READ, env.Capability.DOC_WRITE, env.Capability.EXEC), sorted(
        cap.value for cap in info.capabilities
    )
    env.require(env.Capability.DOC_READ, env.Capability.DOC_WRITE, env.Capability.EXEC)
    try:
        env.require(env.Capability.NET)
    except env.Denied as denied:
        assert denied.capability is env.Capability.NET
    else:
        raise AssertionError("undeclared NET capability was granted")

    path = omp.EnvPath("notes.txt")
    joined = info.root.join("nested", "child.txt")
    assert str(path) == "notes.txt"
    assert str(joined).endswith("nested/child.txt")
    assert path.uri.endswith("/notes.txt")
    assert joined.uri.startswith("file://")

    direct_write_denied = False
    try:
        with open("sandbox-bypass.txt", "wb") as handle:
            handle.write(b"forbidden")
    except PermissionError:
        direct_write_denied = True
    assert direct_write_denied
    try:
        env.direct_filesystem.grant()
    except env.DirectFilesystemDenied as denied:
        assert isinstance(denied, PermissionError)
    else:
        raise AssertionError("trusted direct-filesystem escape was ambiently granted")

    current = await env.docs.open(path)
    stale = await env.docs.open(path)
    try:
        assert isinstance(current, env.Doc)
        pinned = current.revision
        assert isinstance(pinned, env.Revision)
        assert pinned.hex == pinned.content_hash.hex()
        receipt = await current.edit([env.Edit(0, 5, b"HELLO")])
        assert isinstance(receipt, env.TxnReceipt)
        assert receipt.revision.sequence > pinned.sequence
        assert await path.read_text() == "HELLO world\nsecond line\n"
        reader = await env.docs.open(path)
        try:
            assert await reader.read() == "HELLO world\nsecond line\n"
        finally:
            await reader.close()
        try:
            await stale.edit([env.Edit(0, 5, b"STALE")])
        except env.Conflict as conflict:
            assert isinstance(conflict, env.EnvError)
            assert conflict.expected is not None and conflict.current is not None
            conflict_seen = True
        else:
            conflict_seen = False
        assert conflict_seen
    finally:
        await current.close()
        await stale.close()

    meta = await env.fs.stat(path)
    assert isinstance(meta, env.PathMeta)
    assert meta.path == path and meta.kind is env.FileKind.REGULAR_FILE
    assert meta.byte_length == len(b"HELLO world\nsecond line\n")
    assert await env.fs.canonicalize(path) == path
    entries = await env.fs.list_dir(info.root)
    assert any(item.name == "notes.txt" and isinstance(item, env.DirEntry) for item in entries)

    # Document values.
    rev = env.Revision(7, b"\x01" * 32)
    edit = env.Edit(0, 1, b"x")
    plan = env.EditPlan(rev, (edit,), "preview", 1, ("warning",))
    edit_result = env.EditResult(rev, rev, False, False, ((0, 1),), None)
    conflict_fault = env.EditConflictFault(rev, rev, ((0, 1),))
    segment = env.SummarySegment(True, 1, 1, "line")
    summary = env.Summary("python", True, True, 2, (segment,), "line", "line", ((2, 2),), 1)
    unavailable = env.SummaryUnavailable(env.SummaryReason.NO_ELISIONS, 1, "python", True)
    options = env.SummaryOptions(render=env.SummaryRender.NUMBERED, language="python")
    event = env.DocEvent(1, env.DocEventKind.COMMITTED, rev, rev, None, (), None)
    assert plan.edits == (edit,) and edit_result.revision == rev and conflict_fault.expected == rev
    assert summary.segments[0].text == "line" and unavailable.reason is env.SummaryReason.NO_ELISIONS
    assert options.render is env.SummaryRender.NUMBERED and event.kind is env.DocEventKind.COMMITTED

    # Filesystem and search values.
    synthetic_meta = env.PathMeta(path, env.FileKind.REGULAR_FILE, 1)
    directory_entry = env.DirEntry("notes.txt", synthetic_meta)
    copy = env.CopyResult(synthetic_meta, 1)
    symlink = env.SymlinkTarget(path, True)
    entry = env.Entry(path, "file", 1, 0.0, 0)
    match = env.Match(path, 1, 0, b"x")
    assert directory_entry.meta == synthetic_meta and copy.bytes_copied == 1
    assert symlink.relative and entry.path == path and match.line_bytes == b"x"
    assert env.Follow.NEVER.value == "never" and env.Rank.PATH.value == "path"
    assert env.LinkKind.FILE.value == "file" and env.Overwrite.FAIL.value == "fail"
    assert env.Presence.PRESENT.value == "present" and env.Kind.TEXT.value == "text"
    assert env.OnStale.FAIL.value == "fail" and env.Format.OFF.value == "off"

    # LSP values.
    sync = env.SyncPolicy(env.SyncKind.FULL, True, False, False, True, False, "utf-8")
    binding = env.LspBinding(b"server", "server", sync, {"hover": True})
    lsp_event = env.LspEvent(b"server", "notify", {}, str(path), rev)
    binding_event = env.LspBindingEvent(env.LspBindingEventKind.READY, binding, str(path))
    lsp_failure = env.LspFailure(42, "failure", {"detail": True})
    assert binding.sync == sync and lsp_event.revision == rev
    assert binding_event.kind is env.LspBindingEventKind.READY and lsp_failure.code == 42
    assert env.LspStale.RETRY_HEAD.value == "retry_head"

    # Exec, process, HTTP, blob, and DATA receipt values.
    pty = env.Pty(rows=30, columns=100)
    ready_log = env.ReadyLog("ready")
    ready_tcp = env.ReadyTcp(1234)
    ready_ping = env.ReadyPing(9)
    ready_all = env.ReadyAll(ready_log, ready_tcp, ready_ping)
    restart = env.RestartPolicy(omp.Restart.NO)
    process = env.Process("worker", 1, "tcp://127.0.0.1:1")
    process_info = env.ProcessInfo("worker", 1, env.ProcState.RUNNING, terminal)
    process_output = env.ProcessOutput(1, env.Channel.STDOUT, b"ok", 1)
    response = env.HttpResponse(200, {"content-type": "application/json"}, b'{"ok":true}', "https://example.test/final")
    blob_stat = env.BlobStat(True, 3)
    opened_doc = env.OpenedDoc(b"lease", rev)
    opened_session = env.OpenedSession(b"session", info.root)
    started_process = env.StartedProcess("worker", 1, "endpoint")
    started_run = env.StartedRun(b"run")
    txn_receipt = env.TxnReceipt(b"txn", rev, False, False)
    txn_outcome = env.TxnOutcome(b"txn", (txn_receipt,), 1)
    worktree = env.WorktreeInfo("id", info.root, "base", 1)
    grant = env.DirectFilesystemGrant("ext", "pub", "digest", "grant", "now", 1)
    assert pty.rows == 30 and len(ready_all.probes) == 3 and restart.policy is omp.Restart.NO
    assert process.endpoint.endswith(":1") and process_info.state is env.ProcState.RUNNING
    assert process_output.data == b"ok" and env.Lifecycle.EXIT.value == "exit"
    assert response.json() == {"ok": True} and response.final_url.endswith("/final")
    assert blob_stat.present and opened_doc.revision == rev and opened_session.cwd == info.root
    assert started_process.generation == 1 and started_run.id == b"run"
    assert txn_outcome.operation_count == 1 and worktree.generation == 1 and grant.extension_id == "ext"

    # Exception family values retain durable typed faults.
    errors = (
        env.EnvError("base"), env.Denied("denied"),
        env.QuotaExceeded("quota", quota="bytes", limit=1),
        env.NotFound("missing"), env.AlreadyExists("exists"),
        env.Conflict("conflict", expected=rev, current=rev, ranges=((0, 1),)),
        env.Stale("stale"), env.PreconditionFailed("precondition"),
        env.Unsupported("unsupported"), env.Invalid("invalid"),
        env.Cancelled("cancelled"), env.TimedOut("timed out"),
        env.Io("io", errno=5), env.Disconnected("disconnected"),
        env.StreamLost("lost", skipped=2, reason="gap"),
        env.Partial("partial", committed=(txn_receipt,), failed_index=1),
    )
    assert all(isinstance(error, env.EnvError) and error.fault is not None for error in errors)

    return json.dumps({
        "marker": "env-contract-ok",
        "symbols": 105,
        "revision": receipt.revision.sequence,
        "conflict": conflict_seen,
        "direct_write_denied": direct_write_denied,
        "path": str(path),
        "uri": path.uri,
    })
