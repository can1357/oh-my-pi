import json
import omp
from omp import telemetry as t


def envelope(kind):
    return dict(kind=kind, seq=1, at_ms=2, session="s", agent="main", depth=0,
                conversation="c", trace=None, principal="p", generation=1)


@omp.tool(kind="hard")
async def hello() -> str:
    tokens = t.Tokens(input=10, output=5, cache_read=4, total=15, detail={"vendor": 1})
    cost = t.Cost(1000000000, False, 600000000, 400000000, None, None, None)
    slot = t.PromptSlotFingerprint("a" * 32, 12, omp.prompts.SlotClass.STABLE)
    prompt = t.PromptFingerprint("b" * 32, {"system": slot}, (), 12, "cache", "short",
                                 "implicit", "unspecified", "none", ())
    context = t.ContextSnapshot(15, 3, 0, None, 100, .15)
    trace = t.TraceRef("a" * 32, "b" * 16, True)
    ext = t.ExtensionRef("pub", "qaext", "1", "digest", "client", "sandboxed", 1)
    degradation = t.Degradation("sampling.top_k", "unsupported", t.DegradeAction.DROPPED)
    drops = t.DropStats(1, 2, 3, 4, 5, 6, 7, 8)

    events = [
        t.Envelope(**envelope(t.Kind.HOST_WARNING)),
        t.SessionStart(**envelope(t.Kind.SESSION_START), resumed=False, parent=None, cwd=".",
                       place="local", remote=None, model="mock", provider="mock", devices=(),
                       core_tools=(), extensions=(ext,), schema_rev="1", prompt=prompt,
                       registry_hash="hash"),
        t.SessionEnd(**envelope(t.Kind.SESSION_END), reason="exit", turns=1, requests=1, calls=0,
                     tokens=tokens, cost=cost, wall_ms=1, faults=0, issues=0),
        t.TurnStart(**envelope(t.Kind.TURN_START), turn=0, trigger="user", input_chars=2,
                    input_parts=1, attachments=0, model="mock", effort=None),
        t.TurnEnd(**envelope(t.Kind.TURN_END), turn=0, steps=1, requests=1, calls=0,
                  tokens=tokens, cost=cost, latency_ms=1, stop=t.StopReason.END_TURN,
                  tools_used=(), faults=0, interrupted=False, context=context),
        t.ModelRequest(seq=1, usage=tokens, prompt=prompt, served_model="mock", latency_ms=1,
                       ttft_ms=1, degraded=(degradation,)),
        t.CapabilityDegraded(**envelope(t.Kind.CAPABILITY_DEGRADED), intent="search", tool=None,
                             rev=None, requested_priority=1, granted=False, reason="missing",
                             provider="mock", budget_used=0, budget_total=1),
        t.Compaction(**envelope(t.Kind.COMPACTION), reason="manual", strategy="summary", by=None,
                     tokens_before=20, tokens_after=10, items_before=2, items_after=1,
                     prompt_text_dropped_bytes=4, outcomes_kept=1, artifacts_promoted=(),
                     duration_ms=1, aborted=False, epoch=1),
        t.IssueReport(**envelope(t.Kind.ISSUE_REPORT), issue="i", tool="hello",
                      rev=t.Rev.parse("hello@qaext.1"), summary="summary", expected=None,
                      observed=None, reporter="extension", reporter_id=None, call_id=None, turn=0,
                      args_raw=None, payload=None, fault=None, repairs=(), labels=(),
                      consent="not_required"),
    ]

    counter = t.Counter("count", "1", "counter")
    histogram = t.Histogram("latency", "ms", "latency", (1, 10))
    span = t.Span("probe", {"case": "telemetry"})
    span.set(checked=True)
    span.event("constructed", count=len(events))
    predicate = t.Predicate()
    eq = t.Eq("mock")
    step = t.Step(kinds=(t.Kind.MODEL_REQUEST,), where={"served_model": eq}, name="request")
    query = t.Query(match=(step,), scope=t.Scope.SELF)
    row = t.Row((events[5],), {"request": events[5]}, "s", 0, {"served_model": "mock"})
    query_result = t.QueryResult((row,), 1, None, False, 1, 1, False, False, 1)
    rev_metrics = t.RevMetrics(t.Rev.parse("hello@qaext.1"), 1, 2, 1, 1, 1, 0, 0, 0, 0, 0,
                               0, 0, {}, 0, {}, 0.0, 1.0, 1.0, 1.0, 0.0, 1.0, 1.0, 0, 0)
    otlp = t.OtlpTarget("http://127.0.0.1:4318")
    process = t.ProcessTarget("collector")
    file_target = t.FileTarget("telemetry.jsonl")
    handle = t.ExportHandle(1, otlp)
    export_stats = t.ExportStats(sent=1)
    attrs = t.attributes(events[6])
    constants = [t.BATCH_MAX, t.DEFAULT_MAX_BYTES, t.DEFAULT_MAX_COLUMN, t.DEFAULT_MAX_LINES,
                 t.MAX_CARDINALITY, t.MAX_INSTRUMENTS, t.METRIC_PREFIX, t.QUERY_LIMIT_MAX,
                 t.QUEUE_DEFAULT, t.QUEUE_MAX, t.SPILL_BYTES, t.SPILL_COLUMN, t.SPILL_LINES,
                 len(t.semconv), t.Overflow.DROP_OLDEST.value]
    report = {
        "events": [type(event).__name__ for event in events],
        "uncached": tokens.uncached_input,
        "usd": cost.usd,
        "drops": drops.dropped,
        "trace": trace.sampled,
        "query": query_result.rows[0]["served_model"],
        "metrics_rev": str(rev_metrics.rev),
        "targets": [type(otlp).__name__, type(process).__name__, type(file_target).__name__],
        "handle": type(handle).__name__,
        "sent": export_stats.sent,
        "attrs": len(attrs),
        "constants": len(constants),
        "predicate": type(predicate).__name__,
    }
    return json.dumps(report, sort_keys=True)
