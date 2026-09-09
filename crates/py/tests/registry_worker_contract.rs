//! Focused proof that sealed decorator declarations reach the CONTROL
//! projection.

use omp_py::{Engine, pyo3::ffi::c_str};

#[test]
fn decorated_tools_project_as_runnable_control_declarations() {
	let engine = Engine::builder().init().expect("embedded Python boots");
	engine
		.attach(|py| {
			py.run(
				c_str!(
					r#"
import asyncio
import dataclasses
import enum

import omp
import omp._registry as registry_module

omp.packages._install_snapshot(
    [{
        "name": "registry-contract",
        "version": "1.0.0",
        "extension_id": "registry-contract",
        "root": "/registry-contract",
        "files": (),
    }],
    own="registry-contract",
)
skill_metadata = {
    "name": "review",
    "description": "Review a change.",
    "hidden": False,
    "disable_model_invocation": False,
    "autoload": False,
}
registry_module.configure_manifest(
    extension="registry-contract",
    tools=(
        ("contract_device", "wire", 7),
        ("contract_tool", "registry-contract", 3),
    ),
    services=(("acme.contract", 2),),
    declarations=(
        {
            "kind": "skills",
            "path": "extension/.omp-generated/skills/review/SKILL.md",
            "metadata": skill_metadata,
        },
        {
            "id": "contract-device",
            "kind": "soft",
            "module": "__main__",
            "key": "contract_device@wire.7",
            "trigger": "lazy",
            "api": 1,
            "failure": "fault",
        },
        {
            "id": "contract-tool",
            "kind": "hard",
            "module": "__main__",
            "key": "contract_tool@registry-contract.3",
            "trigger": "lazy",
            "api": 1,
            "failure": "fault",
        },
        {
            "id": "contract-service",
            "kind": "service",
            "module": "__main__",
            "key": "acme.contract",
            "trigger": "lazy",
            "api": 1,
            "failure": "fault",
        },
        {
            "id": "contract-renderer",
            "kind": "verdict_renderer",
            "module": "__main__",
            "key": "contract_device@wire.7",
            "trigger": "lazy",
            "api": 1,
            "failure": "fail-open",
        },
        {
            "id": "contract-memory",
            "kind": "prompt_slot",
            "module": "__main__",
            "key": "memory",
            "trigger": "eager-prompt",
            "api": 1,
            "failure": "fail-closed",
        },
    ),
)
skill_evaluations = 0
lowering_evaluations = 0


def deterministic_skill():
    global lowering_evaluations
    lowering_evaluations += 1
    return "Review\n\nInspect the change."


lowering_args = {
    "name": "review",
    "description": "Review a change.",
    "hidden": False,
    "disable_model_invocation": False,
    "autoload": False,
    "contain_root": None,
}
first_lowering = registry_module._lower_skill_declaration(
    deterministic_skill, **lowering_args
)
second_lowering = registry_module._lower_skill_declaration(
    deterministic_skill, **lowering_args
)
assert first_lowering == second_lowering
assert lowering_evaluations == 2
try:
    registry_module._lower_skill_declaration(
        lambda: "x" * 64_000,
        name="oversized",
        description="Oversized.",
        hidden=False,
        disable_model_invocation=False,
        autoload=False,
        contain_root=None,
    )
except ValueError:
    pass
else:
    raise AssertionError("oversized generated skill was accepted")


@omp.skill("review", description="Review a change.")
def review_skill():
    global skill_evaluations
    skill_evaluations += 1
    return "Review\n\nInspect the change."


assert skill_evaluations == 1


@omp.device(
    "contract_device",
    family="wire",
    rev=7,
    summary="Run the decorated contract device.",
    schema={
        "type": "object",
        "properties": {"value": {"type": "integer"}},
        "required": ["value"],
        "additionalProperties": False,
    },
)
async def contract_device(args, ctx):
    return {"details": {"value": args["value"], "has_context": ctx is marker}}


@omp.tool(
    "contract_tool",
    kind="hard",
    rev=3,
    constraint=omp.ToolConstraint.grammar(
        omp.GrammarSyntax.REGEX,
        r"[0-9]+",
        priority=77,
        on_unsupported=omp.ConstraintFallback.ERROR,
    ),
    serial=True,
)
async def contract_tool(count: int, ctx: omp.Context):
    ctx.update({"count": count})
    yield omp.Update({"streamed": count})
    yield omp.Done({"details": {"count": count}})


def reduce_contract_renderer(acc, update):
    return (acc or 0) + update["value"]


@omp.renderer(
    "contract_device",
    family="wire",
    rev=7,
    reduce=reduce_contract_renderer,
    decorates=True,
)
def render_contract_device(view, ctx):
    return omp.ui.text(str(view.state))


@omp.service("acme.contract", rev=2)
class ContractService:
    async def ping(self, value: int) -> dict[str, int]:
        return {"value": value}


@omp.prompt_slot("memory", priority=4, cls=omp.SlotClass.EPOCHAL)
def contract_memory(context):
    return f"{context.session_id}:{context.cls.value}"


class Marker:
    def __init__(self):
        self.updates = []

    def update(self, value):
        self.updates.append(value)


marker = Marker()
snapshot = registry_module.freeze_declarations()
tools = registry_module.registry.worker_tool_definitions()
publication = registry_module.project_control_registry()
assert skill_evaluations == 1
assert len(snapshot.skills) == 1
assert snapshot.skills[0].declaration.path == (
    "extension/.omp-generated/skills/review/SKILL.md"
)
assert snapshot.skills[0].content == (
    b"---\nname: review\ndescription: 'Review a change.'\n---\n\n"
    b"Review\n\nInspect the change.\n"
)
try:
    omp.skill("late", description="late")(lambda: "late")
except omp.DeclarationSealed:
    pass
else:
    raise AssertionError("late @omp.skill declaration was accepted")
assert snapshot.tools == frozenset({
    ("contract_device", "wire", 7),
    ("contract_tool", "registry-contract", 3),
})
assert [(tool.name, tool.family, tool.rev) for tool in tools] == [
    ("contract_device", "wire", 7),
    ("contract_tool", "registry-contract", 3),
]

device_row, tool_row = tools
assert device_row.description == "Run the decorated contract device."
assert device_row.schema["properties"]["value"] == {"type": "integer"}
assert device_row.strict is None
assert tool_row.kind == "hard"
assert tool_row.strict is True
assert tool_row.serial is True
assert tool_row.constraint == omp.ToolConstraint.grammar(
    omp.GrammarSyntax.REGEX,
    r"[0-9]+",
    priority=77,
    on_unsupported=omp.ConstraintFallback.ERROR,
)
assert tool_row.schema == {
    "type": "object",
    "properties": {"count": {"type": "integer"}},
    "additionalProperties": False,
    "required": ["count"],
}
assert asyncio.run(device_row.handler({"value": 11}, marker)) == {
    "details": {"value": 11, "has_context": True}
}
assert asyncio.run(tool_row.handler({"count": 4}, marker)) == {
    "updates": [{"streamed": 4}],
    "details": {"count": 4}
}
assert marker.updates == [{"count": 4}]

metadata = publication
assert metadata["skills"] == [{
    "metadata": skill_metadata,
    "path": "extension/.omp-generated/skills/review/SKILL.md",
}]
assert metadata["tools"][0]["rev"] == 7
assert metadata["prompt_slots"] == [{
    "slot": "memory",
    "priority": 4,
    "class": "epochal",
    "callback": {"$omp.callable": "__main__.contract_memory"},
    "trigger": "eager-prompt",
}]
prompt_result = registry_module.dispatch_prompt_slot(
    "memory",
    "__main__.contract_memory",
    {
        "session_id": "session",
        "model": "model",
        "provider": "provider",
        "context_window": 32000,
        "epoch": 3,
        "cwd": "/workspace",
        "roots": ["/workspace"],
        "vcs_branch": "main",
        "vcs_commit": None,
        "is_subagent": False,
        "agent_kind": None,
        "cls": "epochal",
        "budget_bytes": 1024,
    },
)
assert prompt_result == {
    "slot": "memory",
    "callback": "__main__.contract_memory",
    "content": "session:epochal",
}
assert metadata["verdict_renderers"] == [{
    "kind": "verdict_renderer",
    "name": ["contract_device", "wire", 7],
    "metadata": None,
    "trigger": "lazy",
    "value": {
        "decorates": True,
        "function": {"$omp.callable": "__main__.render_contract_device"},
        "reduce": {"$omp.callable": "__main__.reduce_contract_renderer"},
    },
}]
assert metadata["services"] == [{
    "methods": [{
        "input_schema": {
            "additionalProperties": False,
            "properties": {"value": {"type": "integer"}},
            "required": ["value"],
            "type": "object",
        },
        "name": "ping",
        "result_schema": {
            "additionalProperties": {"type": "integer"},
            "type": "object",
        },
    }],
    "name": "acme.contract",
    "rev": 2,
    "source_module": "__main__",
    "callback": {"operation": "omp.services.dispatch"},
}]
class ContractKind(enum.Enum):
    OK = "ok"


@dataclasses.dataclass(frozen=True)
class ContractResult:
    kind: ContractKind
    count: int


assert registry_module.service_json_value(ContractResult(ContractKind.OK, 2)) == {
    "$omp.type": "__main__.ContractResult",
    "$omp.fields": {
        "kind": {"$omp.enum": "__main__.ContractKind", "value": "ok"},
        "count": 2,
    },
}
try:
    registry_module.service_json_value(object())
except TypeError:
    pass
else:
    raise AssertionError("unsupported service result was silently stringified")

# Manifest drift seals the candidate and rejects it before any projection can run.
drift = registry_module.DeclarationRegistry()
drift.configure_manifest(tools=(("manifest_only", "", 1),))
drift.register_tool("decorator_only", "", 1, lambda args: args)
try:
    drift.freeze()
except omp.DeclarationDrift as error:
    assert error.missing_tools == frozenset({("manifest_only", "", 1)})
    assert error.undeclared_tools == frozenset({("decorator_only", "", 1)})
else:
    raise AssertionError("manifest drift activated")
"#
				),
				None,
				None,
			)
		})
		.expect("registry CONTROL contract");
}
