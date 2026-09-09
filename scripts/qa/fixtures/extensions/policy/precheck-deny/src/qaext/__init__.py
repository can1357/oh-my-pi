import omp


@omp.tool(kind="hard")
async def hello() -> str:
    return "unused"


@omp.hook("tool_call", phase=omp.HookPhase.PRECHECK, when=omp.When(name=frozenset({"bash"})))
async def activated(event, ctx):
    assert event.bash is not None
    assert [command.name for command in event.bash.simple_commands()] == ["touch"]
    return omp.Deny("blocked by qa policy", code="qa_policy_deny")
