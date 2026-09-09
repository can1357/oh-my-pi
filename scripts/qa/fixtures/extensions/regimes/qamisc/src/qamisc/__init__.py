import json
import omp

@omp.tool(kind="hard")
async def hello() -> str:
    limits = [
        omp.limits.ACTIVATION_TIMEOUT, omp.limits.API_LEVEL, omp.limits.API_LEVELS,
        omp.limits.CANCEL_GRACE, omp.limits.DOCS_TOTAL_BUDGET, omp.limits.HEALTH_TIMEOUT,
        omp.limits.HOST_VERSION, omp.limits.INTERACTIVE_CAP, omp.limits.MAX_FRAME_BYTES,
        omp.limits.MAX_HOST_CHILDREN, omp.limits.MAX_PENDING_EFFECTS, omp.limits.MODIFY_ROUNDS,
        omp.limits.OBSERVE_CAP, omp.limits.PING_INTERVAL, omp.limits.PYTHON_REV,
        omp.limits.REENTRANCY_DEPTH, omp.limits.SCHEMA_REV,
        omp.limits.SETTLE_CONTINUATION_CAP, omp.limits.SHUTDOWN_BUDGET,
        omp.limits.SHUTDOWN_GRACE,
    ]
    slot_class = next(iter(omp.prompts.SlotClass))
    prompt_context = omp.prompts.PromptContext(
        session_id="session", model="model", provider="provider", context_window=8192,
        epoch=2, cwd="/workspace", roots=("/workspace",), vcs_branch="main",
        vcs_commit=None, is_subagent=False, agent_kind=None, slot="recall",
        cls=slot_class, budget_bytes=1024,
    )
    prompt_errors = [
        omp.prompts.SlotClassConflict("conflict"),
        omp.prompts.UnknownSlot("unknown"),
        omp.prompts.VolatilePrompt("volatile"),
    ]
    try:
        @omp.prompts.prompt_slot("recall")
        def too_late(ctx):
            return str(ctx)
    except Exception as error:
        sealed = type(error).__name__
    else:
        raise AssertionError("late prompt slot declaration was accepted")
    diagnostic_values = []
    for enum_type in (
        omp.diagnostics.DiagnosticCode,
        omp.diagnostics.FailureCode,
        omp.diagnostics.WarningCode,
    ):
        first = next(iter(enum_type))
        diagnostic_values.append(enum_type(first.value).value)
    report = {
        "limit_count": len(limits),
        "limits_non_null": all(value is not None for value in limits),
        "prompt_slot": prompt_context.slot,
        "prompt_cls": prompt_context.cls.value,
        "errors": [type(error).__name__ for error in prompt_errors],
        "sealed": sealed,
        "diagnostics": diagnostic_values,
    }
    return json.dumps(report)
