/**
 * Contract: a config layer that names an unknown path token (`${HOME}`), or sets a `sandbox.*`
 * value outside the setting's choices or of the wrong type, fails the load (and a strict reload)
 * with a {@link ConfigError} that names the file that supplied the value and the setting. Nothing
 * is loaded in its place: the entry is not dropped. Each config layer (global config, `--config`
 * overlays, project config, runtime overrides) is checked on its own, highest first, so an invalid
 * value a higher layer masks still fails, naming the lower layer's file. A value the session keeps
 * after a live reload never fails a later validation. For settings whose layers merge (records),
 * the error names the layer and file whose own entries fail, never a layer or file that did not
 * contribute the failing value.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ConfigError } from "@oh-my-pi/pi-coding-agent/config/config-file";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	cfgSandboxEnabled,
	cfgSandboxFallback,
	cfgSandboxMode,
	cfgSandboxReadScope,
} from "@oh-my-pi/pi-coding-agent/sandbox/settings";
import { TempDir } from "@oh-my-pi/pi-utils";
import { initSandboxSettings } from "../helpers/sandbox-test-state";
import {
	beginSettingsTest,
	restoreSettingsTestState,
	type SettingsTestState,
	waitFor,
} from "../helpers/settings-test-state";

const BAD_LAYER = { sandbox: { filesystem: { allowWrite: ["${HOME}/x"] } } };

let state: SettingsTestState | undefined;
let scratch: TempDir;
let root: string;
let workspace: string;
let agentDir: string;

beforeEach(() => {
	state = beginSettingsTest();
	scratch = TempDir.createSync("@omp-settings-load-path-token-");
	root = fs.realpathSync(scratch.path());
	workspace = path.join(root, "workspace");
	agentDir = path.join(root, "agent");
	for (const dir of [workspace, agentDir]) fs.mkdirSync(dir);
});

afterEach(() => {
	restoreSettingsTestState(state);
	state = undefined;
	scratch.removeSync();
});

/** The error `run` raises: it must reject, so this fails when nothing is thrown. */
async function expectLoadError(run: () => Promise<unknown>): Promise<ConfigError> {
	try {
		await run();
	} catch (error) {
		if (error instanceof ConfigError) return error;
		throw new Error(`expected a ConfigError, got: ${String(error)}`);
	}
	throw new Error("expected the load to fail");
}

/** The part of `error`'s message from `Validate(<id>)` on: the check's own words, free of file paths. */
function validateTail(error: ConfigError, id: string): string {
	const stage = `Validate(${id})`;
	expect(error.message).toContain(stage);
	return error.message.slice(error.message.indexOf(stage));
}

describe("settings load with an unknown path token", () => {
	it("names the project config file and the setting when the bad token comes from the project layer", async () => {
		const error = await expectLoadError(() =>
			initSandboxSettings({ agentDir, workspace }, { project: BAD_LAYER.sandbox }),
		);

		expect(error.message).toContain(path.join(workspace, ".omp", "config.yml"));
		expect(error.message).toContain(
			'Validate(sandbox.filesystem.allowWrite) error: sandbox.filesystem.allowWrite: unknown path token ${HOME} in "${HOME}/x"',
		);
	});

	it("names the overlay file, and not the global config.yml, when the bad token comes from a config overlay", async () => {
		const overlay = path.join(root, "overlay.yml");
		fs.writeFileSync(overlay, 'sandbox:\n  filesystem:\n    allowWrite:\n      - "${HOME}/x"\n');

		const error = await expectLoadError(() => Settings.init({ agentDir, cwd: workspace, configFiles: [overlay] }));

		expect(error.message).toContain(overlay);
		expect(error.message).not.toContain(path.join(agentDir, "config.yml"));
		expect(error.message).toContain("Validate(sandbox.filesystem.allowWrite)");
	});
});

