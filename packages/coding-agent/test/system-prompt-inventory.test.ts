import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildSystemPrompt as buildSdkSystemPrompt } from "@pk-nerdsaver-ai/pi-coding-agent/sdk";
import {
	buildSystemPrompt,
	DEFAULT_SYSTEM_PROMPT_TOOL_NAMES,
	type SystemPromptToolMetadata,
} from "@pk-nerdsaver-ai/pi-coding-agent/system-prompt";
import type { Tool } from "@pk-nerdsaver-ai/pi-coding-agent/tools";
import { cleanupTempHome } from "./helpers/temp-home-cleanup";

const EMPTY_TREE = {
	rootPath: "",
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [],
};

const TOOLS = new Map<string, SystemPromptToolMetadata>([
	[
		"read",
		{
			label: "Read",
			description: "Reads files from disk.",
			parameters: { type: "object", properties: { path: { type: "string" } } },
		},
	],
	[
		"bash",
		{
			label: "Bash",
			description: "Executes a shell command.",
			parameters: { type: "object", properties: { command: { type: "string" } } },
		},
	],
]);

const SDK_TOOL: Tool = {
	name: "sdk_custom",
	label: "SDK Custom",
	description: "SDK-provided custom tool.",
	parameters: { type: "object", properties: {} },
	approval: "read",
	async execute() {
		return { content: [{ type: "text", text: "ok" }] };
	},
};

describe("system prompt tool inventory", () => {
	let tempDir = "";
	let tempHomeDir = "";
	let originalHome: string | undefined;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-inv-"));
		tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-inv-home-"));
		originalHome = process.env.HOME;
		process.env.HOME = tempHomeDir;
	});

	afterEach(cleanupTempHome(() => ({ tempDir, tempHomeDir, originalHome })));

	async function render(opts: { nativeTools: boolean; inlineToolDescriptors: boolean }): Promise<string> {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: ["read", "bash"],
			tools: TOOLS,
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
			nativeTools: opts.nativeTools,
			inlineToolDescriptors: opts.inlineToolDescriptors,
		});
		return systemPrompt.join("\n\n");
	}

	function inventoryFrom(text: string): string {
		// Tolerate either prompt layout: the merge-base "# Inventory" / "ENV" framing and the
		// reordered "# Tool Inventory" / "TOOL POLICY" framing on current main. The slice just
		// needs to isolate the rendered tool list from the rest of the prompt.
		const inventoryStart =
			["# Tool Inventory", "# Inventory"].map(header => text.indexOf(header)).find(index => index >= 0) ?? -1;
		expect(inventoryStart).toBeGreaterThan(-1);
		const sectionEnds = ["\nENV\n", "\nTOOL POLICY", "\n# "]
			.map(marker => text.indexOf(marker, inventoryStart + 1))
			.filter(index => index > inventoryStart);
		const inventoryEnd = sectionEnds.length > 0 ? Math.min(...sectionEnds) : text.length;
		return text.slice(inventoryStart, inventoryEnd);
	}

	it("renders a compact name list only when native tools are active and descriptors stay in schemas", async () => {
		const text = await render({ nativeTools: true, inlineToolDescriptors: false });
		expect(text).toContain("- Read: `read`");
		expect(text).toContain("- Bash: `bash`");
		// No full per-tool sections in list mode.
		expect(text).not.toContain("# Tool: read");
		expect(text).not.toContain("Reads files from disk.");
	});

	it("renders `# Tool:` sections (not a name list) when tools are not native", async () => {
		const text = await render({ nativeTools: false, inlineToolDescriptors: false });
		expect(text).toContain("# Tool: read");
		expect(text).toContain("# Tool: bash");
		expect(text).toContain("Reads files from disk.");
		expect(text).not.toContain("- Read: `read`");
		// The legacy `<tool>` wrapper is gone.
		expect(text).not.toContain("<tool name=");
	});

	it("renders `# Tool:` sections when descriptors are inlined even with native tools", async () => {
		const text = await render({ nativeTools: true, inlineToolDescriptors: true });
		expect(text).toContain("# Tool: read");
		expect(text).toContain("Executes a shell command.");
		expect(text).not.toContain("- Read: `read`");
	});

	it("uses a conservative fallback inventory when no tools map is provided", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [],
			rules: [],
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
		});
		const inventory = inventoryFrom(systemPrompt.join("\n\n"));
		for (const toolName of DEFAULT_SYSTEM_PROMPT_TOOL_NAMES) {
			expect(inventory).toContain(`- \`${toolName}\``);
		}
		expect(inventory).not.toContain("- `browser`");
		expect(inventory).not.toContain("- `task`");
	});

	it("SDK wrapper renders provided tools instead of the fallback inventory", async () => {
		const { systemPrompt } = await buildSdkSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [],
			tools: [SDK_TOOL],
		});
		const inventory = inventoryFrom(systemPrompt.join("\n\n"));
		expect(inventory).toContain("- SDK Custom: `sdk_custom`");
		expect(inventory).not.toContain("- `read`");
	});

	it("SDK wrapper preserves an explicit empty tool list", async () => {
		const { systemPrompt } = await buildSdkSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [],
			tools: [],
		});
		const text = systemPrompt.join("\n\n");

		expect(text).not.toContain("# Inventory");
		expect(text).not.toContain("- `read`");
	});

	it("keeps visible skills when no tools map is provided", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [
				{
					name: "prompt-authoring",
					description: "Prompt authoring workflow",
					filePath: path.join(tempDir, "SKILL.md"),
					baseDir: tempDir,
					source: "test",
				},
			],
			rules: [],
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
		});
		const text = systemPrompt.join("\n\n");

		expect(text).toContain("- prompt-authoring: Prompt authoring workflow");
	});

	it("omits skills when active tool names exclude read", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [
				{
					name: "search-only-skill",
					description: "Should not render without read",
					filePath: path.join(tempDir, "SKILL.md"),
					baseDir: tempDir,
					source: "test",
				},
			],
			rules: [],
			toolNames: ["bash"],
			tools: TOOLS,
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
		});
		const text = systemPrompt.join("\n\n");

		expect(text).not.toContain("search-only-skill");
	});

	it("omits hidden skills even when read is active", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [
				{
					name: "hidden-workflow",
					description: "Hidden prompt workflow",
					filePath: path.join(tempDir, "SKILL.md"),
					baseDir: tempDir,
					source: "test",
					hide: true,
				},
			],
			rules: [],
			toolNames: ["read"],
			tools: TOOLS,
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
		});
		const text = systemPrompt.join("\n\n");

		expect(text).not.toContain("hidden-workflow");
	});

	it("tells the agent to read matching skills before work", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [
				{
					name: "frontend-design",
					description: "Frontend UI workflow",
					filePath: path.join(tempDir, "SKILL.md"),
					baseDir: tempDir,
					source: "test",
				},
			],
			rules: [],
			toolNames: ["read"],
			tools: TOOLS,
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
		});
		const text = systemPrompt.join("\n\n");

		expect(text).toContain("<skills>");
		expect(text).toContain("- frontend-design: Frontend UI workflow");
	});
});
