import omp


@omp.tool(kind="hard")
async def hello() -> str:
    return "unused"


@omp.hook("tool_call", phase=omp.HookPhase.PRECHECK, when=omp.When(name=frozenset({"bash"})))
async def activated(event, ctx):
    return omp.Deny("blocked by qa hook", code="qa_deny")
