//! Focused CONTROL/DATA contract proof for Python state and credential
//! surfaces.

use omp_py::{Engine, pyo3::ffi::c_str};

#[test]
fn state_persistence_contract() {
	let engine = Engine::builder().init().expect("embedded Python boots");
	engine
		.attach(|py| {
			py.run(
				c_str!(
					r#"
import asyncio
import base64
import json

import omp
from omp import artifacts, creds, sessions


HASH = "11" * 32


def session_row(session_id="session-a", title="Primary"):
    return {
        "id": session_id,
        "title": title,
        "title_source": "user",
        "cwd": "/workspace",
        "project": "/workspace",
        "created_ms": 10,
        "updated_ms": 20,
        "status": "complete",
        "kind": "interactive",
        "parent": None,
        "entries": 4,
        "turns": 2,
        "usage": {
            "input": 5,
            "output": 7,
            "cache_read": 2,
            "cache_write": 1,
            "reasoning": 3,
            "premium_requests": 1,
            "context": 99,
            "total": 18,
            "accuracy": "exact",
            "detail": {"vendor.tokens": 18},
        },
        "cost": {
            "nanos_usd": 42,
            "estimated": False,
            "input_nanos_usd": 17,
            "output_nanos_usd": 25,
        },
        "models": ["acme/model"],
        "remote": True,
    }


def artifact_ref():
    return {
        "id": "1",
        "hash": HASH,
        "media_type": "text/plain",
        "byte_len": 5,
    }


def artifact_stat():
    return {
        "ref": artifact_ref(),
        "url": "artifact://1",
        "media_type": "text/plain",
        "byte_len": 5,
        "description": "sample",
        "lifetime": "session",
        "created_ms": 30,
        "source": "extension:test",
        "reachable_from": [{"session": "session-a", "index": 4}],
        "lines": 1,
    }


class Backend:
    def __init__(self):
        self.calls = []
        self.secret_rules = []

    def current_session(self):
        return session_row()

    def declare_secret(self, rule):
        json.dumps(rule)
        self.secret_rules.append(rule)

    def mask_secret(self, text):
        return text.replace("credential-value", "$$CRED_ABCDEFGHIJKL$$")

    async def request(self, operation, arguments):
        # Every domain arm must honor the common JSON request contract.
        json.dumps(arguments)
        self.calls.append((operation, arguments))
        if operation == "omp.artifacts.adopt":
            assert arguments["blob"] == {"hash": HASH, "size": 5}
            assert arguments["lifetime"] == "session"
            return artifact_ref()
        if operation == "omp.artifacts.stat":
            return artifact_stat()
        if operation == "omp.artifacts.list":
            return [artifact_stat()]
        if operation == "omp.artifacts.pin":
            return None
        if operation == "omp.creds.list":
            return [{
                "id": 7,
                "provider": "acme",
                "identity": "user@example.test",
                "kind": "oauth",
                "expires_at_ms": 1000,
                "state": "active",
                "blocks": [{"scope": "chat", "until_ms": 900}],
            }]
        if operation in {"omp.creds.store", "omp.creds.import_oauth"}:
            sealed = arguments.get("cred", arguments)["secret" if "cred" in arguments else "refresh_token"]
            assert sealed["encoding"] == "base64"
            assert base64.b64decode(sealed["data"]) == b"credential-value"
            return {
                "id": 7,
                "provider": arguments.get("provider") or "acme",
                "identity": "user@example.test",
                "kind": "oauth",
                "state": "active",
                "blocks": [],
            }
        if operation == "omp.creds.mint_scoped":
            assert arguments["ttl"] == "30s"
            return {"token": "scoped-token", "expires_at_ms": 2000}
        if operation == "omp.creds.reveal":
            return {
                "encoding": "base64",
                "data": base64.b64encode(b"credential-value").decode("ascii"),
            }
        if operation == "omp.sessions.list":
            assert arguments["filter"]["kind"] == ["interactive"]
            return [session_row()]
        if operation == "omp.sessions.get":
            return session_row(arguments["session_id"])
        if operation == "omp.sessions.lineage":
            return [{"id": "parent", "parent": None}, {"id": "session-a", "parent": "parent", "at": 3}]
        if operation in {"omp.sessions.resume", "omp.sessions.rename"}:
            return session_row(arguments["session_id"], arguments.get("title", "Primary"))
        if operation == "omp.sessions.delete":
            raise omp.PermissionDenied("approved deletion ticket required")
        if operation == "omp.sessions.usage":
            bucket = {
                "key": {"model": "acme/model"},
                "start_ms": None,
                "usage": session_row()["usage"],
                "cost": session_row()["cost"],
                "requests": 2,
                "errors": 0,
                "duration": "5ms",
            }
            return {"total": bucket, "groups": [bucket], "series": [], "sessions": 1, "truncated": False}
        if operation == "omp.sessions.journal":
            if arguments.get("structure"):
                return {
                    "entries": [
                        {
                            "id": {"session": "session-a", "index": 0},
                            "parent": None,
                            "kind": "init",
                            "ts": 1,
                            "data": {"agent": None},
                            "label": "root",
                        },
                        {
                            "id": {"session": "session-a", "index": 1},
                            "parent": {"session": "session-a", "index": 0},
                            "kind": "msg",
                            "ts": 2,
                            "data": {"role": "user"},
                            "label": None,
                        },
                        {
                            "id": {"session": "session-a", "index": 3},
                            "parent": {"session": "session-a", "index": 99},
                            "kind": "msg",
                            "ts": 3,
                            "data": {"role": "orphan"},
                            "label": None,
                        },
                        {
                            "id": {"session": "session-a", "index": 4},
                            "parent": {"session": "session-a", "index": 0},
                            "kind": "msg",
                            "ts": 4,
                            "data": {"role": "assistant"},
                            "label": None,
                        },
                    ],
                    "leaf": {"session": "session-a", "index": 4},
                    "cursor": None,
                    "done": True,
                }
            assert arguments["since"] == 1
            return {
                "entries": [{
                    "id": {"session": "session-a", "index": 2},
                    "kind": "acme.record",
                    "rev": "1",
                    "ts": 123,
                    "principal": {"id": "user"},
                    "provenance": {"extension": "test"},
                    "value": {"answer": 42},
                    "raw": base64.b64encode(b'{"answer":42}').decode("ascii"),
                    "display": True,
                    "in_context": False,
                    "artifact": artifact_ref(),
                }],
                "cursor": None,
                "done": True,
            }
        raise AssertionError(f"unexpected operation {operation}")


backend = Backend()
omp._install_control_backend(backend)

# Synchronous state is an immutable host snapshot, not a filesystem fallback.
assert sessions.current().id == "session-a"
assert sessions.current().remote is True

# Core owns declaration validation/publication and masking.
rule = omp.SecretRule("TOKEN", kind=omp.SecretKind.ENV, mode=omp.SecretMode.REDACT, label="credential")
omp.secrets.declare(rule)
assert backend.secret_rules == [{
    "kind": "env",
    "mode": "replace",
    "content": "TOKEN",
    "friendly_name": "credential",
    "replacement": None,
    "flags": None,
}]
masked = omp.secrets.mask("credential-value")
assert masked == "$$CRED_ABCDEFGHIJKL$$"
assert omp.secrets.is_masked(masked)


async def exercise():
    blob = omp.BlobRef(bytes.fromhex(HASH), 5)
    ref = await artifacts.adopt(blob, media_type="text/plain")
    assert ref.id == "1"
    metadata = await artifacts.stat(ref)
    assert metadata.reachable_from[0] == omp.EntryId("session-a", 4)
    assert (await artifacts.list())[0].url == omp.ArtifactUrl("artifact://1")
    await artifacts.pin(ref, omp.ArtifactLifetime.SESSION)

    metadata_rows = await creds.list("acme")
    assert metadata_rows[0].identity == "user@example.test"
    secret = omp.Secret(b"credential-value")
    stored = await creds.store(omp.Credential(omp.CredentialKind.OAUTH, secret), provider="acme")
    assert stored.id == 7
    imported = await creds.import_oauth(refresh_token=secret, provider="acme")
    assert imported.kind is omp.CredentialKind.OAUTH
    scoped = await creds.mint_scoped("realtime", ttl=omp.Duration("30s"), provider="acme")
    assert scoped.token == "scoped-token"
    revealed = await creds.reveal(id=7)
    assert str(revealed) == "<redacted>"
    with revealed.use() as raw:
        assert raw == b"credential-value"

    rows = await sessions.list(omp.SessionFilter())
    assert rows[0].usage.reasoning == 3
    assert (await sessions.get("session-a")).cost.nanos_usd == 42
    assert [link.id for link in await sessions.lineage("session-a")] == ["parent", "session-a"]
    assert (await sessions.rename("session-a", "Renamed")).title == "Renamed"
    report = await sessions.usage(omp.UsageQuery())
    assert report.total.duration == omp.Duration("5ms")
    entries = [entry async for entry in sessions.journal("session-a", since=omp.EntryId("session-a", 1))]
    assert entries[0].raw == b'{"answer":42}'
    roots = await sessions.tree()
    assert [node.id.index for node in roots] == [0, 3]
    assert [node.id.index for node in roots[0].children] == [1, 4]
    assert roots[0].label == "root"
    assert [node.id.index for node in await sessions.branch()] == [0, 4]
    assert [
        node.id.index
        for node in await sessions.branch(omp.EntryId("session-a", 1))
    ] == [0, 1]
    assert entries[0].artifact.id == "1"
    try:
        await sessions.delete("session-a")
    except omp.PermissionDenied:
        pass
    else:
        raise AssertionError("typed remote deletion denial did not propagate")


asyncio.run(exercise())
"#
					),
					None,
					None,
				)
		})
		.expect("state persistence Python contract");
}
