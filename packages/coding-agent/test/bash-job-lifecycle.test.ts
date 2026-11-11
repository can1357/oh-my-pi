import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import type { PipeStreams } from "@oh-my-pi/pi-natives";
import { becomesCollectible } from "../../tui/test/gc";
import { AsyncJobManager, type AsyncJobRegisterOptions } from "../src/async";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { parseInternalUrl } from "../src/internal-urls/parse";
import { ProcProtocolHandler } from "../src/internal-urls/proc-protocol";
import { SessionManager } from "../src/session/session-manager";
import type { RemoteObject } from "../src/thread/rpc";
import { toJobWire } from "../src/thread/services/async-jobs";
import {
	type AsyncJobManagerProtocol,
	fromWireReason,
	toWireSignal,
	type WireJobFeed,
} from "../src/thread/services/async-jobs-protocol";
import { RemoteAsyncJobManager } from "../src/thread/services/async-jobs-remote";
import type { ToolSession } from "../src/tools";
import { BashTool } from "../src/tools/bash";
import { WriteTool } from "../src/tools/write";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

type ProtocolSyncHandlers = {
	[K in keyof AsyncJobManagerProtocol]: (
		...args: AsyncJobManagerProtocol[K]["args"]
	) => AsyncJobManagerProtocol[K]["result"];
};

type ProtocolAsyncHandlers = {
	[K in keyof AsyncJobManagerProtocol]?: (
		...args: AsyncJobManagerProtocol[K]["args"]
	) => Promise<AsyncJobManagerProtocol[K]["result"]>;
};

function asyncOnly(method: string): never {
	throw new Error(`RPC method ${method} is async-only`);
}

