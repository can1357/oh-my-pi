import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { Effort } from "@oh-my-pi/pi-ai";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { __providerInFlightForTesting, streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context } from "@oh-my-pi/pi-ai/types";
import {
	onAppendOnlyModeChanged,
	onCodeModeChanged,
	onModelRolesChanged,
	onStatusLineSessionAccentChanged,
	resetSettingsForTest,
	type SettingPath,
	Settings,
} from "@oh-my-pi/pi-coding-agent/config/settings";
import * as discovery from "@oh-my-pi/pi-coding-agent/discovery";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { AUTO_IMAGE_PROVIDER_ORDER } from "@oh-my-pi/pi-coding-agent/tools/image-providers";
import { SEARCH_PROVIDER_ORDER } from "@oh-my-pi/pi-coding-agent/web/search/types";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import * as fileLock from "@oh-my-pi/pi-utils/file-lock";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

function context(): Context {
	return {
		systemPrompt: [],
		messages: [{ role: "user", content: "hi", timestamp: 0 }],
	};
}

class FsCodeError extends Error {
	code: string;

	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

describe("Settings", () => {
	let settingsState: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		settingsState = beginSettingsTest();

		// Use TempDir for Windows-safe cleanup (retries on EBUSY from SQLite
		// file handle release delays).
		tempDir = TempDir.createSync("@pi-settings-test-");
		agentDir = tempDir.join("agent");
		projectDir = tempDir.join("project");

		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
	});

	const getConfigPath = () => path.join(agentDir, "config.yml");

	const writeSettings = async (settings: Record<string, unknown>) => {
		await Bun.write(getConfigPath(), YAML.stringify(settings, null, 2));
	};

	const readSettings = async (): Promise<Record<string, unknown>> => {
		const file = Bun.file(getConfigPath());
		if (!(await file.exists())) return {};
		const content = await file.text();
		const parsed = YAML.parse(content);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return parsed as Record<string, unknown>;
	};

	afterEach(async () => {
		vi.restoreAllMocks();
		clearCustomApis();
		__providerInFlightForTesting.setRoot(undefined);
		AgentStorage.resetInstance();
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		await Bun.sleep(0);
		await tempDir?.remove();
	});

	describe("main config file selection", () => {
		it("loads and updates an existing config.yaml without creating config.yml", async () => {
			const yamlConfigPath = path.join(agentDir, "config.yaml");
			await Bun.write(yamlConfigPath, YAML.stringify({ setupVersion: 1 }, null, 2));

			const settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(settings.get("setupVersion")).toBe(1);

			settings.set("setupVersion", 2);
			await settings.flush();

			const savedSettings = YAML.parse(await Bun.file(yamlConfigPath).text()) as Record<string, unknown>;
			expect(savedSettings.setupVersion).toBe(2);
			expect(await Bun.file(getConfigPath()).exists()).toBe(false);
		});

		it("clones the selected config.yaml path for persisted settings", async () => {
			const yamlConfigPath = path.join(agentDir, "config.yaml");
			await Bun.write(yamlConfigPath, YAML.stringify({ setupVersion: 1 }, null, 2));

			const settings = await Settings.init({ cwd: projectDir, agentDir });
			const cloned = await settings.cloneForCwd(tempDir.join("other-project"));

			cloned.set("setupVersion", 2);
			await cloned.flush();

			const savedSettings = YAML.parse(await Bun.file(yamlConfigPath).text()) as Record<string, unknown>;
			expect(savedSettings.setupVersion).toBe(2);
			expect(await Bun.file(getConfigPath()).exists()).toBe(false);
		});

		it("creates config.yml for new persisted settings when no main config exists", async () => {
			const yamlConfigPath = path.join(agentDir, "config.yaml");

			const settings = await Settings.init({ cwd: projectDir, agentDir });
			settings.set("setupVersion", 1);
			await settings.flush();

			expect(await Bun.file(getConfigPath()).exists()).toBe(true);
			expect(await Bun.file(yamlConfigPath).exists()).toBe(false);
			expect((await readSettings()).setupVersion).toBe(1);
		});

		it("writes mapping headers without trailing whitespace and preserves multiline values", async () => {
			const multiline = ["first line", "scalar line ending in colon: ", "third line "].join("\n");
			const custom = {
				"quoted:key": { nested: [{ value: multiline }] },
				emptyObject: {},
				emptyArray: [],
				emptyString: "",
			};
			await writeSettings({ custom, theme: { dark: "anthracite" } });
			const settings = await Settings.init({ cwd: projectDir, agentDir });

			settings.set("theme.dark", "titanium");
			await settings.flush();

			const content = await Bun.file(getConfigPath()).text();
			expect(content).not.toMatch(/: +$/m);
			expect(YAML.parse(content)).toEqual({ custom, theme: { dark: "titanium" } });
		});
	});

	describe("shell configuration errors", () => {
		it("points to the selected global config in the active agent directory", async () => {
			const configPath = path.join(agentDir, "config.yaml");
			const missingShell = tempDir.join("missing-global-bash");
			await Bun.write(configPath, YAML.stringify({ shellPath: missingShell }, null, 2));

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(() => settings.getShellConfig()).toThrow(`Please update shellPath in ${configPath}`);
		});

		it("points to the project file that supplied shellPath", async () => {
			const configPath = path.join(getProjectAgentDir(projectDir), "config.yml");
			const missingShell = tempDir.join("missing-project-bash");
			await Bun.write(configPath, YAML.stringify({ shellPath: missingShell }, null, 2));

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(() => settings.getShellConfig()).toThrow(`Please update shellPath in ${configPath}`);
		});

		it("points to the overlay that supplied shellPath", async () => {
			const configPath = tempDir.join("shell-overlay.yml");
			const missingShell = tempDir.join("missing-overlay-bash");
			await Bun.write(configPath, YAML.stringify({ shellPath: missingShell }, null, 2));

			const settings = await Settings.init({ cwd: projectDir, agentDir, configFiles: [configPath] });

			expect(() => settings.getShellConfig()).toThrow(`Please update shellPath in ${configPath}`);
		});
	});

