from __future__ import annotations

import omp

@omp.tool(kind="hard")
async def hello() -> str:
    c = omp.context
    tool = c.ToolRef("read", "hl", 3)
    usage = c.ContextUsage(10, 100, 10, 90, 1 / 9, 2, 1, 7, 0, 0, 4, 0.8, False)
    message = c.MessageRef(
        "m1", 1, 2, c.MessageKind.ASSISTANT, "assistant", "t1", 3, 7, 11,
        1, 0, tool, False, False, False, False, None, (), "preview",
    )
    view = c.ContextView("s1", "t1", "mock", "mock", 4, (message,), usage, "hash", None)
    assert list(view.since("t1")) == [message]
    assert list(view.by_turn()) == [("t1", (message,))]
    assert view.tokens_of(("m1", "missing")) == 7
    prune = c.Prune(("m1",), "old")
    drop = c.DropParts(("m1",), "large")
    replace = c.Replace(("m1",), (omp.Part.text("summary"),))
    insert = c.Insert((omp.Part.text("memory"),), c.Anchor.tail(), dedupe_key="memory")
    reorder = c.Reorder(("m1",), "m2")
    patch = c.ContextPatch(prune=[prune], drop_parts=[drop], replace=[replace])
    merged = patch.merge(c.ContextPatch(insert=[insert], reorder=[reorder], note="merged"))
    assert not merged.is_empty() and c.ContextPatch().is_empty()
    assert c.Anchor.before("m1").id == "m1" and c.Anchor.after("m1").id == "m1"
    assert c.Anchor.head().relation == "head" and str(tool) == "read@hl.3"
    compact_event = c.CompactionEvent(
        "prep", c.CompactionTier.LOCAL, "manual", 4, 90, 50, "m1", (message,),
        (), False, None, None, None, omp.Duration("1s"),
    )
    values = [
        c.CancelCompaction("later", 2), c.CustomSummary("summary", "m1"),
        c.DelegateCompaction(focus_ids=("m1",)),
        c.CompactionOutcome("prep", (c.CompactionTier.LOCAL,), None, 90, 40, "m1", 5, 7, None),
        c.ContextResetEvent(8, 5, "clear", 40, "t1"), compact_event,
    ]
    for error in (
        c.CompactionBusy, c.CompactionRefused, c.ContextGone, c.NoVerdict,
        c.PatchRejected, c.PinBudgetExceeded, c.StaleEpoch,
    ):
        values.append(error("probe"))
    assert all(callable(item) for item in (c.compact, c.epoch, c.lane, c.pin, c.unpin, c.usage, c.view))

    j = omp.journal
    entry_id = j.EntryId.parse("session:12")
    assert str(entry_id) == "session:12" and j.decode(b'{"a":1}') == {"a": 1}
    state_id = j.StateEntryId("project", 2)
    journal_entry = j.JournalEntry(entry_id, "dev.qa.note", "v.1", 1, None, None, {"a": 1}, b'{"a":1}', False, False)
    state_entry = j.StateEntry(state_id, "dev.qa.note", "v.1", 1, None, None, {"a": 1}, b'{"a":1}')
    errors = [
        j.JournalError("probe"), j.UnknownEntryKind("kind"),
        j.EntryKindConflict("dev.qa.note"), j.EntryTooLarge(2, 1),
        j.EntryAccessDenied("dev.other.note"), j.JournalIndeterminate(),
        j.EntryUndecodable(b"x", "probe"),
    ]
    assert journal_entry.id == entry_id and state_entry.id == state_id and len(errors) == 7
    assert (j.MAX_INLINE_BYTES, j.MAX_ENTRY_BYTES, j.MAX_LABEL_BYTES, j.MAX_ATOMIC_ENTRIES) == (65536, 16777216, 256, 1024)
    assert all(callable(item) for item in (j.append, j.append_many, j.append_atomic, j.entries, j.latest, j.fold, j.label, j.label_of))

    s = omp.sessions
    token_usage = s.Usage(input=3, output=2, total=5, accuracy=s.UsageAccuracy.EXACT)
    cost = s.Cost(nanos_usd=1_500_000_000, estimated=True)
    session_filter = s.SessionFilter(project="/tmp", status=(s.SessionStatus.COMPLETE,), kind=(s.SessionKind.INTERACTIVE,))
    query = s.UsageQuery(group_by=(s.GroupBy.MODEL,), bucket=s.Bucket.DAY, filter=session_filter)
    bucket = s.UsageBucket({"model": "mock"}, 0, token_usage, cost, 1, 0, omp.Duration("1s"))
    report_value = s.UsageReport(bucket, (bucket,), (bucket,), 1, False)
    link = s.SessionLink("s1", None, 1)
    node = s.SessionNode(entry_id, None, "custom", 1, {"ok": True})
    info = s.SessionInfo(
        "s1", "title", s.TitleSource.USER, omp.EnvPath("/tmp"), "/tmp", 1, 2,
        s.SessionStatus.COMPLETE, s.SessionKind.INTERACTIVE, None, 3, 1,
        token_usage, cost, ("mock/mock",), False,
    )
    setup = s.SessionSetup(title="next", parent="s1", entries=(), initial_prompt="continue")
    session_errors = [
        s.SessionError("probe"), s.SessionAccessDenied("s1"), s.SessionNotFound("s1"),
        s.SessionTransitionDenied("probe"),
        s.SessionTransitionIndeterminate("key", "probe"),
    ]
    assert cost.usd == 1.5 and report_value.sessions == 1 and link.id == info.id
    assert node.data["ok"] and query.bucket is s.Bucket.DAY and setup.parent == "s1"
    assert len(session_errors) == 5
    assert all(callable(item) for item in (
        s.branch, s.create, s.current, s.delete, s.get, s.journal, s.lineage,
        s.list, s.rename, s.resume, s.tree, s.usage,
    ))

    return "constructed"

@omp.hook("extension_activate")
async def activated(event, ctx):
    return None
