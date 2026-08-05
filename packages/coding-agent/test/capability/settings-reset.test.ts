import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ContextFile, contextFileCapability } from "@pk-nerdsaver-ai/pi-coding-agent/capability/context-file";
import { resetSettingsForTest, Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { initializeWithSettings, loadCapability } from "@pk-nerdsaver-ai/pi-coding-agent/discovery";
import { removeWithRetries } from "@pk-nerdsaver-ai/pi-utils";

/**
 * Regression guard for the capability module pinning a discarded `Settings`.
 *
 * `initializeWithSettings` stores the instance in a module-level variable.
 * Clearing the singleton via `resetSettingsForTest()` did NOT clear that
 * reference, so every later `loadCapability()` in the process kept reading
 * `disabledExtensions` off the dead object. Test buckets share one process, so a
 * single file that disabled an extension suppressed it for the rest of the run —
 * `test/discovery/disabled-extensions.test.ts` poisoning `system-prompt-dedup`
 * dozens of files later.
 *
 * Asserting on the specific project file rather than a count keeps this honest:
 * user-level discovery may contribute additional entries depending on the host.
 */
describe("capability settings pin", () => {
	let projectDir = "";

	beforeEach(async () => {
		resetSettingsForTest();
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cap-reset-"));
		await fs.mkdir(path.join(projectDir, ".ompk"), { recursive: true });
		await fs.writeFile(path.join(projectDir, ".ompk", "AGENTS.md"), "# project instructions\n");
	});

	afterEach(async () => {
		resetSettingsForTest();
		await removeWithRetries(projectDir).catch(() => {});
	});

	const projectAgentsPresent = (items: ReadonlyArray<ContextFile>): boolean =>
		items.some(item => path.resolve(item.path) === path.resolve(projectDir, ".ompk", "AGENTS.md"));

	test("resetSettingsForTest drops the pinned settings so disabledExtensions stops applying", async () => {
		const disabling = await Settings.init({
			inMemory: true,
			cwd: projectDir,
			overrides: { disabledExtensions: ["context-file:project:AGENTS.md"] },
		});
		initializeWithSettings(disabling);

		const whileDisabled = await loadCapability<ContextFile>(contextFileCapability.id, { cwd: projectDir });
		expect(projectAgentsPresent(whileDisabled.items)).toBe(false);

		// The pin must not outlive the singleton. Before the fix the capability
		// module kept reading `disabling` here and the file stayed suppressed.
		resetSettingsForTest();

		const afterReset = await loadCapability<ContextFile>(contextFileCapability.id, { cwd: projectDir });
		expect(projectAgentsPresent(afterReset.items)).toBe(true);
	});
});
