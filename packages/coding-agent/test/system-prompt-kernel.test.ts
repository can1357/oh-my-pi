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

// Regression: Bun on macOS 15+ (Darwin 24/25) makes `os.version()` return the
// literal "unknown", which used to leak into the <workstation> block as
// `Kernel: unknown` and caused the model to display the wrong OS glyph
// (issue #4141). The Kernel field must always carry a real identity.
describe("system prompt Kernel field", () => {
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

	it(`falls back to "<type> <release>" when os.version() returns "unknown" (Bun on macOS 15+)`, async () => {
		spyOn(os, "version").mockReturnValue("unknown");
		spyOn(os, "type").mockReturnValue("Darwin");
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
		expect(rendered).not.toContain("Kernel: unknown");
		expect(rendered).toContain("Kernel: Darwin 25.5.0");
	});

	it("also falls back when os.version() is empty or whitespace", async () => {
		spyOn(os, "version").mockReturnValue("   ");
		spyOn(os, "type").mockReturnValue("Darwin");
		spyOn(os, "release").mockReturnValue("25.5.0");

		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: [],
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
		});

		expect(systemPrompt.join("\n\n")).toContain("Kernel: Darwin 25.5.0");
	});

	it("keeps the real uname build string when os.version() is populated", async () => {
		spyOn(os, "version").mockReturnValue(
			"Darwin Kernel Version 25.5.0: Tue Nov  7 21:48:04 PST 2026; root:xnu-11215.1.12~1/RELEASE_ARM64_T6031",
		);

		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: [],
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
		});

		expect(systemPrompt.join("\n\n")).toContain("Kernel: Darwin Kernel Version 25.5.0:");
	});
});
