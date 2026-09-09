import json
import omp


@omp.tool(kind="hard")
async def hello(script: str) -> str:
    ir = await omp.policy.parse(script)
    commands = list(ir.simple_commands())
    assert ir.parse_ok
    assert [command.name for command in commands] == ["echo", "printf", "cat"]
    assert [[arg.text for arg in command.argv] for command in commands] == [
        ["echo", "one"],
        ["printf", "%s", "two"],
        ["cat"],
    ]
    assert [ir.segment(command.index) for command in commands] == [
        "echo one",
        "printf '%s' two",
        "cat",
    ]
    assert len(ir.lists) == 1
    assert len(ir.lists[0].pipelines) == 2
    assert ir.lists[0].operators == (omp.policy.AndOrOp.AND,)
    assert len(ir.lists[0].pipelines[1].commands) == 2
    return json.dumps({
        "names": [command.name for command in commands],
        "argv": [[arg.text for arg in command.argv] for command in commands],
        "segments": [ir.segment(command.index) for command in commands],
        "pipeline_widths": [len(pipeline.commands) for pipeline in ir.lists[0].pipelines],
    })
