import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildSystemPrompt, type SystemPromptToolMetadata } from "@oh-my-pi/pi-coding-agent/system-prompt";
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
			readsSkillUris: true,
			parameters: { type: "object", properties: { path: { type: "string" } } },
		},
	],
	[
		"bash",
		{
			label: "Bash",
			description: "Executes a shell command.",
			readsSkillUris: true,
			parameters: { type: "object", properties: { command: { type: "string" } } },
		},
	],
]);

const TOOL_NAMES = ["read", "bash", "edit", "write", "lsp", "find", "grep", "glob"];

describe("system prompt trim mode", () => {
	let tempDir = "";
	let tempHomeDir = "";
	let originalHome: string | undefined;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-trim-"));
		tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-trim-home-"));
		originalHome = process.env.HOME;
		process.env.HOME = tempHomeDir;
	});

	afterEach(cleanupTempHome(() => ({ tempDir, tempHomeDir, originalHome })));

	async function render(overrides: { trimMode?: boolean } = {}): Promise<string> {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: TOOL_NAMES,
			tools: TOOLS,
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
			...overrides,
		});
		return systemPrompt.join("\n\n");
	}

	it("renders byte-identically when trimMode is off or unset", async () => {
		const unset = await render();
		const off = await render({ trimMode: false });
		expect(off).toBe(unset);
		// Original guidance blocks intact on the default path.
		expect(off).toContain(
			"- NEVER yield while actionable work remains; phase boundary/todo flip/sub-step never stops: same turn.",
		);
		expect(off).toContain(", NEVER shell `grep`/`rg`/`awk`.");
		expect(off).toContain("descriptive `find` FIRST");
		expect(off).toContain("Use `read` ranges, not whole files.");
		expect(off).toContain("- Read: `read`");
		expect(off).not.toContain(
			"Re-read § Delivery before yielding; one failed check is not blocked; finish reachable work.",
		);
	});

	it("collapses the duplicated critical block when trimMode is on", async () => {
		const trimmed = await render({ trimMode: true });
		expect(trimmed).toContain(
			"Re-read § Delivery before yielding; one failed check is not blocked; finish reachable work.",
		);
		expect(trimmed).toContain("§ Critical");
		expect(trimmed).not.toContain(
			"- NEVER yield while actionable work remains; phase boundary/todo flip/sub-step never stops: same turn.",
		);
		expect(trimmed).not.toContain("NEVER narrate/consider session limits");
		expect(trimmed).not.toContain("NEVER re-audit applied edit");
		// The § Delivery contract itself stays untouched.
		expect(trimmed).toContain("phase boundary/todo flip/sub-step never yields: same turn.");
	});

	it("reduces specialized-tool bullets to tool-name mappings", async () => {
		const trimmed = await render({ trimMode: true });
		expect(trimmed).toContain("- File/directory reads: `read` (directory lists entries).");
		expect(trimmed).toContain("- File structure/names: `glob`.");
		expect(trimmed).toContain("- Unknown behavior/location: `find`.");
		expect(trimmed).not.toContain("NEVER text-search/edit for code intelligence");
		expect(trimmed).not.toContain(", NEVER shell `grep`/`rg`/`awk`.");
		expect(trimmed).not.toContain(", NEVER `ls **/*.ext`/`fd`.");
		expect(trimmed).not.toContain("descriptive `find` FIRST");
		expect(trimmed).not.toContain("real binaries/short fact pipelines");
	});

	it("keeps the find-hit rule and drops the read-range clause from Exploration", async () => {
		const trimmed = await render({ trimMode: true });
		expect(trimmed).toContain("Read `find` hits only.");
		expect(trimmed).not.toContain("ranges, not whole files");
	});

	it("renders the tool inventory as plain names without labels", async () => {
		const trimmed = await render({ trimMode: true });
		expect(trimmed).toContain("- `read`\n- `bash`\n- `edit`");
		expect(trimmed).not.toContain("- Read: `read`");
		expect(trimmed).not.toContain("- Bash: `bash`");
	});
});
