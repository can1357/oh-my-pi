import omp

observed = False


@omp.tool(kind="hard")
async def hello() -> dict:
    return {"observed": observed}


@omp.hook("tool_call", phase=omp.HookPhase.OBSERVE, when=omp.When(name=frozenset({"bash"})))
async def activated(event, ctx):
    global observed
    observed = event.target.name == "bash"