	describe("config file failure safety", () => {
		it("moves malformed main config aside and refuses to start with silent defaults", async () => {
			const configPath = getConfigPath();
			const original = [
				"auth:",
				"  broker:",
				"    token: TOP-SECRET",
				"modelRoles:",
				'  default: "unterminated',
				"",
			].join("\n");
			await Bun.write(configPath, original);

			await expect(Settings.init({ cwd: projectDir, agentDir })).rejects.toThrow("Settings config is invalid");

			expect(await Bun.file(configPath).exists()).toBe(false);
			const backupNames = fs.readdirSync(agentDir).filter(name => name.startsWith("config.yml.broken-"));
			expect(backupNames).toHaveLength(1);
			expect(await Bun.file(path.join(agentDir, backupNames[0])).text()).toBe(original);
		});

		it("rejects when another process quarantines malformed config before the lock is acquired", async () => {
			const configPath = getConfigPath();
			const backupPath = `${configPath}.broken-other-process`;
			const original = 'modelRoles:\n  default: "unterminated\n';
			await Bun.write(configPath, original);
			const canonicalConfigPath = await fs.promises.realpath(configPath);
			const withFileLock = fileLock.withFileLock;
			let movedAside = false;
			vi.spyOn(fileLock, "withFileLock").mockImplementation(async (filePath, fn, options) => {
				if (!movedAside && filePath === canonicalConfigPath) {
					await fs.promises.rename(configPath, backupPath);
					movedAside = true;
				}
				return await withFileLock(filePath, fn, options);
			});

			await expect(Settings.init({ cwd: projectDir, agentDir })).rejects.toThrow(
				"invalid before locking and is now missing",
			);

			expect(movedAside).toBe(true);
			expect(await Bun.file(configPath).exists()).toBe(false);
			expect(await Bun.file(backupPath).text()).toBe(original);
		});

		it("keeps malformed config in place for read-only loads", async () => {
			const configPath = getConfigPath();
			const original = 'modelRoles:\n  default: "unterminated\n';
			await Bun.write(configPath, original);

			await expect(Settings.loadReadOnly({ cwd: projectDir, agentDir })).rejects.toThrow(
				"Settings config is invalid",
			);

			expect(await Bun.file(configPath).text()).toBe(original);
			expect(fs.readdirSync(agentDir).filter(name => name.startsWith("config.yml.broken-"))).toEqual([]);
		});

		it("backs up a config corrupted after startup and retains the pending global change for retry", async () => {
			await writeSettings({
				auth: { broker: { token: "TOP-SECRET" } },
				modelRoles: { default: "keep/default" },
			});
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			const corrupted = 'auth:\n  broker:\n    token: TOP-SECRET\nmodelRoles:\n  default: "unterminated\n';
			await Bun.write(getConfigPath(), corrupted);

			settings.set("theme.dark", "anthracite");
			await expect(settings.flush()).rejects.toThrow("Settings config is invalid");

			expect(await Bun.file(getConfigPath()).exists()).toBe(false);
			const backupNames = fs.readdirSync(agentDir).filter(name => name.startsWith("config.yml.broken-"));
			expect(backupNames).toHaveLength(1);
			const backupPath = path.join(agentDir, backupNames[0]);
			expect(await Bun.file(backupPath).text()).toBe(corrupted);

			await settings.flush();
			expect(await readSettings()).toEqual({
				auth: { broker: { token: "TOP-SECRET" } },
				modelRoles: { default: "keep/default" },
				theme: { dark: "anthracite" },
			});
			expect(await Bun.file(backupPath).text()).toBe(corrupted);
			expect(fs.readdirSync(agentDir).some(name => name.endsWith(".tmp"))).toBe(false);
			if (process.platform !== "win32") {
				expect(fs.statSync(getConfigPath()).mode & 0o777).toBe(0o600);
			}
		});

		it("backs up a corrupted project config and retains the pending project role for retry", async () => {
			await writeSettings({});
			const projectConfigPath = path.join(projectDir, ".omp", "config.yml");
			await Bun.write(
				projectConfigPath,
				YAML.stringify({ modelRoles: { default: "keep/default" }, custom: { keep: true } }, null, 2),
			);
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			const corrupted = 'modelRoles:\n  default: keep/default\n  advisor: "unterminated\ncustom:\n  keep: true\n';
			await Bun.write(projectConfigPath, corrupted);

			settings.setProjectModelRole("smol", "new/smol");
			await expect(settings.flush()).rejects.toThrow("Settings config is invalid");

			expect(await Bun.file(projectConfigPath).exists()).toBe(false);
			const projectAgentDir = path.dirname(projectConfigPath);
			const backupNames = fs.readdirSync(projectAgentDir).filter(name => name.startsWith("config.yml.broken-"));
			expect(backupNames).toHaveLength(1);
			const backupPath = path.join(projectAgentDir, backupNames[0]);
			expect(await Bun.file(backupPath).text()).toBe(corrupted);

			await settings.flush();
			const saved = YAML.parse(await Bun.file(projectConfigPath).text()) as Record<string, unknown>;
			expect(saved).toEqual({
				modelRoles: { default: "keep/default", smol: "new/smol" },
				custom: { keep: true },
			});
			expect(await Bun.file(backupPath).text()).toBe(corrupted);
		});

		it("preserves a symlinked main config while atomically updating its target", async () => {
			const managedConfigPath = tempDir.join("managed-config.yml");
			await Bun.write(managedConfigPath, YAML.stringify({ setupVersion: 1 }, null, 2));
			await fs.promises.symlink(managedConfigPath, getConfigPath(), "file");

			const settings = await Settings.init({ cwd: projectDir, agentDir });
			settings.set("setupVersion", 2);
			await settings.flush();

			expect(fs.lstatSync(getConfigPath()).isSymbolicLink()).toBe(true);
			expect(YAML.parse(await Bun.file(managedConfigPath).text())).toEqual({ setupVersion: 2 });
		});

		it("falls back to move-aside replacement when Windows reports EPERM", async () => {
			await writeSettings({ setupVersion: 1 });
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			const canonicalConfigPath = await fs.promises.realpath(getConfigPath());
			const rename = fsp.rename.bind(fsp);
			let injected = false;
			vi.spyOn(fsp, "rename").mockImplementation(async (source, target) => {
				if (!injected && String(source).endsWith(".tmp") && String(target) === canonicalConfigPath) {
					injected = true;
					throw new FsCodeError("EPERM", "injected Windows replacement failure");
				}
				await rename(source, target);
			});

			settings.set("setupVersion", 2);
			await settings.flush();

			expect(injected).toBe(true);
			expect(await readSettings()).toEqual({ setupVersion: 2 });
			expect(fs.readdirSync(agentDir).some(name => name.endsWith(".tmp") || name.endsWith(".bak"))).toBe(false);
		});

		it("leaves an unreadable main config untouched and retains its pending change", async () => {
			const original = YAML.stringify(
				{
					auth: { broker: { token: "TOP-SECRET" } },
					modelRoles: { default: "keep/default" },
				},
				null,
				2,
			);
			await Bun.write(getConfigPath(), original);
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			settings.set("theme.dark", "anthracite");
			const readSpy = vi.spyOn(fs.promises, "readFile");
			readSpy.mockRejectedValueOnce(new FsCodeError("EIO", "injected read failure"));

			await expect(settings.flush()).rejects.toThrow("Failed to read settings config");
			readSpy.mockRestore();

			expect(await Bun.file(getConfigPath()).text()).toBe(original);
			expect(fs.readdirSync(agentDir).some(name => name.startsWith("config.yml.broken-"))).toBe(false);
			await settings.flush();
			expect(await readSettings()).toEqual({
				auth: { broker: { token: "TOP-SECRET" } },
				modelRoles: { default: "keep/default" },
				theme: { dark: "anthracite" },
			});
		});

		it("leaves an unreadable project config untouched and retains its pending role", async () => {
			await writeSettings({});
			const projectConfigPath = path.join(projectDir, ".omp", "config.yml");
			const original = YAML.stringify({ modelRoles: { default: "keep/default" }, custom: { keep: true } }, null, 2);
			await Bun.write(projectConfigPath, original);
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			settings.setProjectModelRole("smol", "new/smol");
			const readSpy = vi.spyOn(fs.promises, "readFile");
			readSpy.mockRejectedValueOnce(new FsCodeError("EACCES", "injected read failure"));

			await expect(settings.flush()).rejects.toThrow("Failed to read settings config");
			readSpy.mockRestore();

			expect(await Bun.file(projectConfigPath).text()).toBe(original);
			expect(
				fs.readdirSync(path.dirname(projectConfigPath)).some(name => name.startsWith("config.yml.broken-")),
			).toBe(false);
			await settings.flush();
			expect(YAML.parse(await Bun.file(projectConfigPath).text())).toEqual({
				modelRoles: { default: "keep/default", smol: "new/smol" },
				custom: { keep: true },
			});
		});

		it("observes both failures when global and project configs are malformed", async () => {
			const malformed = 'modelRoles:\n  default: "unterminated\n';
			await Promise.all([
				Bun.write(getConfigPath(), malformed),
				Bun.write(path.join(projectDir, ".omp", "config.yml"), malformed),
			]);
			const unhandled: unknown[] = [];
			const onUnhandled = (reason: unknown): void => {
				unhandled.push(reason);
			};
			process.on("unhandledRejection", onUnhandled);
			try {
				await expect(Settings.init({ cwd: projectDir, agentDir })).rejects.toThrow("Settings config is invalid");
				expect(unhandled).toEqual([]);
				expect(fs.readdirSync(agentDir).some(name => name.startsWith("config.yml.broken-"))).toBe(true);
				expect(
					fs.readdirSync(path.join(projectDir, ".omp")).some(name => name.startsWith("config.yml.broken-")),
				).toBe(true);
			} finally {
				process.removeListener("unhandledRejection", onUnhandled);
			}
		});
	});

