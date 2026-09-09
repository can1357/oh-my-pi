import omp


_activation = None


@omp.hook("extension_activate")
async def activated(event, ctx: omp.Context) -> None:
    global _activation
    _activation = {
        "reason": str(event.reason),
        "event": ctx.event,
        "extension": ctx.extension,
    }


@omp.tool(kind="hard")
async def hello(value: str) -> dict:
    return {"value": value, "activation": _activation}
