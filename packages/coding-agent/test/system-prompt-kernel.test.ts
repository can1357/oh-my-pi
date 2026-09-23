import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { cleanupTempHome } from "./helpers/temp-home-cleanup";

const EMPTY_TREE = {
	rootPath: "",
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [],
};

// Regression (#4141): Bun on macOS 15+ makes `os.version()` return the literal
// "unknown", which used to leak into the <workstation> block and made the model
// misidentify the host OS. The block identifies the host from platform + release,
// which never depend on the uname version string.
describe("system prompt workstation block", () => {
	let tempDir = "";
	let tempHomeDir = "";
	let originalHome: string | undefined;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-kernel-"));
		tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-kernel-home-"));
		originalHome = process.env.HOME;
		process.env.HOME = tempHomeDir;
	});

	afterEach(cleanupTempHome(() => ({ tempDir, tempHomeDir, originalHome })));

	it(`identifies the host even when os.version() returns "unknown"`, async () => {
		spyOn(os, "version").mockReturnValue("unknown");
		spyOn(os, "platform").mockReturnValue("darwin");
		spyOn(os, "release").mockReturnValue("25.5.0");

		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: [],
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
		});

		const rendered = systemPrompt.join("\n\n");
		expect(rendered).toContain("OS: darwin 25.5.0");
		expect(rendered).not.toContain("unknown");
	});
});
