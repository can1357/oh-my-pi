import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { withFileLock } from "@pk-nerdsaver-ai/pi-coding-agent/config/file-lock";
import {
	persistUnsafeActiveContextImageSettingsMigration,
	Settings,
} from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { getSettingsSelectorValue } from "@pk-nerdsaver-ai/pi-coding-agent/modes/components/settings-selector";
import { getProjectAgentDir, logger, TempDir } from "@pk-nerdsaver-ai/pi-utils";
import { YAML } from "bun";

async function writeGlobalConfig(agentDir: string, value: unknown): Promise<void> {
	await fs.mkdir(agentDir, { recursive: true });
	await Bun.write(path.join(agentDir, "config.yml"), YAML.stringify(value));
}

describe("global-only background-pack settings", () => {
	it("defaults to disabled with no manifests", () => {
		const settings = Settings.isolated();
		expect(settings.getGlobal("backgroundPacks.enabled")).toBe(false);
		expect(settings.getGlobal("backgroundPacks.manifests")).toEqual([]);
	});

	it("ignores project settings when reading runtime pack enablement and manifests", async () => {
		const tempDir = TempDir.createSync("@omp-background-pack-project-settings-");
		try {
			const root = tempDir.path();
			const agentDir = path.join(root, "agent");
			const workspace = path.join(root, "workspace");
			const projectAgentDir = getProjectAgentDir(workspace);
			await fs.mkdir(projectAgentDir, { recursive: true });
			await writeGlobalConfig(agentDir, {
				backgroundPacks: { enabled: false, manifests: ["global-pack.json"] },
			});
			await Bun.write(
				path.join(projectAgentDir, "settings.json"),
				JSON.stringify({ backgroundPacks: { enabled: true, manifests: ["project-pack.json"] } }),
			);

			const settings = await Settings.loadReadOnly({ cwd: workspace, agentDir });

			expect(settings.get("backgroundPacks.enabled")).toBe(true);
			expect(settings.get("backgroundPacks.manifests")).toEqual(["project-pack.json"]);
			expect(settings.getGlobal("backgroundPacks.enabled")).toBe(false);
			expect(settings.getGlobal("backgroundPacks.manifests")).toEqual(["global-pack.json"]);
		} finally {
			tempDir.removeSync();
		}
	});

	it("ignores config overlays and runtime overrides for pack runtime reads", async () => {
		const tempDir = TempDir.createSync("@omp-background-pack-overlay-settings-");
		try {
			const root = tempDir.path();
			const agentDir = path.join(root, "agent");
			const workspace = path.join(root, "workspace");
			const overlayPath = path.join(root, "overlay.yml");
			await fs.mkdir(workspace, { recursive: true });
			await writeGlobalConfig(agentDir, {
				backgroundPacks: { enabled: false, manifests: ["global-pack.json"] },
			});
			await Bun.write(
				overlayPath,
				YAML.stringify({ backgroundPacks: { enabled: true, manifests: ["overlay.json"] } }),
			);

			const settings = await Settings.loadReadOnly({
				cwd: workspace,
				agentDir,
				configFiles: [overlayPath],
				overrides: { "backgroundPacks.enabled": true, "backgroundPacks.manifests": ["runtime.json"] },
			});

			expect(settings.get("backgroundPacks.enabled")).toBe(true);
			expect(settings.get("backgroundPacks.manifests")).toEqual(["runtime.json"]);
			expect(settings.getGlobal("backgroundPacks.enabled")).toBe(false);
			expect(settings.getGlobal("backgroundPacks.manifests")).toEqual(["global-pack.json"]);
		} finally {
			tempDir.removeSync();
		}
	});

	it("selector reads global pack enablement despite merged project state", async () => {
		const tempDir = TempDir.createSync("@omp-background-pack-selector-settings-");
		try {
			const root = tempDir.path();
			const agentDir = path.join(root, "agent");
			const workspace = path.join(root, "workspace");
			const projectAgentDir = getProjectAgentDir(workspace);
			await fs.mkdir(projectAgentDir, { recursive: true });
			await writeGlobalConfig(agentDir, { backgroundPacks: { enabled: false } });
			await Bun.write(
				path.join(projectAgentDir, "settings.json"),
				JSON.stringify({ backgroundPacks: { enabled: true } }),
			);

			const settings = await Settings.loadReadOnly({ cwd: workspace, agentDir });

			expect(settings.get("backgroundPacks.enabled")).toBe(true);
			expect(getSettingsSelectorValue("backgroundPacks.enabled", settings)).toBe(false);
		} finally {
			tempDir.removeSync();
		}
	});

	it("reports a multi-key stale configuration safety migration once", () => {
		const warningSpy = vi.spyOn(logger, "warn");
		try {
			const legacy = {
				compaction: { strategy: "snapcompact" },
				snapcompact: { systemPrompt: "all", toolResults: true },
				"snapcompact.shape": "auto",
			} as unknown as Parameters<typeof Settings.isolated>[0];
			const settings = Settings.isolated(legacy);
			expect(settings.get("compaction.strategy")).toBe("context-full");
			const migrationWarnings = warningSpy.mock.calls.filter(call =>
				String(call[0]).includes("retired unsafe active-context image conversion"),
			);
			expect(migrationWarnings).toHaveLength(1);
		} finally {
			vi.restoreAllMocks();
		}
	});

	it("persists the stale active-context imaging migration idempotently", async () => {
		const tempDir = TempDir.createSync("@omp-background-pack-migration-");
		try {
			const root = tempDir.path();
			const agentDir = path.join(root, "agent");
			const workspace = path.join(root, "workspace");
			await fs.mkdir(workspace, { recursive: true });
			await writeGlobalConfig(agentDir, {
				compaction: { strategy: "snapcompact" },
				snapcompact: { systemPrompt: "all", toolResults: true, shape: "auto" },
			});

			const firstMigration = await persistUnsafeActiveContextImageSettingsMigration(
				path.join(agentDir, "config.yml"),
			);
			const secondMigration = await persistUnsafeActiveContextImageSettingsMigration(
				path.join(agentDir, "config.yml"),
			);
			const persisted = YAML.parse(await Bun.file(path.join(agentDir, "config.yml")).text()) as Record<
				string,
				unknown
			>;

			expect(persisted).toEqual({ compaction: { strategy: "context-full" } });
			expect(firstMigration).toBe(true);
			expect(secondMigration).toBe(false);
		} finally {
			tempDir.removeSync();
		}
	});

	it("re-reads after waiting for the lock and preserves concurrent fields", async () => {
		const tempDir = TempDir.createSync("@omp-background-pack-migration-lock-");
		try {
			const agentDir = path.join(tempDir.path(), "agent");
			const configPath = path.join(agentDir, "config.yml");
			await writeGlobalConfig(agentDir, { compaction: { strategy: "snapcompact" } });

			const lockReady = Promise.withResolvers<void>();
			const releaseLock = Promise.withResolvers<void>();
			const lockHolder = withFileLock(configPath, async () => {
				lockReady.resolve();
				await releaseLock.promise;
			});
			await lockReady.promise;

			const migration = persistUnsafeActiveContextImageSettingsMigration(configPath);
			await Bun.sleep(25);
			await Bun.write(
				configPath,
				YAML.stringify({ compaction: { strategy: "snapcompact" }, concurrentField: "preserved" }),
			);
			releaseLock.resolve();
			await lockHolder;

			expect(await migration).toBe(true);
			expect(YAML.parse(await Bun.file(configPath).text())).toEqual({
				compaction: { strategy: "context-full" },
				concurrentField: "preserved",
			});
		} finally {
			tempDir.removeSync();
		}
	});
});
