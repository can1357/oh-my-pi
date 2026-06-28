import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@pk-nerdsaver-ai/pi-ai";
import { getBundledModel } from "@pk-nerdsaver-ai/pi-catalog/models";
import { ModelRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/config/model-registry";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { createAgentSession } from "@pk-nerdsaver-ai/pi-coding-agent/sdk";
import type { AgentSession } from "@pk-nerdsaver-ai/pi-coding-agent/session/agent-session";
import { SessionManager } from "@pk-nerdsaver-ai/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@pk-nerdsaver-ai/pi-utils";

// Guards the auto-learn tool ACTIVATION wiring in createAgentSession: createTools
// force-includes manage_skill into the built registry for an enabled top-level
// session, but an explicit `toolNames` whitelist would otherwise drop it from the
// active set — so the SDK must re-activate it (mirroring the `yield` invariant),
// or the nudge/guidance would point at a tool the model cannot call. No memory
// backend is configured (manage_skill needs only `autolearn.enabled`), so the
// session starts without a heavy backend.
describe("createAgentSession auto-learn tool activation", () => {
	let registryDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		registryDir = path.join(os.tmpdir(), `pi-autolearn-active-${Snowflake.next()}`);
		fs.mkdirSync(registryDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(registryDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(async () => {
		for (const session of sessions) await session.dispose().catch(() => {});
		authStorage.close();
		if (fs.existsSync(registryDir)) removeSyncWithRetries(registryDir);
	});

	async function activeToolNames(settings: Settings): Promise<string[]> {
		const { session } = await createAgentSession({
			cwd: registryDir,
			agentDir: registryDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings,
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			toolNames: ["read"],
		});
		sessions.push(session);
		return session.getActiveToolNames();
	}

	it("activates force-included manage_skill in a restricted top-level session", async () => {
		const names = await activeToolNames(Settings.isolated({ "autolearn.enabled": true }));
		expect(names).toContain("read");
		// Built by createTools' force-include AND activated by the SDK's explicit-list
		// re-inclusion, so guidance/controller point at a callable tool.
		expect(names).toContain("manage_skill");
	});

	it("initializes the selected memory backend before an auto-learn session can run", async () => {
		const { session } = await createAgentSession({
			cwd: registryDir,
			agentDir: registryDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"autolearn.enabled": true,
				"memory.backend": "hindsight",
				"hindsight.apiUrl": "http://127.0.0.1:1",
				"hindsight.mentalModelsEnabled": false,
			}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			toolNames: ["read"],
		});
		sessions.push(session);

		expect(session.getHindsightSessionState()).toBeDefined();
	});

	it("omits manage_skill from a restricted session when auto-learn is off", async () => {
		const names = await activeToolNames(Settings.isolated({}));
		expect(names).toContain("read");
		expect(names).not.toContain("manage_skill");
	});
});