function createDirectRemoteManager(
	target: AsyncJobManager,
	onFeed?: (feed: WireJobFeed | undefined) => void,
): RemoteAsyncJobManager {
	const sync: ProtocolSyncHandlers = {
		hasWidgets: () => target.widgets !== undefined,
		atCapacity: () => target.atCapacity,
		onJobSettled: listener => target.onJobSettled(() => void listener()),
		register: (type, label, wiredRun, wireOptions) => {
			onFeed?.(wireOptions?.feed);
			return target.register(
				type,
				label,
				ctx =>
					wiredRun({
						jobId: ctx.jobId,
						signal: toWireSignal(ctx.signal),
						reportProgress: ctx.reportProgress,
						markRunning: ctx.markRunning,
						pushFeed: wireOptions?.feed ? () => {} : undefined,
					}),
				{
					id: wireOptions?.id,
					ownerId: wireOptions?.ownerId,
					agentId: wireOptions?.agentId,
					onProgress: wireOptions?.onProgress,
					queued: wireOptions?.queued,
					foreground: wireOptions?.foreground,
					intent: wireOptions?.intent,
				},
			);
		},
		publishCompleted: (type, label, result, options) => target.publishCompleted(type, label, result, options),
		cancel: (id, filter) => target.cancel(id, filter),
		getJob: id => {
			const job = target.getJob(id);
			return job ? toJobWire(job) : undefined;
		},
		getRunningJobs: filter => target.getRunningJobs(filter).map(toJobWire),
		getRecentJobs: (limit, filter) => target.getRecentJobs(limit, filter).map(toJobWire),
		getAllJobs: filter => target.getAllJobs(filter).map(toJobWire),
		backgroundJob: jobId => target.backgroundJob(jobId),
		releaseForegroundJob: jobId => target.releaseForegroundJob(jobId),
		getDeliveryState: filter => target.getDeliveryState(filter),
		hasPendingDeliveries: filter => target.hasPendingDeliveries(filter),
		watchJobs: jobIds => target.watchJobs(jobIds),
		unwatchJobs: jobIds => target.unwatchJobs(jobIds),
		acknowledgeDeliveries: jobIds => target.acknowledgeDeliveries(jobIds),
		consumeJobResults: jobIds => target.consumeJobResults(jobIds),
		isJobResultConsumed: jobId => target.isJobResultConsumed(jobId),
		cancelAll: (filter, reason) => target.cancelAll(filter, fromWireReason(reason)),
		evictCompletedJobs: filter => target.evictCompletedJobs(filter),
		waitForAll: () => asyncOnly("waitForAll"),
		registerDeliverySink: (ownerId, sink) =>
			target.registerDeliverySink(ownerId, (jobId, text, job) =>
				sink(jobId, text, job ? toJobWire(job) : undefined),
			),
		waitForOwnerJobs: () => asyncOnly("waitForOwnerJobs"),
		cancelAndReapOwnerJobs: () => asyncOnly("cancelAndReapOwnerJobs"),
		drainDeliveries: () => asyncOnly("drainDeliveries"),
		isDeliverySuppressed: jobId => target.isDeliverySuppressed(jobId),
		isDeliveryPending: jobId => target.isDeliveryPending(jobId),
		isDeliverySuperseded: jobId => target.isDeliverySuperseded(jobId),
		whenSettled: () => asyncOnly("whenSettled"),
		signal: jobId => {
			const job = target.getJob(jobId);
			return job ? toWireSignal(job.abortController.signal) : undefined;
		},
		setRetainedArtifactsCleanup: (jobId, cleanup) => {
			const job = target.getJob(jobId);
			if (job) job.retainedArtifactsCleanup = cleanup;
		},
		widgetView: jobId => {
			const job = target.getJob(jobId);
			return job ? target.widgets?.view(job) : undefined;
		},
		widgetCaption: jobId => {
			const job = target.getJob(jobId);
			return job ? target.widgets?.caption(job) : undefined;
		},
		widgetRequestCaption: jobId => {
			const job = target.getJob(jobId);
			if (job) target.widgets?.requestCaption(job);
		},
		widgetSubscribe: listener => (target.widgets ? target.widgets.subscribe(() => void listener()) : () => {}),
		widgetForget: jobId => target.widgets?.forget(jobId),
	};

	const asyncMethods: ProtocolAsyncHandlers = {
		waitForAll: () => target.waitForAll(),
		waitForOwnerJobs: (ownerId, options) => target.waitForOwnerJobs(ownerId, options),
		cancelAndReapOwnerJobs: (ownerId, deadlineAt) => target.cancelAndReapOwnerJobs(ownerId, deadlineAt),
		drainDeliveries: options => target.drainDeliveries(options),
		whenSettled: async jobId => {
			await target.getJob(jobId)?.promise;
		},
	};

	const remote: RemoteObject<AsyncJobManagerProtocol> = {
		id: 1,
		call<K extends keyof AsyncJobManagerProtocol & string>(
			method: K,
			...args: AsyncJobManagerProtocol[K]["args"]
		): Promise<AsyncJobManagerProtocol[K]["result"]> {
			const asyncHandler:
				| ((...a: AsyncJobManagerProtocol[K]["args"]) => Promise<AsyncJobManagerProtocol[K]["result"]>)
				| undefined = asyncMethods[method];
			if (asyncHandler) return asyncHandler(...args);
			const syncHandler: (...a: AsyncJobManagerProtocol[K]["args"]) => AsyncJobManagerProtocol[K]["result"] =
				sync[method];
			return Promise.resolve(syncHandler(...args));
		},
		callSync<K extends keyof AsyncJobManagerProtocol & string>(
			method: K,
			...args: AsyncJobManagerProtocol[K]["args"]
		): AsyncJobManagerProtocol[K]["result"] {
			const syncHandler: (...a: AsyncJobManagerProtocol[K]["args"]) => AsyncJobManagerProtocol[K]["result"] =
				sync[method];
			return syncHandler(...args);
		},
		notify<K extends keyof AsyncJobManagerProtocol & string>(
			method: K,
			...args: AsyncJobManagerProtocol[K]["args"]
		): void {
			const syncHandler: (...a: AsyncJobManagerProtocol[K]["args"]) => AsyncJobManagerProtocol[K]["result"] =
				sync[method];
			syncHandler(...args);
		},
	};

	return new RemoteAsyncJobManager(remote);
}

let cwd: string;
let manager: AsyncJobManager;
let authStorage: AuthStorage;
let tool: BashTool;
let write: WriteTool;

