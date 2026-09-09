import importlib
import json
import omp
from typing import Annotated
from omp.params import params as params_decorator

from ._qa_params import PARAMS

D = importlib.import_module("omp.devices")
P = importlib.import_module("omp.params")
L = importlib.import_module("omp.placement")
SYMBOLS = PARAMS["symbols"]

@params_decorator
class Matrix:
    flag: Annotated[bool, omp.Coerce.LOOSE_BOOL]
    count: Annotated[int, omp.Coerce.INTEGER]
    ratio: Annotated[float, omp.Coerce.NUMBER]
    label: Annotated[str, omp.Coerce.STRING, omp.Coerce.STRIP]

@omp.tool(kind="hard")
async def hello(args: Matrix):
    resolved = {}
    for symbol in SYMBOLS:
        module_name, _, attr = symbol.rpartition(".")
        resolved[symbol] = getattr(importlib.import_module(module_name), attr).__name__ if hasattr(getattr(importlib.import_module(module_name), attr), "__name__") else "value"

    effects = D.Effects(
        documents=D.DocEffects(read=True, write_globs=("*.txt",)),
        exec=D.ExecEffects(commands=("printf",), network=False),
        inference=D.InferenceEffects(max_requests=1, max_usd=0.01),
        subagents=1,
    )
    availability = D.Availability(False, "offline")
    example = D.Example({"label": "sample"}, note="representative")
    tool_path = D.ToolPath("hello")
    mount = D.MountSpec("leaf", lambda: None, {"type": "object"}, "leaf summary")
    issue = P.ArgIssue(("label",), "a label", P.ArgIssueKind.MISSING, example="name")
    interrupt = P.Interrupt("steering", "changed course")
    place = L.Place.parse("worker:index")
    site = L.Site.attached("remote-worker")
    resources = L.WorkerResources(memory_bytes=1048576, cpu_shares=1.0, open_files=32)
    spec = L.WorkerSpec("index", resources=resources)
    spill = L.Spill(b"abc", media_type="text/plain")

    values = args if isinstance(args, dict) else vars(args)
    report = {
        "resolved": resolved,
        "matrix": values,
        "effects": [effects.documents.read, effects.exec.commands[0], effects.inference.max_requests, effects.subagents],
        "availability": [availability.mounted, availability.reason],
        "example": [dict(example.args), example.note],
        "path": str(tool_path),
        "mount": mount.subpath,
        "issue": [list(issue.path), issue.kind.value],
        "interrupt": [interrupt.kind, interrupt.reason],
        "placement": [str(place), place.kind.value, place.name, site.kind.value, site.process],
        "worker": [spec.name, spec.resources.memory_bytes],
        "spill": [bytes(spill.value).decode(), spill.media_type],
    }
    return json.dumps(report)
