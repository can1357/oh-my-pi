# Repair release {{release.tag}} in {{repo.full_name}}

Round **{{release.round}}/{{release.max_rounds}}** failed at `{{release.head_sha}}`.
The `{{release.default_branch}}` workspace at `{{workspace.repo_dir}}` starts from that release SHA.

## Failure dossier

{{release.failures_text}}

## Workflow runs

{{release.run_urls}}

Diagnose the root cause, fix it, verify locally, and commit the fix with the mandated release subject. Then call `release_retag` with a concise summary and end the turn. If the failure requires human-only infrastructure, secrets, permissions, or runner intervention, call `abort_task` with the diagnosis.
