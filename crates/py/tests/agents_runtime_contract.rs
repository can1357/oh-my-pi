//! Focused Python-to-CONTROL contract for the operational `omp.agents` surface.

use omp_py::{Engine, pyo3::ffi::c_str};

#[test]
fn agents_runtime_control_contract() {
	let engine = Engine::builder().init().expect("embedded Python boots");
	engine
		.attach(|py| {
			py.run(
				c_str!(
					r#"
import asyncio
import omp


USAGE = {
    "input_tokens": 11,
    "cached_input_tokens": 2,
    "output_tokens": 7,
    "reasoning_tokens": 3,
    "cache_write_tokens": 1,
    "requests": 1,
    "cost_usd": 0.02,
    "wall_ms": 25,
}


class RecordingControl:
    def __init__(self):
        self.calls = []

    async def request(self, operation, arguments):
        self.calls.append((operation, arguments))
        if operation == "omp.agents.completion":
            return {"text": "allow", "choice": "allow", "data": None,
                    "usage": USAGE, "model": "test/model", "fell_back": False}
        if operation in ("omp.agents.spawn", "omp.agents.get", "omp.agents.revive"):
            spec = arguments.get("spec", {"task": "inspect", "agent": "task"})
            return {"run_id": "run-1", "session_id": "child-session", "name": "Scout",
                    "agent": "task", "depth": 1, "effective_max_depth": 0, "spec": spec,
                    "worktree_path": None, "output_url": "agent://child",
                    "transcript_url": "history://child"}
        if operation == "omp.agents.spawn_all":
            return [{"run_id": f"run-{index}", "session_id": f"child-{index}",
                     "name": f"Child{index}", "agent": "task", "depth": 1,
                     "effective_max_depth": 0, "spec": spec, "worktree_path": None,
                     "output_url": f"agent://child-{index}",
                     "transcript_url": f"history://child-{index}"}
                    for index, spec in enumerate(arguments["specs"])]
        if operation == "omp.agents.status":
            return "running"
        if operation == "omp.agents.progress":
            return {"status": "running", "turns": 1, "requests": 1, "tool_calls": 0,
                    "context_tokens": 20, "context_window": 100, "usage": USAGE,
                    "activity": "reading", "model": "test/model", "last_activity_ms": 9}
        if operation in ("omp.agents.steer", "omp.agents.inject",
                         "omp.agents.schedule.fire_now"):
            return "delivered"
        if operation in ("omp.agents.cancel", "omp.agents.release",
                         "omp.agents.set_continuation_policy", "omp.agents.schedule.pause",
                         "omp.agents.schedule.resume", "omp.agents.schedule.delete"):
            return None
        if operation in ("omp.agents.abort", "omp.agents.shutdown",
                         "omp.agents.reload_extensions", "omp.agents.wait_for_idle"):
            return None
        if operation == "omp.agents.is_idle":
            return True
        if operation == "omp.agents.pending_messages":
            return 3
        if operation == "omp.agents.result":
            return None
        if operation == "omp.agents.wait":
            return {"run_id": "run-1", "session_id": "child-session", "name": "Scout",
                    "status": "completed", "text": "done", "data": None, "fault": None,
                    "usage": USAGE, "subtree_usage": USAGE, "turns": 2,
                    "model": "test/model", "model_fallback": False, "warnings": [],
                    "output_url": "agent://child", "transcript_url": "history://child",
                    "worktree": None}
        if operation == "omp.agents.continuations":
            return {"consecutive": 1, "total": 2, "cap": 8, "last_ms": 3,
                    "refusals": 0, "owner": "ext"}
        if operation == "omp.agents.loop_signal":
            return {"repeats": 0, "digest": "abc", "no_progress_turns": 0,
                    "empty_output_retries": 0, "stalled": False}
        if operation == "omp.agents.limits":
            return {"max_depth": 2, "depth": 0, "max_concurrency": 32,
                    "running": 1, "queued": 0, "continuation_cap": 8,
                    "continuations_used": 1, "spawn_allowed": True}
        if operation in ("omp.agents.list", "omp.agents.peers"):
            return [{"id": "child", "name": "Scout", "kind": "sub", "status": "running",
                     "agent": "task", "parent": "main", "depth": 1, "activity": "reading",
                     "last_activity_ms": 9, "usage": USAGE, "output_url": "agent://child",
                     "transcript_url": "history://child"}]
        if operation == "omp.agents.send":
            if arguments["to"] == "Timeout":
                return None
            return {"id": "m1", "from": "Main", "to": arguments["to"],
                    "text": "reply", "mode": "aside", "reply_to": "q1",
                    "sent_ms": 4, "session_id": "s1"} if arguments["await_reply"] else "delivered"
        if operation == "omp.agents.broadcast":
            return {"Scout": "woken"}
        if operation == "omp.agents.inbox":
            return []
        if operation == "omp.agents.wait_for":
            return None
        if operation == "omp.agents.rewind_targets":
            return [{"event": 7, "keep": 3, "text": "question", "ts_ms": 8,
                     "snapshot_id": None}]
        if operation == "omp.agents.rewind":
            return {"head": 3, "dropped_items": 2, "scope": arguments["scope"],
                    "restore": None, "dry_run": arguments["dry_run"]}
        if operation == "omp.agents.snapshot":
            return {"id": "snap", "generation": 2, "label": arguments["label"],
                    "created_ms": 8, "root": "file://workspace", "parent": None,
                    "tree_hash": "tree", "entry_count": 4, "bytes": 20,
                    "partial": arguments["paths"] is not None}
        if operation == "omp.agents.snapshots":
            return []
        if operation == "omp.agents.restore":
            return {"from_generation": 2, "to_generation": 1, "written": 1,
                    "deleted": 0, "unchanged": 3, "conflicts": [],
                    "undo_snapshot_id": "undo", "dry_run": arguments["dry_run"]}
        if operation == "omp.agents.schedule":
            return {"id": "schedule-1", "name": arguments["name"]}
        if operation == "omp.agents.schedule.info":
            return {"id": "schedule-1", "name": "Heartbeat",
                    "trigger": {"kind": "every", "interval_ms": 30000,
                                "jitter_ms": 0, "align": False},
                    "delivery": {"kind": "inject", "prompt": "wake",
                                 "mode": "next_turn", "visible": False},
                    "scope": "session", "enabled": True, "owner": "ext",
                    "principal": "user", "artifact_digest": "sha256:test",
                    "upgrade": "pinned", "missed": "coalesce", "budget": None,
                    "overlap": "skip", "created_ms": 1, "next_ms": 30001,
                    "last_ms": None, "fire_count": 0, "miss_count": 0}
        if operation == "omp.agents.schedules":
            return []
        if operation == "omp.agents.unschedule":
            return True
        if operation == "omp.agents.schedule.history":
            return []
        raise AssertionError(f"unexpected operation: {operation}")


async def contract():
    backend = RecordingControl()
    omp._install_control_backend(backend)

    completion = await omp.agents.completion(
        "classify", choices=("allow", "deny"), deadline=omp.Duration("2s")
    )
    assert completion.choice == "allow" and completion.usage.wall.seconds == 0.025
    op, args = backend.calls[-1]
    assert op == "omp.agents.completion" and args["deadline_ms"] == 2000
    assert "default" not in args
    await omp.agents.completion(
        (
            omp.Part.text("inspect"),
            omp.Part.blob(omp.BlobRef(bytes.fromhex("11" * 32), 7), alt="image"),
        ),
        role="vision",
    )
    op, args = backend.calls[-1]
    assert op == "omp.agents.completion"
    assert args["prompt"][1] == {
        "kind": "blob",
        "blob": {"hash": "11" * 32, "size": 7},
        "alt": "image",
    }
    aside = await omp.agents.completion("what changed?", context="thread")
    assert aside.text == "allow"
    op, args = backend.calls[-1]
    assert op == "omp.agents.completion" and args["context"] == "thread"
    assert not {"role", "system", "choices", "schema", "max_output_tokens"} & args.keys()
    for bad in (
        lambda: omp.agents.completion("x", context="thread", choices=("a",)),
        lambda: omp.agents.completion("x", context="thread", system="s"),
        lambda: omp.agents.completion("x", context="thread", role="slow"),
        lambda: omp.agents.completion("x", context="off"),
    ):
        try:
            await bad()
        except (ValueError, TypeError):
            pass
        else:
            raise AssertionError("illegal thread-context completion must raise")
    try:
        await omp.agents.completion((omp.Part.text("t"),), context="thread")
    except TypeError:
        pass
    else:
        raise AssertionError("thread-context prompt must be plain text")

    spec = omp.agents.SubagentSpec(
        task="inspect", name="Scout", max_depth=0,
        thinking=omp.agents.ThinkingLevel.HI,
        allowed_devices=frozenset({"read"}), deadline=omp.Duration("3s"),
    )
    handle = await omp.agents.spawn(spec)
    op, args = backend.calls[-1]
    assert op == "omp.agents.spawn"
    assert args["spec"]["deadline"] == 3000
    assert args["spec"]["thinking"] == "hi"
    assert handle.output_url.uri == "agent://child"
    assert await handle.status() is omp.agents.RunStatus.RUNNING
    assert (await handle.progress()).activity == "reading"
    assert await handle.steer("continue") is omp.agents.Receipt.DELIVERED
    assert await handle.result() is None
    await handle.cancel(reason="contract")
    assert (await handle.wait()).text == "done"
    await handle.release()
    assert (await omp.agents.get("Scout")).name == "Scout"
    assert (await omp.agents.revive("agent://child")).run_id == "run-1"

    handles = await omp.agents.spawn_all((spec, spec))
    assert len(handles) == 2 and handles[1].run_id == "run-1"
    assert (await omp.agents.continuations()).cap == 8
    await omp.agents.set_continuation_policy(omp.agents.ContinuationPolicy(min_interval=omp.Duration("1s")))
    assert backend.calls[-1][1]["policy"]["min_interval_ms"] == 1000
    assert not (await omp.agents.loop_signal()).stalled
    assert (await omp.agents.limits()).spawn_allowed
    assert (await omp.agents.list())[0].output_url.uri == "agent://child"

    assert await omp.agents.send("Scout", "hello") is omp.agents.Receipt.DELIVERED
    reply = await omp.agents.send("Scout", "question", await_reply=True)
    assert reply.text == "reply" and reply.reply_to == "q1"
    try:
        await omp.agents.send("Timeout", "question", await_reply=True)
    except asyncio.TimeoutError:
        pass
    else:
        raise AssertionError("awaited send must surface a missing reply as TimeoutError")
    assert (await omp.agents.broadcast("hello"))["Scout"] is omp.agents.Receipt.WOKEN
    assert await omp.agents.inbox() == [] and await omp.agents.wait_for() is None
    assert (await omp.agents.peers())[0].name == "Scout"
    assert await omp.agents.inject("wake") is omp.agents.Receipt.DELIVERED
    await omp.agents.abort()
    assert backend.calls[-1] == ("omp.agents.abort", {})
    await omp.agents.shutdown(reason="maintenance")
    assert backend.calls[-1] == (
        "omp.agents.shutdown", {"reason": "maintenance"}
    )
    await omp.agents.reload_extensions()
    assert backend.calls[-1] == ("omp.agents.reload_extensions", {})
    assert await omp.agents.is_idle() is True
    await omp.agents.wait_for_idle()
    assert backend.calls[-1] == ("omp.agents.wait_for_idle", {})
    assert await omp.agents.pending_messages() == 3
    try:
        await omp.agents.shutdown(reason=object())
    except TypeError:
        pass
    else:
        raise AssertionError("shutdown reason must be a string")

    for operation in ("abort", "shutdown", "reload_extensions"):
        spec = omp.operation_spec(f"omp.agents.{operation}")
        assert spec.minimum_phase == omp.InvocationPhase.EFFECTS_AUTHORIZED
        expected = (omp.Durability.EPHEMERAL
                    if operation == "reload_extensions" else omp.Durability.DURABLE)
        assert spec.durability == expected
    for operation in ("is_idle", "wait_for_idle", "pending_messages"):
        spec = omp.operation_spec(f"omp.agents.{operation}")
        assert spec.minimum_phase == omp.InvocationPhase.OPEN
        assert spec.durability == omp.Durability.EPHEMERAL

    assert (await omp.agents.rewind_targets())[0].event == 7
    assert (await omp.agents.rewind(3)).head == 3
    snap = await omp.agents.snapshot(label="checkpoint", paths=("src",))
    assert snap.partial and snap.root.uri == "file://workspace"
    assert await omp.agents.snapshots() == []
    assert (await omp.agents.restore("snap")).undo_snapshot_id == "undo"

    schedule = await omp.agents.schedule(
        "Heartbeat", omp.agents.Every(omp.Duration("30s")),
        omp.agents.Inject("wake"),
    )
    op, args = backend.calls[-1]
    assert op == "omp.agents.schedule"
    assert args["trigger"] == {"kind": "every", "interval_ms": 30000,
                               "jitter_ms": 0, "align": False}
    assert args["delivery"]["kind"] == "inject"
    await schedule.pause()
    await schedule.resume()
    assert await schedule.fire_now() is omp.agents.Receipt.DELIVERED
    assert (await schedule.info()).enabled
    assert await schedule.history() == []
    await schedule.delete()
    assert await omp.agents.schedules() == []
    assert await omp.agents.unschedule("Heartbeat")


asyncio.run(contract())
"#
				),
				None,
				None,
			)
		})
		.expect("agents runtime CONTROL contract");
}
