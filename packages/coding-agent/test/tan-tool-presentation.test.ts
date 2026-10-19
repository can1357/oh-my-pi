import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type CustomTool, createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createSubagentSettings } from "@oh-my-pi/pi-coding-agent/task/executor";
import { TempDir } from "@oh-my-pi/pi-utils";

const mcpTool: CustomTool = {
	name: "mcp__fixture_probe",
	label: "Fixture probe",
	description: "Probe the fixture server.",
	parameters: type({ query: "string" }),
	mcpServerName: "fixture",
	mcpToolName: "probe",
	async execute() {
		return { content: [{ type: "text", text: "fixture" }] };
	},
};

describe("/tan prompt-cache tool presentation", () => {
	for (const xdev of [true, false]) {
		it(`preserves the parent's request tools with xd:// ${xdev ? "enabled" : "disabled"}`, async () => {
			using dir = TempDir.createSync("@omp-tan-tools-");
			const cwd = dir.path();
			const settings = Settings.isolated({ "tools.xdev": xdev, "marketplace.autoUpdate": "off" });
			const base = {
				cwd,
				agentDir: cwd,
				model: getBundledModel("openai", "gpt-4o-mini"),
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableLsp: false,
				enableMCP: false,
				disableExtensionDiscovery: true,
				skipPythonPreflight: true,
				mcpTools: [mcpTool],
			};
			const { session: parent } = await createAgentSession({
				...base,
				settings,
				hasUI: true,
				sessionManager: SessionManager.inMemory(cwd),
			});
			try {
				const { session: child } = await createAgentSession({
					...base,
					settings: createSubagentSettings(settings),
					hasUI: false,
					systemPrompt: [...parent.systemPrompt],
					toolNames: parent.getEnabledToolNames(),
					mountedToolNames: parent.getMountedXdevToolNames(),
					advertiseHeadlessAsk: parent.getActiveToolNames().includes("ask"),
					parentTaskPrefix: "Tan-fixture",
					sessionManager: SessionManager.inMemory(cwd),
				});
				await child.setActiveToolPresentation(parent.getEnabledToolNames(), parent.getMountedXdevToolNames());
				try {
					const advertised = (session: typeof parent) =>
						session.agent.state.tools.map(tool => ({
							name: tool.name,
							description: tool.description,
							parameters: tool.parameters,
						}));
					if (xdev) expect(parent.getMountedXdevToolNames()).toContain(mcpTool.name);
					else expect(parent.getMountedXdevToolNames()).toEqual([]);
					expect(parent.getActiveToolNames()).toContain("ask");
					expect(child.getMountedXdevToolNames()).toEqual(parent.getMountedXdevToolNames());
					expect(child.systemPrompt).toEqual(parent.systemPrompt);
					expect(advertised(child)).toEqual(advertised(parent));
					const ask = child.getToolByName("ask");
					if (!ask) throw new Error("The inherited ask tool was not registered");
					await expect(ask.execute("ask-fixture", { questions: [] })).rejects.toThrow(
						"Ask tool requires interactive mode",
					);
				} finally {
					await child.dispose();
				}
			} finally {
				await parent.dispose();
			}
		}, 30_000);
	}
});