describe("settings load with an invalid sandbox value", () => {
	const GLOBAL = () => path.join(agentDir, "config.yml");
	const PROJECT = () => path.join(workspace, ".omp", "config.yml");

	// One row per setting: each is marked strict on its own, so each must reject on its own.
	const INVALID: { name: string; layer: object; id: string; bad: string; allowed: string[] }[] = [
		{
			name: "an enum outside its choices (mode)",
			layer: { mode: "bogus" },
			id: "sandbox.mode",
			bad: '"bogus"',
			allowed: ["workspace-write", "read-only"],
		},
		{
			name: "an enum outside its choices (fallback)",
			layer: { fallback: "nope" },
			id: "sandbox.fallback",
			bad: '"nope"',
			allowed: ["warn", "block"],
		},
		{
			name: "an enum outside its choices (readScope)",
			layer: { filesystem: { readScope: "everything" } },
			id: "sandbox.filesystem.readScope",
			bad: '"everything"',
			allowed: ["all", "workspace"],
		},
		{
			name: "an enum outside its choices (network.mode)",
			layer: { network: { mode: "open" } },
			id: "sandbox.network.mode",
			bad: '"open"',
			allowed: ["allowlist, deny, allow"],
		},
		{
			name: "a string for a boolean (enabled)",
			layer: { enabled: "maybe" },
			id: "sandbox.enabled",
			bad: '"maybe"',
			allowed: ["boolean"],
		},
		{
			name: "a number for a boolean (windowsListDrives)",
			layer: { filesystem: { windowsListDrives: 1 } },
			id: "sandbox.filesystem.windowsListDrives",
			bad: "1",
			allowed: ["boolean"],
		},
		{
			name: "a string for a boolean (windowsLoopback)",
			layer: { network: { windowsLoopback: "yes" } },
			id: "sandbox.network.windowsLoopback",
			bad: '"yes"',
			allowed: ["boolean"],
		},
		{
			name: "a scope that is not a list",
			layer: { scope: "bash" },
			id: "sandbox.scope",
			bad: '"bash"',
			allowed: ["array"],
		},
	];

	it.each(INVALID)("fails the load naming the file and the setting for $name", async ({ layer, id, bad, allowed }) => {
		const error = await expectLoadError(() => initSandboxSettings({ agentDir, workspace }, { global: layer }));

		expect(error.message).toContain(GLOBAL());
		const tail = validateTail(error, id);
		expect(tail).toContain(bad);
		for (const value of allowed) expect(tail).toContain(value);
	});

	it("names every unknown scope entry", async () => {
		const error = await expectLoadError(() =>
			initSandboxSettings({ agentDir, workspace }, { global: { scope: ["bsah", "nope"] } }),
		);

		const tail = validateTail(error, "sandbox.scope");
		expect(tail).toContain('"bsah"');
		expect(tail).toContain('"nope"');
	});

	it("names the project config file when the invalid value comes from the project layer", async () => {
		const error = await expectLoadError(() =>
			initSandboxSettings({ agentDir, workspace }, { global: { mode: "read-only" }, project: { mode: "readonly" } }),
		);

		expect(error.message).toContain(PROJECT());
		expect(error.message).not.toContain(GLOBAL());
		expect(error.message).toContain("Validate(sandbox.mode)");
	});

	it("names the highest layer at fault: an invalid project value over an invalid global one", async () => {
		const error = await expectLoadError(() =>
			initSandboxSettings({ agentDir, workspace }, { global: { mode: "readonly" }, project: { mode: "bogus" } }),
		);

		expect(error.message).toContain(PROJECT());
		expect(error.message).not.toContain(GLOBAL());
		expect(validateTail(error, "sandbox.mode")).toContain('"bogus"');
	});

	it("fails on an invalid global value that a valid project value masks, naming the global config", async () => {
		const error = await expectLoadError(() =>
			initSandboxSettings(
				{ agentDir, workspace },
				{ global: { mode: "readonly" }, project: { mode: "workspace-write" } },
			),
		);

		expect(error.message).toContain(GLOBAL());
		expect(error.message).not.toContain(PROJECT());
		expect(validateTail(error, "sandbox.mode")).toContain('"readonly"');
	});

	it("fails on an invalid global value that a valid --config overlay value masks, naming the global config", async () => {
		const overlay = path.join(root, "overlay.yml");
		fs.writeFileSync(overlay, "sandbox:\n  mode: workspace-write\n");
		fs.writeFileSync(GLOBAL(), "sandbox:\n  mode: readonly\n");

		const error = await expectLoadError(() => Settings.init({ agentDir, cwd: workspace, configFiles: [overlay] }));

		expect(error.message).toContain(GLOBAL());
		expect(error.message).not.toContain(overlay);
		expect(error.message).toContain("Validate(sandbox.mode)");
	});

	it("loads booleans set to true", async () => {
		const load = initSandboxSettings(
			{ agentDir, workspace },
			{ global: { filesystem: { windowsListDrives: true }, network: { windowsLoopback: true } } },
		);

		await expect(load).resolves.toBeInstanceOf(Settings);
	});

	it("rejects a reload of an invalid global value a valid project value masks, naming the global config", async () => {
		const settings = await initSandboxSettings(
			{ agentDir, workspace },
			{ global: { mode: "read-only", fallback: "warn" }, project: { mode: "workspace-write" } },
		);
		// The rewrite is invalid (`mode`) and also changes a global-only value (`fallback`).
		fs.writeFileSync(GLOBAL(), "sandbox:\n  mode: readonly\n  fallback: block\n");

		const error = await expectLoadError(() => settings.reloadFromDisk());

		expect(error.message).toContain(GLOBAL());
		expect(error.message).not.toContain(PROJECT());
		expect(validateTail(error, "sandbox.mode")).toContain('"readonly"');
		// The rejected reload commits none of the rewritten layer.
		expect(cfgSandboxFallback.get(settings)).toBe("warn");
	});

	it("names the new project's config, not the old one's, when a re-scope into it fails", async () => {
		const settings = await initSandboxSettings({ agentDir, workspace }, { project: { mode: "read-only" } });
		const other = path.join(root, "other");
		fs.mkdirSync(path.join(other, ".omp"), { recursive: true });
		const otherConfig = path.join(other, ".omp", "config.yml");
		fs.writeFileSync(otherConfig, "sandbox:\n  mode: bogus\n");

		const error = await expectLoadError(() => settings.reloadForCwd(other));

		expect(error.message).toContain(otherConfig);
		expect(error.message).not.toContain(PROJECT());
		expect(validateTail(error, "sandbox.mode")).toContain('"bogus"');
		expect(settings.getCwd()).toBe(workspace);
	});

	it("names the rewritten overlay, not the other overlay, when a strict reload rejects it", async () => {
		const a = path.join(root, "a.yml");
		const b = path.join(root, "b.yml");
		fs.writeFileSync(a, "sandbox:\n  fallback: warn\n");
		fs.writeFileSync(b, "sandbox:\n  fallback: block\n");
		const settings = await Settings.init({ agentDir, cwd: workspace, configFiles: [a, b] });
		fs.writeFileSync(a, "sandbox:\n  mode: bogus\n");

		const error = await expectLoadError(() => settings.reloadFromDisk());

		expect(error.message).toContain(a);
		expect(error.message).not.toContain(b);
		expect(validateTail(error, "sandbox.mode")).toContain('"bogus"');
	});

	it("does not fail later validations on an overlay value a live reload kept at its last good value", async () => {
		// Two overlays both setting `sandbox`, so the merged overlay layer is not the files' own objects.
		const base = path.join(root, "o0.yml");
		const overlay = path.join(root, "o1.yml");
		fs.writeFileSync(base, "sandbox:\n  fallback: warn\n");
		fs.writeFileSync(overlay, "sandbox:\n  mode: read-only\n");
		const settings = await Settings.init({ agentDir, cwd: workspace, configFiles: [base, overlay] });
		try {
			settings.startWatching();
			// The edit's unreadable `mode` keeps `read-only`; the rest of the edit applies.
			fs.writeFileSync(overlay, "sandbox:\n  mode: bogus\n  filesystem:\n    readScope: workspace\n");
			await waitFor(() => cfgSandboxReadScope.get(settings) === "workspace");
			expect(cfgSandboxMode.get(settings)).toBe("read-only");

			const other = path.join(root, "other");
			fs.mkdirSync(other);
			await settings.reloadForCwd(other);
			expect(settings.getCwd()).toBe(other);

			fs.writeFileSync(GLOBAL(), "sandbox:\n  enabled: true\n");
			await waitFor(() => cfgSandboxEnabled.get(settings) === true);
			expect(cfgSandboxMode.get(settings)).toBe("read-only");
		} finally {
			settings.cancelPendingSaves();
		}
	});
});

