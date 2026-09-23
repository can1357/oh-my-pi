# Release {{release.tag}} still failing

New CI verdict for `{{release.tag}}`: still failing, round **{{release.round}}/{{release.max_rounds}}**, current release SHA `{{release.head_sha}}`.
Continue in the existing `{{release.default_branch}}` workspace at `{{workspace.repo_dir}}`.

## Current failure dossier

{{release.failures_text}}

## Workflow runs

{{release.run_urls}}

Re-evaluate against this failure set, fix the root cause, verify locally, and commit with the mandated release subject. Call `release_retag`, then end the turn. If this is a crash-resumed round, inspect the worktree and prior transcript before changing anything. If only a human can resolve the failure, call `abort_task` with the concrete diagnosis.