	describe("live persisted reload", () => {
		it("rejects malformed live configs without moving them aside or replacing effective settings", async () => {
			const projectConfigPath = path.join(projectDir, ".omp", "config.yml");
			await writeSettings({
				setupVersion: 1,
				modelRoles: { global_role: "openai/global" },
			});
			await Bun.write(
				projectConfigPath,
				YAML.stringify({ modelRoles: { project_role: "openai/project" } }, null, 2),
			);
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			const malformedGlobal = 'setupVersion: 2\nmodelRoles:\n  global_role: "unterminated\n';
			const malformedProject = 'modelRoles:\n  project_role: "unterminated\n';
			await Promise.all([
				Bun.write(getConfigPath(), malformedGlobal),
				Bun.write(projectConfigPath, malformedProject),
			]);

			await expect(settings.reloadFromDisk()).rejects.toThrow("Settings config is invalid");

			expect(await Bun.file(getConfigPath()).text()).toBe(malformedGlobal);
			expect(await Bun.file(projectConfigPath).text()).toBe(malformedProject);
			expect(fs.readdirSync(agentDir).some(name => name.startsWith("config.yml.broken-"))).toBe(false);
			expect(
				fs.readdirSync(path.dirname(projectConfigPath)).some(name => name.startsWith("config.yml.broken-")),
			).toBe(false);
			expect(settings.get("setupVersion")).toBe(1);
			expect(settings.getModelRole("global_role")).toBe("openai/global");
			expect(settings.getModelRole("project_role")).toBe("openai/project");
		});
		it("retries when a persisted setting changes while files are being read", async () => {
			await writeSettings({ setupVersion: 1 });
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			const loadCapability = discovery.loadCapability;
			const projectLoadStarted = Promise.withResolvers<void>();
			const releaseProjectLoad = Promise.withResolvers<void>();
			let pauseProjectLoad = true;
			vi.spyOn(discovery, "loadCapability").mockImplementation(async (id, options) => {
				if (pauseProjectLoad) {
					pauseProjectLoad = false;
					projectLoadStarted.resolve();
					await releaseProjectLoad.promise;
				}
				return await loadCapability(id, options);
			});

			const reload = settings.reloadFromDisk();
			await projectLoadStarted.promise;
			settings.set("setupVersion", 2);
			releaseProjectLoad.resolve();
			await reload;
			await settings.flush();

			expect(settings.get("setupVersion")).toBe(2);
			expect((await readSettings()).setupVersion).toBe(2);
		});

		it("preserves runtime overrides and only signals semantic model-role changes", async () => {
			await writeSettings({ modelRoles: { default: "openai/original" } });
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			settings.overrideModelRoles({ runtime: "openai/runtime" });
			let signalCount = 0;
			const unsubscribe = onModelRolesChanged(() => {
				signalCount++;
			});

			try {
				await settings.reloadFromDisk();
				expect(signalCount).toBe(0);
				expect(settings.getModelRole("runtime")).toBe("openai/runtime");

				await writeSettings({ modelRoles: { default: "openai/updated" } });
				await settings.reloadFromDisk();

				expect(signalCount).toBe(1);
				expect(settings.getModelRole("default")).toBe("openai/updated");
				expect(settings.getModelRole("runtime")).toBe("openai/runtime");
			} finally {
				unsubscribe();
			}
		});

		it("signals Code Mode partition inputs picked up from disk", async () => {
			await writeSettings({ providers: { "openai-codex": { codeMode: "off" } }, eval: { js: true } });
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			let signalCount = 0;
			const unsubscribe = onCodeModeChanged(() => {
				signalCount++;
			});

			try {
				await settings.reloadFromDisk();
				expect(signalCount).toBe(0);

				await writeSettings({ providers: { "openai-codex": { codeMode: "on" } }, eval: { js: true } });
				await settings.reloadFromDisk();

				expect(settings.get("providers.openai-codex.codeMode")).toBe("on");
				expect(signalCount).toBe(1);

				// A single reload that changes several partition inputs signals once.
				await writeSettings({
					providers: { "openai-codex": { codeMode: "on", codeModeDirectTools: ["bash"] } },
					eval: { js: false },
				});
				await settings.reloadFromDisk();

				expect(settings.get("eval.js")).toBe(false);
				expect(settings.get("providers.openai-codex.codeModeDirectTools")).toEqual(["bash"]);
				expect(signalCount).toBe(2);

				// `edit.mode` renames the direct edit tool on the wire.
				await writeSettings({
					providers: { "openai-codex": { codeMode: "on", codeModeDirectTools: ["bash"] } },
					eval: { js: false },
					edit: { mode: "apply_patch" },
				});
				await settings.reloadFromDisk();

				expect(settings.get("edit.mode")).toBe("apply_patch");
				expect(signalCount).toBe(3);
			} finally {
				unsubscribe();
			}
		});

		it("signals Code Mode partition inputs supplied by the destination project", async () => {
			await writeSettings({ providers: { "openai-codex": { codeMode: "off" } } });
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			const otherProject = tempDir.join("code-mode-project");
			await Bun.write(
				path.join(getProjectAgentDir(otherProject), "config.yml"),
				YAML.stringify({ providers: { "openai-codex": { codeMode: "on" } } }, null, 2),
			);
			let signalCount = 0;
			const unsubscribe = onCodeModeChanged(() => {
				signalCount++;
			});

			try {
				await settings.reloadForCwd(otherProject);

				expect(settings.get("providers.openai-codex.codeMode")).toBe("on");
				expect(signalCount).toBe(1);
			} finally {
				unsubscribe();
			}
		});
	});

