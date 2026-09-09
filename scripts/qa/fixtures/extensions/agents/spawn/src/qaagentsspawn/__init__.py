import json

import omp


@omp.tool(kind="hard")
async def hello() -> str:
    report = {}
    try:
        spec = omp.agents.SubagentSpec(
            task="Yield the exact structured token child-settled-7319.",
            name="QaChild",
            agent="task",
            allowed_devices=frozenset(),
            max_depth=0,
            output_schema={
                "type": "object",
                "properties": {"token": {"type": "string"}},
                "required": ["token"],
                "additionalProperties": False,
            },
            schema_mode="strict",
        )
        handle = await omp.agents.spawn(spec)
        report["handle"] = {
            "run_id": handle.run_id,
            "session_id": handle.session_id,
            "name": handle.name,
            "depth": handle.depth,
            "effective_max_depth": handle.effective_max_depth,
            "output_url": str(handle.output_url),
            "transcript_url": str(handle.transcript_url),
            "steer_registered": callable(handle.steer),
        }
        result = await handle.wait(timeout=omp.Duration("15s"))
        report["result"] = {
            "run_id": result.run_id,
            "session_id": result.session_id,
            "name": result.name,
            "status": result.status.value,
            "data": result.data,
            "text": result.text,
            "turns": result.turns,
            "output_url": str(result.output_url),
            "transcript_url": str(result.transcript_url),
        }
    except Exception as exc:
        report["error"] = {"type": type(exc).__name__, "message": str(exc)}
    return json.dumps(report)
