import importlib
import json

import omp

from ._qa_params import PARAMS

SYMBOLS = PARAMS["symbols"]


@omp.tool(kind="hard")
async def hello() -> str:
    resolved = {}
    for symbol in SYMBOLS:
        module, _, attr = symbol.rpartition(".")
        try:
            owner = importlib.import_module(module)
        except ImportError:
            resolved[symbol] = "missing-module"
            continue
        resolved[symbol] = "ok" if hasattr(owner, attr) else "missing-attr"

    duration = omp.Duration("30s")
    usage = omp.agents.Usage(requests=2, output_tokens=7, wall=duration)
    budget = omp.agents.Budget(max_requests=3, max_wall=duration)
    spec = omp.agents.SubagentSpec(
        task="Inspect one file",
        name="Probe",
        agent="task",
        thinking=omp.agents.ThinkingLevel.LO,
        allowed_devices=frozenset(),
        isolation=omp.agents.Isolation.CLEAN,
        max_depth=0,
        merge=omp.agents.MergeMode.NONE,
        budget=budget,
    )
    completion = omp.agents.Completion("allow", "allow", None, usage, "mock")
    continuation = omp.agents.Continue("Continue once", label="qa")
    continuation_policy = omp.agents.ContinuationPolicy(max_consecutive=1)
    loop_signal = omp.agents.LoopSignal(0, "digest", 0, 0, False)
    triggers = (
        omp.agents.Cron("0 * * * *"),
        omp.agents.Every(duration),
        omp.agents.At(1),
        omp.agents.AfterIdle(duration),
    )
    inject = omp.agents.Inject("scheduled prompt", omp.agents.DeliveryMode.NEXT_TURN, True)
    spawn = omp.agents.Spawn(spec)
    schedule_budget = omp.agents.ScheduleBudget(max_requests_per_firing=1)
    schedule = omp.agents.Schedule(
        "schedule-id", "qa-schedule", triggers[0], inject,
        omp.agents.ScheduleScope.SESSION, True, "qaext", "principal", "digest",
        omp.agents.UpgradePolicy.PINNED, omp.agents.MissedRunPolicy.COALESCE,
        schedule_budget, "skip", 1, 2, None, 0, 0,
    )
    firing = omp.agents.Firing(
        "schedule-id", "schedule-id:1", 1, 0, "injected", "digest",
        "principal", None, None,
    )
    message = omp.agents.Message(
        "message-id", "Main", "Probe", "hello", omp.agents.DeliveryMode.ASIDE,
        None, 1, "session-id",
    )
    rewind_target = omp.agents.RewindTarget(2, 1, "prompt", 3, None)
    rewind_report = omp.agents.RewindReport(
        1, 0, omp.agents.RestoreScope.THREAD, None, True,
    )
    spawn_limits = omp.agents.SpawnLimits(2, 0, 32, 0, 0, 8, 0, True)
    spawn_error = omp.agents.SpawnDenied("denied", "task")
    settle = omp.agents.Settle()

    async_calls = (
        "abort", "broadcast", "completion", "continuations", "get", "inbox",
        "inject", "is_idle", "limits", "list", "loop_signal", "peers",
        "pending_messages", "reload_extensions", "restore", "revive", "rewind",
        "rewind_targets", "schedule", "schedules", "send",
        "set_continuation_policy", "set_model", "shutdown", "snapshot", "snapshots",
        "spawn", "spawn_all", "unschedule", "wait_for", "wait_for_idle",
    )
    handle_methods = ("status", "progress", "steer", "cancel", "wait", "result", "release")
    schedule_methods = ("pause", "resume", "delete", "fire_now", "info", "history")
    registrations = {
        "async_calls": all(callable(getattr(omp.agents, name)) for name in async_calls),
        "steering": all(callable(getattr(omp.agents.SubagentHandle, name)) for name in handle_methods),
        "scheduling": (
            callable(omp.agents.schedule)
            and callable(omp.agents.schedules)
            and callable(omp.agents.unschedule)
            and callable(omp.agents.timer)
            and all(callable(getattr(omp.agents.ScheduleHandle, name)) for name in schedule_methods)
            and callable(omp.agents.TimerHandle.cancel)
        ),
    }
    report = {
        "resolved": resolved,
        "registrations": registrations,
        "representatives": {
            "spawn": [spec.name, spec.max_depth, budget.max_requests],
            "completion": [completion.choice, completion.usage.requests],
            "continuation": [continuation.label, continuation_policy.max_consecutive, loop_signal.stalled, type(settle).__name__],
            "schedule": [schedule.name, type(spawn).__name__, firing.outcome, len(triggers)],
            "messaging": [message.text, message.mode.value],
            "time_travel": [rewind_target.event, rewind_report.scope.value],
            "limits": [spawn_limits.max_concurrency, omp.agents.DEFAULT_MAX_DEPTH, omp.agents.MAILBOX_CAPACITY],
            "exceptions": [type(spawn_error).__name__, spawn_error.field],
            "depth": omp.agents.depth,
        },
    }
    return json.dumps(report)
