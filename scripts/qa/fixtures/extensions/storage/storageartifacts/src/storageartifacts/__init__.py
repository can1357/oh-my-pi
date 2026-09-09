import hashlib
import json
import omp
from omp import artifacts

@omp.tool(kind="hard", effects=omp.Effects(documents=omp.DocEffects(read=True, write_globs=("**",))))
async def hello() -> str:
    checks = {}
    outcomes = {}
    payload = b"alpha\nbeta\ngamma\n"
    digest = hashlib.sha256(payload).hexdigest()
    ref = omp.ArtifactRef(id="7", hash=digest, media_type="text/plain", byte_len=len(payload))
    address = artifacts.url(ref)
    checks["sha256_address"] = (
        ref.hash == digest and isinstance(address, omp.ArtifactUrl) and str(address) == "artifact://7"
    )
    metadata = artifacts.ArtifactStat(
        ref=ref,
        url=address,
        media_type="text/plain",
        byte_len=len(payload),
        description="QA text",
        lifetime=omp.ArtifactLifetime.SESSION,
        created_ms=1,
        source="extension",
        reachable_from=(),
        lines=3,
    )
    checks["stat_record"] = metadata.ref == ref and metadata.lines == 3
    checks["errors"] = all(
        isinstance(error("qa"), artifacts.ArtifactError)
        for error in (artifacts.ArtifactCorrupt, artifacts.ArtifactNotFound, artifacts.ArtifactNotText)
    )

    writer = await artifacts.open_write(media_type="text/plain", description="QA stream")
    try:
        writer.ref
    except RuntimeError:
        checks["writer_precondition"] = True
    checks["writer_protocol"] = hasattr(writer, "write") and hasattr(writer, "__aenter__")

    async def settle(name, awaitable):
        try:
            value = await awaitable
            outcomes[name] = {"status": "ok", "type": type(value).__name__}
        except Exception as error:
            outcomes[name] = {"status": "error", "type": type(error).__name__, "message": str(error)}

    await settle("put", artifacts.put(payload, media_type="text/plain", description="QA text"))
    await settle("adopt", artifacts.adopt(omp.BlobRef(bytes.fromhex(digest), len(payload)), media_type="text/plain"))
    await settle("get", artifacts.get(ref))
    await settle("open", artifacts.open(ref))
    await settle("read", artifacts.read(ref, "raw:2-3"))
    await settle("stat", artifacts.stat(ref))
    await settle("list", artifacts.list(mine=True, limit=20))
    await settle("pin", artifacts.pin(ref, omp.ArtifactLifetime.SESSION))
    checks["host_calls_settle"] = set(outcomes) == {
        "put", "adopt", "get", "open", "read", "stat", "list", "pin"
    }
    checks["host_results_typed"] = (
        outcomes["list"] == {"status": "ok", "type": "tuple"}
        and outcomes["put"] == {"status": "ok", "type": "ArtifactRef"}
        and outcomes["adopt"] == {"status": "ok", "type": "ArtifactRef"}
        and all(
            outcomes[name]["status"] == "error"
            and outcomes[name]["type"] == "ControlProtocolError"
            for name in ("get", "open", "read", "stat", "pin")
        )
    )
    checks["host_errors_typed"] = all(
        row["message"] for row in outcomes.values() if row["status"] == "error"
    )
    return json.dumps({"checks": checks, "outcomes": outcomes}, sort_keys=True)
