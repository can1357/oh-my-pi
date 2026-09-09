import dataclasses
import json

import omp


@dataclasses.dataclass(frozen=True, slots=True)
class RootPayload(omp.Payload):
    value: str


@dataclasses.dataclass(frozen=True, slots=True)
class RootFault(omp.Fault):
    reason: str


@omp.tool(kind="hard")
async def hello(label: str) -> dict:
    payload = RootPayload(value=label, terminate=True)
    fault = RootFault(reason="root-fault-638", terminate=False)
    return json.dumps({
        "payload": payload.value,
        "payload_type": isinstance(payload, omp.Payload),
        "payload_useless": payload.useless(),
        "payload_terminate": payload.terminate,
        "fault": fault.reason,
        "fault_type": isinstance(fault, omp.Fault),
        "fault_terminate": fault.terminate,
    }, sort_keys=True)
