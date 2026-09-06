import { expect, test, vi } from "bun:test";
import { CodexHistoryNotesBackend } from "@oh-my-pi/pi-ai/providers/openai-codex/history-notes";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir, untilAborted } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { createAgentSession, type CreateAgentSessionResult } from "../src/sdk";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

test("two subagent sessions share one optional catalog refresh without waiting for the network", async () => {
	const dir = TempDir.createSync("@history-refresh-");
	const auth = await AuthStorage.create(":memory:");
	const pending = Promise.withResolvers<void>();
	const sessions: Array<Promise<CreateAgentSessionResult>> = [];
	const managers: SessionManager[] = [];
	const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.signature`;
	auth.setRuntimeApiKey("openai-codex", token);
	const base = getBundledModel("openai-codex", "gpt-6-astra");
	if (!base) throw new Error("Missing Codex fixture");
	const stale = buildModel({ ...base, api: "openai-codex-responses", compat: { contextWindows: undefined } });
	const registry = new ModelRegistry(auth, dir.join("models.yml"));
	const refresh = vi.spyOn(registry, "refreshDiscoverableProviders").mockImplementation(() => pending.promise);
	vi.spyOn(CodexHistoryNotesBackend.prototype, "threadHint").mockResolvedValue(undefined);
	try {
		for (const id of ["WorkerOne", "WorkerTwo"]) {
			const manager = SessionManager.inMemory(dir.path());
			managers.push(manager);
			sessions.push(
				createAgentSession({
					cwd: dir.path(),
					agentDir: dir.path(),
					authStorage: auth,
					modelRegistry: registry,
					sessionManager: manager,
					model: stale,
					taskDepth: 1,
					parentTaskPrefix: id,
					agentId: id,
					settings: Settings.isolated({
						"providers.openai-codex.historyNotes": "on",
						"compaction.methodOrder": ["remote"],
						"compaction.asyncEnabled": false,
						"todo.enabled": false,
					}),
					disableExtensionDiscovery: true,
					extensions: [],
					skills: [],
					contextFiles: [],
					promptTemplates: [],
					slashCommands: [],
					rules: [],
					preloadedCustomToolPaths: [],
					enableMCP: false,
					enableLsp: false,
					skipPythonPreflight: true,
					toolNames: [],
				}),
			);
		}
		const ready = await untilAborted(AbortSignal.timeout(5000), Promise.all(sessions));
		expect(refresh).toHaveBeenCalledTimes(1);
		for (const { session } of ready) expect(session.getActiveToolNames()).toContain("notes.read_file");
	} finally {
		pending.resolve();
		for (const settled of await Promise.allSettled(sessions)) {
			if (settled.status === "fulfilled") await settled.value.session.dispose();
		}
		for (const manager of managers) manager.close();
		vi.restoreAllMocks();
		auth.close();
		dir.removeSync();
	}
}, 15000);