	describe("get()", () => {
		it("resolves overrides, schema defaults, and falsey values", () => {
			const isolated = Settings.isolated({
				"display.showTokenUsage": false,
				setupVersion: 0,
				shellPath: "",
				enabledModels: [],
			});

			expect(isolated.get("display.showTokenUsage")).toBe(false);
			expect(isolated.get("setupVersion")).toBe(0);
			expect(isolated.get("shellPath")).toBe("");
			expect(isolated.get("enabledModels")).toEqual([]);
		});

		it("invalidates cached resolved values after set, override, and clearOverride", () => {
			const isolated = Settings.isolated();

			expect(isolated.get("display.showTokenUsage")).toBe(false);
			isolated.set("display.showTokenUsage", true);
			expect(isolated.get("display.showTokenUsage")).toBe(true);

			isolated.override("display.showTokenUsage", false);
			expect(isolated.get("display.showTokenUsage")).toBe(false);

			isolated.clearOverride("display.showTokenUsage");
			expect(isolated.get("display.showTokenUsage")).toBe(true);
		});

		it("re-resolves path-scoped arrays when cwd changes", async () => {
			const otherDir = path.join(tempDir.toString(), "other-project");
			fs.mkdirSync(otherDir, { recursive: true });

			const settings = await Settings.init({
				cwd: projectDir,
				agentDir,
				inMemory: true,
				overrides: {
					enabledModels: [
						"always-model",
						{ path: projectDir, models: ["project-model"] },
						{ path: otherDir, models: ["other-model"] },
					],
					disabledProviders: [
						"always-provider",
						{ pathPrefix: projectDir, providers: ["project-provider"] },
						{ pathPrefix: otherDir, providers: ["other-provider"] },
					],
				},
			});

			expect(settings.get("enabledModels")).toEqual(["always-model", "project-model"]);
			expect(settings.get("disabledProviders")).toEqual(["always-provider", "project-provider"]);

			await settings.reloadForCwd(otherDir);

			expect(settings.get("enabledModels")).toEqual(["always-model", "other-model"]);
			expect(settings.get("disabledProviders")).toEqual(["always-provider", "other-provider"]);
		});

		it("migrates legacy snapcompact system prompt booleans to scoped modes", () => {
			expect(Settings.isolated({ "snapcompact.systemPrompt": true }).get("snapcompact.systemPrompt")).toBe("all");
			const nestedLegacy = { snapcompact: { systemPrompt: false } } as Partial<Record<SettingPath, unknown>>;
			expect(Settings.isolated(nestedLegacy).get("snapcompact.systemPrompt")).toBe("none");
		});

		it("migrates legacy inlineToolDescriptors booleans to the on/off enum", () => {
			expect(Settings.isolated({ inlineToolDescriptors: true }).get("inlineToolDescriptors")).toBe("on");
			expect(Settings.isolated({ inlineToolDescriptors: false }).get("inlineToolDescriptors")).toBe("off");
			expect(Settings.isolated().get("inlineToolDescriptors")).toBe("auto");
		});
	});

	describe("statusLine.sessionAccent hooks", () => {
		it("notifies subscribers only when the effective value changes", () => {
			const isolated = Settings.isolated();
			const values: boolean[] = [];
			const unsubscribe = onStatusLineSessionAccentChanged(() => {
				values.push(isolated.get("statusLine.sessionAccent"));
			});

			try {
				isolated.set("statusLine.sessionAccent", true);
				expect(values).toEqual([]);

				isolated.set("statusLine.sessionAccent", false);
				expect(values).toEqual([false]);

				isolated.override("statusLine.sessionAccent", false);
				expect(values).toEqual([false]);

				isolated.override("statusLine.sessionAccent", true);
				expect(values).toEqual([false, true]);

				isolated.clearOverride("statusLine.sessionAccent");
				expect(values).toEqual([false, true, false]);
			} finally {
				unsubscribe();
			}

			isolated.set("statusLine.sessionAccent", true);
			expect(values).toEqual([false, true, false]);
		});
	});

	describe("provider.appendOnlyContext hooks", () => {
		it("isolates a throwing listener so the rest still receive the value", () => {
			const isolated = Settings.isolated();
			const received: string[] = [];
			const unsubscribeThrower = onAppendOnlyModeChanged(() => {
				throw new Error("boom");
			});
			const unsubscribeOk = onAppendOnlyModeChanged(value => {
				received.push(value);
			});

			try {
				isolated.set("provider.appendOnlyContext", "on");
				expect(received).toEqual(["on"]);
			} finally {
				unsubscribeThrower();
				unsubscribeOk();
			}
		});
	});

