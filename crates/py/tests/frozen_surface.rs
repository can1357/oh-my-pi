//! Embedded proof of the frozen Python extension surface.

use omp_py::{Engine, pyo3::ffi::c_str};

#[test]
fn frozen_surface_contract() {
	let engine = Engine::builder().init().expect("embedded Python boots");
	engine
		.attach(|py| {
			py.run(
				c_str!(
					r#"
import asyncio
import base64
import dataclasses
import importlib
import json
import typing

import omp
from omp._scope import Scope


def expect_raises(error_type, call):
    try:
        call()
    except error_type as error:
        return error
    raise AssertionError(f"expected {error_type.__name__}")
    raise AssertionError(f"expected {error_type.__name__}")


async def expect_raises_async(error_type, awaitable):
    try:
        await awaitable
    except error_type as error:
        return error
    raise AssertionError(f"expected {error_type.__name__}")
    raise AssertionError(f"expected {error_type.__name__}")


# Importability and public export closure.
assert "prelude" in omp.__all__
assert callable(omp.prelude)
for name in omp.__all__:
    getattr(omp, name)
for suffix in (
    "agents", "context", "policy", "limits", "telemetry", "provider",
    "env", "ui", "hooks", "events", "prompts", "packages",
    "sessions", "journal", "artifacts", "index", "diagnostics", "urls", "devices",
    "scribe",
):
    module = importlib.import_module(f"omp.{suffix}")
    for name in module.__all__:
        value = getattr(module, name)
        if getattr(value, "__annotations__", None):
            try:
                typing.get_type_hints(value)
            except Exception as error:
                raise AssertionError(f"unresolved annotations: omp.{suffix}.{name}") from error

registry_module = importlib.import_module("omp._registry")
packages_module = importlib.import_module("omp.packages")


def executable_declaration(declaration_id, kind, key):
    return {
        "id": declaration_id,
        "kind": kind,
        "module": "acme_ext.surface",
        "key": key,
        "trigger": "lazy",
        "api": 1,
        "failure": "fail-open",
    }


# Bidirectional manifest drift reports both a manifest-only declaration and a
# decorator-only declaration without mutating the process registry.
drift_registry = registry_module.DeclarationRegistry()
drift_registry.configure_manifest(
    extension="drift-test",
    declarations=(
        executable_declaration(
            "manifest-only", "soft", "manifest_only@.1"
        ),
    ),
)
drift_registry.register_tool("decorated_only", "", 1, lambda: None)
drift_error = expect_raises(omp.DeclarationDrift, drift_registry.freeze)
assert drift_error.missing_declarations == frozenset({
    ("soft", "manifest_only@.1"),
})
assert drift_error.undeclared_declarations == frozenset({
    ("soft", "decorated_only@.1"),
})
assert drift_error.missing_tools == frozenset()
assert drift_error.undeclared_tools == frozenset()
assert "missing declarations" in str(drift_error)
assert "undeclared declarations" in str(drift_error)
assert "manifest_only@.1" in str(drift_error)
assert "decorated_only@.1" in str(drift_error)


packages_module._install_snapshot(
    [
        {
            "name": "acme-ext",
            "version": "1.0.0",
            "extension_id": "acme-ext",
        }
    ],
    own="acme-ext",
)
registry_module.configure_manifest(
    extension="acme-ext",
    declarations=(
        {
            "kind": "skills",
            "path": "acme_ext/skills/review/SKILL.md",
            "metadata": {
                "name": "review",
                "description": "Review a change.",
            },
        },
        executable_declaration("offline-device", "soft", "offline_device@.1"),
        executable_declaration("surface-device", "soft", "surface_device@.1"),
        executable_declaration(
            "argument-metadata-device",
            "soft",
            "arg_metadata_device@arg-contract.3",
        ),
        executable_declaration(
            "surface-inspect-detail",
            "soft",
            "surface_device/inspect/detail@.1",
        ),
        executable_declaration(
            "surface-inspect-annotated",
            "soft",
            "surface_device/inspect/annotated@surface-routes.1",
        ),
        executable_declaration(
            "surface-mounted-status",
            "soft",
            "surface_device/mounted/status/detail@.1",
        ),
        executable_declaration("compaction-hook", "hook", "compaction/domain"),
        executable_declaration(
            "provider-usage-hook", "hook", "provider_usage/domain"
        ),
        executable_declaration(
            "models-discover-hook", "hook", "models_discover/domain"
        ),
        executable_declaration(
            "provider-refresh-hook", "hook", "provider_refresh/domain"
        ),
        executable_declaration("managed-command", "command", "managed"),
        executable_declaration(
            "copy-cut-shortcut", "shortcut", "ctrl+shift+x"
        ),
        executable_declaration(
            "duplicate-ui-renderer",
            "verdict_renderer",
            "__duplicate_ui__@ui.1",
        ),
        executable_declaration(
            "decorated-ui-renderer",
            "verdict_renderer",
            "__decorated_ui__@ui.1",
        ),
        executable_declaration(
            "surface-verdict-renderer",
            "verdict_renderer",
            "surface_device@.1",
        ),
        executable_declaration(
            "discovery-provider", "provider", "discovery-test"
        ),
        executable_declaration(
            "overlay-provider", "provider", "overlay-provider"
        ),
        executable_declaration(
            "round5-bare-provider", "provider", "round5-bare-provider"
        ),
        executable_declaration(
            "model-request-telemetry", "telemetry", "model_request"
        ),
        executable_declaration(
            "continue-once", "director", "continue-once"
        ),
        executable_declaration(
            "ext-state", "component", "ext-state"
        ),
    ),
)


@omp.director(
    "continue-once",
    claims=("loop",),
    binds={"ai_fastmode": True},
)
class ContinueOnce:
    def on_yield(self, event):
        return "continue"


@omp.component(
    "ext-state",
    interested=("turn.start@1", "patch@1"),
)
def ext_state(entry, dom):
    return (("set", "ext-state", "seen", True),)


surface_snapshot = registry_module.registry.snapshot()
assert surface_snapshot.directors[0].id == "continue-once"
assert surface_snapshot.directors[0].claims == ("loop",)
assert dict(surface_snapshot.directors[0].binds) == {"ai_fastmode": True}
assert surface_snapshot.components[0].id == "ext-state"
assert surface_snapshot.components[0].interested == ("turn.start@1", "patch@1")
assert not hasattr(omp, "campaign")
assert not hasattr(omp, "CampaignScope")
assert not hasattr(omp, "Ladder")


class FrozenControlHost:
    def __init__(self):
        self.calls = []
        self.effects = []
        self.secret_rules = []

    def effect(self, effect):
        self.effects.append(effect)

    def tier_of(self, target):
        return {
            "core": "read",
            "device": "write",
            "mcp": "privileged",
        }.get(target["kind"])

    def current_session(self):
        return self._session_row("surface-session")

    def declare_secret(self, rule):
        json.dumps(rule)
        self.secret_rules.append(rule)

    def mask_secret(self, text):
        return text.replace("TOKEN", "$$CRED_SURFACEVALUE$$")

    @staticmethod
    def _usage():
        return {
            "input_tokens": 11,
            "cached_input_tokens": 2,
            "output_tokens": 7,
            "reasoning_tokens": 3,
            "cache_write_tokens": 1,
            "requests": 1,
            "cost_usd": 0.02,
            "wall_ms": 25,
        }

    @staticmethod
    def _agent(spec=None):
        return {
            "run_id": "run-1",
            "session_id": "child-session",
            "name": "Surface",
            "agent": "task",
            "depth": 1,
            "effective_max_depth": 0,
            "spec": spec or {"task": "t", "agent": "task"},
            "worktree_path": None,
            "output_url": "agent://surface",
            "transcript_url": "history://surface",
        }

    @staticmethod
    def _session_row(session_id, title="Surface"):
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
            "entries": 1,
            "turns": 1,
            "usage": {
                "input": 5, "output": 7, "cache_read": 2, "cache_write": 1,
                "reasoning": 3, "premium_requests": 0, "context": 20,
                "total": 15, "accuracy": "exact", "detail": {},
            },
            "cost": {
                "nanos_usd": 42, "estimated": False,
                "input_nanos_usd": 17, "output_nanos_usd": 25,
            },
            "models": ["acme/model"],
            "remote": False,
        }

    @staticmethod
    def _worker(generation):
        return {
            "name": "surface-worker",
            "generation": generation,
            "state": "ready",
            "site": {"kind": "env", "process": None, "ready": None},
            "pid": 17,
            "spawned_at_ms": 100,
            "last_call_at_ms": None,
            "calls": 2,
            "in_flight": 0,
            "code_cached": 1,
            "enforced": [],
            "fault": None,
        }

    async def request(self, operation, arguments):
        self.calls.append((operation, arguments))
        if operation not in {"omp.ui.dynamic_mount", "omp.jobs.register"}:
            json.dumps(arguments, allow_nan=False)
        if operation == "omp.telemetry.export.stats":
            return {
                "sent": 8, "dropped": 1, "failures": 0, "queue_depth": 2,
                "last_flush_ms": 9, "last_error": None, "backoff_ms": 0,
            }
        if operation == "omp.telemetry.query":
            return {
                "rows": [{
                    "events": [], "bindings": {}, "session": "s", "turn": 0,
                    "values": {"rev": "edit@hl.3"},
                }],
                "total": 1, "cursor": None, "truncated": False,
                "scanned_sessions": 1, "scanned_events": 1,
                "backfilled": False, "floored": False, "elapsed_ms": 1,
            }
        if operation == "omp.agents.completion":
            return {
                "text": "allow", "choice": None, "data": None,
                "usage": self._usage(), "model": "test/model", "fell_back": False,
            }
        if operation == "omp.agents.spawn":
            return self._agent(arguments["spec"])
        if operation == "omp.agents.send":
            return "delivered"
        if operation == "omp.agents.rewind":
            return {
                "head": 3, "dropped_items": 2, "scope": arguments["scope"],
                "restore": None, "dry_run": arguments["dry_run"],
            }
        if operation == "omp.agents.schedule":
            return {"id": "schedule-1", "name": arguments["name"]}
        if operation == "omp.context.compact":
            return {
                "schema": "omp.context.compact.v1",
                "result": {
                    "preparation_id": "compact-1",
                    "tiers_run": ["prune", "local"],
                    "from_extension": None,
                    "tokens_before": 90,
                    "tokens_after": 40,
                    "first_kept_id": "item-4",
                    "epoch": 8,
                    "summary_bytes": 20,
                    "warning": None,
                },
            }
        if operation == "omp.context.view":
            return {
                "schema": "omp.context.view.v1",
                "result": {
                    "session_id": "surface-session",
                    "turn_id": "surface-turn",
                    "model": "test/model",
                    "provider": "test",
                    "epoch": 7,
                    "messages": [],
                    "usage": {
                        "total_tokens": 10,
                        "context_window": 100,
                        "reserve_tokens": 10,
                        "usable_tokens": 90,
                        "fraction": 1 / 9,
                        "prompt_head_tokens": 1,
                        "device_catalog_tokens": 2,
                        "message_tokens": 7,
                        "catalog_notice_tokens": 0,
                        "media_tokens": 0,
                        "compaction_epoch": 7,
                        "threshold_fraction": 0.8,
                        "in_flight": False,
                    },
                    "prompt_hash": "deadbeef",
                    "reset_event": None,
                },
            }
        if operation == "omp.context.epoch":
            return {"schema": "omp.context.epoch.v1", "result": 7}
        if operation == "omp.hooks.dispatch":
            return {"kind": "deny", "reason": "host composed", "fatal": False,
                    "code": "SURFACE"}
        if operation == "omp.creds.usage":
            return {
                "windows": [{"id": "requests", "used": 2, "limit": 10,
                             "fraction": "0.2", "unit": "requests"}],
                "plan": "surface",
            }
        if operation in {"omp.provider.retract", "omp.provider.replace"}:
            return None
        if operation == "omp.provider.models":
            return [catalog_card]
        if operation == "omp.provider.watch_models":
            return [
                catalog_event,
                {
                    "cursor": {"epoch": b"catalog-epoch", "generation": 8},
                    "removed_id": catalog_card.id,
                },
            ]
        if operation == "omp.provider.request":
            requested = arguments["operation"]
            if requested == "generate_image":
                return {
                    "images": [{"hash": "00" * 32, "size": 3}],
                    "cost_nanos_usd": 17,
                }
            if requested == "speak":
                return {
                    "audio": {"hash": "00" * 32, "size": 3},
                    "format": "mp3",
                    "cost_nanos_usd": 11,
                }
            if requested == "transcribe":
                return {"text": "hello", "language": "en", "cost_nanos_usd": 13}
            if requested == "realtime":
                return {
                    "id": "rtc-surface",
                    "endpoint": {"id": "endpoint-surface"},
                    "credential": {"id": "credential-surface"},
                    "expires_at_ms": 2_000_000_000_000,
                    "transport": "webrtc",
                }
        if operation == "omp.sessions.get":
            return self._session_row(arguments["session_id"])
        if operation == "omp.sessions.lineage":
            return [{"id": arguments["session_id"], "parent": None, "at": 1}]
        if operation == "omp.sessions.create":
            setup = arguments["setup"]
            assert setup["schema"] == "omp.sessions.setup.v1"
            assert setup["entries"] == []
            assert setup["initial_prompt"] == [{"kind": "text", "text": "Continue"}]
            return self._session_row("created-session", setup["title"])
        if operation in {"omp.sessions.resume", "omp.sessions.rename"}:
            return self._session_row(
                arguments["session_id"], arguments.get("title", "Surface")
            )
        if operation == "omp.sessions.delete":
            raise omp.PermissionDenied("deletion requires host approval")
        if operation == "omp.policy.pending":
            return [{
                "ticket_id": "ticket-1",
                "invocation_id": "call-1",
                "reasons": [{
                    "title": "Run command", "body": "Review execution",
                    "subject": "echo ok",
                }],
                "state": "pending",
                "decision": None,
                "created_at": 1.5,
            }]
        if operation == "omp.policy.decide":
            return None
        if operation == "omp.prompts.invalidate":
            return 4
        if operation.startswith("omp.workers."):
            action = operation.rsplit(".", 1)[1]
            if action == "restart":
                return self._worker(2)
            if action in {"get", "info"}:
                return self._worker(arguments.get("generation", 1))
        if operation == "omp.ui.dynamic_mount":
            return tuple(command["name"] for command in arguments["commands"])
        if operation == "omp.ui.overlay_events":
            return [
                {
                    "kind": "highlighted", "id": "threads",
                    "value": "thread-2", "values": {"threads": "thread-2"},
                },
                {"kind": "cancel", "values": {}},
            ]
        if operation == "omp.devices.invoke":
            return {"value": arguments["args"]["value"], "admitted": True}
        if operation == "omp.jobs.register":
            return job_ref
        if operation == "omp.artifacts.stat":
            return {
                "ref": {
                    "id": artifact_ref.id, "hash": artifact_ref.hash,
                    "media_type": artifact_ref.media_type,
                    "byte_len": artifact_ref.byte_len,
                },
                "url": str(artifact_ref.url),
                "media_type": artifact_ref.media_type,
                "byte_len": artifact_ref.byte_len,
                "description": "surface artifact",
                "lifetime": "session",
                "created_ms": 30,
                "source": "extension:acme-ext",
                "reachable_from": [],
                "lines": 1,
            }
        if operation == "omp.mcp.mount":
            return {
                "catalog_epoch": 9,
                "devices": [{
                    "name": "surface_echo", "family": "mcp", "rev": 1,
                    "server": "surface",
                    "definition": {
                        "name": "echo", "description": "Echo",
                        "inputSchema": {"type": "object"},
                    },
                    "documentation": "Surface server",
                }],
            }
        if operation == "omp.mcp.invoke":
            return {
                "content": [{"type": "text", "text": "echo"}],
                "structured_content": {"value": arguments["arguments"]["value"]},
                "meta": None, "is_error": False, "truncated": False,
                "dispatch_certainty": 2, "retry_count": 0,
                "auth_retried": False, "effects_unknown": False,
            }
        if operation == "omp.mcp.unmount":
            return {"removed": True}
        if operation == "omp.params.args":
            return {"value": {"query": "needle"}, "phase": "ARGS_FINALIZED"}
        if operation == "omp.params.raw":
            return '{"query":"needle"}'
        if operation == "omp.params.committed":
            return {"value": '{"query":"needle"}', "phase": "EFFECTS_AUTHORIZED"}
        if operation == "omp.urls.read":
            return "authoritative surface"
        raise AssertionError(f"unexpected CONTROL operation: {operation}")


frozen_host = FrozenControlHost()
omp._install_control_backend(frozen_host)
assert omp.Done().result is None


# Shared exception payloads remain inspectable across the frozen boundary.
manifest_error = omp.ManifestError("omp.toml", "extension.name", "missing")
assert (
    manifest_error.path,
    manifest_error.key,
    manifest_error.detail,
) == ("omp.toml", "extension.name", "missing")
declaration_limit = omp.DeclarationLimit(257, 256)
assert (declaration_limit.count, declaration_limit.limit) == (257, 256)
duplicate_registration = omp.DuplicateRegistration("surface", "acme.incumbent")
assert (
    duplicate_registration.name,
    duplicate_registration.holder,
) == ("surface", "acme.incumbent")
declaration_sealed = omp.DeclarationSealed("surface")
assert declaration_sealed.name == "surface"
capability_error = omp.CapabilityError("network:egress")
assert capability_error.capability == "network:egress"
trust_error = omp.TrustError("trusted", "untrusted")
assert (trust_error.required, trust_error.actual) == ("trusted", "untrusted")
effect_spec = object()
effects_error = omp.EffectsNotAuthorized("invoke-1", effect_spec)
assert (
    effects_error.invocation,
    effects_error.spec,
) == ("invoke-1", effect_spec)
deadline = omp.Duration("250ms")
deadline_error = omp.DeadlineExceeded(deadline)
assert deadline_error.deadline is deadline
frame_error = omp.FrameTooLarge(67_108_865, 67_108_864)
assert (frame_error.actual, frame_error.limit) == (67_108_865, 67_108_864)
api_error = omp.ApiLevelError(2, frozenset({1}))
assert (api_error.requested, api_error.supported) == (2, frozenset({1}))


def raise_error(error):
    raise error


for family_error in (
    omp.urls.SelectorError("invalid selector"),
    omp.hooks.HookContractError("invalid hook"),
    omp.packages.PackageError("invalid package"),
    omp.prompts.UnknownSlot("invalid prompt slot"),
    omp.telemetry.TelemetryError("invalid telemetry"),
    omp.placement.WorkerUnavailable("invalid placement"),
):
    expect_raises(
        omp.OmpError,
        lambda family_error=family_error: raise_error(family_error),
    )

assert issubclass(omp.urls.SelectorError, omp.urls.UrlError)
assert issubclass(omp.urls.UrlError, omp.OmpError)
assert issubclass(omp.urls.UrlError, ValueError)

assert omp.MAX_FRAME_BYTES == 67_108_864
assert omp.limits.MAX_FRAME_BYTES == 67_108_864
assert all(
    hasattr(omp, name) and hasattr(omp.limits, name)
    for name in ("CANCEL_GRACE", "SHUTDOWN_GRACE", "HEALTH_TIMEOUT")
)
assert omp.CANCEL_GRACE == omp.Duration("150ms")


@dataclasses.dataclass(frozen=True)
class CodecSample:
    label: str
    count: int


codec_sample = CodecSample("frozen", 3)
assert omp.loads(omp.dumps(codec_sample), CodecSample) == codec_sample

# Compaction is a domain hook, not a phased observation hook.
@omp.hook("compaction")
async def compaction_hook(event):
    return None

expect_raises(
    omp.HookContractError,
    lambda: omp.hook("compaction", phase=omp.HookPhase.REVIEW),
)

expect_raises(
    omp.UnsupportedEvent,
    lambda: omp.hook("sandbox_profile", phase=omp.HookPhase.TRANSFORM),
)
expect_raises(
    omp.UnsupportedEvent,
    lambda: omp.hook("sandbox_violation"),
)

# Bash IR pure behavior.
span_read = omp.Span(start=0, end=3, line=1, column=1)
span_write = omp.Span(start=9, end=12, line=1, column=10)
span_all = omp.Span(start=0, end=12, line=1, column=1)
read_ref = omp.PathRef(
    lexical="input.py",
    resolved="/w/input.py",
    absolute="/w/input.py",
    access=omp.Access.READ,
    origin=omp.PathOrigin.ARGV,
    command_index=0,
    outside_workspace=False,
    exists=True,
    dynamic=False,
    span=span_read,
)
write_ref = omp.PathRef(
    lexical="out",
    resolved=None,
    absolute="/w/out",
    access=omp.Access.WRITE,
    origin=omp.PathOrigin.REDIRECT,
    command_index=1,
    outside_workspace=True,
    exists=False,
    dynamic=True,
    span=span_write,
)
read_command = omp.BashCommandIR(
    index=0,
    name="cat",
    argv=(),
    dynamic_args=(),
    env=(),
    redirects=(),
    process_subs=(),
    reads=(read_ref,),
    writes=(),
    net=(),
    cwd="/w",
    depth=0,
    container=None,
    subshell=False,
    builtin=False,
    coreutil=True,
    external=False,
    read_only=True,
    interpreter_code=None,
    span=span_read,
)
write_command = omp.BashCommandIR(
    index=1,
    name="write",
    argv=(),
    dynamic_args=(),
    env=(),
    redirects=(),
    process_subs=(),
    reads=(),
    writes=(write_ref,),
    net=(),
    cwd="/w",
    depth=0,
    container=None,
    subshell=False,
    builtin=True,
    coreutil=False,
    external=False,
    read_only=False,
    interpreter_code=None,
    span=span_write,
)
pipeline = omp.BashPipeline(
    commands=(read_command, write_command),
    negated=False,
    timed=False,
    span=span_all,
)
command_list = omp.BashAndOrList(
    pipelines=(pipeline,),
    operators=(),
    separator=omp.Separator.SEQUENCE,
    span=span_all,
)
ir = omp.BashIR(
    source="cat x.py > o",
    rev=omp.BASH_IR_REV,
    parser_rev="test",
    parse_ok=True,
    parse_error=None,
    truncated=False,
    node_count=2,
    is_compound=False,
    has_dynamic_eval=False,
    lists=(command_list,),
    commands=(read_command, write_command),
    functions=(),
    reads=(read_ref,),
    writes=(write_ref,),
    net=(),
    opaque=(),
)
assert not ir.is_read_only()
assert ir.writes_outside(("/w",)) == (write_ref,)
assert ir.segment(0) == "cat"
unicode_command = dataclasses.replace(
    read_command,
    span=omp.Span(start=3, end=6, line=1, column=3),
)
unicode_ir = dataclasses.replace(
    ir,
    source="é;cat",
    commands=(unicode_command,),
)
assert unicode_ir.segment(0) == "cat"
assert ir.touches("*.py") == (read_ref,)
read_pipeline = dataclasses.replace(pipeline, commands=(read_command,))
read_list = dataclasses.replace(command_list, pipelines=(read_pipeline,))
read_only_ir = dataclasses.replace(
    ir,
    lists=(read_list,),
    commands=(read_command,),
    writes=(),
)
assert read_only_ir.is_read_only()

availability_calls = 0


def availability_probe():
    global availability_calls
    availability_calls += 1
    return omp.Availability(False, "offline")


@omp.device("offline_device", available=availability_probe)
async def offline_device():
    return None


assert availability_calls == 0


# Device declaration validation and direct awaited invocation.
@omp.device("surface_device")
async def surface_device():
    return 42


def duplicate_equal_precedence():
    @omp.device("surface_device")
    async def duplicate():
        return None


def duplicate_without_replaces():
    @omp.device("surface_device", precedence=omp.Precedence.FALLBACK)
    async def duplicate():
        return None


def core_precedence():
    @omp.device("core_claim", precedence=omp.Precedence.CORE)
    async def invalid():
        return None


def bad_device_name():
    @omp.device("Bad-Name")
    async def invalid():
        return None


def tool_collision():
    @omp.tool("surface_device", rev=2)
    async def duplicate():
        return None


def noncallable_device():
    omp.device("noncallable")(object())


expect_raises(omp.PrecedenceConflict, duplicate_equal_precedence)
expect_raises(omp.PrecedenceConflict, duplicate_without_replaces)
expect_raises(omp.DeviceNameError, core_precedence)
expect_raises(omp.DeviceNameError, bad_device_name)
expect_raises(omp.PrecedenceConflict, tool_collision)
expect_raises(TypeError, noncallable_device)
assert asyncio.run(surface_device()) == 42

# Telemetry identity, fail-open instruments, and declarative export.
telemetry = importlib.import_module("omp.telemetry")
assert telemetry.MAX_INSTRUMENTS == 256
assert telemetry.MAX_CARDINALITY == 1024
assert "MAX_INSTRUMENTS" in telemetry.__all__
assert "MAX_CARDINALITY" in telemetry.__all__
counter = telemetry.counter("cache.hits", unit="1", description="d")
assert counter.name == "omp.ext.acme-ext.cache.hits"
expect_raises(
    telemetry.SubscriptionError,
    lambda: telemetry.counter("omp.reserved", unit="1", description="d"),
)
expect_raises(ValueError, lambda: counter.add(-1))
counter.add(1)
assert telemetry.counter("cache.hits", unit="1", description="d") is counter


class InstrumentSink:
    def __init__(self):
        self.samples = []

    def add(self, name, value, attrs):
        self.samples.append(("counter", name, value, attrs))

    def record(self, name, value, attrs):
        self.samples.append(("histogram", name, value, attrs))


instrument_sink = InstrumentSink()
telemetry._install_instrument_sink(instrument_sink)
counter.add(2, result="hit")
histogram = telemetry.histogram(
    "request.latency", unit="ms", description="d", boundaries=(1, 10)
)
histogram.record(4.5, route="primary")
assert instrument_sink.samples == [
    ("counter", "omp.ext.acme-ext.cache.hits", 2, {"result": "hit"}),
    (
        "histogram",
        "omp.ext.acme-ext.request.latency",
        4.5,
        {"route": "primary"},
    ),
]
telemetry._install_instrument_sink(None)
expect_raises(
    telemetry.ExportError,
    lambda: telemetry.export(
        telemetry.OtlpTarget(endpoint="https://x", protocol="grpc")
    ),
)
export_handle = telemetry.export(telemetry.OtlpTarget(endpoint="https://x"))
export_stats = asyncio.run(export_handle.stats())
assert export_stats.sent == 8 and export_stats.queue_depth == 2

# Agents values, validation, authoritative host requests, and real local timer behavior.
assert [field.name for field in dataclasses.fields(omp.agents.Usage)] == [
    "input_tokens",
    "cached_input_tokens",
    "output_tokens",
    "reasoning_tokens",
    "cache_write_tokens",
    "requests",
    "cost_usd",
    "wall",
]
spec = omp.agents.SubagentSpec(task="t")
assert spec.agent == "task"
assert spec.isolation is omp.agents.Isolation.CLEAN
assert spec.budget is None
expect_raises(omp.agents.SpawnDenied, lambda: omp.agents.SubagentSpec(task=" "))
assert "history://r" in str(
    omp.agents.AgentGone(
        "r", omp.agents.AgentStatus.ABORTED, "history://r"
    )
)


async def agents_contract():
    handle = await omp.agents.spawn(spec)
    assert handle.output_url.uri == "agent://surface"
    assert frozen_host.calls[-1][0] == "omp.agents.spawn"
    receipt = await omp.agents.send("peer", "message")
    assert receipt is omp.agents.Receipt.DELIVERED
    rewind = await omp.agents.rewind(None)
    assert rewind.head == 3 and rewind.dropped_items == 2

    fired = asyncio.Event()
    firings = 0

    async def callback():
        nonlocal firings
        firings += 1
        if firings == 2:
            fired.set()

    timer = omp.agents.timer(omp.Duration("1ms"), callback, repeat=True)
    await asyncio.wait_for(fired.wait(), timeout=1.0)
    timer.cancel()
    assert not timer.active


asyncio.run(agents_contract())

# Context and compaction values.
compacted = asyncio.run(
    omp.context.compact(tier=omp.CompactionTier.LOCAL, focus="facts")
)
assert compacted.epoch == 8 and compacted.tokens_before == 90
assert frozen_host.calls[-1][1]["focus"] == "facts"
assert omp.CustomSummary(summary="s", first_kept_id="m1").summary == "s"
assert issubclass(omp.CompactionBusy, omp.OmpError)
expect_raises(LookupError, omp.Context.current)
context_module = importlib.import_module("omp._context")
logs = []
context_module._install_log_sink(
    lambda level, message, fields: logs.append((level, message, fields))
)
scope = Scope(
    invocation="invocation",
    generation=1,
    principal=object(),
    phase=omp.InvocationPhase.OPEN,
    extension="acme-ext",
    session="session",
    event="before_call",
    settings={"token": "secret"},
    secret_settings=frozenset({"token"}),
)
ctx = omp.Context.from_scope(scope)
assert dict(ctx.settings) == {"token": "secret"}
assert not ctx.signal.is_set()
replacement_scope = dataclasses.replace(scope, generation=2)
replacement_ctx = omp.Context.from_scope(replacement_scope)
assert replacement_ctx.signal is not ctx.signal
scope_module = importlib.import_module("omp._scope")
assert scope_module._request_cancel(scope)
assert ctx.signal.is_set()
assert not replacement_ctx.signal.is_set()
asyncio.run(ctx.signal.wait())
ctx.log("info", "message", token="secret", count=1)
assert logs == [
    (
        "info",
        "message",
        {
            "token": "[REDACTED]",
            "count": 1,
            "extension": "acme-ext",
            "session": "session",
            "generation": 1,
            "event": "before_call",
        },
    )
]
context_module._install_log_sink(None)
expect_raises(omp.CapabilityError, lambda: ctx.require("missing:cap"))

# Provider payload and failover contracts.
provider_module = importlib.import_module("omp.provider")
assert [field.name for field in dataclasses.fields(provider_module.ProviderError)] == [
    "provider",
    "route",
    "model",
    "operation",
    "kind",
    "retryability",
    "status",
    "retry_after",
    "attempt",
    "committed",
    "message",
    "identity",
]
provider_error = provider_module.ProviderError(
    provider="p",
    route="r",
    model="m",
    operation=provider_module.Operation.CHAT,
    kind=provider_module.ErrorKind.RATE_LIMITED,
    retryability=provider_module.Retryability.AFTER_DELAY,
    status=429,
    retry_after=None,
    attempt=1,
    committed=False,
    message="limited",
    identity=None,
)
assert provider_error.retryability is provider_module.Retryability.AFTER_DELAY
assert provider_module.Failover.switch_model("openai/gpt-x").kind is provider_module.FailoverKind.SWITCH_MODEL
assert provider_module.ErrorKind.RATE_LIMITED.value == "rate_limited"

# Environment document events, spill metadata, and workers admin arm.
assert omp.env.DocEventKind.WATCH_RESCANNED.value == "watch_rescanned"
spill = omp.Spill(b"payload", media_type="text/plain")
assert spill.value == b"payload" and spill.media_type == "text/plain"
restarted_worker = asyncio.run(omp.workers.restart("surface-worker"))
assert restarted_worker.generation == 2
assert frozen_host.calls[-1] == (
    "omp.workers.restart", {"name": "surface-worker", "grace": 5.0}
)

# Streaming device frames: typed progress and terminal results round-trip.
update = omp.Update(stage="running")
done = omp.Done(update.payload, useless=True)
assert update.payload == {"stage": "running"}
assert done.result is update.payload and done.useless is True

# Search parsing and provider usage are phase-free domain hooks.
assert provider_module.Api.SEARCH_HTTP.value == "search_http"
assert all(
    name in provider_module.__all__ and getattr(provider_module, name)
    for name in ("SearchPage", "SearchQuery", "SearchResult", "UsageQuery", "UsageReport", "UsageScope", "UsageUnit", "UsageWindow")
)
usage_window = provider_module.UsageWindow(id="w")
assert provider_module.UsageReport(windows=(usage_window,)).windows == (usage_window,)
usage_secret = omp.Secret(b"extension-usage-secret")
usage_query = provider_module.UsageQuery(
    provider="x",
    identity="account",
    scope=provider_module.UsageScope.ALL,
    allow_stale=False,
    api_key=usage_secret,
)
assert usage_query.api_key is usage_secret
assert "extension-usage-secret" not in str(usage_secret)
assert "extension-usage-secret" not in repr(usage_secret)
search_query = provider_module.SearchQuery(provider="x", query="omp", count=5)
search_result = provider_module.SearchResult("OMP", "https://example.test", "snippet", 1)
assert provider_module.SearchPage((search_result,)).results == (search_result,)
@omp.hook("provider_usage", provider="x")
def usage_projection(query):
    return None
expect_raises(
    omp.UnsupportedEvent,
    lambda: omp.hook("search_parse", provider="x"),
)
assert usage_projection.__omp_hooks__[-1].phase == "domain"
composed_hook = asyncio.run(
    omp.hooks.dispatch_hook("tool_call", {"call_id": "surface-call"})
)
assert composed_hook == omp.Deny(
    "host composed", fatal=False, code="SURFACE"
)
assert frozen_host.calls[-1][1]["event"] == "tool_call"

# Telemetry queries and session lifecycle payloads are typed host-owned values.
telemetry_module = importlib.import_module("omp.telemetry")
predicate = telemetry_module.Eq("edit@hl.3")
step = telemetry_module.Step(
    kinds=(telemetry_module.Kind.TOOL_CALL,),
    tool="edit",
    where={"rev": predicate},
)
telemetry_query = telemetry_module.Query(match=(step,), select=("rev",))
assert isinstance(predicate, telemetry_module.Predicate)
assert telemetry_query.match[0].where["rev"] == predicate
row = telemetry_module.Row(events=(), bindings={}, session="s", turn=0, _values={"rev": "edit@hl.3"})
result = telemetry_module.QueryResult(
    rows=(row,), total=1, cursor=None, truncated=False, scanned_sessions=1,
    scanned_events=1, backfilled=False, floored=False, elapsed_ms=1,
)
assert row["rev"] == "edit@hl.3" and result.rows == (row,)
event_prefix = dict(
    kind=telemetry_module.Kind.SESSION_START, seq=1, at_ms=2, session="s", agent="main",
    depth=0, conversation="c", trace=None, principal="p", generation=1,
)
envelope = telemetry_module.Envelope(**event_prefix)
session_start = telemetry_module.SessionStart(
    **event_prefix, resumed=False, parent=None, cwd=None, place=omp.Place.ENV, remote=None,
    model="m", provider="p", devices=(), core_tools=(), extensions=(), schema_rev="1",
    prompt=object(), registry_hash="hash",
)
turn_start = telemetry_module.TurnStart(
    **(event_prefix | {"kind": telemetry_module.Kind.TURN_START}), turn=0, trigger="user",
    input_chars=1, input_parts=1, attachments=0, model="m", effort=None,
)
turn_end = telemetry_module.TurnEnd(
    **(event_prefix | {"kind": telemetry_module.Kind.TURN_END}), turn=0, steps=1, requests=1,
    calls=0, tokens=telemetry_module.Tokens(total=1), cost=None, latency_ms=1,
    stop=telemetry_module.StopReason.END_TURN, tools_used=(), faults=0, interrupted=False,
    context=telemetry_module.ContextSnapshot(1, 0, 0, None, 10, 0.1),
)
session_end = telemetry_module.SessionEnd(
    **(event_prefix | {"kind": telemetry_module.Kind.SESSION_END}), reason="exit", turns=1,
    requests=1, calls=0, tokens=telemetry_module.Tokens(total=1), cost=None, wall_ms=1,
    faults=0, issues=0,
)
assert envelope.session == session_start.session == turn_start.session == turn_end.session == session_end.session
queried = asyncio.run(telemetry_module.query(telemetry_query))
assert queried.rows[0]["rev"] == "edit@hl.3"
assert frozen_host.calls[-1][0] == "omp.telemetry.query"

# Credentials: manifest-scoped host arms expose typed metadata and scoped tokens.
creds_module = importlib.import_module("omp.creds")
assert omp.creds is creds_module
assert all(callable(getattr(creds_module, name)) for name in (
    "list", "store", "refresh", "clear", "disable", "enable", "report_block",
    "usage", "mint_scoped", "import_oauth", "reveal",
))
credential_meta = omp.CredentialMeta(1, "example", None, omp.CredentialKind.API_KEY)
scoped_token = omp.ScopedToken("scoped", 123)
assert credential_meta.kind.value == "api_key"
assert scoped_token.token == "scoped" and scoped_token.expires_at_ms == 123
credential_usage = asyncio.run(omp.creds.usage())
assert credential_usage.plan == "surface"
assert str(credential_usage.windows[0].fraction) == "0.2"

# UI commands, transcript activation, and renderer collisions.
async def complete_managed(query, ctx):
    return ()
@omp.command(
    "managed",
    aliases=("pm",),
    description="Manage prompts",
    args=(omp.ui.Arg("name", "Prompt name", "<name>"),),
    hint="/managed <name>",
    arg_completions=complete_managed,
)
async def managed(inv, ctx):
    return None
command_row = {
    row.name: row for row in registry_module.registry.snapshot().commands
}["managed"]
assert command_row.aliases == ("pm",)
assert command_row.args == (omp.ui.Arg("name", "Prompt name", "<name>"),)
assert command_row.hint == "/managed <name>"
assert command_row.arg_completions is complete_managed
assert command_row.description == "Manage prompts"
assert command_row.handler is managed

activations = []
@omp.ui.on_activate("card")
async def activate_card(event, ctx):
    activations.append((event, ctx))
activation = omp.ui.Activation("card.dynamic", omp.ui.ActivationSource.MOUSE)
asyncio.run(omp.ui._dispatch_activation(activation, "context"))
assert activations == [(activation, "context")]
assert omp.ui.ActivationSource.KEY.value == "key"

@omp.renderer("__duplicate_ui__", family="ui", rev=1)
def first_ui_renderer(view, ctx):
    return None
def register_duplicate_ui_renderer():
    @omp.renderer("__duplicate_ui__", family="ui", rev=1)
    def duplicate_ui_renderer(view, ctx):
        return None
duplicate_renderer = expect_raises(
    omp.ui.DuplicateRenderer,
    register_duplicate_ui_renderer,
)
assert omp.DuplicateRenderer is omp.ui.DuplicateRenderer
assert issubclass(omp.DuplicateRenderer, omp.DuplicateRegistration)
assert duplicate_renderer.name == "('__duplicate_ui__', 'ui', 1)"
assert duplicate_renderer.holder.endswith("first_ui_renderer")
assert duplicate_renderer.claimant.endswith("duplicate_ui_renderer")

# Argument metadata: Field and Coerce lower once into the per-revision registry.
argument_field = omp.Field(
    "Requested issue count.",
    alias=("issueCount",),
    coerce=(omp.Coerce.INTEGER, omp.Coerce.STRIP),
    expected="a positive integer",
    example="3",
)
assert argument_field.description == "Requested issue count."
assert argument_field.additional_properties is False
assert argument_field.alias == ("issueCount",)
assert argument_field.coerce == (omp.Coerce.INTEGER, omp.Coerce.STRIP)
assert tuple(member.value for member in omp.Coerce) == (
    "loose_bool", "integer", "number", "string", "singleton",
    "json_string", "strip", "csv", "null_elision",
)
@omp.device("arg_metadata_device", family="arg-contract", rev=3)
async def arg_metadata_device(
    count: typing.Annotated[int, argument_field],
):
    return count


# Discovery and trust: typed declarations and phase-free model projection.
assert all(
    getattr(omp, name) is getattr(provider_module, name)
    for name in (
        "DiscoveryDefaults", "DiscoveryKind", "DiscoveryPage", "DiscoveryQuery",
        "DiscoverySpec", "LoginRequest", "Pagination", "ProviderHandle",
        "RedirectTrust", "RefreshReason", "RefreshRequest", "RouteLimits",
        "SignRequest", "TrustDomain",
    )
)
assert tuple(member.value for member in omp.DiscoveryKind) == (
    "openai_models", "google_models", "ollama_tags", "account_models", "specialized",
)
assert tuple(member.value for member in omp.RedirectTrust) == (
    "deny", "same_origin", "public_only",
)
expect_raises(
    omp.SpecError,
    lambda: omp.DiscoverySpec(
        omp.DiscoveryKind.SPECIALIZED, "/models", "models",
        interval=omp.Duration("1s"),
    ),
)
discovery_spec = omp.DiscoverySpec(
    omp.DiscoveryKind.SPECIALIZED, "/models", "models",
    interval=omp.Duration("5s"),
)
assert discovery_spec.pagination == omp.Pagination.single_page()
defaults = omp.DiscoveryDefaults(routes=("local",))
assert defaults.cost == omp.Cost.free()
assert defaults.operations == frozenset({omp.Operation.CHAT})
https_route = omp.RouteSpec("remote", "https://example.test/v1", omp.Api.OPENAI_CHAT)
in_process_route = omp.RouteSpec(
    "usage", "local://synthetic-provider", omp.Api.LOCAL,
    transport=omp.Transport.LOCAL,
)
loopback_route = omp.RouteSpec(
    "local", "http://127.0.0.1:1234/v1", omp.Api.OPENAI_CHAT,
    discovery=discovery_spec, trust=omp.TrustDomain.loopback(),
    limits=omp.RouteLimits(max_context_tokens=8192),
)
assert https_route.trust.origin == "https://example.test"
assert in_process_route.trust.origin == "local://synthetic-provider"
assert loopback_route.trust.origin == "http://127.0.0.1:1234"
expect_raises(
    omp.SpecError,
    lambda: omp.RouteSpec(
        "remote-plain", "http://example.test/v1", omp.Api.OPENAI_CHAT,
        trust=omp.TrustDomain.loopback(),
    ),
)
query = omp.DiscoveryQuery(
    "local", "local", None, None, provider_module.DiscoveryTrigger.MANUAL,
)
page = omp.DiscoveryPage(models=(), authoritative=True)
assert query.route == "local" and page.authoritative
discovery_provider = omp.ProviderSpec(
    "discovery-test", "Discovery Test", (loopback_route,),
    discovery_defaults=defaults,
)
discovery_handle = omp.provider(discovery_provider)
assert discovery_handle.id == "discovery-test"
asyncio.run(discovery_handle.retract())
asyncio.run(discovery_handle.replace(discovery_provider))
assert frozen_host.calls[-2] == (
    "omp.provider.retract", {"provider": "discovery-test"}
)
replace_operation, replace_arguments = frozen_host.calls[-1]
assert replace_operation == "omp.provider.replace"
assert replace_arguments["provider"] == "discovery-test"
assert replace_arguments["spec"]["id"] == "discovery-test"
@omp.hook("models_discover", provider="discovery-test")
def discover_models(query, ctx):
    return page
assert discover_models.__omp_hooks__[-1].phase == "domain"

# Environment processes: shared restart policy, combined readiness, and deferred HTTP egress.
restart_policy = omp.env.RestartPolicy(policy=omp.Restart.ON_FAILURE)
assert restart_policy.policy is omp.Restart.ON_FAILURE
log_ready = omp.env.ReadyLog(pattern="x")
tcp_ready = omp.env.ReadyTcp(port=1)
ping_ready = omp.env.ReadyPing(nonce=7)
all_ready = omp.env.ReadyAll(log_ready, tcp_ready)
assert all_ready.probes == (log_ready, tcp_ready)
assert isinstance(ping_ready, omp.env.ReadyPing)
assert omp.env.ProcState.STARTING.value == "starting"
assert omp.env.Lifecycle.EXIT.value == "exit"
completed = omp.env.Completed(
    omp.env.Outcome.EXITED, 0, "", omp.Duration("1ms"), b"ok", None, False,
)
process_info = omp.env.ProcessInfo("p", 1, omp.env.ProcState.RUNNING, completed)
process_output = omp.env.ProcessOutput(1, omp.env.Channel.STDOUT, b"ok", 1)
assert process_info.status is completed and process_output.data == b"ok"
response = omp.env.HttpResponse(
    200,
    {"content-type": "application/json"},
    b'{"ok": true}',
    "https://example.test/final",
)
assert response.json() == {"ok": True}
assert response.final_url == "https://example.test/final"
asyncio.run(
    expect_raises_async(
        TypeError, omp.env.proc.ensure("invalid-ready", "true", ready=object())
    )
)
process = omp.env.Process("p", 7)
assert hasattr(omp.env.Run, "stdin") and not hasattr(omp.env.Run, "write")

class FrozenDataHost:
    def __init__(self):
        self.calls = []

    async def worktree(self):
        self.calls.append(("worktree",))
        return omp.env.WorktreeInfo(
            "surface-worktree", omp.EnvPath("workspace"), "main", 7,
        )

    async def http_request(self, method, url, **options):
        self.calls.append(("http_request", method, url, options))
        return omp.env.HttpResponse(
            200, {"content-type": "application/json"}, b'{"ok":true}', url,
        )

    async def process_restart(self, name, generation):
        self.calls.append(("process_restart", name, generation))
        return omp.env.StartedProcess("p", 8, "unix://p-8")

    async def process_info(self, name, generation):
        self.calls.append(("process_info", name, generation))
        return process_info

    def process_output(self, name, generation, after=0):
        self.calls.append(("process_output", name, generation, after))
        return ()

    def process_states(self, name, generation):
        self.calls.append(("process_states", name, generation))
        return ()

    async def process_send(self, name, generation, data):
        self.calls.append(("process_send", name, generation, data))

    async def process_send_secret(self, name, generation, secret_name, value):
        self.calls.append(("process_send_secret", name, generation, secret_name, value))

    async def process_signal(self, name, generation, signal):
        self.calls.append(("process_signal", name, generation, signal))

    async def process_stop(self, name, generation, **options):
        self.calls.append(("process_stop", name, generation, options))
        return process_info

    async def run_stdin(self, run, data):
        self.calls.append(("run_stdin", run, data))

    async def blobs_get(self, ref, offset=0, length=None):
        self.calls.append(("blobs_get", ref, offset, length))
        return b"artifact dat"

    def process_endpoint(self, name, generation):
        return f"unix://{name}-{generation}"

async def exercise_process_fence(backend):
    restarted = await process.restart()
    assert restarted.name == "p" and restarted.generation == 8
    await process.info()
    async for _ in process.output(after=2):
        pass
    async for _ in process.states():
        pass
    await process.send(b"x")
    await process.send_secret("token", "secret")
    await process.signal("SIGTERM")
    await process.stop(grace=omp.Duration("1s"))
    await omp.env.Run(b"run").stdin(b"x")

data_host = FrozenDataHost()
data_tokens = omp.env._install_backend(
    data_host,
    omp.env.EnvInfo(
        workspace_id=b"surface-workspace",
        root=omp.EnvPath("workspace"),
        server_epoch=b"surface-epoch",
        server_version="1.0.0",
        server_build="frozen-surface",
        schema_rev=1,
        capabilities=frozenset({
            omp.env.Capability.BLOB,
            omp.env.Capability.NET,
            omp.env.Capability.PROCESS,
            omp.env.Capability.WORKTREE,
        }),
        remote=False,
    ),
)
http_response = asyncio.run(omp.env.http_get("https://example.test"))
assert omp.env.info().server_epoch == b"surface-epoch"
assert http_response.json() == {"ok": True}
assert process.endpoint == "unix://p-7"
worktree = asyncio.run(omp.env.worktree())
assert worktree.id == "surface-worktree" and worktree.generation == 7
asyncio.run(exercise_process_fence(data_host))
process_operations = {call[0] for call in data_host.calls if call[0].startswith("process_")}
assert process_operations == {
    "process_restart", "process_info", "process_output", "process_states",
    "process_send", "process_send_secret", "process_signal", "process_stop",
}
assert all(call[2] == 7 for call in data_host.calls if call[0] in process_operations)
assert ("run_stdin", b"run", b"x") in data_host.calls

# Secrets: typed declarations and Core-owned masking use the installed authority.
assert omp.secrets is not None
secret_rule = omp.SecretRule(
    "TOKEN", kind=omp.SecretKind.ENV, mode=omp.SecretMode.REDACT,
    label="credential", replacement="[secret]",
)
assert secret_rule.pattern == "TOKEN" and secret_rule.replacement == "[secret]"
assert tuple(member.value for member in omp.SecretKind) == ("literal", "regex", "env")
assert tuple(member.value for member in omp.SecretMode) == ("obfuscate", "redact")
omp.secrets.declare(secret_rule)
assert frozen_host.secret_rules[-1]["content"] == "TOKEN"
masked_secret = omp.secrets.mask("TOKEN")
assert masked_secret == "$$CRED_SURFACEVALUE$$"
assert omp.secrets.is_masked(masked_secret)

# Residual closures: catalog, Environment values, journal projections, and URL reads.
devices_module = importlib.import_module("omp.devices")
assert {"provenance", "slotted", "schema_bytes", "schema_tokens"} <= set(
	devices_module.DeviceInfo.__dataclass_fields__
)
assert not asyncio.iscoroutinefunction(omp.devices.list)
assert any(row.name == "surface_device" for row in omp.devices.list())
pty = omp.env.Pty(rows=24, columns=80)
assert pty.rows == 24 and pty.columns == 80 and pty.terminal == "xterm-256color"
path_meta = omp.env.PathMeta(
    omp.EnvPath("src"), omp.env.FileKind.DIRECTORY, 0,
)
assert path_meta.kind is omp.env.FileKind.DIRECTORY
assert asyncio.run(omp.env.worktree()) == worktree

assert asyncio.iscoroutinefunction(omp.urls.read)

# Turn inference selection: thinking patches and scope-backed route/effort.
assert "thinking" in {
    field.name for field in dataclasses.fields(omp.TurnStartEvent)
}
selected_model = omp.ModelRef("provider", "api", "model")
selected_route = omp.RouteRef("provider", "route")
turn_selection = omp.TurnStartEvent(
    turn_id="turn",
    turn_index=1,
    prompt_hash="prompt",
    toolset_hash="tools",
    enabled_tools=(),
    input_mode=omp.TurnInputMode.FULL,
    model=selected_model,
    route=selected_route,
    thinking=omp.Effort.MEDIUM,
    deadline=None,
    attempt=1,
    prompt_changed=False,
    toolset_changed=False,
)
thinking_patch = omp.Modify(patch={"thinking": omp.Effort.HIGH})
assert dataclasses.replace(
    turn_selection, **thinking_patch.patch
).thinking is omp.Effort.HIGH
unknown_patch = omp.Modify(patch={"not_a_turn_field": True})
expect_raises(
    TypeError, lambda: dataclasses.replace(turn_selection, **unknown_patch.patch)
)
selection_scope = dataclasses.replace(
    scope,
    model=selected_model,
    route=selected_route,
    thinking=omp.Effort.HIGH,
)
selection_context = omp.Context.from_scope(selection_scope)
assert selection_context.model is selected_model
assert selection_context.route is selected_route
assert selection_context.thinking is omp.Effort.HIGH

# Sessions: typed lineage, indexed cost, and host-owned mutation requests.
assert omp.SandboxSessionKind is omp.policy.SandboxSessionKind
assert omp.SessionKind is omp.sessions.SessionKind
assert omp.SessionLink is omp.sessions.SessionLink
assert omp.SessionNotFound is omp.sessions.SessionNotFound
assert not hasattr(omp.sessions, "UsageCost")
session_cost = omp.sessions.Cost(
    nanos_usd=2_500_000_000, estimated=True,
    input_nanos_usd=1_000_000_000, output_nanos_usd=1_500_000_000,
)
assert session_cost.usd == 2.5
assert typing.get_type_hints(omp.sessions.SessionInfo)["cost"] is omp.sessions.Cost
session_link = omp.SessionLink("child", "parent", 17)
assert (session_link.id, session_link.parent, session_link.at) == (
    "child", "parent", 17,
)
expect_raises(
    dataclasses.FrozenInstanceError,
    lambda: setattr(session_link, "parent", None),
)
assert omp.sessions.current().id == "surface-session"
session_info = asyncio.run(omp.sessions.get("surface-session"))
assert session_info.id == "surface-session" and session_info.usage.reasoning == 3
lineage = asyncio.run(omp.sessions.lineage("surface-session"))
assert lineage == (omp.SessionLink("surface-session", None, 1),)
assert asyncio.run(omp.sessions.resume("surface-session")).id == "surface-session"
setup = omp.sessions.SessionSetup(
    title="Created", parent="surface-session", initial_prompt="Continue",
)
assert setup is not omp.sessions.SessionSetup()
expect_raises(AttributeError, lambda: setattr(setup, "title", "Changed"))
created_session = asyncio.run(omp.sessions.create(setup))
assert created_session.id == "created-session" and created_session.title == "Created"
renamed = asyncio.run(omp.sessions.rename("surface-session", "New title"))
assert renamed.title == "New title"
asyncio.run(
    expect_raises_async(
        omp.PermissionDenied, omp.sessions.delete("surface-session")
    )
)

# Schedules: payload-bearing delivery and schedule attribution.
schedule_trigger = omp.agents.Every(
	omp.Duration("60s"), jitter=omp.Duration("5s"), align=True,
)
schedule_delivery = omp.agents.Inject(
	prompt="poll chat replies",
	mode=omp.agents.DeliveryMode.NEXT_TURN,
	visible=True,
)
assert [field.name for field in dataclasses.fields(schedule_trigger)] == [
	"interval", "jitter", "align",
]
assert [field.name for field in dataclasses.fields(schedule_delivery)] == [
	"prompt", "mode", "visible",
]
assert schedule_delivery.prompt == "poll chat replies"
assert "schedule_id" in {
	field.name for field in dataclasses.fields(omp.BeforeAgentStartEvent)
}
scheduled = asyncio.run(
    omp.agents.schedule("chat-poll", schedule_trigger, schedule_delivery)
)
assert scheduled.id == "schedule-1"
schedule_request = frozen_host.calls[-1]
assert schedule_request[0] == "omp.agents.schedule"
assert schedule_request[1]["trigger"]["interval_ms"] == 60_000
assert schedule_request[1]["delivery"]["kind"] == "inject"
# Approvals: frozen external registration and idempotent late resolution.
@omp.approver(
    "test-approver",
    kinds=(omp.ApprovalKind.EXEC,),
    timeout=omp.Duration("30s"),
    unreachable=omp.Unreachable.FAIL_CLOSED,
)
async def test_approver(ticket, ctx):
    return None

approver_definition = {
    definition.name: definition
    for definition in registry_module.registry.snapshot().approvers
}["test-approver"]
assert approver_definition.handler is test_approver
assert approver_definition.kinds == (omp.ApprovalKind.EXEC,)
approval_decision = omp.ApprovalDecision(
    False, omp.PolicyScope.ONCE, omp.ApprovalSource.EXTERNAL,
    "test-approver", "denied", False,
)
pending_tickets = asyncio.run(omp.policy.pending())
assert pending_tickets[0].ticket_id == "ticket-1"
asyncio.run(omp.policy.decide("ticket-1", approval_decision))
first_decision_request = frozen_host.calls[-1]
assert first_decision_request[1]["decision"]["source"] == "external"
asyncio.run(omp.policy.decide("ticket-1", approval_decision))
assert frozen_host.calls[-1] == first_decision_request
assert omp.tier_of(omp.CoreTool("read", "1", {})) is omp.Tier.READ
assert asyncio.run(omp.prompts.invalidate("memory")) == 4

authority_token = omp._control_backend.set(None)
try:
    asyncio.run(
        expect_raises_async(omp.NotWiredError, omp.policy.pending())
    )
    expect_raises(
        omp.PolicyError,
        lambda: omp.tier_of(omp.CoreTool("read", "1", {})),
    )
finally:
    omp._control_backend.reset(authority_token)

# Provider catalog: overlays, successor rotation, ADC, refresh, and image requests.
image_dimensions = omp.Dimensions(1024, 1024)
image_caps = omp.ImageCaps(
    frozenset({omp.ImageFeature.GENERATE}),
    (image_dimensions,),
    frozenset({omp.ImageFormat.PNG}),
)
image_model = omp.ModelSpec(
    "image-1", "Image One", (), operations=frozenset({omp.Operation.GENERATE_IMAGE}),
    image=image_caps,
)
assert typing.get_type_hints(omp.ModelSpec)["image"] == omp.ImageCaps | None
image_request = omp.ImageRequest("draw a circle", image_dimensions, omp.ImageFormat.PNG, 2)
assert omp.ImageResult((), 17).cost_nanos_usd == 17

model_patch = omp.ModelPatch(display_name="Friendly Base")
model_overlay = omp.ModelOverlay(
    omp.ModelRef("overlay-provider", "openai", "base"), patch=model_patch
)
scoped_alias = omp.ScopedAlias(
    "overlay-provider",
    omp.CatalogAlias("fast", "base", "workspace shorthand", "extension"),
)
overlay_spec = omp.ProviderSpec(
    "overlay-provider", "Overlay Provider", (),
    aliases=(scoped_alias,), model_overlays=(model_overlay,),
)
overlay_handle = omp.provider(overlay_spec, extends="overlay-provider")
assert overlay_handle.id == "overlay-provider"
class OverlayProvider:
    pass
assert overlay_handle(OverlayProvider) is OverlayProvider
assert OverlayProvider.__omp_provider_extends__ == "overlay-provider"
expect_raises(
    omp.SpecError,
    lambda: omp.ProviderSpec(
        "overlay-provider", "Conflict", (),
        model_overlays=(model_overlay, model_overlay),
    ),
)
expect_raises(
    omp.SpecError,
    lambda: omp.provider(overlay_spec),
)
expect_raises(
    omp.SpecError,
    lambda: omp.ProviderSpec(
        "overlay-provider", "Alias Conflict", (),
        aliases=(
            scoped_alias,
            omp.ScopedAlias(
                "overlay-provider",
                omp.CatalogAlias("fast", "other", "conflict", "extension"),
            ),
        ),
    ),
)

adc = omp.CredentialSource.application_default(
    project_env="VERTEX_PROJECT", location_env="VERTEX_LOCATION"
)
assert adc.kind == "application_default"
assert adc.options["project_env"] == "VERTEX_PROJECT"
rotation = omp.Failover.rotate_account("identity-next", cooldown=omp.Duration("5s"))
assert rotation.target == "identity-next" and rotation.kind is omp.FailoverKind.ROTATE_ACCOUNT

@omp.hook("provider_refresh", provider="overlay-provider")
async def refresh_provider(req, ctx):
    return None

assert refresh_provider.__omp_hooks__[-1].phase == "domain"
generated_image = asyncio.run(
    overlay_handle.request(omp.Operation.GENERATE_IMAGE, image_request)
)
assert generated_image.cost_nanos_usd == 17
assert generated_image.images == (omp.BlobRef(bytes(32), 3),)
provider_request = frozen_host.calls[-1]
assert provider_request[0] == "omp.provider.request"
assert provider_request[1]["operation"] == "generate_image"
assert provider_request[1]["request"]["dimensions"] == {
    "width": 1024, "height": 1024,
}

# UI residuals: clipboard effects, frozen shortcuts, and host-fed overlay events.
assert omp.shortcut is omp.ui.shortcut
expect_raises(omp.ui.ShortcutError, lambda: omp.shortcut("ctrl+alt"))

@omp.shortcut(
    "SHIFT+CTRL+X",
    action_id="copy-cut.cut",
    description="Cut composer text",
    when=frozenset({omp.ui.Phase.IDLE}),
)
async def copy_cut_shortcut(action, ctx):
    return None

shortcut_definition = {
    definition.action_id: definition
    for definition in registry_module.registry.snapshot().shortcuts
}["copy-cut.cut"]
assert shortcut_definition.chord == "ctrl+shift+x"
assert shortcut_definition.description == "Cut composer text"
assert shortcut_definition.when == frozenset({omp.ui.Phase.IDLE})
assert shortcut_definition.handler is copy_cut_shortcut

effect_count = len(frozen_host.effects)
omp._install_control_backend(frozen_host)
omp.ui.set_clipboard("copied text")
assert frozen_host.effects[effect_count:] == [
    {"kind": "set_clipboard", "body": {"text": "copied text"}}
]

watched_kinds = (
    omp.ui.EventKind.HIGHLIGHTED,
    omp.ui.EventKind.CHANGED,
    omp.ui.EventKind.FILTERED,
    omp.ui.EventKind.PRESSED,
)
watched_events = tuple(omp.ui.OverlayEvent(kind) for kind in watched_kinds)
assert tuple(event.kind for event in watched_events) == watched_kinds

highlighted_event = omp.ui.OverlayEvent(
    omp.ui.EventKind.HIGHLIGHTED,
    id="threads",
    value="thread-2",
    values={"threads": "thread-2"},
)
assert highlighted_event.query is None

async def collect_overlay_events():
    handle = omp.ui.OverlayHandle("side-chat")
    return [event async for event in handle.events()]

overlay_events = asyncio.run(collect_overlay_events())
assert overlay_events == [
    highlighted_event,
    omp.ui.OverlayEvent(omp.ui.EventKind.CANCEL),
]

# Env HTTP: scoped GET, POST, and PUT host arms preserve request semantics.
assert {"http_get", "http_post", "http_put"} <= set(omp.env.__all__)
http_get = asyncio.run(
    omp.env.http_get(
        "https://example.test",
        timeout=omp.Duration("2s"),
        headers={"accept": "application/json"},
    )
)
http_post = asyncio.run(
    omp.env.http_post(
        "https://example.test",
        body=b"{}",
        headers={"content-type": "application/json"},
        timeout=omp.Duration("2s"),
    )
)
http_put = asyncio.run(
    omp.env.http_put(
        "https://example.test",
        body=b"{}",
        headers={"content-type": "application/json"},
        timeout=omp.Duration("2s"),
    )
)
assert (http_get.status, http_post.status, http_put.status) == (200, 200, 200)
http_calls = [call for call in data_host.calls if call[0] == "http_request"]
assert [call[1] for call in http_calls[-3:]] == ["GET", "POST", "PUT"]
assert http_calls[-2][3]["body"] == b"{}"
assert http_calls[-1][3]["timeout"] == omp.Duration("2s")

# Round 5 devices: child declarations, synchronous snapshots, and slot budget.
@surface_device.subtool("inspect/detail")
async def inspect_surface_device():
    """Inspect one nested surface-device leaf."""
    return None


declared_device_rows = omp.devices.list(mounted_only=False)
assert str(inspect_surface_device.path) == "surface_device/inspect/detail"
assert any(
    row.path == inspect_surface_device.path for row in declared_device_rows
)
assert omp.devices.HARD_SLOT_BUDGET == 8
assert omp.HARD_SLOT_BUDGET == 8

host_catalog_row = dataclasses.replace(
    declared_device_rows[0],
    name="host_catalog_device",
    identity="host_catalog_device@host/1",
    path=omp.ToolPath("host_catalog_device"),
)
devices_module._install_catalog_view((host_catalog_row,))
try:
    merged_device_rows = omp.devices.list(mounted_only=False)
finally:
    devices_module._install_catalog_view(None)
assert merged_device_rows[0] is host_catalog_row
assert any(row.path == inspect_surface_device.path for row in merged_device_rows)

# Round 5 merged catalog: resolved cards and a typed host-fed watch stream.
catalog_card = omp.ModelCard(
    id="acme/reasoner",
    provider="acme",
    model="reasoner",
    name="Acme Reasoner",
    family="acme",
    facets=frozenset({omp.Facet.CHAT}),
    inputs=frozenset({omp.Modality.TEXT}),
    outputs=frozenset({omp.Modality.TEXT}),
    reasoning=True,
    efforts=(omp.Effort.LOW, omp.Effort.HIGH),
    context_window=131072,
    max_output_tokens=8192,
    pricing=(omp.Price(omp.PriceUnit.MTOK_INPUT, 250_000_000),),
    availability=provider_module.Availability.AVAILABLE,
    source=omp.ModelCard.Source.EXTENSION,
    blocked_until_ms=None,
    deprecated=False,
    updated_at_ms=1234,
    supports_tools=True,
    props={"acme/tier": "pro"},
)
assert catalog_card.id == "acme/reasoner"
assert catalog_card.source is omp.ModelCard.Source.EXTENSION
assert catalog_card.pricing[0].unit is omp.PriceUnit.MTOK_INPUT
catalog_cursor = omp.Cursor(epoch=b"catalog-epoch", generation=7)
catalog_event = omp.ModelEvent(cursor=catalog_cursor, upserted=catalog_card)
assert catalog_event.upserted is catalog_card
resolved_models = asyncio.run(omp.models())
assert resolved_models == (catalog_card,)

async def collect_model_events():
    return [event async for event in omp.watch_models(catalog_cursor)]

catalog_events = asyncio.run(collect_model_events())
assert catalog_events == [
    catalog_event,
    omp.ModelEvent(
        cursor=omp.Cursor(epoch=b"catalog-epoch", generation=8),
        removed_id=catalog_card.id,
    ),
]
assert all(isinstance(event, omp.ModelEvent) for event in catalog_events)

# Round 5 UI: typed message folds and host-composed renderer decoration.
message_view = omp.MessageView(
    id="message-1",
    kind="assistant",
    role="assistant",
    text="original",
)
assert omp.MessageView is omp.ui.MessageView
assert dataclasses.is_dataclass(message_view)
assert (message_view.id, message_view.kind, message_view.role, message_view.text) == (
    "message-1", "assistant", "assistant", "original",
)

@omp.renderer("__decorated_ui__", family="ui", rev=1, decorates=True)
def decorated_ui_renderer(view, ctx):
    return omp.ui.text("augmentation")

decorated_registration = omp.ui._device_renderers[("__decorated_ui__", "ui", 1)]
assert decorated_registration.function is decorated_ui_renderer
assert decorated_registration.decorates is True
assert decorated_registration.reduce is None
assert decorated_ui_renderer.__omp_renderer_decorates__ is True
@omp.renderer(
    "surface_device",
    rev=1,
    reduce=lambda acc, update: (acc or 0) + update,
)
def surface_verdict_renderer(view, ctx):
    assert isinstance(view.verdict, omp.Ok)
    assert view.updates == ()
    return omp.ui.text(f"{view.verdict.payload['value']}@{ctx.width}:{view.state}")

surface_verdict = omp.ui._dispatch_renderer(
    "surface_device",
    "",
    1,
    {
        "call_id": "surface-verdict",
        "updates": [2, 3],
        "state": None,
        "verdict": {"kind": "ok", "value": {"value": 3}},
        "elapsed": "1ms",
        "phase": "OPEN",
    },
    {
        "width": 80,
        "charset": "unicode",
        "appearance": "dark",
        "graphics": "cells",
        "hyperlinks": False,
        "focused": False,
        "collapsed": False,
        "place": "transcript",
    },
)
assert surface_verdict == omp.ui.text("3@80:5")

# Round 5 telemetry: prompt slot facts, request timings/content, and coalescing survive freeze.
slot_fingerprint = telemetry_module.PromptSlotFingerprint(
	digest="ab" * 16,
	size_bytes=128,
	band=omp.SlotClass.STABLE,
)
prompt_fingerprint = telemetry_module.PromptFingerprint(
	digest="cd" * 16,
	slots={"workspace": slot_fingerprint},
	changed=("workspace",),
	prefix_stable_bytes=64,
	cache_key="session-key",
	retention="short",
	mode="explicit",
	ttl="thirty_minutes",
	breakpoint="latest_stable_message",
	breakpoint_indices=(0,),
)
degradation = telemetry_module.Degradation(
	what="sampling.top_k",
	detail="provider omitted top-k",
	action=telemetry_module.DegradeAction.DROPPED,
)
model_request = telemetry_module.ModelRequest(
	seq=7,
	usage=telemetry_module.Tokens(input=4, output=2, total=6),
	prompt=prompt_fingerprint,
	served_model="acme/reasoner",
	latency_ms=120,
	ttft_ms=30,
	degraded=(degradation,),
)
assert prompt_fingerprint.slots["workspace"] == slot_fingerprint
assert slot_fingerprint.size_bytes == 128 and slot_fingerprint.band is omp.SlotClass.STABLE
assert model_request.latency_ms == 120 and model_request.ttft_ms == 30
assert model_request.degraded == (degradation,)
assert model_request.request_content is None and model_request.response_content is None
captured_request = dataclasses.replace(
	model_request,
	request_content=b"request",
	response_content=b"response",
)
assert captured_request.request_content == b"request"
assert captured_request.response_content == b"response"

def request_coalesce_key(event):
	return event.served_model

@telemetry_module(
	[telemetry_module.Kind.MODEL_REQUEST],
	overflow=telemetry_module.Overflow.COALESCE_BY_KEY,
	coalesce_key=request_coalesce_key,
)
async def coalesced_request_sink(event, ctx):
	return None

telemetry_snapshot = registry_module.registry.snapshot()
coalesced_definition = next(
	definition
	for definition in telemetry_snapshot.telemetry
	if definition.handler is coalesced_request_sink
)
assert coalesced_definition.coalesce_key is request_coalesce_key
assert coalesced_definition.overflow == telemetry_module.Overflow.COALESCE_BY_KEY.value

# Round 5 provider declarations, media operations, and typed completion parts.
assert issubclass(omp.SpecError, omp.ExtensionError)
assert not issubclass(omp.SpecError, ValueError)
assert tuple(omp.CacheRetention) == (
    omp.CacheRetention.REQUEST,
    omp.CacheRetention.SESSION,
    omp.CacheRetention.SHORT,
    omp.CacheRetention.LONG,
)
cache_caps = omp.PromptCacheCaps(
    frozenset({omp.CacheRetention.SESSION, omp.CacheRetention.SHORT}),
    min_prefix_tokens=256,
    max_breakpoints=4,
)
assert cache_caps.min_prefix_tokens == 256 and cache_caps.max_breakpoints == 4
assert not hasattr(cache_caps, "minimum_prefix_tokens")

speech_caps = omp.SpeechCaps(
    frozenset({omp.SpeechFeature.STREAMING, omp.SpeechFeature.VOICE_SELECTION}),
    ("alloy",),
    frozenset({omp.AudioFormat.MP3}),
    (24_000,),
)
transcription_caps = omp.TranscriptionCaps(
    frozenset({
        omp.TranscriptionFeature.TIMESTAMPS,
        omp.TranscriptionFeature.LANGUAGE_HINT,
    }),
    frozenset({omp.AudioFormat.MP3, omp.AudioFormat.WAV}),
    omp.Duration("1h"),
)
speech_model = omp.ModelSpec(
    "round5-speech",
    "Round 5 Speech",
    (),
    operations=frozenset({omp.Operation.SPEAK, omp.Operation.TRANSCRIBE}),
    speech=speech_caps,
    transcription=transcription_caps,
)
assert typing.get_type_hints(omp.ModelSpec)["speech"] == omp.SpeechCaps | None
assert typing.get_type_hints(omp.ModelSpec)["transcription"] == omp.TranscriptionCaps | None
expect_raises(
    omp.SpecError,
    lambda: omp.ProviderSpec(
        "duplicate-models",
        "Duplicate Models",
        (),
        models=(speech_model, speech_model),
    ),
)

media_blob = omp.BlobRef(bytes(32), 3)
speech_request = omp.SpeechRequest(
    "round5-speech", "hello", "alloy", omp.AudioFormat.MP3,
)
speech_result = omp.SpeechResult(media_blob, omp.AudioFormat.MP3, 11)
transcription_request = omp.TranscriptionRequest("round5-speech", media_blob, "en")
transcription_result = omp.TranscriptionResult("hello", "en", 13)
assert speech_result.audio is media_blob and transcription_result.text == "hello"

bare_spec = omp.ProviderSpec(
    "round5-bare-provider",
    "Round 5 Bare Provider",
    (),
    models=(speech_model,),
)
bare_handle = omp.provider(bare_spec)
bare_definition = next(
    definition
    for definition in registry_module.registry.snapshot().providers
    if definition.id == bare_handle.id
)
assert bare_definition.spec is bare_spec and bare_definition.implementation is None
assert (bare_definition.priority, bare_definition.extends, bare_definition.replaces) == (
    0, None, None,
)
spoken = asyncio.run(
    bare_handle.request(omp.Operation.SPEAK, speech_request)
)
transcribed = asyncio.run(
    bare_handle.request(omp.Operation.TRANSCRIBE, transcription_request)
)
assert spoken.audio == omp.BlobRef(bytes(32), 3)
assert transcribed.text == "hello" and transcribed.language == "en"
completion_parts = (
    omp.Part.text("describe the image"),
    omp.Part.blob(media_blob, alt="image"),
)
vision_completion = asyncio.run(
    omp.agents.completion(completion_parts, role="vision")
)
assert vision_completion.text == "allow"
assert frozen_host.calls[-1][1]["role"] == "vision"
asyncio.run(
    expect_raises_async(TypeError, omp.agents.completion((object(),), role="vision"))
)

# Dynamic commands retain full static-command metadata and use the host registration arm.
async def complete_dynamic(query, ctx):
    return ()
async def invoke_dynamic(invocation, ctx):
    return omp.ui.Prompt("dynamic")
dynamic_spec = omp.ui.CommandMountSpec(
    "foreign-prompt",
    invoke_dynamic,
    aliases=("fp",),
    description="Imported prompt",
    args=(omp.ui.Arg("topic", "Prompt topic", "<topic>"),),
    hint="/foreign-prompt <topic>",
    arg_completions=complete_dynamic,
)
assert dynamic_spec.aliases == ("fp",)
assert dynamic_spec.args == (omp.ui.Arg("topic", "Prompt topic", "<topic>"),)
assert dynamic_spec.hint == "/foreign-prompt <topic>"
assert dynamic_spec.arg_completions is complete_dynamic
assert asyncio.run(omp.ui.dynamic_mount(dynamic_spec)) == ("foreign-prompt",)
assert frozen_host.calls[-1] == (
    "omp.ui.dynamic_mount",
    {"commands": [{
        "name": "foreign-prompt",
        "aliases": ["fp"],
        "description": "Imported prompt",
        "args": [{"name": "topic", "description": "Prompt topic", "usage": "<topic>"}],
        "hint": "/foreign-prompt <topic>",
        "dynamic_completions": True,
    }]},
)
assert omp.ui._command_handlers["foreign-prompt"] is invoke_dynamic

# R-invoke: host composition opens a fresh, independently gated call.
assert asyncio.iscoroutinefunction(omp.devices.invoke)
nested_invocation = asyncio.run(
    omp.devices.invoke(
        "notes/append",
        {"value": "draft"},
        deadline=omp.Duration("2s"),
    )
)
assert nested_invocation == {"value": "draft", "admitted": True}
assert frozen_host.calls[-1] == (
    "omp.devices.invoke",
    {
        "path": "notes/append",
        "args": {"value": "draft"},
        "deadline": "2s",
    },
)

# Round 6 renderer inputs carry copied, read-only presentation state.
presentation_source = {"calm.enabled": True}
render_ctx = omp.ui.RenderCtx(
    width=80,
    charset=omp.ui.Charset.UNICODE,
    appearance=omp.ui.Appearance.DARK,
    graphics=omp.ui.Graphics.CELLS,
    hyperlinks=True,
    focused=False,
    collapsed=True,
    place=omp.ui.RenderPlace.TRANSCRIPT,
    presentation=presentation_source,
)
message_input = omp.MessageView(
    id="calm-message",
    kind="reasoning",
    role="assistant",
    text="thinking",
    presentation=presentation_source,
)
device_input = omp.View(
    identity=omp.ToolIdentity("read", omp.Rev.parse("1")),
    call_id="calm-call",
    updates=(),
    state=None,
    verdict=None,
    elapsed=omp.Duration("1ms"),
    phase=omp.InvocationPhase.OPEN,
    presentation=presentation_source,
)
presentation_source["calm.enabled"] = False
def mutate_presentation(render_input):
    render_input.presentation["calm.enabled"] = False
for render_input in (render_ctx, message_input, device_input):
    assert render_input.presentation == {"calm.enabled": True}
    expect_raises(
        TypeError,
        lambda render_input=render_input: mutate_presentation(render_input),
    )
assert omp.ui.RenderCtx(
    width=80,
    charset=omp.ui.Charset.UNICODE,
    appearance=omp.ui.Appearance.DARK,
    graphics=omp.ui.Graphics.CELLS,
    hyperlinks=False,
    focused=False,
    collapsed=False,
    place=omp.ui.RenderPlace.EXPORT,
).presentation == {}
assert omp.MessageView(
    id="default-message",
    kind="notice",
    role=None,
    text="",
).presentation == {}
assert omp.View(
    identity=omp.ToolIdentity("read", omp.Rev.parse("1")),
    call_id="default-call",
    updates=(),
    state=None,
    verdict=None,
    elapsed=omp.Duration("1ms"),
    phase=omp.InvocationPhase.OPEN,
).presentation == {}

# Detached outcomes retain the authoritative Environment owner and register through JobBoard.
job_ref = omp.JobRef(
	id="process:indexer:7",
	owner_kind="named_process",
	owner_name="indexer",
	owner_generation=7,
	description="knowledge index",
	media_type="application/vnd.omp.knowledge-index+json",
	lifetime="session",
)
assert dataclasses.is_dataclass(job_ref)
assert dataclasses.is_dataclass(omp.Detached(job_ref))
assert not hasattr(job_ref, "__dict__")
expect_raises(
	dataclasses.FrozenInstanceError,
	lambda: setattr(job_ref, "owner_generation", 8),
)
assert omp.Detached(job_ref).job is job_ref
assert (
	job_ref.id,
	job_ref.owner_kind,
	job_ref.owner_name,
	job_ref.owner_generation,
	job_ref.description,
	job_ref.media_type,
	job_ref.lifetime,
) == (
	"process:indexer:7",
	"named_process",
	"indexer",
	7,
	"knowledge index",
	"application/vnd.omp.knowledge-index+json",
	"session",
)

async def detached_frames():
	yield omp.Update(stage="walking")
	yield omp.Done("settled")

registered_frames = detached_frames()
assert asyncio.run(omp.jobs.register(registered_frames, ctx)) is job_ref
assert frozen_host.calls[-1] == (
    "omp.jobs.register",
    {"frames": registered_frames, "context": ctx},
)

# Round 6 router: decorated and mounted routes freeze their own projections.
surface_route_effects = omp.Effects(documents=omp.DocEffects(read=True))


@surface_device.subtool(
    "inspect/annotated",
    family="surface-routes",
    place="env",
    precedence=omp.Precedence.ENHANCEMENT,
    tier=omp.Tier.READ,
    effects=surface_route_effects,
    docs="Annotated child documentation.",
    summary="Inspect annotated input.",
)
async def inspect_annotated_surface_device(
    count: typing.Annotated[
        int,
        omp.Field(
            alias=("routeCount",),
            expected="a route count",
            description="Number of routes to inspect.",
        ),
    ],
):
    return count


surface_router = omp.router("mounted")


@surface_router.subtool("status/detail")
async def mounted_surface_status():
    return "mounted"


(mounted_surface_status_device,) = surface_device.mount(surface_router)
late_router = omp.router("late")


@late_router.subtool("route")
async def late_surface_route():
    return None


# Round 6 hosted tools and Core-owned realtime establishment are fully typed.
hosted_tools = frozenset({
    omp.HostedTool.WEB_SEARCH,
    omp.HostedTool.CODE_EXECUTION,
    omp.HostedTool.RETRIEVAL,
    omp.HostedTool.URL_CONTEXT,
    omp.HostedTool.DEEP_RESEARCH,
})
hosted_chat = omp.ChatCaps(hosted_tools=hosted_tools)
assert hosted_chat.hosted_tools == hosted_tools
assert typing.get_type_hints(omp.ChatCaps)["hosted_tools"] == (
    omp.Cap | frozenset[omp.HostedTool]
)

realtime_features = frozenset({
    omp.RealtimeFeature.AUDIO_IN,
    omp.RealtimeFeature.AUDIO_OUT,
    omp.RealtimeFeature.TEXT,
    omp.RealtimeFeature.TOOLS,
    omp.RealtimeFeature.SERVER_VAD,
    omp.RealtimeFeature.SEMANTIC_VAD,
    omp.RealtimeFeature.INTERRUPTION,
})
realtime_caps = omp.RealtimeCaps(
    realtime_features,
    ("alloy",),
    frozenset({omp.Transport.WEBRTC}),
)
realtime_model = omp.ModelSpec(
    "round6-realtime",
    "Round 6 Realtime",
    (),
    operations=frozenset({omp.Operation.REALTIME}),
    realtime=realtime_caps,
)
assert realtime_model.realtime is realtime_caps
assert typing.get_type_hints(omp.ModelSpec)["realtime"] == omp.RealtimeCaps | None

turn_detection = omp.TurnDetection(
    omp.RealtimeTurnDetectionMode.SERVER_VAD,
    threshold=0.5,
    silence_ms=500,
    prefix_padding_ms=300,
)
realtime_request = omp.RealtimeRequest(
    instructions="Answer briefly.",
    modalities=(omp.RealtimeModality.TEXT, omp.RealtimeModality.AUDIO),
    voice="alloy",
    input_audio=omp.Setting.require(omp.AudioFormat.PCM16),
    output_audio=omp.Setting.prefer(omp.AudioFormat.PCM16),
    turn_detection=omp.Setting.require(turn_detection),
    tools=("lookup",),
    negotiation=omp.NegotiationPolicy(
        emulation=omp.EmulationPolicy.ALLOW_LOSSLESS,
        unknown=omp.UnknownCapabilityPolicy.ALLOW_PREFERENCES,
        vendor_option_mismatch=omp.MismatchPolicy.DROP_PREFERRED,
    ),
)
assert realtime_request.input_audio.kind is omp.SettingKind.REQUIRE
assert realtime_request.output_audio.kind is omp.SettingKind.PREFER
realtime_session = omp.RealtimeSession(
    "rtc_round6",
    omp.RealtimeEndpointRef("endpoint_round6"),
    omp.RealtimeCredentialRef("credential_round6"),
    2_000_000_000_000,
    omp.Transport.WEBRTC,
)
assert realtime_session.transport is omp.Transport.WEBRTC
asyncio.run(
    expect_raises_async(
        TypeError,
        bare_handle.request(omp.Operation.REALTIME, speech_request),
    )
)
established_realtime = asyncio.run(
    bare_handle.request(omp.Operation.REALTIME, realtime_request)
)
assert established_realtime.id == "rtc-surface"
assert established_realtime.endpoint.id == "endpoint-surface"
assert established_realtime.transport is omp.Transport.WEBRTC

# Env HTTP redirects are bounded per verb and every response identifies its final URL.
assert all(
    verb.__kwdefaults__["redirects"] == 10
    for verb in (omp.env.http_get, omp.env.http_post, omp.env.http_put)
)
expect_raises(
    TypeError,
    lambda: asyncio.run(omp.env.http_get("https://example.test", redirects=True)),
)
expect_raises(
    ValueError,
    lambda: asyncio.run(omp.env.http_get("https://example.test", redirects=11)),
)
assert not dataclasses.is_dataclass(omp.env.HttpResponse)
assert all(hasattr(response, name) for name in ("status", "headers", "body", "final_url"))

# The durable call outcome is a closed, public four-arm union.
argument_issue = {"path": ("query",), "expected": "a non-empty string"}
args_rejected = omp.ArgsRejected(argument_issue)
cancelled = omp.Aborted({"reason": "user cancelled"}, omp.AbortKind.CANCELLED)
assert args_rejected.issue is argument_issue
assert cancelled.kind is omp.AbortKind.CANCELLED
assert {
    typing.get_origin(arm) or arm for arm in typing.get_args(omp.CallOutcome)
} == {omp.Ok, omp.Faulted, omp.ArgsRejected, omp.Aborted}
expect_raises(
    ValueError,
    lambda: omp.Aborted(
        {"reason": "policy denied"},
        omp.AbortKind.POLICY_DENIED,
    ),
)

# Artifact references are typed throughout the public journal and namespace.
artifact_ref = omp.ArtifactRef(
    id="7",
    hash="11" * 32,
    media_type="text/plain",
    byte_len=12,
)
assert str(artifact_ref.url) == "artifact://7"
assert omp.artifacts.url(artifact_ref) == artifact_ref.url
assert typing.get_type_hints(omp.JournalEntry)["artifact"] == omp.ArtifactRef | None
assert tuple(field.name for field in dataclasses.fields(omp.ArtifactRef)) == (
    "id",
    "hash",
    "media_type",
    "byte_len",
)
assert {
    "put",
    "open_write",
    "adopt",
    "get",
    "open",
    "read",
    "stat",
    "list",
    "pin",
    "url",
}.issubset(omp.artifacts.__all__)
artifact_bytes = asyncio.run(omp.artifacts.get(artifact_ref))
assert artifact_bytes == b"artifact dat"
assert data_host.calls[-1] == (
    "blobs_get",
    omp.BlobRef(bytes.fromhex("11" * 32), 12),
    0,
    None,
)
omp.env._reset_backend(data_tokens)
asyncio.run(
    expect_raises_async(omp.env.EnvUnavailable, omp.env.worktree())
)

# Catalog notices remain message tokens and expose their ruled explanatory echo.
context_usage = omp.ContextUsage(
    total_tokens=120,
    context_window=1_000,
    reserve_tokens=100,
    usable_tokens=900,
    fraction=120 / 900,
    prompt_head_tokens=20,
    device_catalog_tokens=10,
    message_tokens=80,
    catalog_notice_tokens=7,
    media_tokens=10,
    compaction_epoch=2,
    threshold_fraction=0.8,
    in_flight=False,
)
assert context_usage.catalog_notice_tokens == 7
assert (
    tuple(field.name for field in dataclasses.fields(omp.ContextUsage)).index(
        "catalog_notice_tokens"
    )
    == tuple(field.name for field in dataclasses.fields(omp.ContextUsage)).index(
        "message_tokens"
    )
    + 1
)

# Configured manifest content is typed, frozen, and enumerable without a walk.
assert omp.ContentDeclaration.__dataclass_params__.frozen
assert tuple(field.name for field in dataclasses.fields(omp.ContentDeclaration)) == (
    "kind",
    "path",
    "metadata",
)
assert tuple(kind.value for kind in omp.ContentKind) == (
    "skills",
    "rules",
    "context-files",
    "prompts",
)
(content_row,) = omp.packages.own().declarations
assert content_row.kind is omp.ContentKind.SKILLS
assert content_row.path == "acme_ext/skills/review/SKILL.md"
assert dict(content_row.metadata) == {
    "name": "review",
    "description": "Review a change.",
}
# Auxiliary CONTROL surfaces share the same request authority and typed decoding.
@omp.params
class SurfaceParams:
    query: str

async def auxiliary_control_contract():
    mounted = await omp.mcp.mount(
        omp.mcp.McpMount(
            server="surface",
            transport=omp.mcp.Http("https://example.test/mcp"),
            precedence=omp.Precedence.ENHANCEMENT,
        )
    )
    assert len(mounted) == 1 and mounted[0].rev == 1
    invoked = await mounted[0](value="roundtrip")
    assert invoked["structured_content"] == {"value": "roundtrip"}
    assert frozen_host.calls[-1] == (
        "omp.mcp.invoke",
        {
            "server": "surface",
            "tool": "echo",
            "arguments": {"value": "roundtrip"},
        },
    )
    await omp.mcp.unmount("surface")

    cursor = omp.IncomingParams(
        name="surface",
        rev=omp.Rev("mcp", 1),
        invocation_id="surface-call",
        shape=SurfaceParams,
    )
    assert await cursor.args() == SurfaceParams("needle")
    assert await cursor.raw() == '{"query":"needle"}'
    assert await cursor.committed() == '{"query":"needle"}'
    assert cursor.is_authorized
    args_call = next(
        call for call in frozen_host.calls if call[0] == "omp.params.args"
    )
    assert args_call == (
        "omp.params.args",
        {
            "invocation_id": "surface-call",
            "interruptible": False,
            "expected": "SurfaceParams",
        },
    )

    urls_module = importlib.import_module("omp.urls")
    old_snapshot = (
        urls_module._scheme_source,
        urls_module._scheme_hash,
        urls_module._scheme_cache,
    )
    try:
        urls_module._bind_scheme_source(
            lambda: (
                b"frozen-surface",
                ((
                    urls_module.Scheme.FILE,
                    urls_module.SchemeInfo(True, False, True, "files"),
                ),),
            )
        )
        assert await omp.urls.read("notes.txt", "1-2") == "authoritative surface"
        assert frozen_host.calls[-1] == (
            "omp.urls.read", {"url": "notes.txt:1-2"}
        )
    finally:
        (
            urls_module._scheme_source,
            urls_module._scheme_hash,
            urls_module._scheme_cache,
        ) = old_snapshot

asyncio.run(auxiliary_control_contract())

# Projection hooks can drop whole result parts without discarding typed verdicts.
drop_parts = omp.DropParts(
    ids=("tool-result:42",),
    reason="historical useless result exceeds the projection budget",
)
assert drop_parts.ids == ("tool-result:42",)
assert drop_parts.reason.startswith("historical")
assert omp.DropParts.__dataclass_params__.frozen
assert tuple(field.name for field in dataclasses.fields(omp.DropParts)) == (
    "ids",
    "reason",
)
assert typing.get_type_hints(omp.ContextPatch)["drop_parts"] == list[omp.DropParts]
drop_patch = omp.ContextPatch()
assert drop_patch.is_empty()
drop_patch.drop_parts.append(drop_parts)
combined_patch = omp.ContextPatch(
    prune=[omp.Prune(ids=("stale-message",))],
    replace=[
        omp.Replace(
            ids=("verbose-message",),
            parts=(omp.Part.text("summary"),),
        )
    ],
).merge(drop_patch)
assert combined_patch.drop_parts == [drop_parts]
assert not combined_patch.is_empty()

# Hard-quota faults retain the quota identity and atomic receipt snapshot.
quota_receipt = omp.resources()
quota_error = omp.QuotaExceeded(
	quota="extension.callbacks",
	receipt=quota_receipt,
)
assert quota_error.quota == "extension.callbacks"
assert quota_error.receipt is quota_receipt
assert "extension.callbacks" in str(quota_error)
assert issubclass(omp.QuotaExceeded, omp.OmpError)
assert "QuotaExceeded" in omp.__all__

# Journal failures preserve their documented family and partial-append detail.
journal_entry_id = omp.EntryId(session="session-1", index=7)
journal_error = omp.JournalError(
    "only a prefix was appended",
    appended=[journal_entry_id],
)
assert omp.JournalError is omp.journal.JournalError
assert issubclass(omp.JournalError, omp.OmpError)
assert issubclass(omp.StateScopeDenied, omp.JournalError)
assert str(journal_error) == "only a prefix was appended"
assert journal_error.appended == [journal_entry_id]
assert "JournalError" in omp.__all__
assert "JournalError" in omp.journal.__all__

# FREEZE evaluates deferred availability exactly once and seals the projection.
snapshot = registry_module.freeze_declarations()
assert snapshot.directors[0].id == "continue-once"
assert snapshot.components[0].id == "ext-state"
expect_raises(
    omp.DeclarationSealed,
    lambda: omp.director("late-director")(lambda: None),
)
assert bare_definition in snapshot.providers
assert ("surface_device/inspect/detail", "", 1) in snapshot.tools
assert ("surface_device/inspect/annotated", "surface-routes", 1) in snapshot.tools
assert ("surface_device/mounted/status/detail", "", 1) in snapshot.tools
child_definitions = {
    child.path: child.definition for child in snapshot.child_device_definitions
}
bare_child = child_definitions["inspect/detail"]
assert bare_child.place == omp.Place.HOST
assert bare_child.family == surface_device.family
assert bare_child.precedence == surface_device.precedence
assert bare_child.tier == omp.Tier.WRITE
assert bare_child.effects is None
overridden_child = child_definitions["inspect/annotated"]
assert overridden_child.place == omp.Place.ENV
assert overridden_child.family == "surface-routes"
assert overridden_child.precedence == omp.Precedence.ENHANCEMENT
assert overridden_child.tier == omp.Tier.READ
assert overridden_child.effects is surface_route_effects
assert overridden_child.docs == "Annotated child documentation."
assert overridden_child.summary == "Inspect annotated input."
(route_count_spec,) = overridden_child.arg_specs
assert route_count_spec.path == ("count",)
assert route_count_spec.aliases == ("routeCount",)
assert route_count_spec.expected == "a route count"
assert route_count_spec.description == "Number of routes to inspect."
mounted_child = child_definitions["mounted/status/detail"]
assert mounted_child.family == surface_device.family
assert mounted_child.place == omp.Place.HOST
assert mounted_child.tier == omp.Tier.WRITE
assert str(mounted_surface_status_device.path) == (
    "surface_device/mounted/status/detail"
)
assert mounted_child.body is mounted_surface_status
expect_raises(omp.DeclarationSealed, lambda: surface_device.mount(late_router))
assert shortcut_definition in snapshot.shortcuts
assert approver_definition in snapshot.approvers
assert availability_calls == 1
assert surface_device.mounted
assert not offline_device.mounted
device_states = {
    key: (mounted, reason) for key, mounted, reason in snapshot.device_states
}
assert device_states[("offline_device", "", 1)] == (False, "offline")
argument_specs = dict(snapshot.arg_specs)
(count_spec,) = argument_specs[("arg_metadata_device", "arg-contract", 3)]
assert count_spec.path == ("count",)
assert count_spec.aliases == ("issueCount",)
assert count_spec.coerce == (omp.Coerce.INTEGER, omp.Coerce.STRIP)
assert count_spec.expected == "a positive integer" and count_spec.example == "3"
assert count_spec.description == "Requested issue count."
assert not count_spec.additional_properties
assert registry_module.registry.arg_specs(
    "arg_metadata_device", "arg-contract", 3
) == (count_spec,)
"#
				),
				None,
				None,
			)
		})
		.expect("frozen omp surface contract");
}
