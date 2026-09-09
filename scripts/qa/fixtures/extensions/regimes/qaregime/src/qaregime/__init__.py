from dataclasses import dataclass
import omp

@dataclass(frozen=True)
class DraftState:
    turns: int = 0

@omp.tool(kind="hard")
async def hello() -> dict:
    records = await omp.regimes.active()
    if records:
        stopped = await omp.regimes.stop(records[0].id)
        return {"stopped": str(stopped)}
    handle = await omp.regimes.start("activated", state=DraftState())
    records = await omp.regimes.active()
    return {"activation": str(handle), "active": len(records)}

def at_limit(ctx, next_):
    return next_.complete()

@omp.regimes.regime(
    "activated",
    on=(omp.regimes.SETTLE,),
    lifetime=omp.regimes.RegimeLifetime.RUN,
    state=DraftState,
    max_steps=1,
    on_limit=at_limit,
)
def activated(ctx: omp.regimes.RegimeContext, next_: omp.regimes.Next):
    assert isinstance(ctx.event, omp.regimes.RegimeEvent)
    state = ctx.state.value
    ctx.state.replace(DraftState(state.turns + 1))
    ctx.context.append(omp.regimes.user_text("REGIME_DRAFT_EFFECT"))
    return next_.retry()
