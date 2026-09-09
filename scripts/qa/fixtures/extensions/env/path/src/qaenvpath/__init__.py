
import json
import omp
import omp.env as env


@omp.tool(kind="hard")
async def hello() -> str:
    info = env.info()
    path = omp.EnvPath("notes.txt")
    joined = info.root.join("nested", "child.txt")
    assert str(path) == "notes.txt" and path.uri.endswith("/notes.txt")
    assert joined.uri.startswith("file://") and str(joined).endswith("nested/child.txt")
    try:
        with open("sandbox-bypass.txt", "wb") as handle:
            handle.write(b"forbidden")
    except PermissionError:
        denied = True
    else:
        denied = False
    assert denied
    try:
        env.direct_filesystem.grant()
    except env.DirectFilesystemDenied as error:
        assert isinstance(error, PermissionError)
    else:
        raise AssertionError("trusted direct filesystem was ambiently granted")
    return json.dumps({
        "marker": "env-path-ok",
        "direct_write_denied": denied,
        "path": str(path),
        "uri": path.uri,
    })