describe("settings load error names the layer at fault for merged settings", () => {
	const GLOBAL = () => path.join(agentDir, "config.yml");
	const PROJECT = () => path.join(workspace, ".omp", "config.yml");

	function writeGlobal(yaml: string): void {
		fs.writeFileSync(GLOBAL(), yaml);
	}

	function writeProject(yaml: string): void {
		fs.mkdirSync(path.join(workspace, ".omp"), { recursive: true });
		fs.writeFileSync(PROJECT(), yaml);
	}

	it("names only the global layer when its own record entry fails and the project layer merges a valid one", async () => {
		writeGlobal("providers:\n  maxInFlightRequests:\n    anthropic: 0\n");
		writeProject("providers:\n  maxInFlightRequests:\n    openai: 2\n");

		const error = await expectLoadError(() => Settings.init({ agentDir, cwd: workspace }));

		expect(error.message).toContain(GLOBAL());
		expect(error.message).not.toContain(PROJECT());
		expect(error.message).toContain("Validate(providers.maxInFlightRequests)");
	});

	it("names the project layer when it holds the failing record entry over a valid global one", async () => {
		writeGlobal("providers:\n  maxInFlightRequests:\n    anthropic: 1\n");
		writeProject("providers:\n  maxInFlightRequests:\n    openai: 0\n");

		const error = await expectLoadError(() => Settings.init({ agentDir, cwd: workspace }));

		expect(error.message).toContain(PROJECT());
		expect(error.message).not.toContain(GLOBAL());
	});

	it("names both layers when each holds a failing entry under a different key", async () => {
		writeGlobal("providers:\n  maxInFlightRequests:\n    anthropic: 0\n");
		writeProject("providers:\n  maxInFlightRequests:\n    openai: 0\n");

		const error = await expectLoadError(() => Settings.init({ agentDir, cwd: workspace }));

		expect(error.message).toContain(GLOBAL());
		expect(error.message).toContain(PROJECT());
	});

	it("does not blame a lower layer's entry that a higher layer overrides with a valid value", async () => {
		writeGlobal("providers:\n  maxInFlightRequests:\n    anthropic: 0\n");
		writeProject("providers:\n  maxInFlightRequests:\n    anthropic: 2\n    openai: 0\n");

		const error = await expectLoadError(() => Settings.init({ agentDir, cwd: workspace }));

		expect(error.message).toContain(PROJECT());
		expect(error.message).not.toContain(GLOBAL());
	});

	it("does not blame a layer below a higher layer that replaces the record with a non-record value", async () => {
		writeGlobal("providers:\n  maxInFlightRequests:\n    anthropic: 0\n");
		writeProject("providers:\n  maxInFlightRequests: 7\n");
		const overlay = path.join(root, "a.yml");
		fs.writeFileSync(overlay, "providers:\n  maxInFlightRequests:\n    openai: 0\n");

		const error = await expectLoadError(() => Settings.init({ agentDir, cwd: workspace, configFiles: [overlay] }));

		expect(error.message).toContain(overlay);
		expect(error.message).not.toContain(GLOBAL());
	});

	it("names only the project file that sets the value, not other project settings files", async () => {
		writeProject("providers:\n  maxInFlightRequests:\n    openai: 0\n");
		fs.mkdirSync(path.join(workspace, ".claude"), { recursive: true });
		const claudeSettings = path.join(workspace, ".claude", "settings.json");
		fs.writeFileSync(claudeSettings, JSON.stringify({ compaction: { enabled: true } }));

		const error = await expectLoadError(() => Settings.init({ agentDir, cwd: workspace }));

		expect(error.message).toContain(PROJECT());
		expect(error.message).not.toContain(claudeSettings);
	});

	it("names only the overlay file that sets the value when several overlays are given", async () => {
		const bad = path.join(root, "a.yml");
		const other = path.join(root, "b.yml");
		fs.writeFileSync(bad, "providers:\n  maxInFlightRequests:\n    openai: 0\n");
		fs.writeFileSync(other, "compaction:\n  enabled: true\n");

		const error = await expectLoadError(() => Settings.init({ agentDir, cwd: workspace, configFiles: [bad, other] }));

		expect(error.message).toContain(bad);
		expect(error.message).not.toContain(other);
	});
});
