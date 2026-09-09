import omp


@omp.tool(kind="hard")
async def hello() -> str:
    return "unused"


@omp.hook("tool_call", phase=omp.HookPhase.APPROVAL, when=omp.When(name=frozenset({"bash"})))
async def activated(event, ctx):
    assert event.bash is not None
    return omp.RequireApproval(omp.ApprovalSpec(
        title="Approve QA command",
        body="No external approver is configured.",
        subject=event.bash.source,
        kind=omp.ApprovalKind.EXEC,
        route=omp.ApprovalRoute.NONE,
        timeout=omp.Duration("20ms"),
        default=False,
        evidence=("qa-approval-rule",),
    ))
