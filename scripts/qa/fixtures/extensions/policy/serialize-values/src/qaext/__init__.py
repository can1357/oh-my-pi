import dataclasses
import json
import omp


@omp.tool(kind="hard")
async def hello() -> str:
    profile = omp.policy.SandboxProfile(
        mode=omp.policy.SandboxMode.ENFORCE,
        filesystem=omp.policy.FilesystemPolicy(
            allow_read=(omp.policy.PathRule("/workspace", recursive=True),),
            deny_write=(omp.policy.PathRule("/workspace/.git", delete=True),),
        ),
        network=omp.policy.NetworkPolicy(
            mode=omp.policy.NetworkMode.PROXY,
            allow_domains=(omp.policy.DomainRule("api.example.com", ports=(443,)),),
        ),
        exec=omp.policy.ExecPolicy(deny=("sudo",), max_children=4),
        resources=omp.policy.ResourceBudget(memory_bytes=1048576, processes=4),
        label="qa-policy",
        require=(omp.policy.SandboxBackend.SEATBELT,),
    )
    approval = omp.ApprovalSpec(
        title="Run command",
        body="Review command",
        subject="echo one",
        kind=omp.ApprovalKind.EXEC,
        evidence=("qa-rule",),
    )
    decision = omp.policy.ApprovalDecision(
        approved=True,
        scope=omp.PolicyScope.ONCE,
        source=omp.policy.ApprovalSource.EXTENSION,
        decided_by="qa-policy",
        reason="representative decision",
        audited=False,
    )
    encoded = {
        "profile": dataclasses.asdict(profile),
        "approval": {
            "title": approval.title,
            "body": approval.body,
            "subject": approval.subject,
            "kind": approval.kind.value,
            "scopes": [scope.value for scope in approval.scopes],
            "timeout": str(approval.timeout),
            "evidence": list(approval.evidence),
        },
        "decision": {
            "approved": decision.approved,
            "scope": decision.scope.value,
            "source": decision.source.value,
            "decided_by": decision.decided_by,
            "reason": decision.reason,
            "audited": decision.audited,
        },
    }
    return json.dumps(encoded, default=str, sort_keys=True)
