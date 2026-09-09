
import json
import omp
import omp.env as env



@omp.tool(
    kind="hard",
    effects=omp.Effects(
        documents=omp.DocEffects(read=True),
        exec=omp.ExecEffects(commands=("*",), network=False),
    ),
)
async def hello() -> str:
    info = env.info()
    assert env.has(env.Capability.DOC_READ, env.Capability.EXEC)
    path = omp.EnvPath("notes.txt")
    joined = info.root.join("nested", "child.txt")
    assert path.uri.endswith("/notes.txt")
    assert joined.uri.startswith("file://") and str(joined).endswith("nested/child.txt")

    try:
        with open("sandbox-bypass.txt", "wb") as handle:
            handle.write(b"forbidden")
    except PermissionError:
        direct_write_denied = True
    else:
        direct_write_denied = False
    assert direct_write_denied

    async with env.sh.session(cwd=info.root) as session:
        run = await session.run("printf tracked-exec")
        assert isinstance(run, env.Run) and run.id
        chunks = []
        completed = None
        async for event in run:
            if isinstance(event, env.Output):
                chunks.append(event.data)
            elif isinstance(event, env.Exit):
                completed = event.status
        assert b"".join(chunks) == b"tracked-exec"
        assert isinstance(completed, env.Completed)
        assert completed.outcome is env.Outcome.EXITED and completed.text() == "tracked-exec"

    return json.dumps({
        "marker": "env-live-ok",
        "direct_write_denied": direct_write_denied,
        "exec": completed.text(),
        "path": str(path),
        "uri": path.uri,
    })
