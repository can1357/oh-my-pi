import dataclasses
import json
import omp
import omp.events as events
import omp.hooks as hooks


@omp.tool(kind="hard")
async def hello() -> str:
    core = hooks.CoreTool(name="bash", rev="1", args={"command": "true"})
    device = hooks.DeviceCall(name="search", family="qa", rev="1", args={"q": "needle"})
    mcp = hooks.McpCall(server="local", tool="lookup", args={"id": 7})
    allow = hooks.Allow("reviewed")
    deny = hooks.Deny("blocked", fatal=False, code="qa_block")
    modify = hooks.Modify(target=core, patch={"command": "printf changed"}, reason="normalized")
    defer = hooks.Defer("not-applicable")
    approval_spec = hooks.ApprovalSpec(
        title="Approve command",
        body="Run the reviewed command",
        subject="printf changed",
        kind=hooks.ApprovalKind.EXEC,
        scopes=(hooks.PolicyScope.ONCE,),
        route=hooks.ApprovalRoute.AUTO,
        unreachable=hooks.Unreachable.FAIL_CLOSED,
    )
    approval = hooks.RequireApproval(approval_spec)

    assert dataclasses.asdict(allow) == {"reason": "reviewed"}
    assert dataclasses.asdict(deny) == {"reason": "blocked", "fatal": False, "code": "qa_block"}
    assert dataclasses.asdict(defer) == {"note": "not-applicable"}
    assert modify.target is core and modify.args is None
    assert modify.patch == {"command": "printf changed"}
    assert approval.spec is approval_spec
    assert approval_spec.title == "Approve command"
    assert core.kind is hooks.TargetKind.CORE
    assert device.kind is hooks.TargetKind.DEVICE
    assert mcp.kind is hooks.TargetKind.MCP
    assert hooks.UNSET is not None

    wire = {
        "allow": {"reason": allow.reason},
        "deny": {"reason": deny.reason, "fatal": deny.fatal, "code": deny.code},
        "modify": {
            "target": {"kind": core.kind.value, "name": core.name, "rev": core.rev, "args": dict(core.args)},
            "args": modify.args,
            "patch": dict(modify.patch),
            "reason": modify.reason,
        },
        "defer": {"note": defer.note},
        "require_approval": {
            "spec": {
                "title": approval.spec.title,
                "body": approval.spec.body,
                "subject": approval.spec.subject,
                "kind": approval.spec.kind.value,
                "scopes": [scope.value for scope in approval.spec.scopes],
                "route": approval.spec.route.value,
                "unreachable": approval.spec.unreachable.value,
            }
        },
        "targets": [
            {"kind": core.kind.value, "name": core.name},
            {"kind": device.kind.value, "name": device.name, "family": device.family},
            {"kind": mcp.kind.value, "server": mcp.server, "tool": mcp.tool},
        ],
    }
    encoded = json.loads(json.dumps(wire))
    assert encoded["deny"] == {"reason": "blocked", "fatal": False, "code": "qa_block"}
    assert encoded["modify"]["target"]["kind"] == "core"
    assert encoded["require_approval"]["spec"]["scopes"] == ["once"]

    when = hooks.When(
        target=frozenset({hooks.TargetKind.CORE}),
        name=frozenset({"bash"}),
        origin=frozenset({hooks.CallOrigin.MODEL}),
        once=True,
    )
    assert when.once and "bash" in when.name
    assert hooks.Channel.CONTROL.value == "control"
    assert hooks.Composition.REPLACE.value == "replace"
    assert hooks.HookPhase.TRANSFORM.value == "transform"
    assert hooks.OnFailure.DENY.value == "deny"
    assert hooks.LatencyClass.CALL.value == "call"
    assert hooks.DEFAULT_HOOK_TIMEOUT is not None
    assert hooks.APPROVAL_DEADLINE is not None
    assert callable(hooks.hook) and callable(hooks.dispatch_hook)
    assert hooks.HookDecision is not None and hooks.CallTarget is not None
    for error in (
        hooks.HookContractError,
        hooks.HostShuttingDown,
        hooks.LateRegistration,
        hooks.PhaseConflict,
        hooks.ReentrancyError,
        hooks.UnknownEvent,
    ):
        assert isinstance(error("qa"), Exception)

    event_ids = dict(events.EVENT_IDS)
    tool_spec = events.spec("tool_call")
    all_specs = tuple(events.specs())
    default = events.default_decision("tool_call")
    fields = dict(events.field_composition("tool_call"))
    assert event_ids["tool_call"] == tool_spec.id
    assert all_specs and [row.id for row in all_specs] == sorted(row.id for row in all_specs)
    assert default in (hooks.Allow, hooks.Deny)
    assert fields == dict(tool_spec.fields)

    return "hooks-decisions-ok"
