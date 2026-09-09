import json, pathlib
import omp

@omp.telemetry(["model_request"], scope=omp.telemetry.Scope.SELF)
async def sink(event, ctx):
    pathlib.Path("telemetry-delivered.json").write_text(json.dumps({
        "kind": event.kind.value,
        "seq": event.seq,
        "served_model": event.served_model,
    }))

@omp.tool(kind="hard")
async def hello() -> str:
    stats = omp.telemetry.dropped(sink)
    return json.dumps({
        "delivered": stats.delivered,
        "dropped": stats.dropped,
    })
