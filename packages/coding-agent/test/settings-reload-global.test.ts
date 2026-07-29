import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Effort } from "@oh-my-pi/pi-ai";
import { onModelRolesChanged, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";

/**
 * Contract tests for `Settings.reloadGlobal()`, the per-session re-read of the
 * global config layer. Each case defends a behavior a naive re-read gets wrong.
 */
describe("Settings.reloadGlobal", () => {
	let tempDir: TempDir;
	let agentDir: string;
	let configPath: string;
	let settings: Settings | undefined;

	async function writeConfig(raw: Record<string, unknown>): Promise<void> {
		await Bun.write(configPath, YAML.stringify(raw));
	}

	/**
	 * Rewrite the config and move its mtime forward explicitly.
	 *
	 * The mtime-gated reload only acts when the timestamp differs, and a rewrite inside
	 * the filesystem's timestamp granularity can land on the same value. Setting it
	 * directly keeps that deterministic instead of sleeping past the granularity.
	 */
	async function rewriteConfigWithNewMtime(raw: Record<string, unknown>): Promise<void> {
		await writeConfig(raw);
		const bumped = new Date(Date.now() + 10_000);
		fs.utimesSync(configPath, bumped, bumped);
	}
	async function openSettings(): Promise<Settings> {
		const instance = await Settings.loadIsolated({ cwd: tempDir.path(), agentDir });
		settings = instance;
		return instance;
	}

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-reload-global-");
		agentDir = path.join(tempDir.path(), "agent");
		await Bun.write(path.join(agentDir, ".keep"), "");
		configPath = path.join(agentDir, "config.yml");
	});

	afterEach(async () => {
		await settings?.flush().catch(() => {});
		settings = undefined;
		tempDir.removeSync();
	});

	it("adopts an external edit and names the changed keys", async () => {
		await writeConfig({ defaultThinkingLevel: "low" });
		const s = await openSettings();
		expect(s.get("defaultThinkingLevel")).toBe(Effort.Low);

		await writeConfig({ defaultThinkingLevel: "high" });
		const report = await s.reloadGlobal();

		expect(report.status).toBe("applied");
		expect(report.changed).toContain("defaultThinkingLevel");
		expect(s.get("defaultThinkingLevel")).toBe(Effort.High);
	});

	it("reports unchanged when the file matches live state", async () => {
		await writeConfig({ defaultThinkingLevel: "high" });
		const s = await openSettings();

		const report = await s.reloadGlobal();

		expect(report.status).toBe("unchanged");
		expect(report.changed).toEqual([]);
	});

	it("keeps the previous layer when the file is malformed", async () => {
		await writeConfig({ defaultThinkingLevel: "high", hideThinkingBlock: true });
		const s = await openSettings();

		// A non-atomic editor write can be observed mid-flight. `#loadYamlIfPresent`
		// maps this to `{}`, which would reset every global value to its default.
		await Bun.write(configPath, "defaultThinkingLevel: [unclosed\n");
		const report = await s.reloadGlobal();

		expect(report.status).toBe("failed");
		expect(report.error).toBeTruthy();
		expect(s.get("defaultThinkingLevel")).toBe(Effort.High);
		expect(s.get("hideThinkingBlock")).toBe(true);
	});

	it("keeps the previous layer when the document root is not a mapping", async () => {
		await writeConfig({ defaultThinkingLevel: "high" });
		const s = await openSettings();

		await Bun.write(configPath, "- one\n- two\n");
		const report = await s.reloadGlobal();

		expect(report.status).toBe("failed");
		expect(s.get("defaultThinkingLevel")).toBe(Effort.High);
	});

	it("does not lose an in-session write that has not been persisted yet", async () => {
		await writeConfig({ defaultThinkingLevel: "low" });
		const s = await openSettings();

		// `set()` mutates the live layer and defers the write 100ms. A reload that
		// simply replaced the layer would revert this to the on-disk value, and
		// because `#saveNow` clears its modified sets before taking the file lock,
		// preserving those sets is not sufficient on its own.
		s.set("hideThinkingBlock", true);
		const report = await s.reloadGlobal();

		expect(report.status).not.toBe("failed");
		expect(s.get("hideThinkingBlock")).toBe(true);
		// The flush inside the reload persisted it, so it survives a fresh read too.
		const onDisk = YAML.parse(await Bun.file(configPath).text()) as Record<string, unknown>;
		expect(onDisk.hideThinkingBlock).toBe(true);
	});

	it("merges an external edit with an unpersisted in-session write", async () => {
		await writeConfig({ defaultThinkingLevel: "low" });
		const s = await openSettings();

		s.set("hideThinkingBlock", true);
		// Another process edits a different key while our write is still pending.
		await writeConfig({ defaultThinkingLevel: "xhigh" });
		const report = await s.reloadGlobal();

		expect(report.status).toBe("applied");
		expect(s.get("defaultThinkingLevel")).toBe(Effort.XHigh);
		expect(s.get("hideThinkingBlock")).toBe(true);
	});

	it("treats an absent config file as an empty layer rather than a failure", async () => {
		// "low" is not the schema default ("high"), so the fallback is observable.
		await writeConfig({ defaultThinkingLevel: "low" });
		const s = await openSettings();
		expect(s.get("defaultThinkingLevel")).toBe(Effort.Low);

		await Bun.file(configPath).delete();
		const report = await s.reloadGlobal();

		expect(report.status).not.toBe("failed");
		expect(s.get("defaultThinkingLevel")).toBe(Effort.High);
	});

	it("does not lose settings when a pending write meets a malformed config", async () => {
		await writeConfig({ defaultThinkingLevel: "low", hideThinkingBlock: false });
		const s = await openSettings();

		// The dangerous combination: an unpersisted local edit AND a file caught
		// half-written. A lenient re-read on the save path would map the parse failure
		// to `{}`, merge only the modified key onto it, and write that back, destroying
		// every other setting in memory and on disk. The save path quarantines the
		// invalid file and recovers from live state instead.
		s.set("hideThinkingBlock", true);
		await Bun.write(configPath, "defaultThinkingLevel: [unclosed\nhideThinkingBlock: fal\n");

		await s.reloadGlobal();

		// Both the pre-existing value and the pending edit survive.
		expect(s.get("defaultThinkingLevel")).toBe(Effort.Low);
		expect(s.get("hideThinkingBlock")).toBe(true);
		// The malformed content is not left in place as the live config.
		const onDisk = await Bun.file(configPath)
			.text()
			.catch(() => "");
		expect(onDisk).not.toContain("[unclosed");
	});

	it("fires the effective-change notification for a reloaded model role", async () => {
		await writeConfig({ modelRoles: { default: "anthropic/claude-sonnet-4-5" } });
		const s = await openSettings();

		let roleChanges = 0;
		const unsubscribe = onModelRolesChanged(() => {
			roleChanges += 1;
		});
		try {
			await writeConfig({ modelRoles: { default: "openai/gpt-4o-mini" } });
			const report = await s.reloadGlobal();

			expect(report.changed).toContain("modelRoles");
			// `#fireAllHooks` alone never reaches this signal, which is what drives
			// advisor rebuilds and the session's model rebind.
			expect(roleChanges).toBeGreaterThan(0);
		} finally {
			unsubscribe();
		}
	});

	it("does not let an overlapping check resolve before the reload it skipped has committed", async () => {
		await writeConfig({ defaultThinkingLevel: "low" });
		const s = await openSettings();

		await rewriteConfigWithNewMtime({ defaultThinkingLevel: "xhigh" });

		// A fire-and-forget turn-boundary pickup, then the pre-prompt check that a prompt
		// actually awaits. The mtime is recorded before the reload is awaited, so an
		// unserialized second caller stats, sees the first one's already-recorded mtime,
		// concludes there is nothing to do, and resolves while the value is still
		// uncommitted. Awaiting it would then be no guarantee at all.
		const boundaryPickup = s.reloadGlobalIfChangedOnDisk();
		const prePromptCheck = await s.reloadGlobalIfChangedOnDisk();

		// The load-bearing assertion: whatever the second caller reported, by the time it
		// resolved the new value must already be live, because a prompt starts here.
		expect(s.get("defaultThinkingLevel")).toBe(Effort.XHigh);

		const boundaryReport = await boundaryPickup;
		// Exactly one of them did the work; the other saw committed state.
		const applied = [boundaryReport, prePromptCheck].filter(report => report?.status === "applied");
		expect(applied).toHaveLength(1);
	});

	it("serializes a direct reload against a concurrent on-disk check", async () => {
		await writeConfig({ defaultThinkingLevel: "low" });
		const s = await openSettings();

		await rewriteConfigWithNewMtime({ defaultThinkingLevel: "xhigh" });

		// `/reload-config` calls `reloadGlobal` directly while a boundary pickup may be in
		// flight; both must share one critical section rather than double-applying.
		const [direct, checked] = await Promise.all([s.reloadGlobal(), s.reloadGlobalIfChangedOnDisk()]);

		expect(direct.status).not.toBe("failed");
		expect(checked?.status).not.toBe("failed");
		expect(s.get("defaultThinkingLevel")).toBe(Effort.XHigh);
	});

	it("classifies a changed restart-only setting instead of claiming it applied", async () => {
		// The workspace tree is built once at startup and never rebuilt, so nothing can
		// make this take effect in a live session.
		await writeConfig({ includeWorkspaceTree: false });
		const s = await openSettings();

		await writeConfig({ includeWorkspaceTree: true });
		const report = await s.reloadGlobal();

		expect(report.changed).toContain("includeWorkspaceTree");
		expect(report.restartRequired).toContain("includeWorkspaceTree");
	});

	it("does not call a setting restart-only when a live setter exists for it", async () => {
		await writeConfig({ advisor: { enabled: false } });
		const s = await openSettings();

		await writeConfig({ advisor: { enabled: true } });
		const report = await s.reloadGlobal();

		expect(report.changed).toContain("advisor.enabled");
		// `advisorEnabledSignal` reaches `SessionAdvisors.setAdvisorEnabled`, the same
		// setter `/advisor on|off` uses, so telling the user to restart would be wrong.
		expect(report.restartRequired).not.toContain("advisor.enabled");
	});

	it("classifies a partially reloadable setting with a reason", async () => {
		await writeConfig({ disabledProviders: [] });
		const s = await openSettings();

		await writeConfig({ disabledProviders: ["llama.cpp"] });
		const report = await s.reloadGlobal();

		expect(report.changed).toContain("disabledProviders");
		const partial = report.partiallyApplied.find(entry => entry.key === "disabledProviders");
		expect(partial?.reason).toContain("restart");
		// Not double-reported: partial is distinct from restart-only.
		expect(report.restartRequired).not.toContain("disabledProviders");
	});
});

