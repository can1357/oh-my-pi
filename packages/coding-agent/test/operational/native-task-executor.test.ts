import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { createMockModel, type MockResponse } from "@pk-nerdsaver-ai/pi-ai/providers/mock";
import { TempDir } from "@pk-nerdsaver-ai/pi-utils";
import { __resetDirsFromEnvForTests, getActiveProfile, getAgentDir, setAgentDir } from "@pk-nerdsaver-ai/pi-utils/dirs";
import { runRuntimeCommand } from "../../src/cli/operational-cli";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { createNativeTaskExecutor, parseNativeTaskReceipt } from "../../src/operational/native-task-executor";
import { acquireNativeTaskIntegrationLock } from "../../src/operational/native-task-lock";
import {
	type NativeTaskCheckpoint,
	nativeTaskJson,
	parseNativeTaskCheckpoint,
	parseNativeTaskJobPayload,
} from "../../src/operational/native-task-payload";
import type { JobExecutorContext } from "../../src/operational/runner";
import { DurableRunner } from "../../src/operational/runner";
import { OperationalStore } from "../../src/operational/store";
import { DEFAULT_AGENT_EXECUTION_PROFILE } from "../../src/orchestration/agent-execution-profile";
import { DEFAULT_COLLABORATION_POLICY } from "../../src/orchestration/collaboration-policy";
import { AgentRegistry } from "../../src/registry/agent-registry";
import * as sdk from "../../src/sdk";
import type { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import { SessionWriterGuard } from "../../src/session/session-writer-guard";
import { buildFusionStatusText } from "../../src/slash-commands/helpers/fusion";
import { getBundledAgent } from "../../src/task/agents";
import { observeCodeWrite } from "../../src/task/code-write";
import * as discovery from "../../src/task/discovery";
import * as integration from "../../src/task/integration";
import * as worktree from "../../src/task/worktree";
import * as gitOps from "../../src/utils/git";

const realCreateSession = sdk.createAgentSession;

describe("native durable task executor", () => {
	let dir: TempDir;
	let cwd: string;
	let artifactsDir: string;
	let originalDirs: {
		agent: string | undefined;
		ompProfile: string | undefined;
		piProfile: string | undefined;
		effective: string;
		profile: string | undefined;
	};
	let store: OperationalStore;
	let auth: AuthStorage;
	let registry: ModelRegistry;
	let responses: MockResponse[];
	const sessions: AgentSession[] = [];
	const attempts: Array<{ controller: AbortController; settled: Promise<unknown> }> = [];
	let internalSessions: number;
	let childSessions: number;
	let onChild: ((session: AgentSession) => Promise<void>) | undefined;
	const source = "export const NATIVE_SOURCE_SENTINEL = 1;\n";

	async function git(...args: string[]) {
		const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
		const [text, error, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		if (code) throw new Error(error);
		return text.trim();
	}

	beforeEach(async () => {
		dir = TempDir.createSync("@omp-native-durable-");
		originalDirs = {
			agent: Bun.env.PI_CODING_AGENT_DIR,
			ompProfile: Bun.env.OMP_PROFILE,
			piProfile: Bun.env.PI_PROFILE,
			effective: getAgentDir(),
			profile: getActiveProfile(),
		};
		setAgentDir(dir.path());
		expect(getAgentDir()).toBe(dir.path());
		cwd = path.join(dir.path(), "repo");
		artifactsDir = path.join(dir.path(), "operational", "native-tasks");
		await fs.mkdir(cwd);
		await Bun.write(path.join(cwd, "reference.ts"), "export const REFERENCE_SENTINEL = 1;\n");
		await git("init");
		await git("config", "user.name", "Native test");
		await git("config", "user.email", "test@example.com");
		await git("add", ".");
		await git("commit", "-m", "fixture");
		store = OperationalStore.open({ dbPath: path.join(dir.path(), "operational.db") });
		const defaultStore = OperationalStore.open();
		try {
			expect(defaultStore.dbPath).toBe(store.dbPath);
		} finally {
			defaultStore.close();
		}
		expect(path.join(getAgentDir(), "operational", "native-tasks")).toBe(artifactsDir);
		auth = await AuthStorage.create(path.join(dir.path(), "auth.db"));
		registry = new ModelRegistry(auth, path.join(dir.path(), "models.yml"));
		const model = registry.getAll()[0]!;
		auth.setRuntimeApiKey(model.provider, "test-native-key");
		internalSessions = 0;
		childSessions = 0;
		onChild = undefined;
		responses = [
			{ content: [{ type: "toolCall", name: "write", arguments: { path: "generated.ts", content: source } }] },
			{ content: [{ type: "toolCall", name: "yield", arguments: { result: { data: { complete: true } } } }] },
		];
		vi.spyOn(sdk, "createAgentSession").mockImplementation(async (options = {}) => {
			if (options.nativeTaskExecution) internalSessions++;
			else childSessions++;
			const settings = options.settings ?? Settings.isolated();
			settings.override("task.prefetch.enabled", false);
			settings.override("compaction.enabled", false);
			settings.override("retry.enabled", false);
			settings.override("tools.approvalMode", "yolo");
			settings.override("tools.discoveryMode", "off");
			const created = await realCreateSession({
				...options,
				settings,
				authStorage: auth,
				modelRegistry: registry,
				model,
				disableExtensionDiscovery: true,
				enableMCP: false,
				enableIrc: false,
				enableLsp: false,
				skipPythonPreflight: true,
			});
			sessions.push(created.session);
			if (!options.nativeTaskExecution) {
				created.session.agent.streamFn = createMockModel({ responses }).stream;
				await onChild?.(created.session);
			} else {
				created.session.agent.streamFn = () => {
					throw new Error("Internal executor must not prompt its model");
				};
			}
			return created;
		});
	});

	afterEach(async () => {
		for (const attempt of attempts) attempt.controller.abort(new Error("Test cleanup"));
		await Promise.allSettled(attempts.splice(0).map(attempt => attempt.settled));
		for (const session of sessions.splice(0)) await session.dispose();
		vi.restoreAllMocks();
		store.close();
		auth.close();
		for (const [key, value] of [
			["PI_CODING_AGENT_DIR", originalDirs.agent],
			["OMP_PROFILE", originalDirs.ompProfile],
			["PI_PROFILE", originalDirs.piProfile],
		] as const) {
			if (value === undefined) delete Bun.env[key];
			else Bun.env[key] = value;
		}
		__resetDirsFromEnvForTests();
		expect(getAgentDir()).toBe(originalDirs.effective);
		expect(getActiveProfile()).toBe(originalDirs.profile);
		await dir.remove();
	});

	function payload() {
		const model = registry.getAll()[0]!;
		return parseNativeTaskJobPayload(
			nativeTaskJson({
				version: 1,
				cwd,
				agentId: "NativeChild",
				parentSessionId: "OriginalParent",
				taskDepth: 0,
				params: {
					agent: "task",
					assignment: `Create one module. Acceptance: reference conventions, no extra files. ${"Preserve complete instructions. ".repeat(35)}`,
					role: "Adapter boilerplate specialist",
					codeWrite: { spec: "Create the settled module", reference: "reference.ts", target: "generated.ts" },
				},
				effectiveModel: `${model.provider}/${model.id}`,
				agentDefinition: { ...getBundledAgent("task"), tools: ["read", "write", "yield"], spawns: [] },
				policy: {
					isolationMode: "auto",
					mergeMode: "patch",
					maxRecursionDepth: 2,
					maxRuntimeMs: 0,
					outputSchema: null,
					executionProfile: DEFAULT_AGENT_EXECUTION_PROFILE,
					toolProfile: {
						tier: "frontier",
						autonomy: "independent",
						editMode: "hashline",
						allowDiscovery: false,
						toolsConstrained: true,
						maximum: [
							{ source: "builtin", name: "read" },
							{ source: "builtin", name: "write" },
							{ source: "hidden", name: "yield" },
						],
					},
					collaborationPolicy: DEFAULT_COLLABORATION_POLICY,
				},
			}),
		);
	}

	function runner(leaseMs = 2000, heartbeatIntervalMs = 20) {
		const instance = new DurableRunner({
			store,
			leaseMs,
			executor: createNativeTaskExecutor({ store, artifactsDir, heartbeatIntervalMs }),
		});
		const run = instance.runJobById.bind(instance);
		vi.spyOn(instance, "runJobById").mockImplementation((id, signal) => {
			const controller = new AbortController();
			const settled = run(id, signal ? AbortSignal.any([signal, controller.signal]) : controller.signal);
			attempts.push({ controller, settled });
			return settled;
		});
		return instance;
	}

	async function withinStage<T>(
		label: string,
		operation: (signal: AbortSignal) => Promise<T>,
	): Promise<{ value: T; elapsedMs: number }> {
		const started = performance.now();
		const controller = new AbortController();
		const deadline = Promise.withResolvers<never>();
		const timer = setTimeout(() => {
			const error = new Error(`${label} exceeded its 5000ms stage limit.`);
			controller.abort(error);
			deadline.reject(error);
		}, 5000);
		const execution = Promise.resolve().then(() => operation(controller.signal));
		attempts.push({ controller, settled: execution });
		try {
			const value = await Promise.race([execution, deadline.promise]);
			controller.signal.throwIfAborted();
			const elapsedMs = Math.round(performance.now() - started);
			if (elapsedMs > 5000) throw new Error(`${label} exceeded its 5000ms stage limit (${elapsedMs}ms).`);
			return { value, elapsedMs };
		} finally {
			clearTimeout(timer);
			await Promise.allSettled([execution]);
		}
	}

	it("rejects externally cancelled stages after their callbacks settle", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let callbackSettled = false;
		const operation = withinStage("explicit-cancellation", async () => {
			entered.resolve();
			await release.promise;
			callbackSettled = true;
			return "late success must not escape";
		});
		await entered.promise;
		const reason = new Error("Fixture explicitly cancelled this stage");
		attempts.at(-1)!.controller.abort(reason);
		release.resolve();
		await expect(operation).rejects.toBe(reason);
		expect(callbackSettled).toBe(true);
	});

	async function assertGenerated(jobId: string, mergeMode: "patch" | "branch"): Promise<NativeTaskCheckpoint> {
		const retained = parseNativeTaskCheckpoint(store.getCheckpoint(jobId)!.data);
		expect(retained.phase).toBe("generated");
		expect(retained.baseline?.root.repoRoot).toBe(cwd);
		const patchPath = retained.patchPaths.find(file => file.endsWith("root.patch"));
		expect(patchPath).toBeDefined();
		expect(await Bun.file(patchPath!).text()).toContain("generated.ts");
		expect(await Bun.file(path.join(cwd, "generated.ts")).exists()).toBe(false);
		if (mergeMode === "branch") {
			expect(retained.branchName).toBe("omp/task/NativeChild");
			expect((await git("show", `${retained.branchName}:generated.ts`)).replaceAll("\r\n", "\n")).toBe(
				source.trim(),
			);
		} else expect(retained.branchName).toBeNull();
		return retained;
	}

	async function initialToGenerated(
		mergeMode: "patch" | "branch",
		signal: AbortSignal,
		observe?: (boundary: string) => void,
	): Promise<string> {
		const value = payload();
		value.policy.mergeMode = mergeMode;
		const job = store.createJob({ type: "native_task", payload: nativeTaskJson(value) });
		const observer = OperationalStore.open({ dbPath: store.dbPath });
		const control = new DurableRunner({ store: observer, executor: async () => undefined });
		const checkpointWrite = store.setCheckpointForLease.bind(store);
		let pauseReached = false;
		let unsubscribe: (() => void) | undefined;
		const writeSpy = vi.spyOn(store, "setCheckpointForLease").mockImplementation((id, owner, data) => {
			const saved = checkpointWrite(id, owner, data);
			if (id === job.id && parseNativeTaskCheckpoint(data).phase === "generated") {
				observe?.("generated-checkpoint-written");
				control.pause(id);
				pauseReached = true;
				observe?.("pause-requested");
			}
			return saved;
		});
		onChild = async session => {
			observe?.("child-sdk-ready");
			if (observe) {
				unsubscribe = session.subscribe(event => {
					if (event.type === "message_end" && event.message.role === "assistant") observe("assistant-message-end");
					if (event.type === "tool_execution_end") observe(`tool-end:${event.toolName}`);
					if (event.type === "agent_end") observe("child-agent-end");
				});
				const dispose = session.dispose.bind(session);
				vi.spyOn(session, "dispose").mockImplementation(async () => {
					observe("child-dispose-start");
					try {
						await dispose();
					} finally {
						observe("child-dispose-settled");
					}
				});
			}
			expect(session.sessionManager.getCwd()).not.toBe(cwd);
			expect(await Bun.file(path.join(cwd, "generated.ts")).exists()).toBe(false);
		};
		try {
			const result = await runner().runJobById(job.id, signal);
			observe?.(`runner-settled:${result?.status ?? "none"}`);
			expect(pauseReached, "Initial execution must reach generated before interruption").toBe(true);
			expect(result?.status).toBe("paused");
			expect(internalSessions).toBe(1);
			expect(childSessions).toBe(1);
			return job.id;
		} finally {
			unsubscribe?.();
			writeSpy.mockRestore();
			control.dispose();
			observer.close();
			observe?.("helper-cleanup-settled");
		}
	}

	async function captureGeneratedFixture(mergeMode: "patch" | "branch"): Promise<string> {
		const value = payload();
		value.policy.mergeMode = mergeMode;
		const job = store.createJob({ type: "native_task", payload: nativeTaskJson(value) });
		const baseline = await worktree.captureBaseline(cwd);
		const isolated = await worktree.ensureIsolation(cwd, `Retained-${crypto.randomUUID()}`);
		try {
			const target = path.join(isolated.mergedDir, "generated.ts");
			await Bun.write(target, source);
			const codeReceipt = await observeCodeWrite(
				{
					kind: "code-write",
					reference: path.join(isolated.mergedDir, "reference.ts"),
					target,
					workspaceRoot: isolated.mergedDir,
				},
				"generated.ts",
			);
			const delta = await worktree.captureDeltaPatch(isolated.mergedDir, baseline);
			expect(delta.rootTouchedFiles).toEqual(["generated.ts"]);
			expect(delta.nestedPatches).toEqual([]);
			const branch =
				mergeMode === "branch"
					? await worktree.commitToBranch(
							isolated.mergedDir,
							baseline,
							"NativeChild",
							"Retained generated fixture",
							undefined,
							delta,
						)
					: null;
			const attemptRoot = path.join(artifactsDir, job.id, "attempt-1");
			await fs.mkdir(attemptRoot, { recursive: true });
			const resultPath = path.join(attemptRoot, "worker-result.json");
			const outputPath = path.join(attemptRoot, "worker-output.txt");
			const patchPath = path.join(attemptRoot, "root.patch");
			await fs.writeFile(patchPath, delta.rootPatch);
			await fs.writeFile(outputPath, source);
			await fs.writeFile(
				resultPath,
				JSON.stringify({
					id: "NativeChild",
					agent: "task",
					agentSource: "bundled",
					index: 0,
					task: "Retained generated fixture",
					exitCode: 0,
					output: source,
					stderr: "",
					truncated: false,
					durationMs: 0,
					tokens: 0,
					requests: 0,
				}),
			);
			store.setCheckpoint(
				job.id,
				nativeTaskJson({
					version: 1,
					phase: "generated",
					attempt: 1,
					isolationId: isolated.mergedDir,
					baseline,
					patchPaths: [patchPath, resultPath, outputPath],
					branchName: branch?.branchName ?? null,
					receipt: { generated: true, resultPath, outputPath, nested: [], codeReceipt },
					integrationError: null,
				}),
			);
			return job.id;
		} finally {
			await worktree.cleanupIsolation(isolated);
		}
	}

	async function runRecoveryCli(signal: AbortSignal): Promise<void> {
		await runRuntimeCommand(
			{ action: "run", flags: { once: true } },
			{ store, signal, installSignalHandlers: false, io: { writeStdout: () => {}, writeStderr: () => {} } },
		);
	}

	async function assertRecovered(jobId: string, branchName: string | null): Promise<void> {
		const result = store.getJob(jobId)!;
		expect(result.error).toBeNull();
		expect(result.status).toBe("completed");
		const receipt = parseNativeTaskReceipt(result.result);
		expect(receipt.branchName).toBe(branchName);
		expect(receipt.changesApplied).toBe(true);
		const bytes = await Bun.file(path.join(cwd, "generated.ts")).bytes();
		expect(new TextDecoder().decode(bytes).replaceAll("\r\n", "\n")).toBe(source);
		expect(JSON.parse(receipt.output)).toEqual({
			kind: "code-write",
			target: "generated.ts",
			lines: 1,
			bytes: bytes.length,
			sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
			changesApplied: true,
		});
		expect(parseNativeTaskCheckpoint(store.getCheckpoint(jobId)!.data).phase).toBe("integrated");
		const integratedHead = await git("rev-parse", "HEAD");
		await withinStage("integrated-noop", signal => runRecoveryCli(signal));
		expect(await git("rev-parse", "HEAD")).toBe(integratedHead);
		expect(await Bun.file(path.join(cwd, "generated.ts")).bytes()).toEqual(bytes);
	}

	it("releases a durable transcript guard when cancelled during manager startup", async () => {
		const controller = new AbortController();
		const open = SessionManager.open;
		let opened: SessionManager | undefined;
		vi.spyOn(SessionManager, "open").mockImplementation(async (...args) => {
			opened = await open(...args);
			controller.abort();
			return opened;
		});
		const value = payload();
		delete value.params.codeWrite;
		value.params.evidenceDigest = { paths: ["reference.ts"], question: "Identify the declaration" };
		value.agentDefinition.tools = ["read", "grep", "glob", "ast_grep", "yield"];
		value.policy.toolProfile = null;
		const job = store.createJob({ type: "native_task", payload: nativeTaskJson(value) });
		await runner().runJobById(job.id, controller.signal);
		expect(opened).toBeDefined();
		const guard = SessionWriterGuard.acquire({
			sessionId: opened!.getSessionId(),
			transcriptPath: opened!.getSessionFile()!,
		});
		await guard.release();
		expect(await Bun.file(path.join(cwd, "generated.ts")).exists()).toBe(false);
	});

	it("measures native baseline and isolation startup without model execution", async () => {
		const baseline = await worktree.captureBaseline(cwd);
		expect(baseline.root.headCommit).not.toBe("");
		const isolation = await worktree.ensureIsolation(cwd, `Boundary-${crypto.randomUUID()}`);
		try {
			expect(await Bun.file(path.join(isolation.mergedDir, "reference.ts")).exists()).toBe(true);
		} finally {
			await worktree.cleanupIsolation(isolation);
		}
		expect(childSessions).toBe(0);
	});

	it("settles bounded cancellation across native startup before closing storage", async () => {
		const job = store.createJob({ type: "native_task", payload: nativeTaskJson(payload()) });
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 1500);
		try {
			const result = await runner().runJobById(job.id, controller.signal);
			expect(["queued", "completed"]).toContain(result?.status ?? "missing");
			if (result?.status === "queued") expect(await Bun.file(path.join(cwd, "generated.ts")).exists()).toBe(false);
		} finally {
			clearTimeout(timer);
		}
	});

	it("round-trips complete payload and executes one SDK worker through the real runner", async () => {
		const value = payload();
		expect(String(value.params.assignment).length).toBeGreaterThan(500);
		expect(parseNativeTaskJobPayload(nativeTaskJson(value))).toEqual(value);
		const job = store.createJob({ type: "native_task", payload: nativeTaskJson(value) });
		const result = await runner().runJobById(job.id);
		if (result?.status !== "completed")
			throw new Error(`Native failure: ${result?.error}; ${JSON.stringify(store.getCheckpoint(job.id)?.data)}`);
		const receipt = parseNativeTaskReceipt(result.result);
		expect(receipt.changesApplied).toBe(true);
		expect(JSON.parse(receipt.output)).toMatchObject({
			kind: "code-write",
			target: "generated.ts",
			lines: 1,
			changesApplied: true,
		});
		expect((await Bun.file(path.join(cwd, "generated.ts")).text()).replaceAll("\r\n", "\n")).toBe(source);
		expect(internalSessions).toBe(1);
		expect(childSessions).toBe(1);
		expect(store.getCheckpoint(job.id)?.data).toMatchObject({ phase: "integrated", attempt: 1 });
		expect(JSON.stringify(result.result)).not.toContain("NATIVE_SOURCE_SENTINEL");
		expect(store.getJob(job.id)?.payload).toEqual(nativeTaskJson(value));
	});

	it("prepares a pinned native definition without mutable agent discovery", async () => {
		const discover = vi.spyOn(discovery, "discoverAgents").mockImplementation(async () => {
			throw new Error("Mutable agent discovery must not run for this native execution.");
		});
		const value = payload();
		value.params.agent = "PinnedOnly";
		value.params.isolated = false;
		value.agentDefinition.name = "PinnedOnly";
		value.agentDefinition.systemPrompt = "Pinned definition, independent of filesystem agent roots.";
		const job = store.createJob({ type: "native_task", payload: nativeTaskJson(value) });
		const settled = await runner().runJobById(job.id);
		expect(settled?.status).toBe("failed");
		expect(settled?.error).toContain("Isolation is required for this task.");
		expect(discover).not.toHaveBeenCalled();
		expect(internalSessions).toBe(1);
		expect(childSessions).toBe(0);
		expect(await Bun.file(path.join(cwd, "generated.ts")).exists()).toBe(false);
	});

	it("rejects malformed/legacy native rows before SDK execution", async () => {
		for (const value of [
			{ agentId: "legacy" },
			{ ...payload(), version: 2 },
			{ ...payload(), effectiveModel: "pi/task" },
			{ ...payload(), policy: {} },
		]) {
			const job = store.createJob({ type: "native_task", payload: nativeTaskJson(value) });
			expect((await runner().runJobById(job.id))?.status).toBe("failed");
		}
		expect(internalSessions).toBe(0);
		expect(childSessions).toBe(0);
	});

	it("rejects malformed retained artifacts and baselines before allocating recovery workers", async () => {
		const headCommit = await git("rev-parse", "HEAD");
		for (const corruption of [
			"outside-artifact",
			"cross-job-artifact",
			"nested-traversal",
			"missing-baseline",
			"outside-baseline",
			"failed-worker",
		] as const) {
			const job = store.createJob({ type: "native_task", payload: nativeTaskJson(payload()) });
			const attemptRoot = path.join(artifactsDir, job.id, "attempt-1");
			await fs.mkdir(attemptRoot, { recursive: true });
			const outputPath = path.join(attemptRoot, "worker-output.txt");
			const resultPath = path.join(attemptRoot, "worker-result.json");
			const patchPath = path.join(attemptRoot, "root.patch");
			const result = {
				id: "NativeChild",
				agent: "task",
				agentSource: "bundled",
				index: 0,
				task: "Create module",
				exitCode: corruption === "failed-worker" ? 1 : 0,
				output: source,
				stderr: "",
				truncated: false,
				durationMs: 1,
				tokens: 0,
				requests: 0,
			};
			await fs.writeFile(resultPath, JSON.stringify(result));
			await fs.writeFile(outputPath, source);
			await fs.writeFile(patchPath, "");
			const generated = {
				generated: true,
				resultPath,
				outputPath,
				nested: [] as Array<{ relativePath: string; patchPath: string }>,
				codeReceipt: {
					kind: "code-write",
					target: "generated.ts",
					lines: 1,
					bytes: Buffer.byteLength(source),
					sha256: new Bun.CryptoHasher("sha256").update(source).digest("hex"),
					changesApplied: false,
				},
			};
			const checkpoint: NativeTaskCheckpoint = {
				version: 1,
				phase: "generated",
				attempt: 1,
				isolationId: "retained",
				baseline: {
					root: { repoRoot: cwd, headCommit, staged: "", unstaged: "", untracked: [], untrackedPatch: "" },
					nested: [],
				},
				patchPaths: [resultPath, outputPath, patchPath],
				branchName: null,
				receipt: null,
				integrationError: null,
			};
			if (corruption === "outside-artifact" || corruption === "cross-job-artifact") {
				const outside = path.join(
					corruption === "outside-artifact" ? dir.path() : path.join(artifactsDir, "another-job"),
					"foreign-result.json",
				);
				await fs.mkdir(path.dirname(outside), { recursive: true });
				await fs.copyFile(resultPath, outside);
				generated.resultPath = outside;
				checkpoint.patchPaths[0] = outside;
			} else if (corruption === "nested-traversal") {
				generated.nested.push({ relativePath: "../outside", patchPath });
			} else if (corruption === "missing-baseline") {
				checkpoint.baseline = null;
			} else if (corruption === "outside-baseline") {
				const outsideRepo = path.join(dir.path(), "outside-repo");
				await fs.mkdir(outsideRepo, { recursive: true });
				checkpoint.baseline!.root.repoRoot = outsideRepo;
			}
			checkpoint.receipt = nativeTaskJson(generated);
			store.setCheckpoint(job.id, nativeTaskJson(checkpoint));
			const settled = await runner().runJobById(job.id);
			expect(settled?.status, corruption).toBe("failed");
			expect(settled?.error).not.toContain("NATIVE_SOURCE_SENTINEL");
			expect(await Bun.file(resultPath).exists()).toBe(true);
			expect(await Bun.file(path.join(cwd, "generated.ts")).exists()).toBe(false);
		}
		expect(internalSessions).toBe(0);
		expect(childSessions).toBe(0);
	});

	it("returns integrated receipt without reference validation, SDK creation or another write", async () => {
		const job = store.createJob({ type: "native_task", payload: nativeTaskJson(payload()) });
		const receipt = {
			kind: "native-task",
			agentId: "NativeChild",
			output: JSON.stringify({
				kind: "code-write",
				target: "generated.ts",
				lines: 1,
				bytes: 18,
				sha256: new Bun.CryptoHasher("sha256").update("already integrated").digest("hex"),
				changesApplied: true,
			}),
			exitCode: 0,
			changesApplied: true,
			mergeSummary: "applied",
			artifacts: [],
			outputPath: "retained.md",
			branchName: null,
		};
		const checkpoint: NativeTaskCheckpoint = {
			version: 1,
			phase: "integrated",
			attempt: 1,
			isolationId: null,
			baseline: null,
			patchPaths: [],
			branchName: null,
			receipt: nativeTaskJson(receipt),
			integrationError: null,
		};
		store.setCheckpoint(job.id, nativeTaskJson(checkpoint));
		await fs.rm(path.join(cwd, "reference.ts"));
		await Bun.write(path.join(cwd, "generated.ts"), "already integrated");
		await runRuntimeCommand(
			{ action: "run", flags: { once: true } },
			{ store, installSignalHandlers: false, io: { writeStdout: () => {}, writeStderr: () => {} } },
		);
		expect(store.getJob(job.id)?.result).toEqual(receipt);
		expect(internalSessions).toBe(0);
		expect(childSessions).toBe(0);
		expect(await Bun.file(path.join(cwd, "generated.ts")).text()).toBe("already integrated");
	});

	it("requires reconciliation for integrating checkpoints without launching a model", async () => {
		const job = store.createJob({ type: "native_task", payload: nativeTaskJson(payload()) });
		store.setCheckpoint(
			job.id,
			nativeTaskJson({
				version: 1,
				phase: "integrating",
				attempt: 1,
				isolationId: null,
				baseline: null,
				patchPaths: [],
				branchName: null,
				receipt: null,
				integrationError: null,
			}),
		);
		const result = await runner().runJobById(job.id);
		expect(result?.status).toBe("failed");
		expect(result?.error).toContain("Recovery requires reconciliation");
		expect(childSessions).toBe(0);
	});

	for (const mergeMode of ["patch", "branch"] as const) {
		it(`persists initial ${mergeMode} generation before parent integration`, async () => {
			const started = performance.now();
			const boundaries: Array<{ boundary: string; elapsedMs: number }> = [];
			const observe =
				mergeMode === "branch"
					? (boundary: string) => boundaries.push({ boundary, elapsedMs: Math.round(performance.now() - started) })
					: undefined;
			if (observe) {
				const capture = worktree.captureDeltaPatch;
				const commit = worktree.commitToBranch;
				const cleanup = worktree.cleanupIsolation;
				vi.spyOn(worktree, "captureDeltaPatch").mockImplementation(async (...args) => {
					observe("patch-capture-start");
					try {
						const result = await capture(...args);
						observe("patch-capture-complete");
						return result;
					} catch (error) {
						observe("patch-capture-failed");
						throw error;
					}
				});
				vi.spyOn(worktree, "commitToBranch").mockImplementation(async (...args) => {
					observe("branch-capture-start");
					try {
						const result = await commit(...args);
						observe("branch-capture-complete");
						return result;
					} catch (error) {
						observe("branch-capture-failed");
						throw error;
					}
				});
				vi.spyOn(worktree, "cleanupIsolation").mockImplementation(async (...args) => {
					observe("isolation-cleanup-start");
					try {
						await cleanup(...args);
						observe("isolation-cleanup-complete");
					} catch (error) {
						observe("isolation-cleanup-failed");
						throw error;
					}
				});
			}
			try {
				const initial = await withinStage("initial-generation", signal => {
					observe?.("stage-start");
					return initialToGenerated(mergeMode, signal, observe);
				});
				observe?.("stage-resolved");
				await assertGenerated(initial.value, mergeMode);
				observe?.("assertions-complete");
			} finally {
				if (observe) console.info("NATIVE_INITIAL_BRANCH_TIMING", { boundaries });
			}
		});

		it(`recovers retained ${mergeMode} artifacts without an initial model request`, async () => {
			const jobId = await captureGeneratedFixture(mergeMode);
			const generated = await assertGenerated(jobId, mergeMode);
			await fs.rm(path.join(cwd, "reference.ts"));
			const applied = vi.spyOn(integration, "integrateTaskResult");
			await withinStage("generated-recovery", signal => runRecoveryCli(signal));
			await assertRecovered(jobId, generated.branchName);
			expect(applied).toHaveBeenCalledTimes(1);
			expect(internalSessions).toBe(0);
			expect(childSessions).toBe(0);
		});

		// Disclosed total allowance: two independently enforced 5s stages, plus setup/cleanup.
		it(`stages initial ${mergeMode} generation and CLI recovery with independent deadlines`, async () => {
			const initial = await withinStage("initial-generation", signal => initialToGenerated(mergeMode, signal));
			const generated = await assertGenerated(initial.value, mergeMode);
			await fs.rm(path.join(cwd, "reference.ts"));
			const control = new DurableRunner({ store, executor: async () => undefined });
			control.resume(initial.value);
			control.dispose();
			const applied = vi.spyOn(integration, "integrateTaskResult");
			const recovery = await withinStage("generated-recovery", signal => runRecoveryCli(signal));
			await assertRecovered(initial.value, generated.branchName);
			expect(applied).toHaveBeenCalledTimes(1);
			expect(internalSessions).toBe(1);
			expect(childSessions).toBe(1);
			console.info("NATIVE_STAGED_TIMING", {
				mergeMode,
				initialMs: initial.elapsedMs,
				recoveryMs: recovery.elapsedMs,
			});
		}, 15_000);
	}

	it("settles cancelled branch CLI recovery before store teardown", async () => {
		const jobId = await captureGeneratedFixture("branch");
		await fs.rm(path.join(cwd, "reference.ts"));
		const control = new AbortController();
		const integrate = integration.integrateTaskResult;
		vi.spyOn(integration, "integrateTaskResult").mockImplementation(async options => {
			await integrate(options);
			control.abort(new Error("Cancel after observed integration"));
		});
		await withinStage("cancelled-recovery", signal => runRecoveryCli(AbortSignal.any([signal, control.signal])));
		expect(store.getJob(jobId)?.status).toBe("queued");
		expect(parseNativeTaskCheckpoint(store.getCheckpoint(jobId)!.data).phase).toBe("integrating");
		expect(await Bun.file(path.join(cwd, "generated.ts")).exists()).toBe(true);
		expect(internalSessions).toBe(0);
		expect(childSessions).toBe(0);
	});

	for (const action of ["pause", "cancel"] as const)
		it(`observes external ${action} on heartbeat before integration`, async () => {
			const started = Promise.withResolvers<void>();
			let aborted = false;
			onChild = async session => {
				session.agent.streamFn = createMockModel({
					handler: (_context, options) => {
						options?.signal?.addEventListener(
							"abort",
							() => {
								aborted = true;
							},
							{ once: true },
						);
						started.resolve();
						return { ...responses[0], delayMs: 10_000 };
					},
				}).stream;
			};
			const job = store.createJob({ type: "native_task", payload: nativeTaskJson(payload()) });
			const observer = OperationalStore.open({ dbPath: path.join(dir.path(), "operational.db") });
			const control = new DurableRunner({ store: observer, executor: async () => undefined });
			const running = runner().runJobById(job.id);
			try {
				await started.promise;
				control[action](job.id);
				expect((await running)?.status).toBe(action === "pause" ? "paused" : "cancelled");
				expect(aborted).toBe(true);
				expect(await Bun.file(path.join(cwd, "generated.ts")).exists()).toBe(false);
				expect(parseNativeTaskCheckpoint(store.getCheckpoint(job.id)!.data).phase).toBe("executing");
			} finally {
				observer.close();
			}
		});

	it("keeps a live heartbeat lease unreclaimable by an independent runner", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		onChild = async session => {
			session.agent.streamFn = createMockModel({
				responses: [
					async () => {
						started.resolve();
						await release.promise;
						return responses[0]!;
					},
					responses[1]!,
				],
			}).stream;
		};
		const job = store.createJob({ type: "native_task", payload: nativeTaskJson(payload()) });
		const observer = OperationalStore.open({ dbPath: path.join(dir.path(), "operational.db") });
		const competing = new DurableRunner({
			store: observer,
			leaseMs: 2000,
			executor: async () => {
				throw new Error("Live job must not be reclaimed");
			},
		});
		const running = runner().runJobById(job.id);
		try {
			await started.promise;
			const owner = observer.getJob(job.id)!.leaseOwner;
			await Bun.sleep(2200);
			expect(observer.recoverExpiredLeases()).toHaveLength(0);
			expect(await competing.runJobById(job.id)).toBeNull();
			expect(observer.getJob(job.id)!.leaseOwner).toBe(owner);
			release.resolve();
			expect((await running)?.status).toBe("completed");
		} finally {
			release.resolve();
			observer.close();
		}
	}, 20_000);

	it("retains a failed conflict receipt and patch without overwriting a competing parent file", async () => {
		onChild = async () => {
			await Bun.write(path.join(cwd, "generated.ts"), "competing parent\n");
		};
		const job = store.createJob({ type: "native_task", payload: nativeTaskJson(payload()) });
		const result = await runner().runJobById(job.id);
		expect(result?.status).toBe("failed");
		const checkpoint = parseNativeTaskCheckpoint(store.getCheckpoint(job.id)!.data);
		expect(checkpoint.integrationError).toContain("failed");
		expect(checkpoint.patchPaths.some(file => file.endsWith("root.patch"))).toBe(true);
		for (const file of checkpoint.patchPaths) expect(await Bun.file(file).exists()).toBe(true);
		expect(await Bun.file(path.join(cwd, "generated.ts")).text()).toBe("competing parent\n");
		expect(JSON.stringify(checkpoint.receipt)).not.toContain("NATIVE_SOURCE_SENTINEL");
	});

	it("restarts restricted executing attempts in a fresh isolation and retains orphan metadata", async () => {
		const orphan = path.join(dir.path(), "orphan");
		await fs.mkdir(orphan);
		await Bun.write(path.join(orphan, "generated.ts"), "partial old attempt");
		const job = store.createJob({ type: "native_task", payload: nativeTaskJson(payload()) });
		store.setCheckpoint(
			job.id,
			nativeTaskJson({
				version: 1,
				phase: "executing",
				attempt: 1,
				isolationId: orphan,
				baseline: null,
				patchPaths: [],
				branchName: null,
				receipt: null,
				integrationError: null,
			}),
		);
		onChild = async session => {
			expect(session.sessionManager.getCwd()).not.toBe(orphan);
		};
		const result = await runner().runJobById(job.id);
		expect(result?.status).toBe("completed");
		const checkpoint = parseNativeTaskCheckpoint(store.getCheckpoint(job.id)!.data);
		expect(checkpoint.attempt).toBe(2);
		expect(checkpoint.patchPaths.some(file => file.endsWith("orphan-attempt.json"))).toBe(true);
		expect(await Bun.file(path.join(orphan, "generated.ts")).text()).toBe("partial old attempt");
	});

	it("refuses unrestricted interrupted attempts and unavailable pins before worker allocation", async () => {
		const unrestricted = payload();
		delete unrestricted.params.codeWrite;
		const first = store.createJob({ type: "native_task", payload: nativeTaskJson(unrestricted) });
		store.setCheckpoint(
			first.id,
			nativeTaskJson({
				version: 1,
				phase: "prepared",
				attempt: 1,
				isolationId: null,
				baseline: null,
				patchPaths: [],
				branchName: null,
				receipt: null,
				integrationError: null,
			}),
		);
		expect((await runner().runJobById(first.id))?.error).toContain("Recovery requires reconciliation");
		const unavailable = { ...payload(), effectiveModel: "missing-provider/missing-model" };
		const second = store.createJob({ type: "native_task", payload: nativeTaskJson(unavailable) });
		expect((await runner().runJobById(second.id))?.status).toBe("failed");
		expect(childSessions).toBe(0);
	});

	it("refuses integration and checkpoint writes after another owner claims the job", async () => {
		const job = store.createJob({ type: "native_task", payload: nativeTaskJson(payload()) });
		const observer = OperationalStore.open({ dbPath: store.dbPath });
		const write = store.setCheckpointForLease.bind(store);
		vi.spyOn(store, "setCheckpointForLease").mockImplementation((id, owner, data) => {
			const saved = write(id, owner, data);
			if (parseNativeTaskCheckpoint(data).phase === "generated") {
				observer.transitionJob(id, { to: "queued", leaseOwner: owner });
				observer.claimJobById(id, "replacement-owner", 10_000);
			}
			return saved;
		});
		try {
			const result = await runner().runJobById(job.id);
			expect(result?.status).toBe("running");
			expect(result?.leaseOwner).toBe("replacement-owner");
			expect(parseNativeTaskCheckpoint(store.getCheckpoint(job.id)!.data).phase).toBe("generated");
			expect(await Bun.file(path.join(cwd, "generated.ts")).exists()).toBe(false);
		} finally {
			observer.close();
		}
	});

	for (const action of ["pause", "cancel"] as const)
		it(`retains reconciliation evidence when ${action} arrives during integration`, async () => {
			const job = store.createJob({ type: "native_task", payload: nativeTaskJson(payload()) });
			const observer = OperationalStore.open({ dbPath: store.dbPath });
			const control = new DurableRunner({ store: observer, executor: async () => undefined });
			const realIntegrate = integration.integrateTaskResult;
			vi.spyOn(integration, "integrateTaskResult").mockImplementation(async options => {
				expect(parseNativeTaskCheckpoint(observer.getCheckpoint(job.id)!.data).phase).toBe("integrating");
				await realIntegrate(options);
				control[action](job.id);
			});
			try {
				const result = await runner().runJobById(job.id);
				expect(result?.status).toBe(action === "pause" ? "paused" : "cancelled");
				expect(await Bun.file(path.join(cwd, "generated.ts")).exists()).toBe(true);
				const checkpoint = parseNativeTaskCheckpoint(store.getCheckpoint(job.id)!.data);
				expect(checkpoint.phase).toBe("integrating");
				expect(checkpoint.receipt).not.toBeNull();
				for (const file of checkpoint.patchPaths) expect(await Bun.file(file).exists()).toBe(true);
				expect((await fs.readdir(path.join(artifactsDir, "integration-locks"))).length).toBe(1);
			} finally {
				observer.close();
			}
		});

	it("aborts before worker allocation when a fenced checkpoint write fails", async () => {
		const job = store.createJob({ type: "native_task", payload: nativeTaskJson(payload()) });
		vi.spyOn(store, "setCheckpointForLease").mockImplementation(() => {
			throw new Error("Injected checkpoint storage unavailable");
		});
		const result = await runner().runJobById(job.id);
		expect(result?.status).not.toBe("completed");
		expect(result?.error).toContain("checkpoint storage unavailable");
		expect(childSessions).toBe(0);
		expect(await Bun.file(path.join(cwd, "generated.ts")).exists()).toBe(false);
	});

	it("serializes repository locks across independent store connections", async () => {
		const observer = OperationalStore.open({ dbPath: store.dbPath });
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const order: string[] = [];
		const first = new DurableRunner({
			store,
			executor: async ctx => {
				const unlock = await acquireNativeTaskIntegrationLock({ store, ctx, artifactsDir, repoRoot: cwd });
				order.push("first");
				entered.resolve();
				try {
					await release.promise;
				} finally {
					await unlock();
				}
			},
		});
		const second = new DurableRunner({
			store: observer,
			executor: async ctx => {
				const unlock = await acquireNativeTaskIntegrationLock({
					store: observer,
					ctx,
					artifactsDir,
					// Same directory, different spelling: case variants only resolve on
					// case-insensitive filesystems, so POSIX uses a "." suffix instead.
					repoRoot: process.platform === "win32" ? cwd.toUpperCase() : path.join(cwd, "."),
				});
				try {
					order.push("second");
				} finally {
					await unlock();
				}
			},
		});
		const firstJob = first.enqueue({ type: "native-lock-test", payload: {} });
		const secondJob = second.enqueue({ type: "native-lock-test", payload: {} });
		const firstRun = first.runJobById(firstJob.id);
		await entered.promise;
		const secondRun = second.runJobById(secondJob.id);
		try {
			await Bun.sleep(100);
			expect(order).toEqual(["first"]);
			release.resolve();
			expect((await firstRun)?.status).toBe("completed");
			expect((await secondRun)?.status).toBe("completed");
			expect(order).toEqual(["first", "second"]);
		} finally {
			release.resolve();
			await Promise.allSettled([firstRun, secondRun]);
			observer.close();
		}
	});

	for (const state of ["generated", "integrating", "missing-owner"] as const)
		it(`handles stale ${state} integration locks conservatively`, async () => {
			const stale = store.createJob({ type: "native-lock-test", payload: {} });
			const staleJob = store.claimJobById(stale.id, "old-worker", 10_000)!;
			const ctx: JobExecutorContext = {
				job: staleJob,
				signal: new AbortController().signal,
				checkpoint: null,
				heartbeat: () => {
					store.renewLease(stale.id, "old-worker", 10_000);
					return true;
				},
				checkpointWrite: data => {
					store.setCheckpointForLease(stale.id, "old-worker", data);
				},
			};
			await acquireNativeTaskIntegrationLock({ store, ctx, artifactsDir, repoRoot: cwd });
			store.setCheckpoint(
				stale.id,
				nativeTaskJson({
					version: 1,
					phase: state === "integrating" ? "integrating" : "generated",
					attempt: 1,
					isolationId: null,
					baseline: null,
					patchPaths: [],
					branchName: null,
					receipt: null,
					integrationError: null,
				}),
			);
			store.transitionJob(stale.id, { to: "failed", leaseOwner: "old-worker" });
			if (state === "missing-owner") {
				const root = path.join(artifactsDir, "integration-locks");
				await fs.rm(path.join(root, (await fs.readdir(root))[0]!, "owner.json"));
			}
			const next = new DurableRunner({
				store,
				executor: async live => {
					const unlock = await acquireNativeTaskIntegrationLock({ store, ctx: live, artifactsDir, repoRoot: cwd });
					await unlock();
				},
			});
			const result = await next.runJobById(next.enqueue({ type: "native-lock-test", payload: {} }).id);
			expect(result?.status).toBe(state === "generated" ? "completed" : "failed");
			if (state !== "generated") expect(result?.error).toContain("Recovery requires reconciliation");
		});

	it("recovers one target after a real child-process crash and store reopen", async () => {
		const value = payload();
		const job = store.createJob({ type: "native_task", payload: nativeTaskJson(value) });
		const markerPath = path.join(dir.path(), "crash-ready.json");
		const configPath = path.join(dir.path(), "crash-config.json");
		await fs.writeFile(
			configPath,
			JSON.stringify({
				dbPath: store.dbPath,
				authPath: path.join(dir.path(), "auth.db"),
				modelsPath: path.join(dir.path(), "models.yml"),
				artifactsDir,
				markerPath,
				jobId: job.id,
				model: value.effectiveModel,
			}),
		);
		const child = Bun.spawn(
			[process.execPath, "test", path.join(import.meta.dir, "fixtures", "native-task-crash.fixture.ts")],
			{
				cwd,
				env: { ...process.env, NATIVE_TASK_CRASH_CONFIG: configPath },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const stdout = new Response(child.stdout).text();
		const stderr = new Response(child.stderr).text();
		try {
			const deadline = Date.now() + 15_000;
			while (!(await Bun.file(markerPath).exists())) {
				if (child.exitCode !== null)
					throw new Error(`Crash fixture exited before boundary: ${await stdout}\n${await stderr}`);
				if (Date.now() > deadline) throw new Error("Crash fixture did not reach the executing boundary");
				await Bun.sleep(25);
			}
			const marker: { workspace: string } = JSON.parse(await fs.readFile(markerPath, "utf8"));
			expect(marker.workspace).not.toBe(cwd);
			expect(await Bun.file(path.join(cwd, "generated.ts")).exists()).toBe(false);
			const interrupted = parseNativeTaskCheckpoint(store.getCheckpoint(job.id)!.data);
			expect(interrupted.phase).toBe("executing");
			child.kill();
			await child.exited;
			await Promise.all([stdout, stderr]);
			const dbPath = store.dbPath;
			store.close();
			store = OperationalStore.open({ dbPath });
			await Bun.sleep(Math.max(0, (store.getJob(job.id)!.leaseExpiresAt ?? 0) - Date.now() + 2));
			expect(store.recoverExpiredLeases().map(recovered => recovered.id)).toContain(job.id);
			const result = await runner().runJobById(job.id);
			expect(result?.error).toBeNull();
			expect(result?.status).toBe("completed");
			const checkpoint = parseNativeTaskCheckpoint(store.getCheckpoint(job.id)!.data);
			expect(checkpoint.attempt).toBe(2);
			expect(checkpoint.isolationId).not.toBe(marker.workspace);
			expect(checkpoint.patchPaths.some(file => file.endsWith("orphan-attempt.json"))).toBe(true);
			const output = JSON.parse(parseNativeTaskReceipt(result!.result).output);
			const generated = await fs.readFile(path.join(cwd, "generated.ts"));
			expect(output.sha256).toBe(new Bun.CryptoHasher("sha256").update(generated).digest("hex"));
			expect(output.bytes).toBe(generated.byteLength);
			expect(generated.toString().replaceAll("\r\n", "\n")).toBe(source);
			expect(childSessions).toBe(1);
		} finally {
			if (child.exitCode === null) child.kill();
			await child.exited;
			await Promise.all([stdout, stderr]);
		}
	}, 30_000);

	it("blocks autonomous allocation when operational storage cannot be opened", async () => {
		const settings = Settings.isolated();
		settings.override("fusion.enabled", true);
		settings.override("fusion.mode", "autonomous");
		settings.override("async.enabled", false);
		settings.override("tools.discoveryMode", "off");
		const { session } = await realCreateSession({
			cwd,
			settings,
			modelRegistry: registry,
			authStorage: auth,
			model: registry.getAll()[0]!,
			toolNames: ["task"],
			disableExtensionDiscovery: true,
			enableMCP: false,
			enableIrc: false,
			enableLsp: false,
			skipPythonPreflight: true,
			contextFiles: [],
			skills: [],
			rules: [],
			promptTemplates: [],
			slashCommands: [],
		});
		sessions.push(session);
		vi.spyOn(OperationalStore, "open").mockImplementation(() => {
			throw new Error("Injected operational storage unavailable");
		});
		const value = payload();
		const result = await session
			.getToolByName("task")!
			.execute("unavailable", { ...value.params, model: value.effectiveModel });
		expect(JSON.stringify(result.content)).toContain("operational storage unavailable");
		expect(childSessions).toBe(0);
		expect(internalSessions).toBe(0);
		expect(await Bun.file(path.join(cwd, "generated.ts")).exists()).toBe(false);
	});

	for (const conflict of [false, true])
		it(`runs the autonomous default-isolation provider flow with ${conflict ? "a durable conflict" : "receipt-only integration"}`, async () => {
			await fs.writeFile(
				path.join(cwd, "bulk.ts"),
				Array.from({ length: 351 }, (_, n) => `const BULK_SOURCE_SENTINEL_${n} = ${n};`).join("\n"),
			);
			await git("add", "bulk.ts");
			await git("commit", "-m", "bulk fixture");
			const settings = Settings.isolated({
				"fusion.enabled": true,
				"fusion.mode": "autonomous",
				"async.enabled": false,
				"task.batch": false,
				"task.prefetch.enabled": false,
				"compaction.enabled": false,
				"retry.enabled": false,
				"tools.approvalMode": "yolo",
				"tools.discoveryMode": "off",
			});
			expect(settings.get("task.isolation.mode")).toBe("none");
			const { session } = await realCreateSession({
				cwd,
				settings,
				sessionManager: SessionManager.inMemory(cwd),
				modelRegistry: registry,
				authStorage: auth,
				model: registry.getAll()[0]!,
				toolNames: ["read", "task"],
				disableExtensionDiscovery: true,
				enableMCP: false,
				enableIrc: false,
				enableLsp: false,
				skipPythonPreflight: true,
				contextFiles: [],
				skills: [],
				rules: [],
				promptTemplates: [],
				slashCommands: [],
			});
			sessions.push(session);
			const value = payload();
			onChild = async child => {
				if (child.getAllToolNames().includes("write")) {
					if (conflict) await fs.writeFile(path.join(cwd, "generated.ts"), "competing parent\n");
				} else
					child.agent.streamFn = createMockModel({
						responses: [
							{ content: [{ type: "toolCall", name: "read", arguments: { path: "bulk.ts" } }] },
							{
								content: [
									{
										type: "toolCall",
										name: "yield",
										arguments: {
											result: { data: { findings: ["[bulk.ts:1-351] 351 constant declarations."] } },
										},
									},
								],
							},
						],
					}).stream;
			};
			const parentTransport = createMockModel({
				responses: [
					{ content: [{ type: "toolCall", name: "read", arguments: { path: "bulk.ts" } }] },
					{
						content: [
							{
								type: "toolCall",
								name: "task",
								arguments: {
									agent: "task",
									id: "DigestFlow",
									assignment:
										"Summarize the declaration count. Acceptance: cite source lines; do not reproduce source.",
									model: value.effectiveModel,
									evidenceDigest: { paths: ["bulk.ts"], question: "How many declarations are present?" },
								},
							},
						],
					},
					{
						content: [
							{
								type: "toolCall",
								name: "task",
								arguments: { ...value.params, id: "CodeFlow", model: value.effectiveModel },
							},
						],
					},
					{ content: [{ type: "toolCall", name: "read", arguments: { path: "agent://CodeFlow" } }] },
					{ content: ["Delegated work is settled; inspect the native receipt."] },
				],
			});
			session.agent.streamFn = parentTransport.stream;
			await session.prompt(
				"Summarize the corpus through a worker, then generate and integrate the new module. Keep all source out of the planning context.",
			);
			const providerContext = JSON.stringify(parentTransport.calls);
			expect(providerContext).toContain("Bulk read blocked");
			expect(providerContext).toContain("351 constant declarations");
			expect(providerContext).not.toContain("BULK_SOURCE_SENTINEL");
			expect(providerContext).not.toContain("NATIVE_SOURCE_SENTINEL");
			expect(providerContext).not.toContain("REFERENCE_SENTINEL");
			const operational = OperationalStore.open();
			try {
				const jobs = operational.listJobs({ type: "native_task" });
				expect(jobs).toHaveLength(2);
				expect(jobs[0]?.status).toBe("completed");
				expect(jobs[1]?.status).toBe(conflict ? "failed" : "completed");
				const checkpoint = parseNativeTaskCheckpoint(operational.getCheckpoint(jobs[1]!.id)!.data);
				if (conflict) {
					expect(checkpoint.integrationError).not.toBeNull();
					for (const file of checkpoint.patchPaths) expect(await Bun.file(file).exists()).toBe(true);
					expect(await fs.readFile(path.join(cwd, "generated.ts"), "utf8")).toBe("competing parent\n");
				} else {
					const receipt = parseNativeTaskReceipt(jobs[1]!.result);
					expect(JSON.parse(receipt.output)).toMatchObject({ kind: "code-write", changesApplied: true });
					expect(providerContext).toContain("sha256");
					expect(providerContext).not.toContain("Not found: CodeFlow");
					expect(
						await fs.readFile(path.join(session.sessionManager.getArtifactsDir()!, "CodeFlow.md"), "utf8"),
					).toBe(receipt.output);
					expect((await fs.readFile(path.join(cwd, "generated.ts"), "utf8")).replaceAll("\r\n", "\n")).toBe(
						source,
					);
				}
				const runtime = {
					session,
					sessionManager: session.sessionManager,
					settings,
					cwd,
					output: () => {},
					refreshCommands: () => {},
					reloadPlugins: async () => {},
				};
				expect(buildFusionStatusText(runtime)).toContain(`0 running / 0 queued / ${conflict ? 1 : 0} failed`);
				expect(AgentRegistry.global().get("Main")?.session).toBe(session);
			} finally {
				operational.close();
			}
		}, 15_000);

	it("dispatches native recovery through the operational CLI without the process parser", async () => {
		const job = store.createJob({ type: "native_task", payload: { agentId: "legacy-incomplete" } });
		const output: string[] = [];
		await runRuntimeCommand(
			{ action: "run", flags: { once: true, json: true } },
			{
				store,
				installSignalHandlers: false,
				io: { writeStdout: line => output.push(line), writeStderr: line => output.push(line) },
			},
		);
		expect(store.getJob(job.id)?.status).toBe("failed");
		expect(store.getJob(job.id)?.error).toContain("native_task payload version");
		expect(output.join("\n")).not.toContain("OMP process");
		expect(internalSessions).toBe(0);
		expect(childSessions).toBe(0);
	});

	it("rejects forged integrated receipts before reconstructing an SDK", async () => {
		for (const output of [
			"{}",
			JSON.stringify({
				kind: "code-write",
				target: "other.ts",
				lines: 1,
				bytes: 3,
				sha256: "bad",
				changesApplied: true,
			}),
		]) {
			const job = store.createJob({ type: "native_task", payload: nativeTaskJson(payload()) });
			store.setCheckpoint(
				job.id,
				nativeTaskJson({
					version: 1,
					phase: "integrated",
					attempt: 1,
					isolationId: null,
					baseline: null,
					patchPaths: [],
					branchName: null,
					integrationError: null,
					receipt: {
						kind: "native-task",
						agentId: "NativeChild",
						output,
						exitCode: 0,
						changesApplied: true,
						mergeSummary: "applied",
						artifacts: [],
						outputPath: "retained.md",
						branchName: null,
					},
				}),
			);
			expect((await runner().runJobById(job.id))?.status).toBe("failed");
		}
		expect(internalSessions).toBe(0);
		expect(childSessions).toBe(0);
	});

	for (const phase of ["prepared", "executing"] as const)
		it(`replays a restricted digest from ${phase} without writing a file`, async () => {
			const value = payload();
			delete value.params.codeWrite;
			value.params.evidenceDigest = { paths: ["reference.ts"], question: "Describe the module without copying it." };
			value.agentDefinition.tools = ["read", "grep", "glob", "ast_grep", "yield"];
			value.policy.toolProfile = {
				tier: "frontier",
				autonomy: "independent",
				editMode: "none",
				allowDiscovery: false,
				toolsConstrained: true,
				maximum: ["read", "grep", "glob", "ast_grep", "yield"].map(name => ({
					name,
					source: name === "yield" ? "hidden" : "builtin",
				})),
			};
			responses = [
				{ content: [{ type: "toolCall", name: "read", arguments: { path: "reference.ts" } }] },
				{
					content: [
						{
							type: "toolCall",
							name: "yield",
							arguments: { result: { data: { finding: "[reference.ts:1] One export." } } },
						},
					],
				},
			];
			const job = store.createJob({ type: "native_task", payload: nativeTaskJson(value) });
			store.setCheckpoint(
				job.id,
				nativeTaskJson({
					version: 1,
					phase,
					attempt: 1,
					isolationId: null,
					baseline: null,
					patchPaths: [],
					branchName: null,
					receipt: null,
					integrationError: null,
				}),
			);
			const result = await runner().runJobById(job.id);
			expect(result?.status).toBe("completed");
			expect(parseNativeTaskReceipt(result!.result).output).toContain("One export");
			expect(childSessions).toBe(1);
			expect(await Bun.file(path.join(cwd, "generated.ts")).exists()).toBe(false);
			expect(parseNativeTaskCheckpoint(store.getCheckpoint(job.id)!.data).attempt).toBe(2);
		});

	for (const phase of ["integrating", "integrated"] as const)
		it(`does not report success when lease ownership changes after ${phase}`, async () => {
			const job = store.createJob({ type: "native_task", payload: nativeTaskJson(payload()) });
			const other = OperationalStore.open({ dbPath: store.dbPath });
			const replaceOwner = () => {
				const current = other.getJob(job.id)!;
				other.transitionJob(job.id, { to: "queued", leaseOwner: current.leaseOwner });
				other.claimJobById(job.id, "new-owner", 20_000);
			};
			if (phase === "integrating") {
				const realIntegrate = integration.integrateTaskResult;
				vi.spyOn(integration, "integrateTaskResult").mockImplementation(async options => {
					await realIntegrate(options);
					replaceOwner();
				});
			} else {
				const write = store.setCheckpointForLease.bind(store);
				vi.spyOn(store, "setCheckpointForLease").mockImplementation((id, owner, data) => {
					const saved = write(id, owner, data);
					if (parseNativeTaskCheckpoint(data).phase === "integrated") replaceOwner();
					return saved;
				});
			}
			try {
				const result = await runner().runJobById(job.id);
				expect(result?.status).toBe("running");
				expect(result?.leaseOwner).toBe("new-owner");
				expect(parseNativeTaskCheckpoint(store.getCheckpoint(job.id)!.data).phase).toBe(phase);
				expect(await Bun.file(path.join(cwd, "generated.ts")).exists()).toBe(true);
			} finally {
				other.close();
			}
		});

	it("serializes a real child-process lock contender", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const owner = new DurableRunner({
			store,
			executor: async ctx => {
				const unlock = await acquireNativeTaskIntegrationLock({ store, ctx, artifactsDir, repoRoot: cwd });
				entered.resolve();
				try {
					await release.promise;
				} finally {
					await unlock();
				}
			},
		});
		const holding = owner.runJobById(owner.enqueue({ type: "lock-owner", payload: {} }).id);
		await entered.promise;
		const job = store.createJob({ type: "lock-contender", payload: {} });
		const marker = path.join(dir.path(), "lock-stage.txt");
		const result = path.join(dir.path(), "lock-result.json");
		const config = path.join(dir.path(), "lock-config.json");
		await fs.writeFile(
			config,
			JSON.stringify({ dbPath: store.dbPath, artifactsDir, cwd, marker, result, jobId: job.id }),
		);
		const process = Bun.spawn(
			[Bun.which("bun")!, path.join(import.meta.dir, "fixtures", "native-task-lock.fixture.ts"), config],
			{ cwd, stdout: "pipe", stderr: "pipe" },
		);
		const stdout = new Response(process.stdout).text();
		const stderr = new Response(process.stderr).text();
		try {
			const deadline = Date.now() + 5000;
			while (!(await Bun.file(marker).exists())) {
				if (process.exitCode !== null || Date.now() > deadline) throw new Error("Lock contender failed to start");
				await Bun.sleep(10);
			}
			await Bun.sleep(100);
			expect(await fs.readFile(marker, "utf8")).toBe("waiting");
			release.resolve();
			await holding;
			expect(await process.exited).toBe(0);
			expect(JSON.parse(await fs.readFile(result, "utf8"))).toMatchObject({
				status: "completed",
				result: { acquired: true },
			});
			expect(await fs.readFile(marker, "utf8")).toBe("acquired");
		} finally {
			release.resolve();
			await holding;
			owner.dispose();
			if (process.exitCode === null) process.kill();
			await process.exited;
			await Promise.all([stdout, stderr]);
		}
	}, 10_000);

	it("preserves actual submodule enumeration after the empty-index fast path", async () => {
		expect(await gitOps.ls.submodules(cwd)).toEqual([]);
		const childRepo = path.join(dir.path(), "submodule-source");
		await fs.mkdir(childRepo);
		const original = cwd;
		cwd = childRepo;
		try {
			await git("init");
			await git("config", "user.name", "Fixture");
			await git("config", "user.email", "fixture@example.com");
			await fs.writeFile(path.join(cwd, "child.txt"), "submodule");
			await git("add", ".");
			await git("commit", "-m", "child");
		} finally {
			cwd = original;
		}
		await git("-c", "protocol.file.allow=always", "submodule", "add", childRepo, "nested-child");
		expect(await gitOps.ls.submodules(cwd)).toContain("nested-child");
		expect((await worktree.captureBaseline(cwd)).nested).toHaveLength(0);
	}, 10_000);

	it("projects durable async completion into the original parent handles", async () => {
		const { AsyncJobManager } = await import("../../src/async");
		const settings = Settings.isolated({
			"fusion.enabled": true,
			"fusion.mode": "autonomous",
			"task.batch": false,
			"async.enabled": true,
			"tools.approvalMode": "yolo",
			"tools.discoveryMode": "off",
		});
		const { session } = await realCreateSession({
			cwd,
			settings,
			sessionManager: SessionManager.inMemory(cwd),
			modelRegistry: registry,
			authStorage: auth,
			model: registry.getAll()[0]!,
			toolNames: ["task", "read"],
			disableExtensionDiscovery: true,
			enableMCP: false,
			enableIrc: false,
			enableLsp: false,
			skipPythonPreflight: true,
			contextFiles: [],
			skills: [],
			rules: [],
			promptTemplates: [],
			slashCommands: [],
		});
		sessions.push(session);
		responses[1] = {
			content: [
				{
					type: "toolCall",
					name: "yield",
					arguments: { result: { data: { raw: source, reference: "REFERENCE_SENTINEL" } } },
				},
			],
		};
		const updates: unknown[] = [];
		const value = payload();
		const scheduled = await session
			.getToolByName("task")!
			.execute("async", { ...value.params, id: "AsyncNative", model: value.effectiveModel }, undefined, update =>
				updates.push(update),
			);
		const details = scheduled.details as import("../../src/task/types").TaskToolDetails;
		const job = AsyncJobManager.instance()?.getJob(details.async!.jobId);
		if (!job) throw new Error("Native async job not registered");
		await job.promise;
		expect(job.status).toBe("completed");
		expect(JSON.parse(job.resultText!)).toMatchObject({ kind: "code-write", changesApplied: true });
		expect(JSON.stringify({ scheduled, updates, completion: job.resultText })).not.toContain(
			"NATIVE_SOURCE_SENTINEL",
		);
		expect(JSON.stringify({ scheduled, updates, completion: job.resultText })).not.toContain("REFERENCE_SENTINEL");
		const handle = await session.getToolByName("read")!.execute("handle", { path: "agent://AsyncNative:raw" });
		expect(JSON.stringify(handle.content)).toContain("sha256");
		expect(JSON.stringify(handle.content)).not.toContain("NATIVE_SOURCE_SENTINEL");
		const durable = store.listJobs({ type: "native_task" });
		expect(durable).toHaveLength(1);
		expect(durable[0]?.status).toBe("completed");
		expect(durable[0]?.id).not.toBe(job.id);
		const runtime = {
			session,
			sessionManager: session.sessionManager,
			settings,
			cwd,
			output: () => {},
			refreshCommands: () => {},
			reloadPlugins: async () => {},
		};
		for (let i = 0; i < 101; i++) store.createJob({ type: "native_task", payload: {} });
		expect(buildFusionStatusText(runtime)).toContain("0 running / 101 queued / 0 failed");
		const open = vi.spyOn(OperationalStore, "open").mockImplementation(() => {
			throw new Error("Unavailable status storage");
		});
		expect(buildFusionStatusText(runtime)).toContain("Native tasks:   unavailable");
		open.mockRestore();
	}, 10_000);
});
