import omp


@omp.tool(kind="hard")
async def hello() -> str:
    return "unused"


@omp.hook("tool_call", phase=omp.HookPhase.TRANSFORM, order=10, when=omp.When(name=frozenset({"bash"})))
async def activated(event, ctx):
    return omp.Modify(patch={"command": "printf modified > hook-output"}, reason="qa rewrite")
