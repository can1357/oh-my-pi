import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionError } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { ExtensionRunner, loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

/**
 * Bot review on PR #9379: `emitResourcesDiscover` aggregated handler results
 * without validating them — a malformed return such as
 * `{ skillPaths: "./skills" }` has a truthy `.length`, so the aggregation
 * called `.map` on a string and threw *outside* the guarded handler
 * invocation. Since startup awaits this emitter in every mode, one bad
 * extension return aborted session initialization instead of being reported
 * through the extension error listener and skipped.
 */
describe("emitResourcesDiscover result validation (PR #9379 review)", () => {
	afterEach(() => {
		resetSettingsForTest();
	});

	it("reports malformed result fields through onError and keeps well-formed contributions", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-resources-discover-validation-"));
		try {
			resetSettingsForTest();
			await Settings.init({ inMemory: true, cwd: tempDir });

			const extensionsDir = path.join(tempDir, "ext");
			await fs.mkdir(extensionsDir, { recursive: true });
			const malformedPath = path.join(extensionsDir, "malformed.ts");
			await fs.writeFile(
				malformedPath,
				`export default function (pi) {
	pi.on("resources_discover", () => ({ skillPaths: "./skills", promptPaths: ["/ok/prompts", 42] }));
}
`,
			);
			const wellFormedPath = path.join(extensionsDir, "well-formed.ts");
			await fs.writeFile(
				wellFormedPath,
				`export default function (pi) {
	pi.on("resources_discover", () => ({ skillPaths: ["/contributed/skills"] }));
}
`,
			);

			const loaded = await loadExtensions([malformedPath, wellFormedPath], tempDir);
			expect(loaded.errors).toEqual([]);

			const authStorage = createInMemoryAuthStorage();
			const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
			const sessionManager = SessionManager.inMemory(tempDir);
			const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, tempDir, sessionManager, modelRegistry);
			const reported: ExtensionError[] = [];
			runner.onError(error => reported.push(error));

			const result = await runner.emitResourcesDiscover(tempDir, "startup");

			// The well-formed contribution survives; the malformed string field
			// is skipped, and the mixed array keeps only its string entries.
			expect(result.skillPaths.map(entry => entry.path)).toEqual(["/contributed/skills"]);
			expect(result.promptPaths.map(entry => entry.path)).toEqual(["/ok/prompts"]);
			expect(result.themePaths).toEqual([]);

			const skillPathError = reported.find(error => error.error.includes("skillPaths"));
			expect(skillPathError?.event).toBe("resources_discover");
			expect(skillPathError?.extensionPath).toBe(malformedPath);
			const promptPathError = reported.find(error => error.error.includes("promptPaths"));
			expect(promptPathError?.extensionPath).toBe(malformedPath);
		} finally {
			await removeWithRetries(tempDir);
		}
	});
});
