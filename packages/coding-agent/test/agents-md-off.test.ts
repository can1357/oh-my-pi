import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "../src/cli/args";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { buildSessionOptions } from "../src/main";
import { discoverContextFiles } from "../src/sdk";
import { AuthStorage } from "../src/session/auth-storage";
import { loadProjectContextFiles } from "../src/system-prompt";

describe("lean-launch --agentmd-off runtime behavior", () => {
	let tempDir: string;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-md-off-"));
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
	});

	afterEach(() => {
		authStorage?.close();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	describe("buildSessionOptions", () => {
		it("sets disableAgentsMd when parsed.noAgentMd is true", async () => {
			const parsed = parseArgs(["--cwd", tempDir, "--agentmd-off"]);
			const settings = Settings.isolated();
			const modelRegistry = new ModelRegistry(authStorage);

			const { options } = await buildSessionOptions(parsed, [], undefined, modelRegistry, settings);

			expect(options.disableAgentsMd).toBe(true);
			expect(options.rules).toBeUndefined();
			expect(options.skills).toBeUndefined();
		});

		it("leaves disableAgentsMd undefined when parsed.noAgentMd is not set", async () => {
			const parsed = parseArgs(["--cwd", tempDir]);
			const settings = Settings.isolated();
			const modelRegistry = new ModelRegistry(authStorage);

			const { options } = await buildSessionOptions(parsed, [], undefined, modelRegistry, settings);

			expect(options.disableAgentsMd).toBeUndefined();
		});

		it("does not conflate noRules or noSkills with noAgentMd", async () => {
			const parsed = parseArgs(["--cwd", tempDir, "--no-rules", "--no-skills"]);
			const settings = Settings.isolated();
			const modelRegistry = new ModelRegistry(authStorage);

			const { options } = await buildSessionOptions(parsed, [], undefined, modelRegistry, settings);

			expect(options.disableAgentsMd).toBeUndefined();
			expect(options.rules).toEqual([]);
			expect(options.skills).toEqual([]);
		});
	});

	describe("loadProjectContextFiles and discoverContextFiles provider exclusion", () => {
		it("suppresses only agents-md provider items and preserves other context files", async () => {
			// Standalone AGENTS.md loaded by agents-md provider
			const standaloneAgentsMd = path.join(tempDir, "AGENTS.md");
			fs.writeFileSync(standaloneAgentsMd, "# Standalone Agents Instructions");

			// Without exclusion: agents-md items are discovered
			const normalFiles = await loadProjectContextFiles({ cwd: tempDir });
			const agentsMdItems = normalFiles.filter(f => f._source?.provider === "agents-md");
			expect(agentsMdItems.length).toBeGreaterThan(0);

			// With excludeProviders: ["agents-md"], standalone is suppressed, other providers remain
			const filteredFiles = await loadProjectContextFiles({
				cwd: tempDir,
				excludeProviders: ["agents-md"],
			});

			const filteredAgentsMd = filteredFiles.filter(f => f._source?.provider === "agents-md");
			expect(filteredAgentsMd).toHaveLength(0);

			// Other providers (such as user-level codex) still load normally
			const otherProvidersNormal = normalFiles.filter(f => f._source?.provider !== "agents-md");
			const otherProvidersFiltered = filteredFiles.filter(f => f._source?.provider !== "agents-md");
			expect(otherProvidersFiltered).toEqual(otherProvidersNormal);

			// discoverContextFiles also forwards excludeProviders
			const discoveredNormal = await discoverContextFiles(tempDir);
			expect(discoveredNormal.some(f => f._source?.provider === "agents-md")).toBe(true);

			const discoveredFiltered = await discoverContextFiles(tempDir, undefined, {
				excludeProviders: ["agents-md"],
			});
			expect(discoveredFiltered.some(f => f._source?.provider === "agents-md")).toBe(false);
		});
	});
});
