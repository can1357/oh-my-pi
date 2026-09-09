import json
import omp

@omp.tool(kind="hard")
async def hello() -> str:
    rows = await omp.telemetry.rev_metrics("hello", scope=omp.telemetry.Scope.SELF)
    return json.dumps({"rows": len(rows), "revs": [str(row.rev) for row in rows]})
