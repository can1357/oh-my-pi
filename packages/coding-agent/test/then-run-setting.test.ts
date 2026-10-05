import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EDIT_MODES } from "@oh-my-pi/pi-coding-agent/edit/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { cfgToolsThenRun } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

function sessionWith(settings: Settings): ToolSession {
	const cwd = path.join(os.tmpdir(), "then-run-setting");
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "session"),
		settings,
	};
}

/** Property names the model sees in the tool's JSON schema. */
function advertisedFields(tool: Pick<AgentTool, "parameters">): string[] {
	const schema = (tool.parameters as { toJsonSchema(): { properties?: Record<string, unknown> } }).toJsonSchema();
	return Object.keys(schema.properties ?? {});
}

describe("tools.thenRun setting", () => {
	it("is off by default", () => {
		expect(cfgToolsThenRun.get(Settings.isolated())).toBe(false);
	});

	describe("write tool definition", () => {
		it("hides then_run from the schema and the prompt when the setting is off", () => {
			const tool = new WriteTool(sessionWith(Settings.isolated()));
			expect(advertisedFields(tool)).not.toContain("then_run");
			expect(tool.description).not.toContain("then_run");
		});

		it("advertises then_run in the schema and the prompt when the setting is on", () => {
			const tool = new WriteTool(sessionWith(Settings.isolated({ "tools.thenRun": true })));
			expect(advertisedFields(tool)).toContain("then_run");
			expect(tool.description).toContain("then_run");
		});
	});

	describe.each([...EDIT_MODES])("edit tool definition (%s)", mode => {
		it("hides then_run from the schema and the prompt when the setting is off", () => {
			const tool = new EditTool(sessionWith(Settings.isolated()), mode);
			expect(advertisedFields(tool)).not.toContain("then_run");
			expect(tool.description).not.toContain("then_run");
		});

		it("advertises then_run in the schema when the setting is on", () => {
			const tool = new EditTool(sessionWith(Settings.isolated({ "tools.thenRun": true })), mode);
			expect(advertisedFields(tool)).toContain("then_run");
		});
	});

	describe("system prompt with inlined tool descriptors", () => {
		let tempDir: string;
		let authStorage: AuthStorage;
		let session: AgentSession;

		beforeAll(async () => {
			tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `then-run-prompt-${Snowflake.next()}-`));
			const cwd = path.join(tempDir, "cwd");
			fs.mkdirSync(cwd, { recursive: true });
			authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
			const created = await createAgentSession({
				cwd,
				agentDir: tempDir,
				authStorage,
				sessionManager: SessionManager.inMemory(cwd),
				settings: Settings.isolated({ inlineToolDescriptors: "on", "tools.thenRun": true }),
				model: getBundledModel("openai", "gpt-4o-mini"),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				workspaceTree: { rootPath: cwd, rendered: ".\n", truncated: false, totalLines: 1, agentsMdFiles: [] },
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				toolNames: ["write", "edit"],
			});
			session = created.session;
		});

		afterAll(async () => {
			await session.dispose();
			authStorage.close();
			removeSyncWithRetries(tempDir);
		});

		const prompt = () => session.agent.state.systemPrompt.join("\n");

		it("drops then_run from the live prompt when the setting is switched off", async () => {
			expect(prompt()).toContain("then_run");
			session.settings.writeValue(cfgToolsThenRun, false, "override");
			// The rebuild runs from a coalesced settings listener.
			for (let i = 0; i < 100 && prompt().includes("then_run"); i++) await Bun.sleep(20);
			expect(prompt()).not.toContain("then_run");
		});
	});
});