describe("Settings.reloadGlobalIfChangedOnDisk overlay coverage", () => {
	let tempDir: TempDir;
	let agentDir: string;
	let configPath: string;
	let overlayPath: string;
	let settings: Settings | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-reload-overlay-");
		agentDir = path.join(tempDir.path(), "agent");
		await Bun.write(path.join(agentDir, ".keep"), "");
		configPath = path.join(agentDir, "config.yml");
		overlayPath = path.join(tempDir.path(), "overlay.yml");
	});

	afterEach(async () => {
		await settings?.flush().catch(() => {});
		settings = undefined;
		tempDir.removeSync();
	});

	it("picks up an overlay edit even when the main config is untouched", async () => {
		await Bun.write(configPath, YAML.stringify({ defaultThinkingLevel: "low" }));
		await Bun.write(overlayPath, YAML.stringify({ hideThinkingBlock: false }));
		settings = await Settings.loadIsolated({
			cwd: tempDir.path(),
			agentDir,
			configFiles: [overlayPath],
		});
		expect(settings.get("hideThinkingBlock")).toBe(false);

		// Take the change-detection baseline first. The very first call always reloads
		// while it establishes that baseline, so without this the assertion below would
		// pass even if overlays were not tracked at all.
		await settings.reloadGlobalIfChangedOnDisk();
		expect(await settings.reloadGlobalIfChangedOnDisk()).toBeUndefined();

		// Now only the overlay changes. Watching just the main config's mtime would never
		// notice, yet overlays outrank global in the merge and are re-staged by the same
		// reload, so their edits have to trigger it too.
		await Bun.write(overlayPath, YAML.stringify({ hideThinkingBlock: true }));
		const bumped = new Date(Date.now() + 10_000);
		fs.utimesSync(overlayPath, bumped, bumped);

		const report = await settings.reloadGlobalIfChangedOnDisk();

		expect(report?.status).toBe("applied");
		expect(report?.changed).toContain("hideThinkingBlock");
		expect(settings.get("hideThinkingBlock")).toBe(true);
	});

	it("keeps the selected config path when an overlay fails to parse", async () => {
		await Bun.write(configPath, YAML.stringify({ defaultThinkingLevel: "low" }));
		await Bun.write(overlayPath, YAML.stringify({ hideThinkingBlock: true }));
		settings = await Settings.loadIsolated({
			cwd: tempDir.path(),
			agentDir,
			configFiles: [overlayPath],
		});

		// Main config staging runs before overlay staging, so a mutation there would
		// survive an overlay failure and break the "previous state intact" promise.
		await Bun.write(overlayPath, "hideThinkingBlock: [unclosed\n");
		const report = await settings.reloadGlobal();

		expect(report.status).toBe("failed");
		expect(settings.get("defaultThinkingLevel")).toBe(Effort.Low);
		expect(settings.get("hideThinkingBlock")).toBe(true);
	});
	it("does not repoint the save target when a later stage aborts the reload", async () => {
		// Only the legacy filename exists, so it becomes this session's save target.
		const legacyPath = path.join(agentDir, "config.yaml");
		await Bun.write(legacyPath, YAML.stringify({ defaultThinkingLevel: "low" }));
		await Bun.write(overlayPath, YAML.stringify({ hideThinkingBlock: true }));
		settings = await Settings.loadIsolated({
			cwd: tempDir.path(),
			agentDir,
			configFiles: [overlayPath],
		});

		// `config.yml` outranks `config.yaml`, so staging now selects the new file...
		await Bun.write(configPath, YAML.stringify({ defaultThinkingLevel: "medium" }));
		// ...but the overlay fails, so the whole reload must abort with nothing adopted.
		await Bun.write(overlayPath, "hideThinkingBlock: [unclosed\n");

		const report = await settings.reloadGlobal();
		expect(report.status).toBe("failed");

		// Main-config staging runs before overlay staging. Assigning the selected path
		// there would leave this session saving into the file it never actually adopted.
		settings.set("symbolPreset", "nerd");
		await settings.flush();

		const legacy = YAML.parse(await Bun.file(legacyPath).text()) as Record<string, unknown>;
		const promoted = YAML.parse(await Bun.file(configPath).text()) as Record<string, unknown>;
		expect(legacy.symbolPreset).toBe("nerd");
		expect(promoted.symbolPreset).toBeUndefined();
	});
	it("detects a rewrite that reuses the same mtime", async () => {
		// A whole second round-trips exactly through `utimesSync`, so both writes below
		// can be given a byte-identical nanosecond mtime. An arbitrary value cannot:
		// Number(ns) / 1e9 loses precision at that scale.
		const FIXED_SECONDS = 1_700_000_000;
		const FIXED_NS = BigInt(FIXED_SECONDS) * 1_000_000_000n;

		await Bun.write(configPath, YAML.stringify({ defaultThinkingLevel: "low" }));
		fs.utimesSync(configPath, FIXED_SECONDS, FIXED_SECONDS);
		settings = await Settings.loadIsolated({ cwd: tempDir.path(), agentDir });

		await settings.reloadGlobalIfChangedOnDisk();
		expect(await settings.reloadGlobalIfChangedOnDisk()).toBeUndefined();

		// A fast editor write can land inside the filesystem's timestamp granularity and
		// reuse the previous mtime. Pinning both writes to the same second reproduces
		// that exactly: a stamp keyed on mtime alone sees no change here at all.
		await Bun.write(configPath, YAML.stringify({ defaultThinkingLevel: "xhigh" }));
		fs.utimesSync(configPath, FIXED_SECONDS, FIXED_SECONDS);
		// Precondition, not decoration: without an identical mtime this proves nothing.
		expect(fs.statSync(configPath, { bigint: true }).mtimeNs).toBe(FIXED_NS);

		const report = await settings.reloadGlobalIfChangedOnDisk();

		expect(report?.status).toBe("applied");
		expect(settings.get("defaultThinkingLevel")).toBe(Effort.XHigh);
	});
});
