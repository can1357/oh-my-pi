import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ASYNC_JOB_LABEL_MAX_CHARS } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type {
	ExtensionAsyncJobAccess,
	ExtensionContext,
	ExtensionRuntime,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AsyncResultEntry } from "@oh-my-pi/pi-coding-agent/session/async-job-delivery";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { resolveInlineByteCapBudget } from "@oh-my-pi/pi-coding-agent/tools/output-meta";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@oh-my-pi/pi-coding-agent/tools/streaming-output";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

function createRunner(asyncJobs?: ExtensionAsyncJobAccess): ExtensionRunner {
	const runtime = {
		flagValues: new Map(),
		pendingProviderRegistrations: [],
	} as unknown as ExtensionRuntime;
	return new ExtensionRunner(
		[],
		runtime,
		"/tmp",
		{ getCwd: () => "/tmp" } as never,
		{} as never,
		undefined,
		undefined,
		undefined,
		asyncJobs,
	);
}

describe("ExtensionRunner async job context", () => {
	it("defaults to null and no-op cancel outside a session", () => {
		const ctx = createRunner().createContext();
		expect(ctx.getAsyncJobSnapshot()).toBeNull();
		expect(ctx.cancelAsyncJob("job-1")).toBe(false);
	});

	it("cancels through the owning session", () => {
		const cancelled: string[] = [];
		const ctx = createRunner({
			getSnapshot: () => null,
			cancel: id => {
				cancelled.push(id);
				return id === "job-1";
			},
		}).createContext();
		expect(ctx.cancelAsyncJob("job-1")).toBe(true);
		expect(ctx.cancelAsyncJob("job-2")).toBe(false);
		expect(cancelled).toEqual(["job-1", "job-2"]);
	});
});

