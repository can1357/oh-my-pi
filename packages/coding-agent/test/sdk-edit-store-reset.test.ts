import { afterEach, describe, expect, it } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getEditStore } from "@oh-my-pi/pi-coding-agent/edit/store";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

describe("sdk edit-store session reset", () => {
	let authStorage: AuthStorage;
	let tempDir: TempDir;
	let session: AgentSession | undefined;

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage?.close();
		try {
			await tempDir.remove();
		} catch {}
	});

	it("clears the tool-side hashline store on /new so stale tags stop resolving (#13370)", async () => {
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in anthropic model to exist");
		tempDir = TempDir.createSync("@omp-edit-store-reset-");
		const settings = Settings.isolated({
			"async.enabled": false,
			"browser.enabled": false,
			"computer.enabled": false,
			"compaction.enabled": false,
			"todo.enabled": false,
		});
		settings.setModelRole("default", `${bundled.provider}/${bundled.id}`);
		const result = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			agentRegistry: new AgentRegistry(),
			authStorage,
			modelRegistry,
			settings,
			model: bundled,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			workspaceTree: {
				rootPath: tempDir.path(),
				rendered: "",
				truncated: false,
				totalLines: 0,
				agentsMdFiles: [],
			},
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});
		session = result.session;

		// Record a tag exactly the way the read tool does: through the TOOL
		// session's store (the sdk-built host context), not the AgentSession's
		// own lazy field.
		const toolSession: ToolSession = Reflect.get(session.getToolByName("read") ?? {}, "session");
		const toolStore = getEditStore(toolSession);
		const tag = toolStore.recordSnapshot("/tmp/omp-13370/a.rs", "alpha\nbeta\n", undefined);
		expect(tag).toBeDefined();
		expect(toolStore.byHashText("/tmp/omp-13370/a.rs", tag)).toBe("alpha\nbeta\n");

		await session.newSession();

		// /new fired the session-change callbacks: the tool-side store is empty,
		// so the stale tag can't be presented as "issued in this session".
		expect(toolStore.byHashText("/tmp/omp-13370/a.rs", tag)).toBeNull();
	});
});
