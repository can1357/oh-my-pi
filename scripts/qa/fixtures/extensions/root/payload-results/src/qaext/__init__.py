import dataclasses

import omp


@dataclasses.dataclass(frozen=True, slots=True)
class RootPayload(omp.Payload):
    value: str


@dataclasses.dataclass(frozen=True, slots=True)
class RootFault(omp.Fault):
    reason: str


@omp.tool(kind="hard")
async def hello(value: str, fault: bool = False) -> omp.Payload | omp.Fault:
    if fault:
        return RootFault(reason=value)
    return RootPayload(value=value)
