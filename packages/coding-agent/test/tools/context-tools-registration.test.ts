import { describe, expect, test, vi } from "bun:test";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "../../src/config/settings";
import { createAgentSession } from "../../src/sdk";
import { SessionManager } from "../../src/session/session-manager";
import { createTools, type ToolSession } from "../../src/tools";
import { TempDir } from "@oh-my-pi/pi-utils";

function createSession(enabled: boolean, restricted = false): ToolSession {
	const settings = Settings.isolated();
	settings.override("compaction.experimentalContextManagement", enabled);
	settings.override("tools.xdev", false);
	settings.override("astGrep.enabled", false);
	const sessionManager = SessionManager.inMemory();
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings,
		sessionManager,
		getSessionId: () => sessionManager.getSessionId(),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		skipPythonPreflight: true,
		restrictToolNames: restricted,
	};
}

describe("experimental context tool registration", () => {
	test("disabled sessions cannot activate context tools even by explicit name", async () => {
		const tools = await createTools(createSession(false), ["read", "grep", "context_notes", "new_context"]);
		expect(tools.map(tool => tool.name)).not.toContain("context_notes");
		expect(tools.map(tool => tool.name)).not.toContain("new_context");
	});

	test("enabling the experiment adds callable notes and rollover to an unrestricted recovery-capable set", async () => {
		const tools = await createTools(createSession(true), ["read", "grep"]);
		const names = tools.map(tool => tool.name);
		expect(names).toContain("context_notes");
		expect(names).toContain("new_context");
	});

	test("restricted read-only sessions retain their explicit capability boundary", async () => {
		const tools = await createTools(createSession(true, true), ["read", "grep"]);
		expect(tools.map(tool => tool.name)).not.toContain("context_notes");
		expect(tools.map(tool => tool.name)).not.toContain("new_context");
	});

	test("advisor identities cannot acquire a parent's journal tools", async () => {
		const session = createSession(true);
		session.getSessionId = () => `${session.sessionManager!.getSessionId()}-advisor`;
		const tools = await createTools(session, ["context_notes", "new_context"]);
		expect(tools.map(tool => tool.name)).not.toContain("context_notes");
		expect(tools.map(tool => tool.name)).not.toContain("new_context");
	});
	test("SDK preserves the recovery-capable notes pair in an explicit runtime tool set", async () => {
		using tempDir = TempDir.createSync("@omp-context-tools-sdk-");
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockRejectedValue(new Error("network disabled in registration test"));
		try {
			const sessionManager = SessionManager.inMemory(tempDir.path());
			const { session } = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				sessionManager,
				settings: Settings.isolated({ "compaction.experimentalContextManagement": true }),
				modelRegistry: new ModelRegistry(authStorage),
				model: getBundledModel("openai", "gpt-4o-mini"),
				toolNames: ["read", "grep"],
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
			});
			try {
				expect(session.getEnabledToolNames()).toEqual(expect.arrayContaining(["context_notes", "new_context"]));
				const notes = session.getToolByName("context_notes");
				if (!notes) throw new Error("expected registered context notes tool");
				await notes.execute("store-notebook", { text: "stored through SDK registration" });
				expect(sessionManager.getBranch()).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							type: "custom",
							customType: "experimental_context_notes",
							data: { version: 1, text: "stored through SDK registration" },
						}),
					]),
				);
			} finally {
				await session.dispose();
			}
		} finally {
			fetchSpy.mockRestore();
			authStorage.close();
		}
	});
});
