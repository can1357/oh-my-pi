OMP-native repository security scans: plan, start, inspect, cancel, validate.
`preflight`: immutable plan pinned to repository snapshot, model, exact OAuth credential.
`start`: plan → background OMP job.
`status`, `cancel`: returned operation ID.
`cloud_scans`: Codex Security cloud configurations for exact selected ChatGPT OAuth account.
`cloud_start`: creates/enables configuration using `repository_id`, `repository_url`, `environment_id`; consumes account's separate Codex Security cloud allowance; NEVER native-scan fallback.
`cloud_status`: cloud progress.
`cloud_pull`: cloud findings → canonical OMP security store, available through `security://`.
Cloud actions: `cloud_configuration_id` required; `credential_id` MAY pin account.
Security MUST be enabled in settings.
