import importlib
import json
import omp

p = importlib.import_module("omp.provider")

@omp.tool(kind="hard")
async def hello(operation: str) -> str:
    if operation == "models":
        cards = await p.models()
        return json.dumps({"cards": len(cards)})
    intent = p.Intent(p.IntentKind.SERVICE_TIER, payload="priority")
    p.intents.set("qa-provider", intent)
    p.intents.clear("qa-provider")
    return json.dumps({"intent": intent.kind.value})