beforeEach(async () => {
	cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-job-lifecycle-"));
	manager = new AsyncJobManager({});
	authStorage = createInMemoryAuthStorage();
	const session: ToolSession = {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionId: () => cwd,
		getSessionSpawns: () => "*",
		asyncJobManager: manager,
		settings: Settings.isolated({}),
	};
	tool = new BashTool(session);
	write = new WriteTool(session);
});

afterEach(async () => {
	await manager.dispose();
	authStorage.close();
	await fs.rm(cwd, { recursive: true, force: true });
});

it.skipIf(process.platform === "win32")(
	"allows a cancelled bash job to run its TERM cleanup",
	async () => {
		const script = path.join(cwd, "cleanup.sh");
		await Bun.write(
			script,
			"trap 'sleep 0.2; printf cleaned >> cleaned; exit 0' TERM\nprintf 'ready\\n'\nwhile :; do :; done\n",
		);
		const ready = Promise.withResolvers<void>();
		const result = await tool.execute(
			"term-cleanup",
			{ command: `sh ${JSON.stringify(script)}`, async: true, timeout: 0 },
			undefined,
			update => {
				if (update.content?.some(block => block.type === "text" && block.text.includes("ready"))) ready.resolve();
			},
		);
		await ready.promise;
		const id = result.details?.async?.jobId;
		if (!id) throw new Error("expected background job");
		const watchAbort = new AbortController();
		const watcher = fs.watch(cwd, { signal: watchAbort.signal });
		const cleaned = (async () => {
			for await (const event of watcher) {
				if (event.filename === "cleaned") return true;
			}
			return false;
		})();
		// A real subprocess handles TERM; fake timers cannot bound its OS-level cleanup.
		const deadline = Promise.withResolvers<false>();
		const watchdog = setTimeout(() => deadline.resolve(false), 3_000);
		try {
			const cancelled = await write.execute("cancel-cleanup", { path: `proc://${id}/kill` });
			expect(cancelled.details?.proc).toMatchObject({ cancelled: [{ id, status: "cancelled" }] });
			await manager.waitForAll();
			expect(await Promise.race([cleaned, deadline.promise])).toBe(true);
			expect(await Bun.file(path.join(cwd, "cleaned")).text()).toBe("cleaned");
		} finally {
			clearTimeout(watchdog);
			watchAbort.abort();
			await cleaned.catch(() => {});
		}
	},
	10_000,
);

it.skipIf(process.platform === "win32")("gives a background job the session identity", async () => {
	const sessionFile = path.join(cwd, "sessions", "bg.jsonl");
	const job = new BashTool({
		cwd,
		hasUI: false,
		getSessionFile: () => sessionFile,
		getSessionId: () => "session-bg",
		getSessionSpawns: () => "*",
		asyncJobManager: manager,
		settings: Settings.isolated({}),
	});
	const result = await job.execute("bg-env", {
		command: `printf '%s|%s|%s' "$PI_SESSION_ID" "$PI_SESSION_FILE" "$PI_TOOL_CALL_ID" > env.txt`,
		async: true,
	});
	if (!result.details?.async?.jobId) throw new Error("expected background job");
	await manager.waitForAll();
	const [id, file, callId] = (await Bun.file(path.join(cwd, "env.txt")).text()).split("|");
	expect(id).toBe("session-bg");
	expect(file).toBe(sessionFile);
	expect(callId).toBe("bg-env");
});

