# @pk-nerdsaver-ai/pi-remote-workspace

Phase-1 library and CLI for recording and running isolated Docker workspace jobs. It is a standalone package; it is not yet integrated with the top-level `omp` CLI.

## Requirements

- Bun 1.3.14 or later
- Docker CLI with a reachable Docker daemon
- The local `oh-my-pi/pi:dev` worker image

Check the backend before use:

```sh
bun run src/cli.ts doctor
```

`doctor` reports whether Docker is reachable and whether the worker image exists locally. The job database defaults to `~/.omp/remote-jobs.sqlite`; set `OMPK_REMOTE_DB` to use another path.

## CLI

From this package directory, run:

```sh
bun run src/cli.ts doctor
bun run src/cli.ts run <repo-url> [ref] [prompt...]
bun run src/cli.ts status [job-id]
bun run src/cli.ts cancel <job-id>
bun run src/cli.ts list
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

- Only the local `msi-docker` backend is implemented; there is no remote-host, cloud, or backend-selection integration.
- Remote cloning is disabled by default. The CLI does not expose restricted-egress network or repository-host configuration, so its `run` command fails safely before launching a clone job.
- The worker only clones a repository, prints the supplied prompt, and runs the supplied validation commands. It does not invoke an Oh My Pi agent, publish branches or pull requests, or provision credentials.
- The CLI always uses `echo ok` as its validation command and has no flags for resource limits, image choice, or result mode.
- Custom environment variables and secret injection are unsupported until a secure injection path exists.
- The package does not create or enforce the restricted-egress Docker network; its operator must configure that network to allow only the intended repository traffic.
- `cancel` terminates an active worker and records cleanup proof when managed runtime resources exist.

## Development commands

```sh
bun run check
bun run check:types
bun run lint
bun run test
```