	// Tests that SettingsManager merges with DB state on save rather than blindly overwriting.
	// This ensures external edits (via AgentStorage directly) aren't lost when the app saves.
	describe("preserves externally added settings", () => {
		it("should preserve enabledModels when changing thinking level", async () => {
			// Seed initial settings in config.yml
			await writeSettings({
				theme: "dark",
				modelRoles: { default: "claude-sonnet" },
			});

			// Settings loads the initial state
			const settings = await Settings.init({ cwd: projectDir, agentDir });

			// Simulate external edit (e.g., user modifying DB directly or another process)
			await writeSettings({
				theme: { dark: "anthracite" },
				modelRoles: { default: "claude-sonnet" },
				enabledModels: ["claude-opus-4-5", "gpt-5.2-codex"],
			});

			// Settings saves a change - should merge, not overwrite
			settings.set("defaultThinkingLevel", Effort.High);
			await settings.flush();

			const savedSettings = await readSettings();
			expect(savedSettings.enabledModels).toEqual(["claude-opus-4-5", "gpt-5.2-codex"]);
			expect(savedSettings.defaultThinkingLevel).toBe(Effort.High);
			expect(savedSettings.theme).toEqual({ dark: "anthracite" });
			expect((savedSettings.modelRoles as { default?: string } | undefined)?.default).toBe("claude-sonnet");
		});

		it("persists native terminal progress only after the user changes it", async () => {
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(await readSettings()).toEqual({});

			settings.set("terminal.showProgress", true);
			await settings.flush();

			const savedSettings = await readSettings();
			expect(savedSettings.terminal).toEqual({ showProgress: true });
		});

		it("filters model allow-list and disabled providers by current path prefix", async () => {
			const workDir = path.join(projectDir, "work", "service");
			const privateDir = path.join(projectDir, "private", "app");
			fs.mkdirSync(workDir, { recursive: true });
			fs.mkdirSync(privateDir, { recursive: true });

			await writeSettings({
				enabledModels: [
					"claude-sonnet-4-5",
					{ path: path.join(projectDir, "work"), values: ["anthropic/claude-opus-4-5"] },
					{ path: path.join(projectDir, "private"), values: ["openai/gpt-5.2-codex"] },
				],
				disabledProviders: [
					"ollama",
					{ path: path.join(projectDir, "work"), values: ["openai"] },
					{ path: path.join(projectDir, "private"), values: ["anthropic"] },
				],
			});

			const workSettings = await Settings.init({ cwd: workDir, agentDir });
			expect(workSettings.get("enabledModels")).toEqual(["claude-sonnet-4-5", "anthropic/claude-opus-4-5"]);
			expect(workSettings.get("disabledProviders")).toEqual(["ollama", "openai"]);

			resetSettingsForTest();
			const privateSettings = await Settings.init({ cwd: privateDir, agentDir });
			expect(privateSettings.get("enabledModels")).toEqual(["claude-sonnet-4-5", "openai/gpt-5.2-codex"]);
			expect(privateSettings.get("disabledProviders")).toEqual(["ollama", "anthropic"]);
		});

		it("should preserve custom settings when changing theme", async () => {
			await writeSettings({
				modelRoles: { default: "claude-sonnet" },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			await writeSettings({
				modelRoles: { default: "claude-sonnet" },
				shellPath: "/bin/zsh",
				extensions: ["/path/to/extension.ts"],
			});

			settings.set("theme.dark", "anthracite");
			await settings.flush();

			const savedSettings = await readSettings();
			expect(savedSettings.shellPath).toBe("/bin/zsh");
			expect(savedSettings.extensions).toEqual(["/path/to/extension.ts"]);
			expect(savedSettings.theme).toEqual({ dark: "anthracite" });
		});

		it("should let in-memory changes override file changes for same key", async () => {
			await writeSettings({
				theme: { dark: "anthracite" },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			await writeSettings({
				theme: { dark: "anthracite" },
				defaultThinkingLevel: Effort.Low,
			});

			settings.set("defaultThinkingLevel", Effort.High);
			await settings.flush();

			const savedSettings = await readSettings();
			expect(savedSettings.defaultThinkingLevel).toBe(Effort.High);
		});

		it("preserves a same-key external edit made after a local save was queued", async () => {
			await writeSettings({
				defaultThinkingLevel: Effort.Low,
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });
			settings.set("defaultThinkingLevel", Effort.High);

			await writeSettings({
				defaultThinkingLevel: Effort.Medium,
			});
			await settings.flush();

			expect((await readSettings()).defaultThinkingLevel).toBe(Effort.Medium);
			expect(settings.get("defaultThinkingLevel")).toBe(Effort.Medium);
		});

		it("merges a pending local change with a later disjoint external edit", async () => {
			await writeSettings({
				defaultThinkingLevel: Effort.Low,
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });
			settings.set("defaultThinkingLevel", Effort.High);

			await writeSettings({
				defaultThinkingLevel: Effort.Low,
				enabledModels: ["openai/gpt-5.2-codex"],
			});
			await settings.flush();

			const savedSettings = await readSettings();
			expect(savedSettings.defaultThinkingLevel).toBe(Effort.High);
			expect(savedSettings.enabledModels).toEqual(["openai/gpt-5.2-codex"]);
		});
		it("reapplies runtime hooks when a later external edit wins", async () => {
			await writeSettings({
				provider: { appendOnlyContext: "auto" },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });
			const received: string[] = [];
			const unsubscribe = onAppendOnlyModeChanged(value => {
				received.push(value);
			});

			try {
				settings.set("provider.appendOnlyContext", "on");
				await writeSettings({
					provider: { appendOnlyContext: "off" },
				});
				await settings.flush();

				expect(settings.get("provider.appendOnlyContext")).toBe("off");
				expect(received).toEqual(["on", "off"]);
			} finally {
				unsubscribe();
			}
		});
	});

	describe("model role overrides", () => {
		it("does not persist temporary default model overrides when another role is saved", async () => {
			await writeSettings({
				modelRoles: { default: "anthropic/claude-sonnet-4-5" },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			settings.overrideModelRoles({ default: "openai/gpt-5.2-codex" });
			expect(settings.getModelRole("default")).toBe("openai/gpt-5.2-codex");

			settings.setModelRole("smol", "anthropic/claude-haiku-4-5");
			await settings.flush();

			const savedSettings = await readSettings();
			expect(savedSettings.modelRoles).toEqual({
				default: "anthropic/claude-sonnet-4-5",
				smol: "anthropic/claude-haiku-4-5",
			});
			expect(settings.getModelRole("default")).toBe("openai/gpt-5.2-codex");
			expect(settings.getModelRole("smol")).toBe("anthropic/claude-haiku-4-5");
		});

		it("preserves a same-role external edit made after a local save was queued", async () => {
			await writeSettings({
				modelRoles: { default: "anthropic/claude-sonnet-4-5" },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });
			settings.setModelRole("default", "openai/gpt-5.2-codex");

			await writeSettings({
				modelRoles: { default: "moonshot/kimi-k3:max" },
			});
			await settings.flush();

			expect((await readSettings()).modelRoles).toEqual({ default: "moonshot/kimi-k3:max" });
			expect(settings.getModelRole("default")).toBe("moonshot/kimi-k3:max");
		});

		it("preserves concurrent external per-role edits when saving one global role", async () => {
			await writeSettings({
				modelRoles: { default: "anthropic/claude-sonnet-4-5", advisor: "moonshot/kimi-k2" },
			});

			// Process loads its #global snapshot.
			const settings = await Settings.init({ cwd: projectDir, agentDir });

			// External edit (another omp instance / manual edit): changes advisor,
			// adds vision. This process's #global is now stale.
			await writeSettings({
				modelRoles: {
					default: "anthropic/claude-sonnet-4-5",
					advisor: "moonshot/kimi-k3:max",
					vision: "anthropic/claude-haiku-4-5",
				},
			});

			// This process makes one global-scope role switch and flushes.
			settings.setModelRole("smol", "anthropic/claude-haiku-4-5");
			await settings.flush();

			const savedSettings = await readSettings();
			// The role we changed lands…
			expect((savedSettings.modelRoles as Record<string, string>).smol).toBe("anthropic/claude-haiku-4-5");
			// …and the concurrent external per-role edits survive rather than
			// being clobbered by our stale whole-map snapshot.
			expect(savedSettings.modelRoles).toEqual({
				default: "anthropic/claude-sonnet-4-5",
				advisor: "moonshot/kimi-k3:max",
				vision: "anthropic/claude-haiku-4-5",
				smol: "anthropic/claude-haiku-4-5",
			});
		});

		it("does not replay a preserved role after the save writes it", async () => {
			await writeSettings({
				modelRoles: { default: "anthropic/claude-sonnet-4-5" },
			});
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			const firstSaveEntered = Promise.withResolvers<void>();
			const releaseFirstSave = Promise.withResolvers<void>();
			const firstSaveFinished = Promise.withResolvers<void>();
			const withFileLock = fileLock.withFileLock;
			vi.spyOn(fileLock, "withFileLock").mockImplementation(async (filePath, fn, options) => {
				firstSaveEntered.resolve();
				const result = await withFileLock(filePath, fn, options);
				firstSaveFinished.resolve();
				return result;
			});

			settings.setModelRole("smol", "anthropic/claude-haiku-4-5");
			await firstSaveEntered.promise;
			settings.setModelRole("advisor", "moonshot/kimi-k3:max");
			releaseFirstSave.resolve();
			await firstSaveFinished.promise;

			expect((await readSettings()).modelRoles).toEqual({
				default: "anthropic/claude-sonnet-4-5",
				smol: "anthropic/claude-haiku-4-5",
				advisor: "moonshot/kimi-k3:max",
			});

			await writeSettings({
				modelRoles: {
					default: "anthropic/claude-sonnet-4-5",
					smol: "anthropic/claude-haiku-4-5",
					advisor: "external/new-advisor",
				},
			});
			await settings.flush();

			expect((await readSettings()).modelRoles).toEqual({
				default: "anthropic/claude-sonnet-4-5",
				smol: "anthropic/claude-haiku-4-5",
				advisor: "external/new-advisor",
			});
		});

		it("restores persisted model roles after clearing runtime overrides", async () => {
			await writeSettings({
				modelRoles: { default: "anthropic/claude-sonnet-4-5" },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			settings.overrideModelRoles({ default: "openai/gpt-5.2-codex" });
			expect(settings.getModelRole("default")).toBe("openai/gpt-5.2-codex");

			settings.clearOverride("modelRoles");

			expect(settings.getModelRole("default")).toBe("anthropic/claude-sonnet-4-5");
		});

		it("keeps the live role value aligned when saving over a runtime override", () => {
			const settings = Settings.isolated({
				modelRoles: { default: "anthropic/claude-sonnet-4-5" },
			});

			settings.overrideModelRoles({ default: "openai/gpt-5.2-codex" });
			settings.setModelRole("default", "anthropic/claude-opus-4-5");

			expect(settings.getModelRole("default")).toBe("anthropic/claude-opus-4-5");

			settings.clearOverride("modelRoles");

			expect(settings.getModelRole("default")).toBe("anthropic/claude-opus-4-5");
		});
		it("clears a role when setModelRole receives undefined", () => {
			const settings = Settings.isolated();

			settings.setModelRole("smol", "x/y");
			expect(settings.getModelRole("smol")).toBe("x/y");

			settings.setModelRole("smol", undefined);

			expect(settings.getModelRole("smol")).toBeUndefined();
			expect(Object.hasOwn(settings.getModelRoles(), "smol")).toBe(false);
		});

		it("clears a role from the runtime override layer so the effective view updates immediately", () => {
			const settings = Settings.isolated({
				modelRoles: { smol: "anthropic/claude-haiku-4-5" },
			});

			settings.overrideModelRoles({ smol: "openai/gpt-5.2-codex" });
			expect(settings.getModelRole("smol")).toBe("openai/gpt-5.2-codex");

			settings.setModelRole("smol", undefined);

			expect(settings.getModelRole("smol")).toBeUndefined();
			expect(Object.hasOwn(settings.getModelRoles(), "smol")).toBe(false);
		});
	});

	describe("getEditVariantForModel", () => {
		it("matches configured model variants case-insensitively", async () => {
			await writeSettings({
				edit: {
					modelVariants: {
						kimi: "hashline",
					},
				},
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.getEditVariantForModel("openrouter/moonshotai/Kimi-K2-Instruct")).toBe("hashline");
		});

		it("refreshes cached model variants when the active project settings change", async () => {
			const otherProjectDir = tempDir.join("other-project");
			fs.mkdirSync(getProjectAgentDir(otherProjectDir), { recursive: true });

			await Bun.write(
				path.join(getProjectAgentDir(projectDir), "settings.json"),
				JSON.stringify({ edit: { modelVariants: { kimi: "hashline" } } }),
			);
			await Bun.write(
				path.join(getProjectAgentDir(otherProjectDir), "settings.json"),
				JSON.stringify({ edit: { modelVariants: { "gpt-5": "apply_patch" } } }),
			);

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.getEditVariantForModel("openrouter/moonshotai/Kimi-K2-Instruct")).toBe("hashline");

			await settings.reloadForCwd(otherProjectDir);

			expect(settings.getEditVariantForModel("openrouter/moonshotai/Kimi-K2-Instruct")).toBeNull();
			expect(settings.getEditVariantForModel("openai/gpt-5.2-codex")).toBe("apply_patch");
		});
	});

	describe("provider preference migration", () => {
		it("expands a legacy providers.webSearch choice into the head of webSearchOrder", async () => {
			await writeSettings({ providers: { webSearch: "exa" } });

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("providers.webSearchOrder")).toEqual([
				"exa",
				...SEARCH_PROVIDER_ORDER.filter(id => id !== "exa"),
			]);
		});

		it("drops legacy providers.webSearch auto without seeding an order", async () => {
			await writeSettings({ providers: { webSearch: "auto" } });

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("providers.webSearchOrder")).toEqual([]);
		});

		it("keeps an explicit webSearchOrder over the legacy webSearch preference", async () => {
			await writeSettings({ providers: { webSearch: "exa", webSearchOrder: ["gemini"] } });

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("providers.webSearchOrder")).toEqual(["gemini"]);
		});

		it("expands a legacy providers.image choice into the head of imageOrder", async () => {
			await writeSettings({ providers: { image: "xai" } });

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("providers.imageOrder")).toEqual([
				"xai",
				...AUTO_IMAGE_PROVIDER_ORDER.filter(id => id !== "xai"),
			]);
		});
	});

	describe("compaction method migration", () => {
		it("defaults to server, snapcompact, handoff, shake, then soft compaction", () => {
			expect(Settings.isolated().get("compaction.methodOrder")).toEqual([
				"remote",
				"snapcompact",
				"handoff",
				"shake",
				"soft",
			]);
		});

		it("migrates a local-only legacy strategy to soft compaction", async () => {
			await writeSettings({ compaction: { strategy: "context-full", remoteEnabled: false } });

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("compaction.methodOrder")).toEqual(["soft"]);
		});
	});
	describe("migrations", () => {
		it("consolidates legacy Exa suite toggles onto exa.enabled", async () => {
			await writeSettings({
				exa: {
					enabled: true,
					enableSearch: false,
					enableResearcher: true,
					enableWebsets: true,
				},
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("exa.enabled")).toBe(false);
			settings.set("display.showTokenUsage", true);
			await settings.flush();
			expect((await readSettings()).exa).toEqual({ enabled: false });
		});

		it("migrates quoted dotted Exa toggles and removes obsolete suite settings", async () => {
			await Bun.write(
				getConfigPath(),
				`"exa.enabled": true\n"exa.enableSearch": false\n"exa.enableResearcher": true\n"exa.enableWebsets": true\n`,
			);

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("exa.enabled")).toBe(false);
			settings.set("display.showTokenUsage", true);
			await settings.flush();
			expect((await readSettings()).exa).toEqual({ enabled: false });
		});

		it("removes the legacy Exa block when it contains only retired suite toggles", async () => {
			await writeSettings({ exa: { enableResearcher: true, enableWebsets: true } });

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("exa.enabled")).toBe(true);
			settings.set("display.showTokenUsage", true);
			await settings.flush();
			expect((await readSettings()).exa).toBeUndefined();
		});

		it("removes the retired computer backend setting", async () => {
			await writeSettings({ computer: { backend: "auto", enabled: true }, "computer.backend": "native" });

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("computer.enabled")).toBe(true);
			settings.set("display.showTokenUsage", true);
			await settings.flush();
			expect((await readSettings()).computer).toEqual({ enabled: true });
		});

		it("maps removed atom edit mode settings to hashline", async () => {
			await writeSettings({
				edit: {
					mode: "atom",
					modelVariants: {
						"claude-opus": "atom",
						"gpt-5": "apply_patch",
					},
				},
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("edit.mode")).toBe("hashline");
			expect(settings.getEditVariantForModel("claude-opus-4-5")).toBe("hashline");
			expect(settings.getEditVariantForModel("gpt-5.2")).toBe("apply_patch");
		});

		it("maps legacy hindsight.dynamicBankId=true onto hindsight.scoping=per-project", async () => {
			await writeSettings({
				hindsight: { dynamicBankId: true },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("hindsight.scoping")).toBe("per-project");
		});

		it("does not override an explicit hindsight.scoping when migrating", async () => {
			await writeSettings({
				hindsight: { dynamicBankId: true, scoping: "global" },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("hindsight.scoping")).toBe("global");
		});

		it("promotes legacy hindsight.agentName onto hindsight.bankId when bankId is unset", async () => {
			await writeSettings({
				hindsight: { agentName: "ada-cli" },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("hindsight.bankId")).toBe("ada-cli");
		});

		it("migrates the legacy mnemosyne memory backend to mnemopi", async () => {
			await writeSettings({
				memory: { backend: "mnemosyne" },
				mnemosyne: { dbPath: "/tmp/old.db", scoping: "global" },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("memory.backend")).toBe("mnemopi");
			expect(settings.get("mnemopi.dbPath")).toBe("/tmp/old.db");
			expect(settings.get("mnemopi.scoping")).toBe("global");
		});

		it("does not clobber an explicit mnemopi block when the legacy mnemosyne block is also present", async () => {
			await writeSettings({
				mnemosyne: { dbPath: "/tmp/old.db" },
				mnemopi: { dbPath: "/tmp/new.db" },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("mnemopi.dbPath")).toBe("/tmp/new.db");
		});

		it("migrates boolean task.eager/todo.eager true to always", async () => {
			await writeSettings({
				task: { eager: true },
				todo: { eager: true },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			// `true` reproduced the previous "on" behavior, now `always`.
			expect(settings.get("task.eager")).toBe("always");
			expect(settings.get("todo.eager")).toBe("always");
		});

		it("migrates boolean task.eager/todo.eager false to default", async () => {
			await writeSettings({
				task: { eager: false },
				todo: { eager: false },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			// Load-bearing direction: consumers treat any non-`default` value as enabled
			// (`false !== "default"`), so an un-coerced boolean `false` would read as ON.
			expect(settings.get("task.eager")).toBe("default");
			expect(settings.get("todo.eager")).toBe("default");
		});

		it("migrates legacy features.unexpectedStopDetection=true to smart", async () => {
			await writeSettings({ features: { unexpectedStopDetection: true } });

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			// `true` reproduced the previous small-model-classified guard, now "smart".
			expect(settings.get("features.unexpectedStopDetection")).toBe("smart");
		});

		it("maps legacy features.unexpectedStopDetection=false to none", async () => {
			await writeSettings({ features: { unexpectedStopDetection: false } });

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("features.unexpectedStopDetection")).toBe("none");
		});

		it("resolves unconfigured features.unexpectedStopDetection to the mechanical default", async () => {
			await writeSettings({});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("features.unexpectedStopDetection")).toBe("mechanical");
		});

		it("normalizes a quoted-dotted legacy unexpected-stop boolean", async () => {
			await Bun.write(getConfigPath(), '"features.unexpectedStopDetection": true\n');

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("features.unexpectedStopDetection")).toBe("smart");
		});

		it("keeps an explicit unexpected-stop mode over a legacy dotted boolean", async () => {
			await Bun.write(
				getConfigPath(),
				'"features.unexpectedStopDetection": false\nfeatures:\n  unexpectedStopDetection: smart\n',
			);

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("features.unexpectedStopDetection")).toBe("smart");
		});

		it("moves legacy lastChangelogVersion out of config.yml into the marker file", async () => {
			await writeSettings({ lastChangelogVersion: "0.40.0" });

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			// Marker seeded from the legacy key.
			expect(fs.readFileSync(path.join(agentDir, "last-changelog-version"), "utf8")).toBe("0.40.0");

			// Key stripped from config.yml on the next save.
			settings.set("display.showTokenUsage", true);
			await settings.flush();
			const onDisk = await readSettings();
			expect("lastChangelogVersion" in onDisk).toBe(false);
			expect((onDisk.display as Record<string, unknown>).showTokenUsage).toBe(true);
		});

		it("never clobbers an existing marker with the legacy config value", async () => {
			fs.writeFileSync(path.join(agentDir, "last-changelog-version"), "0.41.0");
			await writeSettings({ lastChangelogVersion: "0.40.0" });

			await Settings.init({ cwd: projectDir, agentDir });

			expect(fs.readFileSync(path.join(agentDir, "last-changelog-version"), "utf8")).toBe("0.41.0");
		});

		it("migrates legacy find and search settings to glob and grep", async () => {
			await writeSettings({
				find: { enabled: false },
				search: {
					enabled: false,
					contextBefore: 2,
					contextAfter: 5,
				},
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("glob.enabled")).toBe(false);
			expect(settings.get("grep.enabled")).toBe(false);
			expect(settings.get("grep.contextBefore")).toBe(2);
			expect(settings.get("grep.contextAfter")).toBe(5);
		});

		it("migrates flat legacy find and search settings keys to nested glob and grep", async () => {
			await writeSettings({
				"find.enabled": false,
				"search.enabled": false,
				"search.contextBefore": 2,
				"search.contextAfter": 5,
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("glob.enabled")).toBe(false);
			expect(settings.get("grep.enabled")).toBe(false);
			expect(settings.get("grep.contextBefore")).toBe(2);
			expect(settings.get("grep.contextAfter")).toBe(5);
		});

		it("does not clobber existing glob/grep settings when migrating legacy find/search ones", async () => {
			await writeSettings({
				find: { enabled: false },
				glob: { enabled: true },
				search: { enabled: false },
				grep: { enabled: true },
				"find.enabled": false,
				"glob.enabled": true,
				"search.enabled": false,
				"grep.enabled": true,
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("glob.enabled")).toBe(true);
			expect(settings.get("grep.enabled")).toBe(true);
		});

		it("migrates nested dev.autoqa.consent and todo.reminders.max without configuring parents", async () => {
			await writeSettings({
				dev: { autoqa: { consent: "granted" } },
				todo: { reminders: { max: 5 } },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("dev.autoqaConsent")).toBe("granted");
			expect(settings.get("dev.autoqa")).toBe(true);
			expect(settings.isConfigured("dev.autoqa")).toBe(false);
			expect(settings.get("todo.remindersMax")).toBe(5);
			expect(settings.get("todo.reminders")).toBe(true);
			expect(settings.isConfigured("todo.reminders")).toBe(false);
		});

		it("migrates quoted dotted legacy keys for consent and reminders max", async () => {
			await Bun.write(getConfigPath(), `"dev.autoqa.consent": denied\n"todo.reminders.max": 2\n`);

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("dev.autoqaConsent")).toBe("denied");
			expect(settings.isConfigured("dev.autoqa")).toBe(false);
			expect(settings.get("todo.remindersMax")).toBe(2);
			expect(settings.get("todo.reminders")).toBe(true);
		});

		it("lets explicit new keys win over legacy nested consent/max values", async () => {
			await writeSettings({
				dev: { autoqa: { consent: "denied" }, autoqaConsent: "granted" },
				todo: { reminders: { max: 1 }, remindersMax: 9 },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("dev.autoqaConsent")).toBe("granted");
			expect(settings.isConfigured("dev.autoqa")).toBe(false);
			expect(settings.get("todo.remindersMax")).toBe(9);
			expect(settings.get("todo.reminders")).toBe(true);
		});

		it("preserves recoverable parent booleans alongside legacy leaf keys", async () => {
			await Bun.write(
				getConfigPath(),
				`dev:\n  autoqa: true\n"dev.autoqa.consent": unset\ntodo:\n  reminders: false\n"todo.reminders.max": 4\n`,
			);

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("dev.autoqa")).toBe(true);
			expect(settings.get("dev.autoqaConsent")).toBe("unset");
			expect(settings.get("todo.reminders")).toBe(false);
			expect(settings.get("todo.remindersMax")).toBe(4);
		});

		it("migrates denied/granted/unset consent values through isolated overrides", () => {
			for (const consent of ["denied", "granted", "unset"] as const) {
				const settings = Settings.isolated({
					"dev.autoqa.consent": consent,
				} as Partial<Record<SettingPath, unknown>>);
				expect(settings.get("dev.autoqaConsent")).toBe(consent);
				expect(settings.isConfigured("dev.autoqa")).toBe(false);
			}
		});

		it("persists migrated consent/max keys and drops legacy nested parents on save", async () => {
			await writeSettings({
				dev: { autoqa: { consent: "denied" } },
				todo: { reminders: { max: 1 } },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(settings.get("dev.autoqaConsent")).toBe("denied");
			expect(settings.get("todo.remindersMax")).toBe(1);

			// Touch an unrelated key so the migrated tree is written back.
			settings.set("display.showTokenUsage", true);
			await settings.flush();

			const onDisk = await readSettings();
			const dev = onDisk.dev as Record<string, unknown>;
			const todo = onDisk.todo as Record<string, unknown>;
			expect(dev.autoqaConsent).toBe("denied");
			expect(dev.autoqa).toBeUndefined();
			expect(todo.remindersMax).toBe(1);
			expect(todo.reminders).toBeUndefined();
			expect(onDisk["dev.autoqa.consent"]).toBeUndefined();
			expect(onDisk["todo.reminders.max"]).toBeUndefined();

			const reloaded = await Settings.loadIsolated({ cwd: projectDir, agentDir });
			expect(reloaded.get("dev.autoqaConsent")).toBe("denied");
			expect(reloaded.isConfigured("dev.autoqa")).toBe(false);
			expect(reloaded.get("todo.remindersMax")).toBe(1);
			expect(reloaded.get("todo.reminders")).toBe(true);
		});

		it("drops dead BM25-discovery keys and leaves tools.xdev at its default", async () => {
			await writeSettings({
				tools: { discoveryMode: "off", essentialOverride: ["read"] },
				mcp: { discoveryMode: "auto", discoveryDefaultServers: ["gh"] },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			// No migration mapping: legacy discovery intent is discarded, xdev
			// keeps its own default. An explicit xdev value is untouched.
			expect(settings.get("tools.xdev")).toBe(true);
			expect(settings.isConfigured("tools.xdev")).toBe(false);
		});

		it("migrates from settings.json containing comments", async () => {
			const jsonPath = path.join(agentDir, "settings.json");
			await fs.promises.writeFile(
				jsonPath,
				`{
					// This is a comment
					"display": {
						/* Multiline comment */
						"showTokenUsage": true
					}
				}`,
			);

			const settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(settings.get("display.showTokenUsage")).toBe(true);
			expect(fs.existsSync(jsonPath)).toBe(false);
			expect(fs.existsSync(`${jsonPath}.bak`)).toBe(true);
		});
		it("migrates legacy power booleans with system=true to system level", async () => {
			await writeSettings({
				power: {
					preventIdleSleep: true,
					preventSystemSleep: true,
					declareUserActive: false,
					preventDisplaySleep: false,
				},
			});
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(settings.get("power.sleepPrevention")).toBe("system");
		});

		it("migrates legacy power booleans with display=true to display level", async () => {
			await writeSettings({
				power: {
					preventIdleSleep: true,
					preventSystemSleep: false,
					declareUserActive: false,
					preventDisplaySleep: true,
				},
			});
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(settings.get("power.sleepPrevention")).toBe("display");
		});

		it("migrates legacy power booleans with declareUserActive=true to system level", async () => {
			await writeSettings({
				power: {
					preventIdleSleep: true,
					preventSystemSleep: false,
					declareUserActive: true,
					preventDisplaySleep: false,
				},
			});
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(settings.get("power.sleepPrevention")).toBe("system");
		});

		it("preserves old idle default when only non-idle keys are set", async () => {
			// Old default was preventIdleSleep=true; user only set display=false.
			// Migration should yield "idle", not "off".
			await writeSettings({
				power: { preventDisplaySleep: false },
			});
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(settings.get("power.sleepPrevention")).toBe("idle");
		});

		it("migrates all-false power booleans to off", async () => {
			await writeSettings({
				power: {
					preventIdleSleep: false,
					preventSystemSleep: false,
					declareUserActive: false,
					preventDisplaySleep: false,
				},
			});
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(settings.get("power.sleepPrevention")).toBe("off");
		});

		it("migrates flat-key power booleans to the enum", async () => {
			await writeSettings({
				"power.preventIdleSleep": true,
				"power.preventDisplaySleep": true,
			});
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(settings.get("power.sleepPrevention")).toBe("display");
		});

		it("does not overwrite an explicit power.sleepPrevention", async () => {
			await writeSettings({
				power: { sleepPrevention: "off", preventIdleSleep: true },
			});
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(settings.get("power.sleepPrevention")).toBe("off");
		});

		describe("provider request limits", () => {
			it("uses the effective merged value when configuring hooks", async () => {
				const settings = Settings.isolated({ "providers.maxInFlightRequests": { openai: 1 } });
				__providerInFlightForTesting.setRoot(tempDir.join("provider-inflight"));
				registerMockApi();
				const firstStarted = Promise.withResolvers<void>();
				const releaseFirst = Promise.withResolvers<void>();
				let active = 0;
				let maxActive = 0;
				let callIndex = 0;
				const mock = createMockModel({
					provider: "openai",
					handler: async () => {
						callIndex++;
						active++;
						maxActive = Math.max(maxActive, active);
						try {
							if (callIndex === 1) {
								firstStarted.resolve();
								await releaseFirst.promise;
							}
							return { content: [`reply ${callIndex}`] };
						} finally {
							active--;
						}
					},
				});

				settings.set("providers.maxInFlightRequests", { openai: 4 });

				const first = streamSimple(mock.model, context());
				const firstResult = first.result();
				await firstStarted.promise;
				const second = streamSimple(mock.model, context());
				await Bun.sleep(20);

				expect(settings.get("providers.maxInFlightRequests")).toEqual({ openai: 1 });
				expect(mock.calls).toHaveLength(1);

				releaseFirst.resolve();
				await Promise.all([firstResult, second.result()]);
				expect(maxActive).toBe(1);
			});

			it("rejects invalid provider limits from config.yml", async () => {
				await writeSettings({ providers: { maxInFlightRequests: { openai: "2" } } });

				await expect(Settings.init({ cwd: projectDir, agentDir })).rejects.toThrow(
					"Provider request limits must be positive numbers: openai",
				);
			});

			it("rejects invalid provider limits from project settings", async () => {
				await Bun.write(
					path.join(getProjectAgentDir(projectDir), "settings.json"),
					JSON.stringify({ providers: { maxInFlightRequests: { anthropic: 0 } } }),
				);

				await expect(Settings.init({ cwd: projectDir, agentDir, inMemory: true })).rejects.toThrow(
					"Provider request limits must be positive numbers: anthropic",
				);
			});

			it("rejects invalid provider limits from config overlays", async () => {
				const overlayPath = tempDir.join("overlay.yml");
				await Bun.write(overlayPath, YAML.stringify({ providers: { maxInFlightRequests: { umans: -1 } } }));

				await expect(
					Settings.init({ cwd: projectDir, agentDir, inMemory: true, configFiles: [overlayPath] }),
				).rejects.toThrow("Provider request limits must be positive numbers: umans");
			});
		});
	});

	describe("extensionsSourceLevel", () => {
		it("reports project when a foreign project provider (.claude/settings.json) supplies extensions", async () => {
			const claudeSettings = path.join(projectDir, ".claude", "settings.json");
			fs.mkdirSync(path.dirname(claudeSettings), { recursive: true });
			fs.writeFileSync(claudeSettings, JSON.stringify({ extensions: ["../claude-ext"] }));

			const settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(settings.get("extensions")).toContain("../claude-ext");
			expect(settings.extensionsSourceLevel()).toBe("project");
		});

		it("reports user for a user-only setting and for runtime overrides", async () => {
			await writeSettings({ extensions: ["../user-ext"] });
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(settings.extensionsSourceLevel()).toBe("user");

			settings.override("extensions", ["../override-ext"]);
			expect(settings.extensionsSourceLevel()).toBe("user");
		});
	});
});
