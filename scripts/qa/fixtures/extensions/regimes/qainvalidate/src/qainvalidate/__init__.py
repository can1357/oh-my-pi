import omp

@omp.tool(kind="hard")
async def hello() -> str:
    generation = await omp.prompts.invalidate("recall")
    return str(generation)
