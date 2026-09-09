import json

import omp


@omp.tool(kind="hard")
async def hello(label: str, ctx: omp.Context) -> str:
    report = {
        "label": label,
        "is_context": isinstance(ctx, omp.Context),
        "extension": ctx.extension,
        "session": ctx.session,
        "principal": str(ctx.principal),
        "generation": ctx.generation,
        "turn": ctx.turn,
        "event": ctx.event,
        "call": ctx.call,
        "device": ctx.device,
        "trust": str(ctx.trust),
        "caps": sorted(str(cap) for cap in ctx.caps),
        "place": str(ctx.place),
        "phase": str(ctx.phase),
        "roots": [str(root) for root in ctx.roots],
        "root": str(ctx.root) if ctx.roots else None,
        "remote": ctx.remote,
        "has_ui": ctx.has_ui,
        "headless": ctx.headless,
        "model": None if ctx.model is None else str(ctx.model),
        "settings": sorted(ctx.settings),
        "deadline": ctx.deadline,
    }
    return json.dumps(report, sort_keys=True)
