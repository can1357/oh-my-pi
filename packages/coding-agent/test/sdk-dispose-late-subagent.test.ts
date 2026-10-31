import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { finalizeSubagentLifecycle } from "@oh-my-pi/pi-coding-agent/task/executor";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

// A top-level session disposes its agent lifecycle before it aborts its own
// running tools, so a foreground task its teardown interrupts finishes after the
// lifecycle is gone. Its agent is released, and dispose() must not resolve
// before that release has: nothing is left to dispose the agent afterwards.
describe("createAgentSession dispose and subagents that finish during it", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(() => {
		authStorage = createInMemoryAuthStorage();
		modelRegistry = new ModelRegistry(
			authStorage,
			path.join(os.tmpdir(), `pi-sdk-late-models-${Snowflake.next()}.yml`),
		);
		tempDir = path.join(os.tmpdir(), `pi-sdk-dispose-late-subagent-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterAll(() => {
		authStorage.close();
		removeSyncWithRetries(tempDir);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("resolves only after a subagent its own teardown interrupted is released", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			hasUI: false,
			bindProcessState: false,
			enableMCP: false,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
		});
		// The lifecycle a subagent run started by this session settles with.
		const lifecycle = AgentLifecycleManager.global();

		// The subagent's session is slow to dispose: it is still disposing when the
		// parent's own teardown closes its transcript, its last step.
		const parentClosing = Promise.withResolvers<void>();
		const closeParent = session.sessionManager.close.bind(session.sessionManager);
		vi.spyOn(session.sessionManager, "close").mockImplementation(async () => {
			parentClosing.resolve();
			await closeParent();
		});
		let childDisposeCalls = 0;
		const child = {
			prepareForHeadlessAdvisorDrain: () => {},
			waitForAdvisorCatchup: async () => true,
			dispose: async () => {
				childDisposeCalls++;
				await parentClosing.promise;
				const nextTurn = Promise.withResolvers<void>();
				setImmediate(nextTurn.resolve);
				await nextTurn.promise;
			},
		} as unknown as AgentSession;
		const id = "Interrupted-Child";
		AgentRegistry.global().register({
			id,
			displayName: id,
			kind: "sub",
			session: child,
			sessionFile: null,
			status: "running",
		});
		const releaseChild = vi.fn(async () => {});

		// Where the teardown aborts the session's running tools, the interrupted
		// foreground task settles; an interrupted run stays resumable, so it is kept alive.
		const abortRetry = session.abortRetry.bind(session);
		vi.spyOn(session, "abortRetry").mockImplementation(() => {
			abortRetry();
			void finalizeSubagentLifecycle({
				id,
				session: child,
				aborted: true,
				abortKind: "signal",
				keepAlive: true,
				isolated: false,
				agentIdleTtlMs: 0,
				reviveSession: async () => child,
				onRelease: releaseChild,
				lifecycle,
			});
		});

		await session.dispose();

		expect(childDisposeCalls).toBe(1);
		expect(releaseChild).toHaveBeenCalledTimes(1);
		expect(AgentRegistry.global().get(id)).toBeUndefined();
	}, 20_000);
});
