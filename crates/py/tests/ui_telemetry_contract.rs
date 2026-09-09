//! Focused proof that UI, telemetry, and projection callbacks cross the Python
//! host bridge.

use omp_py::{Engine, pyo3::ffi::c_str};

#[test]
fn ui_telemetry_host_contract() {
	let engine = Engine::builder().init().expect("embedded Python boots");
	engine
		.attach(|py| {
			py.run(
				c_str!(
					r#"
import asyncio
import dataclasses
import importlib

import omp

telemetry = importlib.import_module("omp.telemetry")
verdicts = importlib.import_module("omp._verdicts")


class InstrumentSink:
    def add(self, *args):
        pass

    def record(self, *args):
        pass


class Backend:
    def __init__(self):
        self.effects = []
        self.calls = []
        self.instrument = InstrumentSink()

    def effect(self, effect):
        self.effects.append(effect)

    async def request(self, operation, arguments):
        self.calls.append((operation, arguments))
        if operation == "omp.ui.presentation":
            return {
                "charset": "ascii", "appearance": "light", "width": 120,
                "height": 40, "graphics": "cells", "hyperlinks": True,
                "has_ui": True,
            }
        if operation == "omp.ui.commands":
            return {
                "commands": [{
                    "name": "review", "aliases": ["rv"],
                    "description": "Review changes", "source": "extension",
                }]
            }
        if operation == "omp.ui.icons":
            return ["check", "chevron-right"]
        if operation == "omp.ui.editor_text":
            return "draft"
        if operation == "omp.ui.confirm":
            title = arguments["title"]
            if title == "Declined":
                return {
                    "accepted": False, "value": None, "values": None,
                    "answers": None, "reason": None,
                }
            if title == "Dismissed":
                return {
                    "accepted": False, "value": None, "values": None,
                    "answers": None, "reason": "dismissed",
                }
            if title == "Timed out":
                return {
                    "accepted": False, "value": None, "values": None,
                    "answers": None, "reason": "timed_out",
                }
            return {
                "accepted": True, "value": None, "values": None,
                "answers": None, "reason": None,
            }
        if operation == "omp.ui.select":
            return {
                "accepted": True, "value": "alpha", "values": None,
                "answers": None, "reason": None,
            }
        if operation == "omp.ui.multi_select":
            return {
                "accepted": True, "value": None, "values": ["alpha", "beta"],
                "answers": None, "reason": None,
            }
        if operation == "omp.ui.form":
            return {
                "accepted": True, "value": None, "values": None,
                "answers": {"name": "Ada", "enabled": True}, "reason": None,
            }
        if operation == "omp.ui.ask_user":
            return {
                "accepted": True, "value": None, "values": None,
                "answers": {
                    "language": {
                        "selected": ["python"], "freeform": None,
                        "note": "preferred", "timed_out": False,
                    },
                },
                "reason": None,
            }
        if operation == "omp.ui.overlay":
            return {"id": "overlay-1"}
        if operation == "omp.ui.overlay_values":
            return {"name": "Ada"}
        if operation in {"omp.ui.overlay_close", "omp.telemetry.export.stop", "omp.telemetry.span.close"}:
            return None
        if operation == "omp.telemetry.export.stats":
            return {
                "sent": 8, "dropped": 1, "failures": 0, "queue_depth": 2,
                "last_flush_ms": 9, "last_error": None, "backoff_ms": 0,
            }
        if operation == "omp.telemetry.flush":
            return True
        if operation == "omp.telemetry.query":
            return {
                "rows": [{
                    "events": [], "bindings": {}, "session": "s", "turn": 3,
                    "values": {"count()": 4},
                }],
                "total": 1, "cursor": None, "truncated": False,
                "scanned_sessions": 1, "scanned_events": 4,
                "backfilled": False, "floored": False, "elapsed_ms": 2,
            }
        if operation == "omp.telemetry.rev_metrics":
            return [{
                "rev": "hl.3", "first_seen_ms": 1, "last_seen_ms": 2,
                "sessions": 1, "calls": 4, "ok": 3, "faults": 1,
                "blocked": 0, "timeouts": 0, "aborted": 0, "skipped": 0,
                "postcondition_rejected": 0, "abandoned": 0,
                "fault_codes": {"conflict": 1}, "repaired_calls": 1,
                "repair_paths": {"$.ops": 1}, "retry_rate": 0.25,
                "p50_latency_ms": 2.0, "p95_latency_ms": 3.0,
                "p99_latency_ms": 4.0, "p50_speculation_ms": 0.0,
                "p50_prompt_bytes": 40.0, "p95_prompt_bytes": 50.0,
                "spills": 0, "issues": 0,
            }]
        if operation == "omp.telemetry.span.open":
            return {
                "handle": "span-1",
                "trace": {"trace_id": "a" * 32, "span_id": "b" * 16, "sampled": True},
            }
        raise AssertionError(f"unexpected operation {operation}")


backend = Backend()
omp._install_control_backend(backend)

# Synchronous effects enter the configured host queue rather than disappearing.
omp.ui.mount(omp.ui.Slot.HEADER, omp.ui.text("connected"), key="contract")
omp.ui.notify(
    "ready", level=omp.ui.Level.WARN, title="Contract", desktop=True,
    sound=omp.ui.Sound.WARNING, urgency=omp.ui.Urgency.CRITICAL,
)
omp.ui.set_status(
    "contract-status", omp.ui.text("left"), order=7, side=omp.ui.Slot.STATUS_LEFT,
)
omp.ui.set_progress(omp.ui.Progress.value(42))
image = omp.ui.image(b"P6 image bytes", w=2, h=1, trim=True)
omp.ui.set_editor_text("hello")
omp.ui.set_working_indicator(())
assert [effect["kind"] for effect in backend.effects] == [
    "mount", "notify", "set_status", "set_progress", "image", "set_editor_text",
    "set_working_indicator",
]
assert backend.effects[0]["body"]["content"] == {"source": "<text>connected</text>"}
assert backend.effects[1]["body"] == {
    "message": "ready", "level": "warn", "title": "Contract",
    "desktop": True, "sound": "warning", "urgency": "critical",
}
assert backend.effects[2]["body"] == {
    "key": "contract-status", "content": {"source": "<text>left</text>"},
    "order": 7, "side": "status_left",
}
assert backend.effects[3]["body"] == {"state": {"kind": "value", "pct": 42}}
image_body = backend.effects[4]["body"]
assert image_body["source"] == b"P6 image bytes"
assert image_body["resource"].startswith("ext-image-")
assert image.source == (
    f"<img src={image_body['resource']} w=2 h=1 trim/>"
)
assert backend.effects[-1]["body"] == {"frames": [], "interval_ms": None}

ui_callbacks = []

@omp.completion(omp.ui.Trigger(prefix="@@", max_results=1))
async def complete_contract(query, ctx):
    ui_callbacks.append(("completion", query, ctx))
    return [omp.ui.CompletionItem("one"), omp.ui.CompletionItem("two")]

@omp.shortcut("ctrl+alt+u", action_id="contract-action")
async def shortcut_contract(action, ctx):
    ui_callbacks.append(("shortcut", action.action_id, ctx))

@omp.command("contract-command", arg_completions=lambda query, ctx: [omp.ui.CompletionItem(query.prefix)])
async def command_contract(invocation, ctx):
    ui_callbacks.append(("command", invocation.argv, ctx))
    return omp.ui.Prompt("projected")

@omp.message_renderer("contract-message")
def message_contract(message, ctx):
    return omp.ui.text(message.text)


telemetry_events = []

@telemetry([telemetry.Kind.TURN_START])
async def telemetry_contract_sink(event, ctx):
    telemetry_events.append((event, ctx))


@dataclasses.dataclass(frozen=True, slots=True)
class ContractPayload(omp.Payload):
    value: int = 1


@dataclasses.dataclass(frozen=True, slots=True)
class ContractFault(omp.Fault):
    detail: str = "fault"


class ContractDevice:
    Payload = ContractPayload
    Fault = ContractFault

    async def __call__(self, args, ctx):
        return ContractPayload()

    def prompt(self, view, caps):
        return [omp.Part.text("real projection")]


omp.device("ui_telemetry_contract_device", family="contract", rev=1)(ContractDevice())


@omp.renderer("ui_telemetry_contract_device", family="contract", rev=1)
def contract_renderer(view, ctx):
    assert isinstance(view, omp.View)
    assert isinstance(view.verdict, omp.Ok)
    return omp.ui.text(f"{view.verdict.payload.value}@{ctx.width}")


async def contract():
    presentation = await omp.ui.presentation()
    assert presentation.charset is omp.ui.Charset.ASCII
    assert presentation.appearance is omp.ui.Appearance.LIGHT
    assert presentation.has_ui and presentation.width == 120
    assert await omp.ui.commands() == ({
        "name": "review", "aliases": ("rv",),
        "description": "Review changes", "source": "extension",
    },)
    assert await omp.ui.icons("ch") == ("check", "chevron-right")
    assert await omp.ui.editor_text() == "draft"
    outcome = await omp.ui.confirm("Continue?")
    assert isinstance(outcome, omp.ui.DialogOutcome)
    assert not outcome.cancelled and outcome.confirmed and outcome.reason is None
    declined = await omp.ui.confirm("Declined")
    assert not declined.cancelled and not declined.confirmed and declined.reason is None
    dismissed = await omp.ui.confirm("Dismissed")
    assert dismissed.cancelled and dismissed.reason is omp.ui.DialogCancel.DISMISSED
    timed_out = await omp.ui.confirm("Timed out")
    assert timed_out.cancelled and timed_out.reason is omp.ui.DialogCancel.TIMED_OUT
    selected = await omp.ui.select("Choose", ["alpha"])
    assert selected.value == "alpha" and selected.values == ()
    multi = await omp.ui.multi_select("Choose", ["alpha", "beta"])
    assert multi.values == ("alpha", "beta")
    form = await omp.ui.form("Profile", ())
    assert form.fields == {"name": "Ada", "enabled": True}
    answers = await omp.ui.ask_user(omp.ui.AskQuestion("language", "Language?"))
    assert answers.answers == (
        omp.ui.AskAnswer(
            "language", selected=("python",), note="preferred", timed_out=False,
        ),
    )
    overlay = await omp.ui.overlay(omp.ui.text("form"))
    assert await overlay.values() == {"name": "Ada"}
    await overlay.close()

    completions = await omp.ui._dispatch_completion("@@", "q", "ctx")
    assert completions == (omp.ui.CompletionItem("one"),)
    await omp.ui._dispatch_shortcut(
        {"action_id": "contract-action", "chord": "ctrl+alt+u", "phase": "idle"},
        "ctx",
    )
    command_result = await omp.ui._dispatch_command(
        {"name": "contract-command", "argv": ["a"], "raw": "/contract-command a", "mode": "interactive"},
        "ctx",
    )
    assert command_result == omp.ui.Prompt("projected")
    arg_results = await omp.ui._dispatch_command_completion(
        "contract-command", {"prefix": "pre", "argv": []}, "ctx"
    )
    assert arg_results == (omp.ui.CompletionItem("pre"),)
    rendered = omp.ui._dispatch_message_renderer(
        "contract-message",
        {"id": "m1", "kind": "assistant", "role": "assistant", "text": "rendered"},
        {
            "width": 80, "charset": "unicode", "appearance": "dark",
            "graphics": "cells", "hyperlinks": False, "focused": False,
            "collapsed": False, "place": "transcript",
        },
    )
    assert rendered == omp.ui.text("rendered")
    verdict_rendered = omp.ui._dispatch_renderer(
        "ui_telemetry_contract_device",
        "contract",
        1,
        {
            "call_id": "call-1",
            "updates": [],
            "state": None,
            "verdict": {"kind": "ok", "value": {"value": 1}},
            "elapsed": "1ms",
            "phase": "OPEN",
        },
        {
            "width": 80, "charset": "unicode", "appearance": "dark",
            "graphics": "cells", "hyperlinks": False, "focused": False,
            "collapsed": False, "place": "transcript",
        },
    )
    assert verdict_rendered == omp.ui.text("1@80")

    subscribed = []
    cancelled = []
    omp.ui._install_terminal_input(
        granted=True, headless=False, focus_token="focus-1",
        subscribe=subscribed.append, cancel=cancelled.append,
    )
    stream = omp.ui.terminal_input()
    pending = asyncio.create_task(anext(stream))
    await asyncio.sleep(0)
    assert omp.ui._feed_terminal_input({"sequence": 7, "data": b"x", "focus_token": "focus-1"})
    frame = await pending
    assert frame.sequence == 7 and frame.data == b"x"
    await stream.aclose()
    assert subscribed == ["focus-1"] and cancelled == ["focus-1"]

    event = {
        "kind": "turn_start", "seq": 1, "at_ms": 2, "session": "s",
        "agent": "main", "depth": 0, "conversation": "c", "trace": None,
        "principal": "p", "generation": 1, "turn": 3, "trigger": "user",
        "input_chars": 1, "input_parts": 1, "attachments": 0,
        "model": "m", "effort": None,
    }
    stats = {
        "delivered": 1, "dropped": 2, "coalesced": 0, "errored": 0,
        "replay_skipped": 0, "queue_depth": 0, "first_drop_seq": 4,
        "since_ms": 10,
    }
    await telemetry._dispatch_subscription(
        f"{telemetry_contract_sink.__module__}.{telemetry_contract_sink.__qualname__}",
        event, "telemetry-ctx", stats,
    )
    assert isinstance(telemetry_events[0][0], telemetry.TurnStart)
    assert telemetry_events[0][1] == "telemetry-ctx"
    assert telemetry.dropped(telemetry_contract_sink).dropped == 2

    target = telemetry.OtlpTarget("https://collector.example")
    export_handle = telemetry.export(target)
    export_stats = await export_handle.stats()
    assert isinstance(export_stats, telemetry.ExportStats) and export_stats.sent == 8
    await export_handle.stop()
    assert await telemetry.flush()

    query = telemetry.Query(match=(telemetry.Step(kinds=(telemetry.Kind.TURN_START,)),))
    query_result = await telemetry.query(query)
    assert isinstance(query_result, telemetry.QueryResult)
    assert isinstance(query_result.rows[0], telemetry.Row)
    assert query_result.rows[0]["count()"] == 4
    metrics = await telemetry.rev_metrics("edit", family="hl")
    assert metrics[0].rev == omp.Rev("hl", 3) and metrics[0].calls == 4

    async with telemetry.span("contract.span", phase="test") as active_span:
        assert active_span.trace.sampled
        active_span.set(rows=1)
        active_span.event("checkpoint", ready=True)
    assert backend.calls[-1][0] == "omp.telemetry.span.close"


asyncio.run(contract())

caps = omp.PromptCaps(
    maximum_parts=1,
    maximum_text_bytes=64,
    media=False,
    dialect=omp.Dialect.NATIVE,
    model_class=omp.ModelClass.FRONTIER,
)

assert omp.prompt(omp.Ok(ContractPayload()), caps) == [omp.TextPart("real projection")]
assert verdicts._dispatch_prompt(
    "ui_telemetry_contract_device", "contract", 1, omp.Ok(ContractPayload()), caps
) == [omp.TextPart("real projection")]
assert {entry[0] for entry in ui_callbacks} == {"completion", "shortcut", "command"}
assert {operation for operation, _ in backend.calls} >= {
    "omp.ui.presentation", "omp.ui.confirm", "omp.telemetry.query",
    "omp.telemetry.export.stats", "omp.telemetry.span.open",
    "omp.telemetry.span.close",
}
"#
				),
				None,
				None,
			)
		})
		.expect("UI and telemetry callbacks reach the host bridge");
}
