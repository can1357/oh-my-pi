import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ContextFile, contextFileCapability } from "@pk-nerdsaver-ai/pi-coding-agent/capability/context-file";
import { resetSettingsForTest, Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { initializeWithSettings, loadCapability } from "@pk-nerdsaver-ai/pi-coding-agent/discovery";
import { removeWithRetries } from "@pk-nerdsaver-ai/pi-utils";

describe("disabledExtensions runtime filtering", () => {
	let tempDir = "";
	let tempHomeDir = "";
	let originalHome: string | undefined;

	// Restore this spy individually rather than via `vi.restoreAllMocks()`.
	// That call IS `mock.restore()` (same native function), and the global
	// restore walks Bun's mock registry to unpatch the sealed `os` namespace,
	// segfaulting this shared-process bucket (exit 132) once a later file
	// imports an overlapping module graph.
	let homedirSpy: { mockRestore: () => void } | undefined;
	beforeEach(async () => {
		resetSettingsForTest();
		originalHome = process.env.HOME;
		tempHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-disabled-ext-home-"));
		process.env.HOME = tempHomeDir;
		homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(tempHomeDir);
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-disabled-ext-"));
		await fs.mkdir(path.join(tempDir, ".ompk"), { recursive: true });
		await fs.writeFile(path.join(tempDir, ".ompk", "AGENTS.md"), "# project instructions\n");

		const settings = await Settings.init({
			inMemory: true,
			cwd: tempDir,
			overrides: {
				disabledExtensions: ["context-file:project:AGENTS.md"],
			},
		});
		initializeWithSettings(settings);
	});

	afterEach(async () => {
		resetSettingsForTest();
		homedirSpy?.mockRestore();
		homedirSpy = undefined;
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		await removeWithRetries(tempHomeDir);
		await removeWithRetries(tempDir);
	});

	test("hides disabled context files from runtime loads by default", async () => {
		const result = await loadCapability<ContextFile>(contextFileCapability.id, { cwd: tempDir });

		expect(result.items).toHaveLength(0);
	});

	test("can include disabled context files for dashboard-style loads", async () => {
		const result = await loadCapability<ContextFile>(contextFileCapability.id, {
			cwd: tempDir,
			includeDisabled: true,
		});

		expect(result.items).toHaveLength(1);
		expect(path.basename(result.items[0]!.path)).toBe("AGENTS.md");
	});
});