it.skipIf(process.platform === "win32")(
	"releases foreground PipeStreams on normal completion without surfacing a background job",
	async () => {
		const runForegroundPipeline = async (): Promise<{ text: string; streamsRef: WeakRef<PipeStreams> }> => {
			let streamsRef: WeakRef<PipeStreams> | undefined;
			const originalRegister = manager.register.bind(manager);
			const registerSpy = vi
				.spyOn(manager, "register")
				.mockImplementation((type, label, run, options?: AsyncJobRegisterOptions) => {
					if (options?.process?.streams) {
						streamsRef = new WeakRef(options.process.streams);
					}
					return originalRegister(type, label, run, options);
				});
			try {
				const fgTool = new BashTool({
					cwd,
					hasUI: false,
					getAgentId: () => "Main",
					getSessionFile: () => null,
					getSessionId: () => "fg-release",
					getSessionSpawns: () => "*",
					asyncJobManager: manager,
					settings: Settings.isolated({
						"async.enabled": true,
						"bash.autoBackground.enabled": true,
						"bash.autoBackground.thresholdMs": 60_000,
					}),
				});
				const result = await fgTool.execute("fg-pipe", {
					command: "printf 'stage-1\\nstage-2\\n' | cat",
				});
				await manager.waitForAll();
				const textBlock = result.content.find(block => block.type === "text");
				if (!streamsRef || !textBlock || textBlock.type !== "text") {
					throw new Error("expected foreground pipeline output and PipeStreams registration");
				}
				return { text: textBlock.text, streamsRef };
			} finally {
				registerSpy.mockRestore();
			}
		};

		const { text, streamsRef } = await runForegroundPipeline();
		expect(text).toContain("stage-1\nstage-2");
		expect(manager.getAllJobs()).toEqual([]);
		expect(await becomesCollectible(streamsRef)).toBe(true);
	},
);

it.skipIf(process.platform === "win32")(
	"releases worker-local inputs on RemoteAsyncJobManager when a foreground bash call settles",
	async () => {
		let retainedFeed: WireJobFeed | undefined;
		const remoteManager = createDirectRemoteManager(manager, feed => {
			retainedFeed = feed;
		});
		const runRemoteForeground = async (): Promise<WeakRef<PipeStreams>> => {
			let streamsRef: WeakRef<PipeStreams> | undefined;
			const origRegister = remoteManager.register.bind(remoteManager);
			const spy = vi
				.spyOn(remoteManager, "register")
				.mockImplementation((type, label, run, options?: AsyncJobRegisterOptions) => {
					if (options?.process?.streams) {
						streamsRef = new WeakRef(options.process.streams);
					}
					return origRegister(type, label, run, options);
				});
			try {
				const remoteTool = new BashTool({
					cwd,
					hasUI: false,
					getAgentId: () => "Worker",
					getSessionFile: () => null,
					getSessionId: () => "worker-fg",
					getSessionSpawns: () => "*",
					asyncJobManager: remoteManager,
					settings: Settings.isolated({
						"async.enabled": true,
						"bash.autoBackground.enabled": true,
						"bash.autoBackground.thresholdMs": 60_000,
					}),
				});
				const res = await remoteTool.execute("remote-fg-pipe", {
					command: "printf 'worker-pipe\\n' | cat",
				});
				expect(res.content[0]).toMatchObject({ type: "text" });
				await manager.waitForAll();
				if (!streamsRef) throw new Error("expected PipeStreams registration on remote manager");
				return streamsRef;
			} finally {
				spy.mockRestore();
			}
		};

		const streamsRef = await runRemoteForeground();
		expect(retainedFeed).toBeDefined();
		expect(await becomesCollectible(streamsRef)).toBe(true);
	},
);

