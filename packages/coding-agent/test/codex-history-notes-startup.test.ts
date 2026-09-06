import { afterEach, expect, test, vi } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { CodexHistoryNotesBackend } from "@oh-my-pi/pi-ai/providers/openai-codex/history-notes";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { createAgentSession } from "../src/sdk";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import { toolRenderers } from "../src/tools/renderers";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
});

async function start(mode: "notes" | "window" | "off", offline = false) {
	const dir = TempDir.createSync("@codex-notes-startup-");
	cleanups.push(() => dir.removeSync());
	const auth = await AuthStorage.create(":memory:");
	cleanups.push(() => auth.close());
	const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.signature`;
	auth.setRuntimeApiKey("openai-codex", token);
	const base = getBundledModel("openai-codex", "gpt-6-astra");
	if (!base) throw new Error("Missing bundled Codex fixture");
	const stale = buildModel({ ...base, api: "openai-codex-responses", compat: { contextWindows: undefined } });
	const fresh = buildModel({
		...stale,
		compat: {
			contextWindows: {
				enabled: false,
				useHistoryNotes: true,
				reminderThresholdTokens: 1000,
				reminderMessageTemplate: "Remaining: {n_remaining}",
				guidanceMessage: "Catalog checkpoint guidance",
				autoCompactFallbackPrompt: "Catalog checkpoint fallback",
				autoCompactFallbackBufferTokens: 2000,
			},
		},
	});
	const registry = new ModelRegistry(auth, dir.join("models.yml"));
	let refreshed = false;
	const find = registry.find.bind(registry);
	vi.spyOn(registry, "find").mockImplementation((provider, id) =>
		provider === stale.provider && id === stale.id ? (refreshed ? fresh : stale) : find(provider, id),
	);
	const refresh = vi.spyOn(registry, "refreshDiscoverableProviders").mockImplementation(async () => {
		if (offline) throw new Error("Discovery unavailable");
		refreshed = true;
	});
	vi.spyOn(CodexHistoryNotesBackend.prototype, "threadHint").mockResolvedValue(undefined);
	const manager = SessionManager.inMemory(dir.path());
	cleanups.push(() => manager.close());
	const { session } = await createAgentSession({
		cwd: dir.path(),
		agentDir: dir.path(),
		authStorage: auth,
		modelRegistry: registry,
		sessionManager: manager,
		model: stale,
		settings: Settings.isolated({
			"providers.openai-codex.historyNotes": mode === "notes" ? "on" : "off",
			"compaction.methodOrder": mode === "window" ? ["window", "remote"] : ["remote"],
			"compaction.asyncEnabled": false,
			"todo.enabled": false,
			"todo.reminders": false,
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
	});
	cleanups.push(() => session.dispose());
	return { session, refresh, auth };
}

test.each(["notes", "window"] as const)("refreshes missing catalog guidance before %s activation", async mode => {
	const { session, refresh } = await start(mode);
	const context = session.transformCodexContext({ messages: [] });
	expect(
		context.messages.some(
			message => typeof message.content === "string" && message.content.startsWith("<context_window_guidance>"),
		),
	).toBe(true);
	expect(refresh).toHaveBeenCalledWith(["openai-codex"], "online");
	expect(
		session.agent.state.tools.some(tool => tool.name === (mode === "notes" ? "notes.write_file" : "new_context")),
	).toBe(true);
});

test("a failed optional catalog refresh does not prevent notes-only startup", async () => {
	const { session, refresh } = await start("notes", true);
	expect(refresh).toHaveBeenCalledWith(["openai-codex"], "online");
	expect(session.agent.state.tools.some(tool => tool.name === "notes.write_file")).toBe(true);
	expect(session.agent.state.tools.some(tool => tool.name === "new_context")).toBe(false);
});

test("does not force catalog discovery when both features are disabled", async () => {
	const { session, refresh } = await start("off");
	expect(refresh).not.toHaveBeenCalled();
	expect(session.agent.state.tools.some(tool => tool.name === "notes.write_file" || tool.name === "new_context")).toBe(
		false,
	);
});

test("context-window tools resolve through the registry, survive selection changes, and leave with the model", async () => {
	const { session, auth } = await start("notes");
	// The TUI, ACP gating, and hasBuiltInTool all look tools up by name; built-in
	// cards come from the renderer registry, not from hooks on the tool object.
	expect(session.getToolByName("notes.write_file")?.name).toBe("notes.write_file");
	expect(toolRenderers["notes.write_file"]).toBeDefined();
	expect(session.hasBuiltInTool("notes.read_file")).toBe(true);
	expect(session.getActiveToolNames()).toContain("notes.write_file");

	await session.setActiveToolsByName(["read"]);
	expect(session.getActiveToolNames()).toContain("notes.write_file");
	expect(session.agent.state.tools.some(tool => tool.name === "notes.write_file")).toBe(true);
	const other = getBundledModel("anthropic", "claude-opus-4-8");
	if (!other) throw new Error("Missing bundled Anthropic fixture");
	auth.setRuntimeApiKey("anthropic", "sk-ant-fixture");
	await session.setModel(other);
	expect(session.getToolByName("notes.write_file")).toBeUndefined();
	expect(session.hasBuiltInTool("notes.write_file")).toBe(false);
	expect(session.agent.state.tools.some(tool => tool.name.startsWith("notes."))).toBe(false);
});
