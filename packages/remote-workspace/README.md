# @pk-nerdsaver-ai/pi-remote-workspace

Phase-1 library and CLI for recording and running **local isolated Docker workspace jobs**. It is a standalone package; it is not yet integrated with the top-level `omp` CLI.

## Local sandbox vs cloud mesh SoT

This package is **not** the mesh orchestrator.

| Concern | Source of truth |
| --- | --- |
| Local Docker sandbox jobs (`ompk-remote run`, `MsiDockerBackend`) | This package |
| Mesh / cloud / auth / codespace-style launch | **environments-cloud (pkscloudenvs)** |

**MSI-local canonical root:** `C:\dev\desktop-infra\environments-cloud`  
Upstream: [kingkillery/pkscloudenvs](https://github.com/kingkillery/pkscloudenvs). Override with `OMPK_ENVIRONMENTS_CLOUD_ROOT` (or `PKS_ENVIRONMENTS_CLOUD_ROOT`).

```sh
bun src/cli.ts environments
bun src/cli.ts environments skill mesh-orchestrator
bun src/cli.ts environments handoff mesh status
bun src/cli.ts environments handoff cloud status
```

```ts
import {
	resolveEnvironmentsCloudRoot,
	resolveEnvironmentsCloudSkill,
	resolveMeshHandoff,
	environmentsCloudSkillCustomDirectories,
} from "@pk-nerdsaver-ai/pi-remote-workspace";
```

Coding-agent auto-includes `{root}/.agents/skills` when present. See `docs/environments-cloud.md` and `.wiki/concepts/environments-cloud-routing.md`.

## Requirements

- Bun 1.3.14 or later
- Docker CLI with a reachable Docker daemon (for phase-1 local jobs only)
- The local `oh-my-pi/pi:dev` worker image

Check the backend before use:

```sh
bun src/cli.ts doctor
```

`doctor` reports whether Docker is reachable and whether the worker image exists locally. The job database defaults to `~/.ompk/remote-jobs.sqlite`; set `OMPK_REMOTE_DB` to use another path.

## CLI

From this package directory, run:

```sh
bun src/cli.ts doctor
bun src/cli.ts run <repo-url> [ref] [prompt...]
bun src/cli.ts status [job-id]
bun src/cli.ts cancel <job-id>
bun src/cli.ts list
bun src/cli.ts environments
bun src/cli.ts environments skill mesh-orchestrator
bun src/cli.ts environments handoff mesh status
bun src/cli.ts cloud
```

`run` records a job, runs it synchronously, and prints its logs, patch (when available), and cleanup proof. `status` without an ID lists all stored jobs; `list` is an alias. Installed packages expose the same commands through the `ompk-remote` binary.

## Library use

The public API exports the backend contracts, durable job types, Docker backend, and orchestrator:

```ts
import { MsiDockerBackend, RemoteWorkspaceOrchestrator } from "@pk-nerdsaver-ai/pi-remote-workspace";

const backend = new MsiDockerBackend({
	restrictedNetworkName: "ompk-restricted-egress",
	allowedRepoHosts: ["github.com"],
});

const orchestrator = new RemoteWorkspaceOrchestrator({
	dbPath: "/path/to/remote-jobs.sqlite",
	backend,
	networkEgress: "restricted",
});

const job = orchestrator.submit({
	source: { repoUrl: "https://github.com/example/repo.git", ref: "main" },
	task: {
		prompt: "Inspect the repository",
		validationCommands: ["echo ok"],
		resultMode: "none",
	},
});

try {
	const result = await orchestrator.run(job.id);
	console.log(result);
} finally {
	orchestrator.close();
}
```

The current backend creates a per-job container and volume, labels managed resources, runs as a non-root user with CPU, memory, and PID limits, and removes the resources during cleanup.

Remote cloning is disabled by default. To enable it, configure `networkEgress: "restricted"`, an externally managed restricted-egress Docker network, and an allowlist containing the credential-free HTTPS repository host. The backend rejects launch when any of those conditions is absent or the repository host is not allowlisted.

## Current limitations

- Only the local `msi-docker` backend is implemented. Cloud mesh orchestration, auth, and multi-node launch stay in environments-cloud (pkscloudenvs); this package only resolves and documents handoff to those entrypoints.
- Remote cloning is disabled by default. The CLI does not expose restricted-egress network or repository-host configuration, so its `run` command fails safely before launching a clone job.
- The worker only clones a repository, prints the supplied prompt, and runs the supplied validation commands. It does not invoke an Oh My Pi agent, publish branches or pull requests, or provision credentials.
- The CLI always uses `echo ok` as its validation command and has no flags for resource limits, image choice, or result mode.
- Custom environment variables and secret injection are unsupported until a secure injection path exists.
- The package does not create or enforce the restricted-egress Docker network; its operator must configure that network to allow only the intended repository traffic.
- `cancel` terminates an active worker and records cleanup proof when managed runtime resources exist.
- The library API is for a trusted local operator. `validationCommands` are intentional shell commands inside the sandbox; there is no multi-user authentication or authorization layer.
- Cleanup is guaranteed for handled success, failure, timeout, and cancellation paths. A host-process crash can leave labeled Docker resources behind; automatic startup reconciliation/reaping is not implemented yet.
- The SQLite job database stores task prompts and is restricted to the owner (`0600`) on POSIX. Windows access follows the containing directory ACL.

## Development commands

```sh
bun run check
bun run check:types
bun run lint
bun run test
```
