
import json
import omp
import omp.env as env



@omp.tool(kind="hard")
async def hello() -> dict:
    path = omp.EnvPath(".")
    rev = env.Revision(7, b"\x01" * 32)
    edit = env.Edit(0, 1, b"x")
    plan = env.EditPlan(rev, (edit,), "preview", 1, ("warning",))
    segment = env.SummarySegment(True, 1, 1, "line")
    summary = env.Summary("python", True, True, 2, (segment,), "line", "line", ((2, 2),), 1)
    unavailable = env.SummaryUnavailable(env.SummaryReason.NO_ELISIONS, 1, "python", True)
    doc_event = env.DocEvent(1, env.DocEventKind.COMMITTED, rev, rev, None, (), None)

    meta = env.PathMeta(path, env.FileKind.DIRECTORY, 0)
    entry = env.DirEntry("child", meta)
    found = env.Entry(path, "directory", 0, 0.0, 0)
    match = env.Match(path, 1, 0, b"x")

    sync = env.SyncPolicy(env.SyncKind.FULL, True, False, False, True, False, "utf-8")
    binding = env.LspBinding(b"server", "server", sync, {"hover": True})
    lsp_event = env.LspEvent(b"server", "notify", {}, ".", rev)

    completed = env.Completed(
        env.Outcome.EXITED, 0, "", omp.Duration("1ms"), b"ok", None, False
    )
    output = env.Output(env.Channel.STDOUT, b"ok", 1)
    exited = env.Exit(completed)
    pty = env.Pty(rows=30, columns=100)
    probes = env.ReadyAll(env.ReadyLog("ready"), env.ReadyTcp(1234), env.ReadyPing(9))
    process = env.ProcessInfo("worker", 1, env.ProcState.RUNNING, completed)

    response = env.HttpResponse(
        200, {"content-type": "application/json"}, b'{"ok":true}', "https://example.test/final"
    )
    blob = env.BlobStat(True, 3)
    receipt = env.TxnReceipt(b"txn", rev, False, False)
    worktree = env.WorktreeInfo("id", path, "base", 1)
    denied = env.Denied("denied")
    conflict = env.EditConflictFault(rev, rev, ((0, 1),))

    assert plan.edits == (edit,) and summary.segments == (segment,)
    assert unavailable.reason is env.SummaryReason.NO_ELISIONS
    assert doc_event.kind is env.DocEventKind.COMMITTED
    assert entry.meta == meta and found.path == path and match.line_bytes == b"x"
    assert binding.sync == sync and lsp_event.revision == rev
    assert completed.text() == "ok" and output.data == b"ok" and exited.status == completed
    assert pty.rows == 30 and len(probes.probes) == 3 and process.status == completed
    assert response.json() == {"ok": True} and blob.present
    assert receipt.revision == rev and worktree.generation == 1
    assert isinstance(denied, env.EnvError) and conflict.expected == rev
    return json.dumps({"marker": "env-values-ok", "families": 7})
