import { afterEach, describe, expect, it } from "bun:test";
import { TempDir } from "@pk-nerdsaver-ai/pi-utils";
import type {
	BackendCapabilities,
	BackendEstimate,
	BackendReadiness,
	CleanupResult,
	ConnectionInfo,
	DockerCommandResult,
	DockerCommandRunner,
	ExecutionBackend,
	ExecutionControl,
	RuntimeHandle,
	RuntimeStatusResult,
	SubmitJobInput,
	WorkspaceArtifacts,
	WorkspaceLaunchSpec,
} from "../src";
import {
	createJob,
	JobStore,
	MsiDockerBackend,
	parseDockerWaitExitCode,
	RemoteWorkspaceOrchestrator,
	registerResource,
	transition,
} from "../src";

const CAPABILITIES: BackendCapabilities = Object.freeze({
	interactiveShell: false,
	browserIDE: false,
	persistentVolume: true,
	fullPauseResume: false,
	docker: false,
	nestedVirtualization: false,
	gpu: false,
	longRunning: false,
	publicPreviewPorts: false,
	privateNetworking: false,
	windows: false,
	linux: true,
	arm64: false,
});

const SUCCESSFUL_ARTIFACTS: WorkspaceArtifacts = Object.freeze({
	logs: "agent completed\nvalidation passed",
	patch: "diff --git a/src/example.ts b/src/example.ts\n",
	exitCode: 0,
	changedFiles: Object.freeze(["src/example.ts"]),
	durationMs: 125,
});

const SUCCESSFUL_CLEANUP: CleanupResult = Object.freeze({
	containerGone: true,
	volumeGone: true,
	networkGone: true,
	workspaceDirGone: true,
	credentialRevoked: true,
	errors: Object.freeze([]),
});

interface FakeBackendOptions {
	readonly artifacts?: WorkspaceArtifacts;
	readonly cleanupResult?: CleanupResult;
	readonly launchError?: Error;
	readonly collectBarrier?: Promise<void>;
	readonly collectDelayMs?: number;
	readonly collectError?: Error;
}

class FakeExecutionBackend implements ExecutionBackend {
	readonly id = "fake-execution-backend";
	readonly capabilities = CAPABILITIES;
	readonly calls: string[] = [];
	lastLaunchSpec: WorkspaceLaunchSpec | undefined;
	lastExecutionControl: ExecutionControl | undefined;
	readonly #artifacts: WorkspaceArtifacts;
	readonly #cleanupResult: CleanupResult;
	readonly #launchError: Error | undefined;
	readonly #collectDelayMs: number;
	readonly #collectError: Error | undefined;
	readonly #collectBarrier: Promise<void> | undefined;
	#resolveCollectionStarted: (() => void) | undefined;
	readonly collectionStarted: Promise<void>;

	constructor(options: FakeBackendOptions = {}) {
		this.#artifacts = options.artifacts ?? SUCCESSFUL_ARTIFACTS;
		this.#cleanupResult = options.cleanupResult ?? SUCCESSFUL_CLEANUP;
		this.#launchError = options.launchError;
		this.#collectDelayMs = options.collectDelayMs ?? 0;
		this.#collectError = options.collectError;
		this.#collectBarrier = options.collectBarrier;
		this.collectionStarted = new Promise(resolve => {
			this.#resolveCollectionStarted = () => resolve();
		});
	}

	async probe(): Promise<BackendReadiness> {
		return {
			backendId: this.id,
			status: "ready",
			checkedAt: "2026-01-01T00:00:00.000Z",
			issues: [],
			capabilities: this.capabilities,
		};
	}

	async estimate(_spec: WorkspaceLaunchSpec): Promise<BackendEstimate> {
		return { backendId: this.id, estimatedStartMs: 1 };
	}

