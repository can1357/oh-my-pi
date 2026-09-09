import omp


@omp.tool(kind="hard")
async def hello(value: str) -> str:
    return f"echo:{value}:chars={len(value)}"
