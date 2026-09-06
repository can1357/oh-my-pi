import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession, type ExtensionFactory } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AsyncJobSnapshot } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

describe("AsyncJobManager singleton across concurrent top-level sessions", () => {
	const tempDirs: string[] = [];
	// Building a ModelRegistry per session is the dominant cost here: createAgentSession
	// otherwise runs discoverAuthStorage (a fresh AuthStorage DB create+reload) and a
	// background online model refresh for every spawn (~450ms each). The singleton
	// ownership behavior under test is independent of model resolution, so we hand every
	// session one shared, network-free registry built once (~10ms/session instead).
	let sharedTempDir: string;
	let sharedAuthStorage: AuthStorage;
	let sharedModelRegistry: ModelRegistry;

	beforeAll(async () => {
		sharedTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sdk-async-singleton-shared-"));
		sharedAuthStorage = await AuthStorage.create(path.join(sharedTempDir, "auth.db"));
		sharedModelRegistry = new ModelRegistry(sharedAuthStorage, path.join(sharedTempDir, "models.yml"));
	});

	afterAll(() => {
		sharedAuthStorage.close();
		removeSyncWithRetries(sharedTempDir);
	});

	afterEach(async () => {
		for (const tempDir of tempDirs.splice(0)) {
			removeSyncWithRetries(tempDir);
		}
		AsyncJobManager.resetForTests();
	});

	async function spawnTopLevelSession(extraSettings?: Record<string, unknown>, extensions: ExtensionFactory[] = []) {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-async-singleton-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, `project-${Snowflake.next()}`);
		const agentDir = path.join(tempDir, "agent");
		fs.mkdirSync(cwd, { recursive: true });
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			settings: Settings.isolated({ "bash.autoBackground.enabled": true, ...extraSettings }),
			disableExtensionDiscovery: true,
			extensions,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			modelRegistry: sharedModelRegistry,
		});
		return session;
	}

	it("keeps the primary session's manager installed after a secondary session disposes", async () => {
		const primary = await spawnTopLevelSession();
		try {
			const primaryManager = AsyncJobManager.instance();
			expect(primaryManager).toBeDefined();

			const secondary = await spawnTopLevelSession();
			try {
				// While the secondary is alive the global instance MUST still point at
				// the primary's manager so background tools keep delivering completions
				// to the primary session that owns them.
				expect(AsyncJobManager.instance()).toBe(primaryManager);
			} finally {
				await secondary.dispose();
			}

			// After the secondary disposes, the primary's manager MUST still be the
			// reachable singleton — otherwise the `task` async path errors with
			// "Async execution is enabled but no async job manager is available".
			expect(AsyncJobManager.instance()).toBe(primaryManager);
		} finally {
			await primary.dispose();
		}

		// Once the owning primary session disposes the singleton clears, matching
		// the documented single-owner invariant.
		expect(AsyncJobManager.instance()).toBeUndefined();
	}, 60000);

	// Capability markers, not prose: each is a parameter literal (or the label
	// frame that routes a clause to one surface) the guidance can only instruct
	// when the built-in tool's schema exposes it, so copy edits to the
	// surrounding sentences never fail these tests.
	const BASH_ASYNC_MARKER = 'async: "auto"';
	const HUB_PROGRESS_MARKER = 'op: "start"';
	const HUB_WAIT_MARKER = "`pattern`/`for`/`timeout`";
	const BASH_CHATTY_MARKER = "\nBash:";
	const HUB_CHATTY_MARKER = "\nHub:";

	function asyncProgressBlock(systemPrompt: string): string | undefined {
		const start = systemPrompt.indexOf("<async-progress>");
		if (start < 0) return undefined;
		const end = systemPrompt.indexOf("</async-progress>", start);
		if (end < 0) throw new Error("Unclosed <async-progress> block");
		return systemPrompt.slice(start, end);
	}

	it("advertises available harness-pushed progress surfaces under Tool Policy", async () => {
		const session = await spawnTopLevelSession({ "async.enabled": true });
		try {
			const systemPrompt = session.systemPrompt.join("\n\n");
			const toolPolicyIndex = systemPrompt.indexOf("§ Tool Policy");
			const progressIndex = systemPrompt.indexOf("<async-progress>");
			const workflowIndex = systemPrompt.indexOf("§ Workflow");
			expect(toolPolicyIndex).toBeGreaterThanOrEqual(0);
			expect(progressIndex).toBeGreaterThan(toolPolicyIndex);
			expect(progressIndex).toBeLessThan(workflowIndex);
			const block = asyncProgressBlock(systemPrompt);
			if (block === undefined) throw new Error("Expected <async-progress> block");
			// Both built-in surfaces are registered, so both async-parameter
			// instructions and both chatty-guidance clauses must render inside
			// the block.
			expect(block).toContain(BASH_ASYNC_MARKER);
			expect(block).toContain(BASH_CHATTY_MARKER);
			expect(block).toContain(HUB_PROGRESS_MARKER);
			expect(block).toContain(HUB_WAIT_MARKER);
			expect(block).toContain(HUB_CHATTY_MARKER);
		} finally {
			await session.dispose();
		}
	}, 60000);

	it("rebuilds async guidance from the currently active built-in tools", async () => {
		const session = await spawnTopLevelSession({ "async.enabled": true });
		try {
			await session.setActiveToolsByName(["read", "hub"]);
			let block = asyncProgressBlock(session.systemPrompt.join("\n\n"));
			if (block === undefined) throw new Error("Expected Hub-only <async-progress> block");
			expect(block).not.toContain(BASH_ASYNC_MARKER);
			expect(block).not.toContain(BASH_CHATTY_MARKER);
			expect(block).toContain(HUB_PROGRESS_MARKER);
			expect(block).toContain(HUB_WAIT_MARKER);
			expect(block).toContain(HUB_CHATTY_MARKER);

			await session.setActiveToolPresentation(["read", "bash"], []);
			block = asyncProgressBlock(session.systemPrompt.join("\n\n"));
			if (block === undefined) throw new Error("Expected Bash-only <async-progress> block");
			expect(block).toContain(BASH_ASYNC_MARKER);
			expect(block).toContain(BASH_CHATTY_MARKER);
			// Hub is inactive, so no clause may reference it: neither the
			// Hub-only parameter literals nor the tool name itself.
			expect(block).not.toContain(HUB_PROGRESS_MARKER);
			expect(block).not.toContain(HUB_WAIT_MARKER);
			expect(block).not.toMatch(/\bhub\b/i);

			await session.setActiveToolPresentation(["read"], []);
			expect(asyncProgressBlock(session.systemPrompt.join("\n\n"))).toBeUndefined();

			await session.setActiveToolsByName(["read", "bash", "hub"]);
			block = asyncProgressBlock(session.systemPrompt.join("\n\n"));
			if (block === undefined) throw new Error("Expected restored <async-progress> block");
			expect(block).toContain(BASH_ASYNC_MARKER);
			expect(block).toContain(HUB_PROGRESS_MARKER);
			expect(block).toContain(HUB_WAIT_MARKER);
		} finally {
			await session.dispose();
		}
	}, 60000);

	it("advertises only Hub progress when async Bash is disabled", async () => {
		const session = await spawnTopLevelSession({ "async.enabled": false });
		try {
			const block = asyncProgressBlock(session.systemPrompt.join("\n\n"));
			if (block === undefined) throw new Error("Expected <async-progress> block");
			expect(block).not.toContain(BASH_ASYNC_MARKER);
			expect(block).not.toContain(BASH_CHATTY_MARKER);
			expect(block).toContain(HUB_PROGRESS_MARKER);
			expect(block).toContain(HUB_WAIT_MARKER);
			expect(block).toContain(HUB_CHATTY_MARKER);
		} finally {
			await session.dispose();
		}
	}, 60000);

	it("omits push guidance when neither progress surface is available", async () => {
		const session = await spawnTopLevelSession({ "async.enabled": false, "launch.enabled": false });
		try {
			expect(session.systemPrompt.join("\n\n")).not.toContain("<async-progress>");
		} finally {
			await session.dispose();
		}
	}, 60000);

	function overrideBuiltinExtension(name: "bash" | "hub"): ExtensionFactory {
		return pi => {
			pi.registerTool({
				name,
				label: `Custom ${name}`,
				description: `Custom ${name} replacement without async progress parameters.`,
				parameters: type({}),
				approval: "read",
				async execute() {
					return { content: [{ type: "text" as const, text: "custom" }] };
				},
			});
		};
	}

	it("drops async Bash guidance when an extension replaces the built-in bash tool", async () => {
		const session = await spawnTopLevelSession({ "async.enabled": true }, [overrideBuiltinExtension("bash")]);
		try {
			// The custom `bash` keeps the name but not the built-in's async/progress
			// schema, so the block must not instruct bash async parameters.
			const block = asyncProgressBlock(session.systemPrompt.join("\n\n"));
			if (block === undefined) throw new Error("Expected <async-progress> block");
			expect(block).not.toContain(BASH_ASYNC_MARKER);
			// Hub guidance is unaffected by the bash override.
			expect(block).toContain(HUB_PROGRESS_MARKER);
			expect(block).toContain(HUB_WAIT_MARKER);
		} finally {
			await session.dispose();
		}
	}, 60000);

	it("drops Hub progress guidance when an extension replaces the built-in hub tool", async () => {
		const session = await spawnTopLevelSession({ "async.enabled": true }, [overrideBuiltinExtension("hub")]);
		try {
			const block = asyncProgressBlock(session.systemPrompt.join("\n\n"));
			if (block === undefined) throw new Error("Expected <async-progress> block");
			expect(block).not.toContain(HUB_PROGRESS_MARKER);
			expect(block).not.toContain(HUB_WAIT_MARKER);
			// Bash guidance is unaffected by the hub override.
			expect(block).toContain(BASH_ASYNC_MARKER);
		} finally {
			await session.dispose();
		}
	}, 60000);

	it("does not cancel the primary session's running jobs when a secondary session disposes", async () => {
		const primary = await spawnTopLevelSession();
		try {
			const primaryManager = AsyncJobManager.instance();
			expect(primaryManager).toBeDefined();

			// Register a long-running job on the primary's manager under the
			// MAIN_AGENT_ID owner — the same owner the secondary would inherit by
			// default. The secondary's dispose-time `cancelOwnAsyncJobs` must NOT
			// cancel this job (issue #1923).
			const release = Promise.withResolvers<string>();
			const jobId = primaryManager!.register(
				"bash",
				"sleep",
				async ({ signal }) => {
					const aborted = Promise.withResolvers<void>();
					signal.addEventListener("abort", () => aborted.resolve(), { once: true });
					await Promise.race([release.promise, aborted.promise]);
					return signal.aborted ? "aborted" : "completed";
				},
				{ ownerId: "Main" },
			);
			expect(primary.getAsyncJobSnapshot()?.running.some(job => job.id === jobId)).toBe(true);

			const secondary = await spawnTopLevelSession();
			try {
				expect(secondary.getAsyncJobSnapshot()).toBeNull();
			} finally {
				await secondary.dispose();
			}

			const job = primaryManager!.getJob(jobId);
			expect(job?.status).toBe("running");

			release.resolve("done");
			await primaryManager!.waitForAll();
		} finally {
			await primary.dispose();
		}
	}, 60000);

	it("exposes the owning session's jobs through a production extension context", async () => {
		let observedSnapshot: AsyncJobSnapshot | null | undefined;
		const snapshotExtension: ExtensionFactory = pi => {
			pi.registerTool({
				name: "capture_async_job_snapshot",
				label: "Capture async job snapshot",
				description: "Capture the session-owned async job snapshot for this test.",
				parameters: type({}),
				approval: "read",
				async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
					observedSnapshot = ctx.getAsyncJobSnapshot();
					return { content: [{ type: "text", text: "captured" }] };
				},
			});
		};
		const session = await spawnTopLevelSession(undefined, [snapshotExtension]);
		const manager = AsyncJobManager.instance();
		expect(manager).toBeDefined();
		const release = Promise.withResolvers<string>();
		const jobId = manager!.register("bash", "extension snapshot test", async () => release.promise, {
			ownerId: "Main",
		});

		try {
			const snapshotTool = session.getToolByName("capture_async_job_snapshot");
			expect(snapshotTool).toBeDefined();
			await snapshotTool!.execute("call-snapshot", {});

			expect(observedSnapshot?.running.some(job => job.id === jobId)).toBe(true);
		} finally {
			release.resolve("done");
			await manager!.waitForAll();
			await session.dispose();
		}
	}, 60000);

	it("refuses async bash from a secondary session instead of routing it to the primary's manager", async () => {
		const primary = await spawnTopLevelSession({ "async.enabled": true });
		try {
			const primaryManager = AsyncJobManager.instance();
			expect(primaryManager).toBeDefined();
			const primaryJobCountBefore = primaryManager!.getAllJobs().length;

			const secondary = await spawnTopLevelSession({ "async.enabled": true });
			try {
				const bashTool = secondary.getToolByName("bash");
				expect(bashTool).toBeDefined();
				await expect(bashTool!.execute("call-1", { command: "echo hi", async: true })).rejects.toThrow(
					/Async job manager unavailable/,
				);
			} finally {
				await secondary.dispose();
			}

			// The secondary's failed async attempt must not have leaked a job into
			// the primary's manager.
			expect(primaryManager!.getAllJobs().length).toBe(primaryJobCountBefore);
		} finally {
			await primary.dispose();
		}
	}, 60000);

	it("clears a manager installed before a top-level session startup failure takes ownership", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-async-startup-failure-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, `project-${Snowflake.next()}`);
		const agentDir = path.join(tempDir, "agent");
		fs.mkdirSync(cwd, { recursive: true });

		await expect(
			createAgentSession({
				cwd,
				agentDir,
				settings: Settings.isolated({ "bash.autoBackground.enabled": true }),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				modelRegistry: sharedModelRegistry,
				systemPrompt: () => {
					throw new Error("forced startup failure");
				},
			}),
		).rejects.toThrow("forced startup failure");

		expect(AsyncJobManager.instance()).toBeUndefined();

		const replacement = await spawnTopLevelSession();
		try {
			expect(AsyncJobManager.instance()).toBeDefined();
			expect(replacement.getAsyncJobSnapshot()).not.toBeNull();
		} finally {
			await replacement.dispose();
		}
	}, 60000);
});