it.skipIf(process.platform === "win32")(
	"keeps worker PipeStreams on RemoteAsyncJobManager when releaseForegroundJob runs after promotion",
	async () => {
		const remoteManager = createDirectRemoteManager(manager);
		const steer = new AbortController();
		const workerSession: ToolSession = {
			cwd,
			hasUI: false,
			getAgentId: () => "Worker",
			getSessionFile: () => null,
			getSessionId: () => "worker-promoted",
			getSessionSpawns: () => "*",
			asyncJobManager: remoteManager,
			settings: Settings.isolated({
				"async.enabled": true,
				"launch.enabled": false,
				"bash.autoBackground.enabled": true,
				"bash.autoBackground.thresholdMs": 60_000,
			}),
		};
		const remoteTool = new BashTool(workerSession);
		const ctx: AgentToolContext = {
			sessionManager: SessionManager.inMemory(),
			modelRegistry: new ModelRegistry(authStorage),
			model: undefined,
			isIdle: () => false,
			hasQueuedMessages: () => true,
			abort: () => {},
			toolNames: [],
			toolCall: {
				batchId: "batch-worker-promote",
				index: 0,
				total: 1,
				toolCalls: [{ id: "worker-promote-pipe", name: "bash" }],
				steeringSignal: steer.signal,
			},
		};

		const marker = path.join(cwd, "worker-pipe-ready");
		const execPromise = remoteTool.execute(
			"worker-promote-pipe",
			{
				command: `{ printf 'promoted-1\\npromoted-2\\n'; printf x > ${JSON.stringify(marker)}; sleep 30; } | tail -n 1`,
				timeout: 0,
			},
			undefined,
			undefined,
			ctx,
		);
		const deadline = Date.now() + 5_000;
		while (!(await Bun.file(marker).exists()) && Date.now() < deadline) {
			await Bun.sleep(10);
		}
		steer.abort();

		const handoff = await execPromise;
		const jobId = handoff.details?.async?.jobId;
		if (!jobId) throw new Error("expected worker foreground command to promote to a background job");

		expect(remoteManager.releaseForegroundJob(jobId)).toBe(false);
		expect(manager.getJob(jobId)).toBeDefined();

		const proc = new ProcProtocolHandler();
		const listResource = await proc.resolve(parseInternalUrl(`proc://${jobId}/streams`), {
			session: workerSession,
		});
		expect(listResource.content).toContain(`proc://${jobId}/streams/1`);
		const streamResource = await proc.resolve(parseInternalUrl(`proc://${jobId}/streams/1`), {
			session: workerSession,
		});
		expect(streamResource.content).toBe("promoted-1\npromoted-2\n");

		await proc.write(parseInternalUrl(`proc://${jobId}/kill`), "", { session: workerSession });
		await manager.waitForAll();
	},
	10_000,
);

it.skipIf(process.platform === "win32")(
	"retains proc://<id>/streams when a foreground pipeline hands off to background via steering",
	async () => {
		const steer = new AbortController();
		const session: ToolSession = {
			cwd,
			hasUI: false,
			getAgentId: () => "Main",
			getSessionFile: () => null,
			getSessionId: () => "fg-handoff",
			getSessionSpawns: () => "*",
			asyncJobManager: manager,
			settings: Settings.isolated({
				"async.enabled": true,
				"launch.enabled": false,
				"bash.autoBackground.enabled": true,
				"bash.autoBackground.thresholdMs": 60_000,
			}),
		};
		const fgTool = new BashTool(session);
		const ctx: AgentToolContext = {
			sessionManager: SessionManager.inMemory(),
			modelRegistry: new ModelRegistry(authStorage),
			model: undefined,
			isIdle: () => false,
			hasQueuedMessages: () => true,
			abort: () => {},
			toolNames: [],
			toolCall: {
				batchId: "batch-steer",
				index: 0,
				total: 1,
				toolCalls: [{ id: "handoff-pipe", name: "bash" }],
				steeringSignal: steer.signal,
			},
		};

		const marker = path.join(cwd, "pipe-ready");
		const execPromise = fgTool.execute(
			"handoff-pipe",
			{
				command: `{ printf 'held-1\\nheld-2\\n'; printf x > ${JSON.stringify(marker)}; sleep 30; } | tail -n 1`,
				timeout: 0,
			},
			undefined,
			undefined,
			ctx,
		);
		const deadline = Date.now() + 5_000;
		while (!(await Bun.file(marker).exists()) && Date.now() < deadline) {
			await Bun.sleep(10);
		}
		steer.abort();

		const handoff = await execPromise;
		const jobId = handoff.details?.async?.jobId;
		if (!jobId) throw new Error("expected foreground command to hand off to a background job");

		const proc = new ProcProtocolHandler();
		const listResource = await proc.resolve(parseInternalUrl(`proc://${jobId}/streams`), { session });
		expect(listResource.content).toContain(`proc://${jobId}/streams/1`);
		const streamResource = await proc.resolve(parseInternalUrl(`proc://${jobId}/streams/1`), { session });
		expect(streamResource.content).toBe("held-1\nheld-2\n");

		await proc.write(parseInternalUrl(`proc://${jobId}/kill`), "", { session });
		await manager.waitForAll();
	},
	10_000,
);
