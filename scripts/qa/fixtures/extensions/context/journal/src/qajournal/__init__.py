from __future__ import annotations

from dataclasses import dataclass
import json
import omp

@omp.entry_kind("dev.omp.qa.context_sessions.note", rev="v.1", spill=False)
@dataclass(frozen=True, slots=True)
class Note:
    text: str

@omp.tool(kind="hard")
async def hello(mode: str = "write") -> str:
    current = omp.sessions.current()
    if mode == "write":
        first = await omp.journal.append(Note("durable-91"), idempotency_key="qa-note-one")
        many = await omp.journal.append_many(
            (Note("many-a"), Note("many-b")), idempotency_key="qa-note-many"
        )
        atomic = await omp.journal.append_atomic(
            (Note("atomic-a"), Note("atomic-b")), idempotency_key="qa-note-atomic"
        )
        await omp.journal.label(first, "qa durable note")
        assert await omp.journal.label_of(first) == "qa durable note"
        assert len(many) == 2 and len(atomic) == 2
    rows = await omp.journal.entries(Note, live=True)
    latest = await omp.journal.latest(Note)
    texts, watermark = await omp.journal.fold(
        Note, lambda acc, row: acc + [row.value.text], []
    )
    visible = await omp.sessions.list(omp.sessions.SessionFilter(limit=10))
    fetched = await omp.sessions.get(current.id)
    historical = [row async for row in omp.sessions.journal(current.id, live=True)]
    usage = await omp.sessions.usage(omp.sessions.UsageQuery())
    lineage = await omp.sessions.lineage(current.id)
    tree = await omp.sessions.tree(current.id)
    branch = await omp.sessions.branch()
    assert any(item.id == current.id for item in visible) and fetched.id == current.id
    assert historical and latest is not None and watermark == latest.id
    return json.dumps({
        "session": current.id,
        "texts": texts,
        "latest": latest.value.text,
        "historical": len(historical),
        "usage_sessions": usage.sessions,
        "lineage": len(lineage),
        "tree": len(tree),
        "branch": len(branch),
    }, sort_keys=True)

@omp.hook("extension_activate")
async def activated(event, ctx):
    return None