// Extensions that run work elsewhere (a remote host, a job queue) register it as a session job
// so the agent can `wait` on it, cancel it, and receive its result like a native background job.
describe("ExtensionContext.asyncJobs", () => {
	let tempDir: string;
	let session: AgentSession | undefined;
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-ext-async-jobs-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await session?.dispose();
		session = undefined;
		for (const authStorage of authStorages.splice(0)) authStorage.close();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	async function extensionContext(): Promise<ExtensionContext> {
		const authStorage = createInMemoryAuthStorage();
		authStorages.push(authStorage);
		let seen: ExtensionContext | undefined;
		({ session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir, "models.yml")),
			settings: Settings.isolated(),
			sessionManager: SessionManager.inMemory(),
			disableExtensionDiscovery: true,
			extensions: [
				pi => {
					pi.on("before_agent_start", (_event, ctx) => {
						seen = ctx;
					});
				},
			],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
		}));
		await session!.extensionRunner!.emitBeforeAgentStart("hi", undefined, []);
		return seen!;
	}

	it("runs a job the session lists and delivers its result to the owning agent", async () => {
		const ctx = await extensionContext();
		const delivered = Promise.withResolvers<AsyncResultEntry>();
		const enqueue = session!.yieldQueue.enqueueWithReceipt.bind(session!.yieldQueue);
		vi.spyOn(session!.yieldQueue, "enqueueWithReceipt").mockImplementation((kind, entry) => {
			if (kind !== "async-result") return enqueue(kind, entry);
			delivered.resolve(entry as AsyncResultEntry);
			return Promise.resolve();
		});
		const gate = Promise.withResolvers<string>();
		const progressed = Promise.withResolvers<void>();
		const jobId = ctx.asyncJobs!.register(
			"remote build",
			async ({ reportProgress }) => {
				await reportProgress("compiling");
				progressed.resolve();
				return await gate.promise;
			},
			{ intent: "Build on the remote host" },
		);

		await progressed.promise;
		expect(session!.getAsyncJobSnapshot()?.running).toMatchObject([
			{ id: jobId, type: "extension", label: "remote build", intent: "Build on the remote host" },
		]);
		expect(session!.asyncJobManager!.getJob(jobId)).toMatchObject({ ownerId: "Main", progressText: "compiling" });

		gate.resolve("REMOTE BUILD GREEN");
		const entry = await delivered.promise;
		expect(entry).toMatchObject({ jobId, result: "REMOTE BUILD GREEN" });
		expect(session!.getAsyncJobSnapshot()?.running).toEqual([]);
	});

	it("gives a job registered from an advisor-scoped context to the session's agent", async () => {
		await extensionContext();
		const advisorCtx = session!.extensionRunner!.createContext(undefined, undefined, {
			kind: "sub",
			id: "advisor",
			name: "advisor",
			depth: 0,
			parentId: "Main",
		});
		const gate = Promise.withResolvers<string>();
		const jobId = advisorCtx.asyncJobs!.register("advisor hook job", () => gate.promise);

		expect(session!.getAsyncJobSnapshot()?.running.map(job => job.id)).toEqual([jobId]);
		expect(session!.cancelAsyncJob(jobId)).toBe(true);
		gate.resolve("unused");
	});

	it("stores an extension-supplied label and intent as one bounded, escape-free line each", async () => {
		const ctx = await extensionContext();
		const gate = Promise.withResolvers<string>();
		const jobId = ctx.asyncJobs!.register(`\u001b[2Jbuild\n\ttarget ${"x".repeat(300)}`, () => gate.promise, {
			intent: `ship\u001b[31m\n\nrelease ${"y".repeat(300)}`,
		});

		const job = session!.getAsyncJobSnapshot()!.running.find(row => row.id === jobId)!;
		expect(job.label).toStartWith("build target xxx");
		expect(job.intent).toStartWith("ship release yyy");
		for (const text of [job.label, job.intent!]) {
			expect(text).not.toContain("\n");
			expect(text).not.toContain("\u001b");
			expect(text.length).toBeLessThanOrEqual(ASYNC_JOB_LABEL_MAX_CHARS);
		}
		gate.resolve("unused");
	});

	it("keeps only the tail of an oversized progress report, as a background bash job's output does", async () => {
		const ctx = await extensionContext();
		const gate = Promise.withResolvers<string>();
		const progressed = Promise.withResolvers<void>();
		const log = Array.from({ length: 20_000 }, (_, line) => `remote log line ${line}`).join("\n");
		const jobId = ctx.asyncJobs!.register("remote log", async ({ reportProgress }) => {
			await reportProgress(log);
			progressed.resolve();
			return await gate.promise;
		});

		await progressed.promise;
		const progress = session!.asyncJobManager!.getJob(jobId)!.progressText!;
		expect(Buffer.byteLength(progress)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
		expect(progress.split("\n").length).toBeLessThanOrEqual(DEFAULT_MAX_LINES);
		expect(progress).toEndWith("remote log line 19999");
		gate.resolve("unused");
	});

	it("caps an oversized result and failure message the way a bash result is capped", async () => {
		const ctx = await extensionContext();
		let delivered = 0;
		const bothDelivered = Promise.withResolvers<void>();
		const enqueue = session!.yieldQueue.enqueueWithReceipt.bind(session!.yieldQueue);
		vi.spyOn(session!.yieldQueue, "enqueueWithReceipt").mockImplementation((kind, entry) => {
			if (kind !== "async-result") return enqueue(kind, entry);
			if (++delivered === 2) bothDelivered.resolve();
			return Promise.resolve();
		});
		const output = Array.from({ length: 50_000 }, (_, line) => `remote output line ${line}`).join("\n");
		const done = ctx.asyncJobs!.register("remote build", async () => output);
		const failed = ctx.asyncJobs!.register("remote test", async () => {
			throw new Error(output);
		});

		await bothDelivered.promise;
		const manager = session!.asyncJobManager!;
		for (const text of [manager.getJob(done)!.resultText!, manager.getJob(failed)!.errorText!]) {
			expect(Buffer.byteLength(text)).toBeLessThanOrEqual(resolveInlineByteCapBudget(undefined));
			expect(text).toStartWith("remote output line 0\n");
			expect(text).toContain("elided");
			expect(text).toContain("remote output line 49999");
			const artifactId = /local:\/\/([^\s\]:]+)\.log/.exec(text)?.[1];
			const artifactPath = await session!.sessionManager.getArtifactPath(artifactId!);
			expect(await Bun.file(artifactPath!).text()).toBe(output);
		}
	});

	it("aborts the job's signal when the agent cancels it", async () => {
		const ctx = await extensionContext();
		const aborted = Promise.withResolvers<void>();
		const jobId = ctx.asyncJobs!.register("remote watch", async ({ signal }) => {
			signal.addEventListener("abort", () => aborted.resolve(), { once: true });
			await aborted.promise;
			return "late result";
		});

		expect(session!.cancelAsyncJob(jobId)).toBe(true);
		await aborted.promise;
		await session!.asyncJobManager!.waitForAll();
		expect(session!.asyncJobManager!.getJob(jobId)?.status).toBe("cancelled");
		expect(session!.asyncJobManager!.hasPendingDeliveries({ ownerId: "Main" })).toBe(false);
	});
});
