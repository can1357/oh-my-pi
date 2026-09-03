import { describe, expect, test } from "bun:test";
import { Settings } from "../../src/config/settings";
import { LspTool } from "../../src/lsp";
import { buildSystemPrompt } from "../../src/system-prompt";
import { createTools, type ToolSession } from "../../src/tools";

function toolSession(settings: Settings): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		skipPythonPreflight: true,
		restrictToolNames: true,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings,
	};
}

async function promptWithSecurity(securityEnabled: boolean): Promise<string> {
	const { systemPrompt } = await buildSystemPrompt({
		cwd: process.cwd(),
		contextFiles: [],
		skills: [],
		toolNames: ["read"],
		workspaceTree: {
			rootPath: process.cwd(),
			rendered: "",
			truncated: false,
			totalLines: 0,
			agentsMdFiles: [],
		},
		activeRepoContext: null,
		securityEnabled,
		includeModelInPrompt: false,
	});
	return systemPrompt.join("\n");
}

describe("security feature gate", () => {
	test("security_scan is absent while disabled and present only when explicitly enabled", async () => {
		const disabled = Settings.isolated({ "security.enabled": false });
		const enabled = Settings.isolated({ "security.enabled": true });
		try {
			expect((await createTools(toolSession(disabled), ["security_scan"])).map(tool => tool.name)).toEqual([]);
			expect((await createTools(toolSession(enabled), ["security_scan"])).map(tool => tool.name)).toEqual([
				"security_scan",
			]);
		} finally {
			disabled.cancelPendingSaves();
			enabled.cancelPendingSaves();
		}
	});

	test("restricted security sessions retain read-only LSP access", async () => {
		const restricted = Settings.isolated();
		const session = {
			...toolSession(restricted),
			enableLsp: true,
			lspReadOnly: true,
			restrictToolNames: true,
		};
		try {
			expect((await createTools(session, ["lsp"])).map(tool => tool.name)).toEqual(["lsp"]);
			const lsp = new LspTool(session);
			await expect(
				lsp.execute("rename", {
					action: "rename",
					file: "src/example.ts",
					line: 1,
					symbol: "example",
					new_name: "renamed",
				}),
			).rejects.toThrow("disabled in this read-only session");
		} finally {
			restricted.cancelPendingSaves();
		}
	});

	test("security:// is omitted from the system prompt while disabled", async () => {
		expect(await promptWithSecurity(false)).not.toContain("security://");
		expect(await promptWithSecurity(true)).toContain("security://");
	});
});
