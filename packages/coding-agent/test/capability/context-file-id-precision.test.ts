import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ContextFile, contextFileCapability } from "@pk-nerdsaver-ai/pi-coding-agent/capability/context-file";
import { resetSettingsForTest, Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { initializeWithSettings, loadCapability } from "@pk-nerdsaver-ai/pi-coding-agent/discovery";
import { removeWithRetries } from "@pk-nerdsaver-ai/pi-utils";

/**
 * Context-file disable ids are path-qualified. The old format keyed by
 * basename, so one disabled id — `context-file:project:AGENTS.md` — suppressed
 * EVERY project-level AGENTS.md the process ever discovered. Two contracts:
 *
 * 1. Precision: disabling one project's file (new path-qualified id) must not
 *    disable a same-named file in a different project.
 * 2. Legacy compat: ids persisted in the old basename format keep disabling —
 *    silently re-enabling something a user turned off would be worse than
 *    honouring the old key's collision behaviour.
 */
describe("context-file extension id precision", () => {
	let projectA = "";
	let projectB = "";

	const agentsMd = (root: string) => path.join(root, ".ompk", "AGENTS.md");
	const newIdFor = (root: string) => `context-file:project:${path.resolve(agentsMd(root)).split(path.sep).join("/")}`;

	const present = (items: ReadonlyArray<ContextFile>, root: string): boolean =>
		items.some(item => path.resolve(item.path) === path.resolve(agentsMd(root)));

	beforeEach(async () => {
		resetSettingsForTest();
		projectA = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ctxid-a-"));
		projectB = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ctxid-b-"));
		for (const root of [projectA, projectB]) {
			await fs.mkdir(path.join(root, ".ompk"), { recursive: true });
			await fs.writeFile(agentsMd(root), "# project instructions\n");
		}
	});

	afterEach(async () => {
		resetSettingsForTest();
		await removeWithRetries(projectA).catch(() => {});
		await removeWithRetries(projectB).catch(() => {});
	});

	test("path-qualified disable suppresses only that project's file", async () => {
		const settings = await Settings.init({
			inMemory: true,
			cwd: projectA,
			overrides: { disabledExtensions: [newIdFor(projectA)] },
		});
		initializeWithSettings(settings);

		const inA = await loadCapability<ContextFile>(contextFileCapability.id, { cwd: projectA });
		expect(present(inA.items, projectA)).toBe(false);

		// Same disabled set, different project: the same-named file must survive.
		const inB = await loadCapability<ContextFile>(contextFileCapability.id, { cwd: projectB });
		expect(present(inB.items, projectB)).toBe(true);
	});

	test("legacy basename-format disable keeps working (with its old collision behaviour)", async () => {
		const settings = await Settings.init({
			inMemory: true,
			cwd: projectA,
			overrides: { disabledExtensions: ["context-file:project:AGENTS.md"] },
		});
		initializeWithSettings(settings);

		const inA = await loadCapability<ContextFile>(contextFileCapability.id, { cwd: projectA });
		expect(present(inA.items, projectA)).toBe(false);

		// Legacy ids match by basename, so the collision is intentionally kept:
		// project B's AGENTS.md is suppressed too, exactly as before the change.
		const inB = await loadCapability<ContextFile>(contextFileCapability.id, { cwd: projectB });
		expect(present(inB.items, projectB)).toBe(false);
	});
});
