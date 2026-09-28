import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { cfgCollabEnabled } from "@oh-my-pi/pi-coding-agent/collab/settings";
import { cfgShareEnabled } from "@oh-my-pi/pi-coding-agent/commands/settings";
import { cfgModelRoles } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgEditFuzzyMatch } from "@oh-my-pi/pi-coding-agent/edit/settings";
import { logger, TempDir } from "@oh-my-pi/pi-utils";

describe("machine-managed settings", () => {
	let temp: TempDir;
	let agentDir: string;
	let project: string;
	let managedPath: string;

	beforeEach(() => {
		temp = TempDir.createSync("@pi-settings-managed-");
		agentDir = temp.join("agent");
		project = temp.join("project");
		managedPath = temp.join("machine", "config.yml");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(path.join(project, ".omp"), { recursive: true });
	});

	afterEach(() => {
		temp.removeSync();
	});

	it("machine policy wins over global, project, CLI overlay, runtime, environment and child overrides", async () => {
		await Bun.write(
			path.join(agentDir, "config.yml"),
			"share:\n  enabled: true\nmodelRoles:\n  smol: anthropic/global\n",
		);
		await Bun.write(path.join(project, ".omp", "config.yml"), "share:\n  enabled: true\n");
		const overlayPath = temp.join("overlay.yml");
		await Bun.write(overlayPath, "share:\n  enabled: true\n");
		await Bun.write(
			managedPath,
			"share:\n  enabled: false\nedit:\n  fuzzyMatch: false\nmodelRoles:\n  default: anthropic/policy\n",
		);
		const oldEnv = Bun.env.PI_EDIT_FUZZY;
		Bun.env.PI_EDIT_FUZZY = "1";
		try {
			const settings = await Settings.loadReadOnly({
				cwd: project,
				agentDir,
				managedConfigPath: managedPath,
				configFiles: [overlayPath],
				overrides: { "share.enabled": true, "modelRoles.default": "anthropic/runtime" },
			});
			expect(cfgShareEnabled.get(settings)).toBe(false);
			expect(cfgEditFuzzyMatch.get(settings)).toBe(false);
			expect(cfgEditFuzzyMatch.provenance(settings)).toBe("managed");
			const child = settings.overlay({ "share.enabled": true, "modelRoles.default": "anthropic/child" });
			expect(cfgShareEnabled.get(child)).toBe(false);
			expect(cfgShareEnabled.provenance(child)).toBe("managed");
			expect(child.getModelRole("default")).toBe("anthropic/policy");
			expect(child.getModelRoleProvenance("default")).toBe("managed");
			expect(child.getModelRole("smol")).toBe("anthropic/global");
			expect(child.getModelRoleProvenance("smol")).toBe("global");
			cfgShareEnabled.override(child, true);
			expect(cfgShareEnabled.get(child)).toBe(false);
			const clone = await settings.cloneForCwd(temp.join("other"));
			expect(cfgShareEnabled.get(clone)).toBe(false);
		} finally {
			if (oldEnv === undefined) delete Bun.env.PI_EDIT_FUZZY;
			else Bun.env.PI_EDIT_FUZZY = oldEnv;
		}
	});

	it("rejects invalid known machine policy values instead of using a permissive lower layer", async () => {
		await Bun.write(managedPath, "collab:\n  enabled: 'false'\n");
		await expect(Settings.loadReadOnly({ cwd: project, agentDir, managedConfigPath: managedPath })).rejects.toThrow(
			/Invalid machine policy config.*collab.enabled/,
		);
	});

	it("ignores unknown policy keys without letting an unknown group shadow known settings", async () => {
		await Bun.write(path.join(agentDir, "config.yml"), "share:\n  enabled: false\n");
		await Bun.write(managedPath, "share: newer-client-value\ncollab:\n  enabeld: false\n  enabled: false\n");
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const settings = await Settings.loadReadOnly({ cwd: project, agentDir, managedConfigPath: managedPath });
			expect(cfgShareEnabled.get(settings)).toBe(false);
			expect(cfgShareEnabled.provenance(settings)).toBe("global");
			expect(cfgCollabEnabled.get(settings)).toBe(false);
			expect(cfgCollabEnabled.provenance(settings)).toBe("managed");
			expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ path: "share" }));
			expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ path: "collab.enabeld" }));
		} finally {
			warn.mockRestore();
		}
	});

	it("forwards parent record changes only when visible through an overlay", async () => {
		const settings = await Settings.loadReadOnly({ cwd: project, agentDir, managedConfigPath: managedPath });
		const child = settings.overlay({ "modelRoles.default": "anthropic/child" });
		const values: string[] = [];
		const unsubscribe = cfgModelRoles.listen(child, roles => {
			values.push(`${roles.default}:${roles.smol ?? ""}`);
		});
		try {
			cfgModelRoles.override(settings, { default: "anthropic/parent" });
			await Promise.resolve();
			expect(values).toEqual([]);
			cfgModelRoles.override(settings, { default: "anthropic/other", smol: "anthropic/smol" });
			await Promise.resolve();
			expect(values).toEqual(["anthropic/child:anthropic/smol"]);
		} finally {
			unsubscribe();
		}
	});

	it("reloads machine policy and retains the last good value after an invalid update", async () => {
		await Bun.write(managedPath, "collab:\n  enabled: false\n");
		const settings = await Settings.loadIsolated({ cwd: project, agentDir, managedConfigPath: managedPath });
		const clone = await settings.cloneForCwd(temp.join("other-project"));
		const child = settings.overlay({ "collab.enabled": true });
		const observed: boolean[] = [];
		const unsubscribe = cfgCollabEnabled.listen(child, value => {
			observed.push(value);
		});
		expect(cfgCollabEnabled.get(settings)).toBe(false);
		await Bun.write(managedPath, "collab:\n  enabled: true\n");
		await settings.reloadFromDisk();
		expect(cfgCollabEnabled.get(settings)).toBe(true);
		await clone.reloadFromDisk();
		expect(cfgCollabEnabled.get(clone)).toBe(true);
		await Bun.write(managedPath, "collab:\n  enabled: no\n");
		await expect(settings.reloadFromDisk()).rejects.toThrow("Invalid machine policy config");
		expect(cfgCollabEnabled.get(settings)).toBe(true);
		await Bun.write(managedPath, "collab:\n  enabled: false\n");
		await settings.reloadFromDisk();
		expect(cfgCollabEnabled.get(child)).toBe(false);
		fs.rmSync(managedPath);
		await settings.reloadFromDisk();
		expect(cfgCollabEnabled.provenance(settings)).toBe("default");
		expect(cfgCollabEnabled.get(child)).toBe(true);
		expect(observed).toEqual([true, false, true]);
		unsubscribe();
	});
});