	async launch(spec: WorkspaceLaunchSpec): Promise<RuntimeHandle> {
		this.calls.push("launch");
		this.lastLaunchSpec = spec;
		if (this.#launchError) throw this.#launchError;
		return {
			backendId: this.id,
			jobId: spec.jobId,
			workerId: "worker-1",
			startedAt: "2026-01-01T00:00:00.000Z",
			metadata: Object.freeze({
				containerName: `container-${spec.jobId}`,
				volumeName: `volume-${spec.jobId}`,
				networkName: `network-${spec.jobId}`,
			}),
		};
	}

	async collectArtifacts(_runtime: RuntimeHandle, control?: ExecutionControl): Promise<WorkspaceArtifacts> {
		this.lastExecutionControl = control;
		this.calls.push("collectArtifacts");
		this.#resolveCollectionStarted?.();
		if (this.#collectBarrier) await this.#collectBarrier;
		if (this.#collectError) throw this.#collectError;
		if (this.#collectDelayMs > 0) await Bun.sleep(this.#collectDelayMs);
		return this.#artifacts;
	}

	async status(_runtime: RuntimeHandle): Promise<RuntimeStatusResult> {
		return { status: "running", checkedAt: "2026-01-01T00:00:00.000Z" };
	}

	async connect(_runtime: RuntimeHandle): Promise<ConnectionInfo> {
		return { notes: "fake backend" };
	}

	async terminate(_runtime: RuntimeHandle): Promise<void> {
		this.calls.push("terminate");
	}

	async cleanup(_runtime: RuntimeHandle): Promise<CleanupResult> {
		this.calls.push("cleanup");
		return this.#cleanupResult;
	}
}

interface Fixture {
	readonly tempDir: TempDir;
	readonly dbPath: string;
	readonly backend: FakeExecutionBackend;
	readonly orchestrator: RemoteWorkspaceOrchestrator;
	closed: boolean;
}

let fixtures: Fixture[] = [];

afterEach(() => {
	for (const fixture of fixtures) {
		if (!fixture.closed) fixture.orchestrator.close();
		fixture.tempDir.removeSync();
	}
	fixtures = [];
});

function createFixture(options: FakeBackendOptions = {}): Fixture {
	const tempDir = TempDir.createSync("@remote-workspace-contract-");
	const backend = new FakeExecutionBackend(options);
	const fixture: Fixture = {
		tempDir,
		dbPath: tempDir.join("jobs.sqlite"),
		backend,
		orchestrator: new RemoteWorkspaceOrchestrator({
			dbPath: tempDir.join("jobs.sqlite"),
			backend,
		}),
		closed: false,
	};

	fixtures.push(fixture);
	return fixture;
}

function submitInput(validationCommands: readonly string[] = ["bun test"], timeoutMs = 5_000): SubmitJobInput {
	return {
		source: { repoUrl: "https://example.test/acme/repo.git", ref: "main" },
		task: {
			prompt: "Make the requested change",
			validationCommands,
			resultMode: "patch",
		},
		limits: { timeoutMs },
	};
}

interface TestLatch {
	readonly promise: Promise<void>;
	release(): void;
}

function createLatch(): TestLatch {
	let resolve: (() => void) | undefined;
	const promise = new Promise<void>(complete => {
		resolve = complete;
	});
	return {
		promise,
		release() {
			resolve?.();
		},
	};
}

function dockerCommandResult(stdout: string, code = 0, stderr = ""): DockerCommandResult {
	return { stdout, stderr, code };
}

function encodeArtifact(value: string): string {
	return Buffer.from(value, "utf8").toString("base64");
}

function dockerArtifactOutput(input: {
	readonly patch: string;
	readonly changedFiles: readonly string[];
	readonly agentExitCode: number;
	readonly validationExitCode: number;
}): string {
	return [
		`patch=${encodeArtifact(input.patch)}`,
		`changed-files=${encodeArtifact(`${input.changedFiles.join("\n")}\n`)}`,
		`agent-exit-code=${encodeArtifact(`${input.agentExitCode}\n`)}`,
		`validation-exit-code=${encodeArtifact(`${input.validationExitCode}\n`)}`,
	].join("\n");
}

function dockerRuntime(): RuntimeHandle {
	return Object.freeze({
		backendId: "msi-docker",
		jobId: "job-docker-contract",
		workerId: "worker-docker-contract",
		startedAt: "2026-01-01T00:00:00.000Z",
		metadata: Object.freeze({
			containerName: "container-docker-contract",
			volumeName: "volume-docker-contract",
			image: "example.test/worker:latest",
		}),
	});
}

describe("RemoteWorkspaceOrchestrator execution backend contract", () => {
	it("rejects credential-bearing and non-HTTPS repository URLs before persistence", () => {
		const fixture = createFixture();
		for (const repoUrl of ["http://example.test/acme/repo.git", "https://token:secret@example.test/acme/repo.git"]) {
			expect(() => fixture.orchestrator.submit({ ...submitInput(), source: { repoUrl, ref: "main" } })).toThrow();
		}
		expect(fixture.orchestrator.listJobs()).toEqual([]);
	});

	it("assigns distinct IDs to identical immediate submissions", () => {
		const fixture = createFixture();
		const first = fixture.orchestrator.submit(submitInput());
		const second = fixture.orchestrator.submit(submitInput());

		expect(first.id).not.toBe(second.id);
		expect(fixture.orchestrator.listJobs().map(job => job.id)).toEqual(expect.arrayContaining([first.id, second.id]));
	});

	it("runs a successful job through cleanup and persists its durable lifecycle", async () => {
		const fixture = createFixture();
		const job = fixture.orchestrator.submit(submitInput());

		const summary = await fixture.orchestrator.run(job.id);

		expect(summary).toMatchObject({
			jobId: job.id,
			state: "succeeded",
			exitCode: 0,
			patch: SUCCESSFUL_ARTIFACTS.patch,
			logs: SUCCESSFUL_ARTIFACTS.logs,
		});
		expect(fixture.backend.calls).toEqual(["launch", "collectArtifacts", "cleanup"]);
		expect(fixture.backend.lastLaunchSpec).toMatchObject({
			jobId: job.id,
			repoUrl: job.source.repoUrl,
			ref: job.source.ref,
			timeoutMs: 5_000,
			validationCommands: ["bun test"],
			labels: { "ompk.job_id": job.id },
			networkEgress: "none",
		});

		const stored = fixture.orchestrator.getJob(job.id);
		expect(stored?.state).toBe("succeeded");
		expect(stored?.transitions.map(event => event.to)).toEqual([
			"authorizing",
			"planning",
			"plan_auditing",
			"provisioning",
			"cloning",
			"installing",
			"running_agent",
			"validating",
			"checkpointing_result",
			"cleaning",
			"succeeded",
		]);
		expect(stored?.resources.every(resource => resource.cleanedAt !== undefined)).toBe(true);
		expect(stored?.cleanupProof).toMatchObject({
			containerGone: true,
			volumeGone: true,
			networkGone: true,
			workspaceDirGone: true,
			credentialRevoked: true,
		});

		fixture.orchestrator.close();
		fixture.closed = true;
		const reopened = new JobStore({ path: fixture.dbPath });
		try {
			const durable = reopened.get(job.id);
			expect(durable).toMatchObject({ id: job.id, state: "succeeded", workerId: "worker-1" });
			expect(durable?.transitions).toHaveLength(11);
			expect(reopened.byState("succeeded").map(candidate => candidate.id)).toEqual([job.id]);
		} finally {
			reopened.close();
		}
	});

	it("records cleanup failure with durable proof after the backend cannot remove a required resource", async () => {
		const cleanupResult: CleanupResult = {
			containerGone: false,
			volumeGone: true,
			networkGone: true,
			workspaceDirGone: true,
			credentialRevoked: true,
			errors: ["container remains attached"],
		};
		const fixture = createFixture({ cleanupResult });
		const job = fixture.orchestrator.submit(submitInput());

		const summary = await fixture.orchestrator.run(job.id);

		expect(summary.state).toBe("cleanup_failed");
		expect(fixture.backend.calls).toEqual(["launch", "collectArtifacts", "cleanup"]);
		const stored = fixture.orchestrator.getJob(job.id);
		expect(stored?.state).toBe("cleanup_failed");
		expect(stored?.transitions.at(-1)).toMatchObject({ to: "cleanup_failed" });
		expect(stored?.cleanupProof).toMatchObject({
			containerGone: false,
			notes: "container remains attached",
		});
		expect(stored?.resources.find(resource => resource.kind === "container")?.cleanedAt).toBeUndefined();
		expect(stored?.resources.find(resource => resource.kind === "volume")?.cleanedAt).toBeDefined();
	});

	it("records a nonzero agent exit, then fails after cleanup", async () => {
		const artifacts: WorkspaceArtifacts = {
			...SUCCESSFUL_ARTIFACTS,
			exitCode: 23,
			agentExitCode: 23,
			logs: "agent failed",
		};
		const fixture = createFixture({ artifacts });
		const job = fixture.orchestrator.submit(submitInput([]));

		const summary = await fixture.orchestrator.run(job.id);

		expect(summary).toMatchObject({ jobId: job.id, state: "failed", exitCode: 23 });
		expect(fixture.backend.calls).toEqual(["launch", "collectArtifacts", "terminate", "cleanup"]);
		const stored = fixture.orchestrator.getJob(job.id);
		expect(stored?.state).toBe("failed");
		expect(stored?.transitions.map(event => event.to)).toContain("failed");
		expect(stored?.transitions.map(event => event.to)).toContain("validating");
		expect(stored?.cleanupProof).toMatchObject({ containerGone: true, volumeGone: true });
	});

	it("fails, cleans up, and persists a nonzero validation exit", async () => {
		const artifacts: WorkspaceArtifacts = {
			...SUCCESSFUL_ARTIFACTS,
			exitCode: 19,
			agentExitCode: 0,
			validationExitCode: 19,
			logs: "validation failed",
		};
		const fixture = createFixture({ artifacts });
		const job = fixture.orchestrator.submit(submitInput(["bun test"]));

		const summary = await fixture.orchestrator.run(job.id);

		expect(summary).toMatchObject({ jobId: job.id, state: "failed", exitCode: 19 });
		expect(fixture.backend.calls).toEqual(["launch", "collectArtifacts", "terminate", "cleanup"]);
		const stored = fixture.orchestrator.getJob(job.id);
		expect(stored?.state).toBe("failed");
		expect(stored?.validationExitCode).toBe(19);
		expect(stored?.transitions.map(event => event.to)).toContain("validating");
		expect(stored?.transitions.map(event => event.to)).toContain("failed");
		expect(stored?.cleanupProof).toMatchObject({ containerGone: true, volumeGone: true });
	});

	it("terminates and cleans up a job that exceeds its timeout without leaking a late artifact rejection", async () => {
		const artifacts = createLatch();
		const fixture = createFixture({
			collectBarrier: artifacts.promise,
			collectError: new Error("artifact collection completed after timeout"),
		});
		const job = fixture.orchestrator.submit(submitInput([], 1));
		const running = fixture.orchestrator.run(job.id);

		await fixture.backend.collectionStarted;
		const summary = await running;
		artifacts.release();
		await Bun.sleep(0);

		expect(summary.state).toBe("timed_out");
		expect(fixture.backend.calls).toContain("terminate");
		expect(fixture.backend.calls).toContain("cleanup");
		expect(fixture.backend.calls.indexOf("terminate")).toBeLessThan(fixture.backend.calls.indexOf("cleanup"));
		const stored = fixture.orchestrator.getJob(job.id);
		expect(stored?.state).toBe("timed_out");
		expect(stored?.transitions.map(event => event.to)).toContain("timed_out");
		expect(stored?.cleanupProof).toMatchObject({ containerGone: true, volumeGone: true });
		expect(fixture.backend.lastExecutionControl?.signal?.aborted).toBe(true);
	});

	it("terminates and cleans up an active job after cancellation", async () => {
		const fixture = createFixture({ collectDelayMs: 20 });
		const job = fixture.orchestrator.submit(submitInput());
		const running = fixture.orchestrator.run(job.id);

		await fixture.backend.collectionStarted;
		expect(await fixture.orchestrator.cancel(job.id)).toBe(true);
		const summary = await running;

		expect(summary.state).toBe("cancelled");
		expect(fixture.backend.calls).toContain("terminate");
		expect(fixture.backend.calls).toContain("cleanup");
		expect(fixture.backend.calls.indexOf("terminate")).toBeLessThan(fixture.backend.calls.indexOf("cleanup"));
		const stored = fixture.orchestrator.getJob(job.id);
		expect(stored?.state).toBe("cancelled");
		expect(stored?.transitions.map(event => event.to)).toContain("cancelled");
		expect(stored?.cleanupProof).toMatchObject({ containerGone: true, volumeGone: true });
		expect(fixture.backend.lastExecutionControl?.signal?.aborted).toBe(true);
	});

	it("honors cancellation from a second orchestrator while artifact collection is in flight", async () => {
		const artifacts = createLatch();
		const fixture = createFixture({
			collectBarrier: artifacts.promise,
			collectError: new Error("artifact collection completed after cancellation"),
		});
		const job = fixture.orchestrator.submit(submitInput());
		const running = fixture.orchestrator.run(job.id);
		await fixture.backend.collectionStarted;

		const canceller = new RemoteWorkspaceOrchestrator({ dbPath: fixture.dbPath, backend: fixture.backend });
		try {
			expect(await canceller.cancel(job.id)).toBe(true);
			artifacts.release();
			const summary = await running;

			expect(summary).toMatchObject({ jobId: job.id, state: "cancelled", outcomeState: "cancelled" });
			expect(summary.state).not.toBe("succeeded");
			expect(summary.state).not.toBe("failed");
			const stored = fixture.orchestrator.getJob(job.id);
			expect(stored).toMatchObject({ state: "cancelled", outcomeState: "cancelled" });
			expect(stored?.transitions.at(-1)).toMatchObject({ to: "cancelled" });
			expect(stored?.resources.every(resource => resource.cleanedAt !== undefined)).toBe(true);
			expect(fixture.backend.calls).toContain("cleanup");
		} finally {
			artifacts.release();
			canceller.close();
		}
	});
});

describe("remote workspace durable state contracts", () => {
	it("rejects skipped transitions and restores the failed terminal state after cleanup", () => {
		const job = createJob({
			source: { repoUrl: "https://example.test/acme/repo.git", ref: "main" },
			task: { prompt: "Task", validationCommands: [], resultMode: "none" },
			limits: { timeoutMs: 1_000 },
			backendId: "fake-execution-backend",
		});

		const skipped = transition(job, "validating", "orchestrator", "must not skip provisioning");
		expect(skipped).toMatchObject({ ok: false, code: "invalid_transition" });
		expect(job.state).toBe("queued");

		expect(transition(job, "authorizing", "orchestrator", "begin").ok).toBe(true);
		expect(transition(job, "failed", "orchestrator", "launch failed").ok).toBe(true);
		expect(transition(job, "cleaning", "orchestrator", "release resources").ok).toBe(true);
		expect(transition(job, "failed", "orchestrator", "cleanup complete after failure").ok).toBe(true);
		expect(job.state).toBe("failed");
		expect(transition(job, "planning", "orchestrator", "must not reopen")).toMatchObject({
			ok: false,
			code: "already_terminal",
		});
	});

	it("round-trips structured job state and resource inventory through SQLite", () => {
		const tempDir = TempDir.createSync("@remote-workspace-store-");
		const dbPath = tempDir.join("jobs.sqlite");
		const store = new JobStore({ path: dbPath });
		const job = createJob({
			source: { repoUrl: "https://example.test/acme/repo.git", ref: "main", resolvedCommit: "abc123" },
			task: { prompt: "Task", validationCommands: ["bun test"], resultMode: "branch" },
			limits: { timeoutMs: 2_000, maxTokens: 100 },
			backendId: "fake-execution-backend",
		});
		try {
			expect(transition(job, "authorizing", "orchestrator", "begin").ok).toBe(true);
			registerResource(job, "container", "container-1", "job container");
			store.upsert(job);
		} finally {
			store.close();
		}

		const reopened = new JobStore({ path: dbPath });
		try {
			const persisted = reopened.get(job.id);
			expect(persisted).toMatchObject({
				id: job.id,
				state: "authorizing",
				source: { resolvedCommit: "abc123" },
				limits: { maxTokens: 100 },
				resources: [{ kind: "container", id: "container-1" }],
			});
			expect(reopened.count()).toBe(1);
			expect(reopened.delete(job.id)).toBe(true);
			expect(reopened.count()).toBe(0);
		} finally {
			reopened.close();
			tempDir.removeSync();
		}
	});
});

describe("MsiDockerBackend artifact collection contract", () => {
	it("parses Docker wait exit status from stdout rather than the CLI process status", () => {
		expect(parseDockerWaitExitCode("17\n")).toBe(17);
		expect(() => parseDockerWaitExitCode("17\nextra")).toThrow("invalid exit code");
		expect(() => parseDockerWaitExitCode("256")).toThrow("out-of-range exit code");
	});

	it("waits for completion before reading logs and stopped-container artifacts", async () => {
		const commands: string[][] = [];
		const responses: DockerCommandResult[] = [
			dockerCommandResult("19\n"),
			dockerCommandResult("agent output\nvalidation output"),
			dockerCommandResult(
				dockerArtifactOutput({
					patch: "diff --git a/src/first.ts b/src/first.ts\n",
					changedFiles: ["src/first.ts", "src/second.ts"],
					agentExitCode: 0,
					validationExitCode: 19,
				}),
			),
		];
		const executeDocker: DockerCommandRunner = async args => {
			commands.push([...args]);
			const response = responses.shift();
			if (!response) throw new Error(`Unexpected Docker command: ${args.join(" ")}`);
			return response;
		};
		const backend = new MsiDockerBackend({ executeDocker });

		const artifacts = await backend.collectArtifacts(dockerRuntime());

		expect(artifacts).toMatchObject({
			logs: "agent output\nvalidation output",
			exitCode: 19,
			agentExitCode: 0,
			validationExitCode: 19,
			patch: "diff --git a/src/first.ts b/src/first.ts\n",
		});
		expect(artifacts.changedFiles).toEqual(["src/first.ts", "src/second.ts"]);
		expect(commands.map(command => command[0])).toEqual(["wait", "logs", "run"]);
		expect(commands[0]).toEqual(["wait", "container-docker-contract"]);
		expect(commands[1]).toEqual(["logs", "container-docker-contract"]);
		expect(commands[2]).toEqual(
			expect.arrayContaining([
				"run",
				"--rm",
				"--network",
				"none",
				"--read-only",
				"--volume",
				"volume-docker-contract:/workspace:ro",
				"example.test/worker:latest",
			]),
		);
	});

	it("requires allowlisted restricted egress and keeps runtime content out of Docker arguments", async () => {
		const commands: string[][] = [];
		const executeDocker: DockerCommandRunner = async args => {
			commands.push([...args]);
			switch (args[0]) {
				case "volume":
					return dockerCommandResult("volume-id");
				case "run":
					return dockerCommandResult("container-id");
				case "rm":
					return dockerCommandResult("");
				case "inspect":
					return dockerCommandResult("", 1, "No such object");
				default:
					throw new Error(`Unexpected Docker command: ${args.join(" ")}`);
			}
		};
		const backend = new MsiDockerBackend({
			restrictedNetworkName: "ompk-egress-proxy",
			allowedRepoHosts: ["example.test"],
			executeDocker,
		});
		const spec: WorkspaceLaunchSpec = {
			jobId: "job-secure-launch",
			image: "example.test/worker:latest",
			repoUrl: "https://example.test/acme/repo.git",
			ref: "main",
			taskPrompt: "Private task details",
			validationCommands: ["bun test"],
			timeoutMs: 1_000,
			labels: {},
			networkEgress: "restricted",
		};

		const runtime = await backend.launch(spec);
		const run = commands.find(command => command[0] === "run");
		expect(run).toEqual(expect.arrayContaining(["--network", "ompk-egress-proxy", "--entrypoint", "/bin/sh"]));
		expect(run?.join(" ")).not.toContain("Private task details");
		expect(run?.join(" ")).not.toContain("OMPK_SCRIPT_B64");
		expect(run).not.toContain("--env");

		const cleanup = await backend.cleanup(runtime);
		expect(cleanup).toMatchObject({ containerGone: true, volumeGone: true, workspaceDirGone: true });
		await expect(backend.launch({ ...spec, networkEgress: "none" })).rejects.toThrow("restricted network egress");
		await expect(backend.launch({ ...spec, repoUrl: "https://secret@example.test/acme/repo.git" })).rejects.toThrow(
			"credential-free HTTPS",
		);
	});
});
