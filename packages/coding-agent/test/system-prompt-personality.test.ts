import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Personality } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { getAgentDir, removeSyncWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

const EMPTY_TREE = {
	rootPath: "",
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [],
};

// Distinctive line from the bundled default preset (prompts/system/personalities/default.md).
const DEFAULT_PRESET_MARKER = "Evidence-first terse engineer";
const OVERRIDE = "Follow ASD-STE100 Simplified Technical English for all responses.";

const originalAgentDir = getAgentDir();

// PERSONALITY.md contract (issue #8528): `<agentDir>/PERSONALITY.md` replaces
// the selected preset's text in the personality block; `none` still omits the
// block (subagents always run with `none`); an empty file falls back to the
// configured preset.
describe("PERSONALITY.md override", () => {
	let tempDir = "";
	let tempAgentDir = "";

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-personality-"));
		tempAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-personality-agent-"));
		setAgentDir(tempAgentDir);
	});

	afterEach(() => {
		setAgentDir(originalAgentDir);
		removeSyncWithRetries(tempDir);
		removeSyncWithRetries(tempAgentDir);
	});

	async function renderPrompt(personality?: Personality): Promise<string> {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: [],
			personality,
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
		});
		return systemPrompt.join("\n\n");
	}

	function writePersonalityFile(content: string): void {
		fs.writeFileSync(path.join(tempAgentDir, "PERSONALITY.md"), content);
	}

	it("replaces the selected preset's text with <agentDir>/PERSONALITY.md", async () => {
		writePersonalityFile(OVERRIDE);

		const rendered = await renderPrompt("default");
		expect(rendered).toContain("# Personality");
		expect(rendered).toContain(OVERRIDE);
		expect(rendered).not.toContain(DEFAULT_PRESET_MARKER);
	});

	it(`omits the block for personality "none" even when PERSONALITY.md exists (subagent contract)`, async () => {
		writePersonalityFile(OVERRIDE);

		const rendered = await renderPrompt("none");
		expect(rendered).not.toContain("# Personality");
		expect(rendered).not.toContain(OVERRIDE);
	});

	it("falls back to the configured preset when the file is empty", async () => {
		writePersonalityFile("   \n");

		const rendered = await renderPrompt("default");
		expect(rendered).toContain(DEFAULT_PRESET_MARKER);
	});

	it("renders the selected preset when no override file exists", async () => {
		const rendered = await renderPrompt("default");
		expect(rendered).toContain(DEFAULT_PRESET_MARKER);
	});
});
