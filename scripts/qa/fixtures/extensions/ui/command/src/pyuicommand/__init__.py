import omp
from omp import ui


@omp.tool(kind="hard")
async def hello(name: str = "world") -> str:
    return name


@omp.command("qa-ui")
async def qa_command(inv: ui.Invocation, ctx: omp.Context):
    return ui.Consumed(ui.text(inv.raw))
