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
	__physicalTargetSegmentsForTesting,
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
	const withCanonicalParent = async (filePath: string) =>
		path.join(await fs.promises.realpath(path.dirname(filePath)), path.basename(filePath));

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
		AgentStorage.close();
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

		it("writes through a dangling symlink chain to the final target, preserving every link", async () => {
			// config.yml -> mid.yml -> final.yml where final.yml does not exist yet
			// (first-run into a dotfiles/managed checkout). realpath throws ENOENT at
			// the missing tail, so the write path must walk the chain hop by hop and
			// land on final.yml — recreating it while leaving both links intact.
			const finalPath = tempDir.join("final-config.yml");
			const midPath = tempDir.join("mid-config.yml");
			await fs.promises.symlink(finalPath, midPath, "file");
			await fs.promises.symlink(midPath, getConfigPath(), "file");

			const settings = await Settings.init({ cwd: projectDir, agentDir });
			settings.set("setupVersion", 3);
			await settings.flush();

			expect(fs.lstatSync(getConfigPath()).isSymbolicLink()).toBe(true);
			expect(fs.lstatSync(midPath).isSymbolicLink()).toBe(true);
			expect(fs.lstatSync(finalPath).isSymbolicLink()).toBe(false);
			expect(YAML.parse(await Bun.file(finalPath).text())).toEqual({ setupVersion: 3 });
		});

		it("lands on the deepest resolved hop when an intermediate link vanishes mid-walk", async () => {
			// config.yml -> mid.yml -> final.yml (final dangling). The resolver
			// confirms mid.yml is a symlink via lstat, then a concurrent process
			// removes mid.yml before readlink(mid.yml) runs. The ENOENT must not
			// collapse the write back to the chain head (config.yml) — that would
			// let the atomic rename replace the first user-managed link.
			const finalPath = tempDir.join("final-config.yml");
			const midPath = tempDir.join("mid-config.yml");
			await fs.promises.symlink(finalPath, midPath, "file");
			await fs.promises.symlink(midPath, getConfigPath(), "file");
			const canonicalMidPath = await withCanonicalParent(midPath);

			const settings = await Settings.init({ cwd: projectDir, agentDir });
			const readlink = fs.promises.readlink.bind(fs.promises);
			let injected = false;
			vi.spyOn(fs.promises, "readlink").mockImplementation((async (target: fs.PathLike) => {
				if (!injected && String(target) === canonicalMidPath) {
					injected = true;
					await fs.promises.unlink(midPath);
					throw new FsCodeError("ENOENT", "injected mid-chain link removal");
				}
				return readlink(target);
			}) as typeof fs.promises.readlink);

			settings.set("setupVersion", 4);
			await settings.flush();

			expect(injected).toBe(true);
			// The chain head must survive as a symlink; the write lands on the
			// deepest resolved hop (mid.yml), never clobbering config.yml.
			expect(fs.lstatSync(getConfigPath()).isSymbolicLink()).toBe(true);
			expect(fs.lstatSync(midPath).isSymbolicLink()).toBe(false);
			expect(YAML.parse(await Bun.file(midPath).text())).toEqual({ setupVersion: 4 });
			expect(fs.existsSync(finalPath)).toBe(false);
		});

		it("resolves a relative intermediate target against the link's physical parent, not a symlinked alias", async () => {
			// config.yml -> alias/sub/mid.yml, where `alias` is a symlinked
			// directory (alias -> physical/deep) and mid.yml is a dangling link
			// whose relative target has enough `..` to climb out of the alias.
			// Popping `..` off the PHYSICAL parent lands on physical/final.yml; a
			// lexical resolve would collapse `..` against the alias and clobber an
			// unrelated sibling of the alias while leaving the real chain dangling.
			const deepDir = tempDir.join("physical", "deep");
			const subDir = path.join(deepDir, "sub");
			fs.mkdirSync(subDir, { recursive: true });
			const aliasDir = tempDir.join("alias");
			await fs.promises.symlink(deepDir, aliasDir, "dir");

			const midPath = path.join(aliasDir, "sub", "mid-config.yml");
			await fs.promises.symlink("../../final-config.yml", midPath, "file");
			await fs.promises.symlink(midPath, getConfigPath(), "file");

			const physicalFinal = tempDir.join("physical", "final-config.yml");
			const lexicalSibling = tempDir.join("final-config.yml");

			const settings = await Settings.init({ cwd: projectDir, agentDir });
			settings.set("setupVersion", 7);
			await settings.flush();

			// The write lands on the physical target, recreating it, while the
			// alias's lexical sibling (the mis-resolution) stays untouched.
			expect(YAML.parse(await Bun.file(physicalFinal).text())).toEqual({ setupVersion: 7 });
			expect(fs.existsSync(lexicalSibling)).toBe(false);
			// Every user-managed link in the chain survives.
			expect(fs.lstatSync(getConfigPath()).isSymbolicLink()).toBe(true);
			expect(fs.lstatSync(midPath).isSymbolicLink()).toBe(true);
		});

		it("throws a bounded ELOOP when the chain turns cyclic after realpath reports ENOENT", async () => {
			// config.yml -> mid.yml -> final.yml (final missing), so the initial
			// realpath() reports ENOENT and the manual chain walk runs. A
			// concurrent process then retargets mid.yml back at the chain head, so
			// readlink() alternates head<->mid forever. The resolver must cap its
			// hops and throw an ELOOP-style error rather than hang flush().
			const finalPath = tempDir.join("final-config.yml");
			const midPath = tempDir.join("mid-config.yml");
			await fs.promises.symlink(finalPath, midPath, "file");
			await fs.promises.symlink(midPath, getConfigPath(), "file");
			const canonicalMidPath = await withCanonicalParent(midPath);

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			const readlink = fs.promises.readlink.bind(fs.promises);
			let readlinkCalls = 0;
			// Bounded safety valve set far above the resolver's hop cap: the fixed
			// resolver throws ELOOP well before this fires, so it never trips. An
			// unbounded walk (pre-fix) only stops here, surfacing a distinct error
			// that proves no ELOOP was raised — RED without hanging the suite.
			const safetyValve = 500;
			vi.spyOn(fs.promises, "readlink").mockImplementation((async (target: fs.PathLike) => {
				readlinkCalls++;
				if (readlinkCalls > safetyValve) {
					throw new FsCodeError("ETESTVALVE", "unbounded symlink walk");
				}
				// Retarget mid back at the chain head to close the cycle.
				if (String(target) === canonicalMidPath) return getConfigPath();
				return readlink(target);
			}) as typeof fs.promises.readlink);

			settings.set("setupVersion", 5);
			await expect(settings.flush()).rejects.toThrow(/ELOOP/);
			expect(readlinkCalls).toBeLessThanOrEqual(safetyValve);
		});

		it("follows an intermediate directory symlink inside a relative target before applying ..", async () => {
			// config.yml -> alias/../final.yml, where `alias` is a symlinked
			// directory (alias -> elsewhere/deep) and final.yml is missing. The
			// filesystem follows `alias` first and then pops its PHYSICAL parent,
			// landing on elsewhere/final.yml. A lexical normalization of the whole
			// target collapses `alias/..` to the config dir up front and would
			// clobber <configdir>/final.yml while leaving the real chain dangling.
			const elsewhereDir = tempDir.join("elsewhere");
			const deepDir = path.join(elsewhereDir, "deep");
			fs.mkdirSync(deepDir, { recursive: true });
			const aliasDir = path.join(agentDir, "alias");
			await fs.promises.symlink(deepDir, aliasDir, "dir");

			await fs.promises.symlink("alias/../final-config.yml", getConfigPath(), "file");

			const physicalFinal = path.join(elsewhereDir, "final-config.yml");
			const lexicalSibling = path.join(agentDir, "final-config.yml");

			const settings = await Settings.init({ cwd: projectDir, agentDir });
			settings.set("setupVersion", 8);
			await settings.flush();

			// The write lands on the physical target (fs semantics), recreating it,
			// while the lexically collapsed sibling stays untouched.
			expect(YAML.parse(await Bun.file(physicalFinal).text())).toEqual({ setupVersion: 8 });
			expect(fs.existsSync(lexicalSibling)).toBe(false);
			// The user-managed chain head survives as a symlink.
			expect(fs.lstatSync(getConfigPath()).isSymbolicLink()).toBe(true);
		});

		it("resolves an absolute target's intermediate directory symlink before applying ..", async () => {
			// config.yml -> /base/alias/../final.yml (ABSOLUTE target), where
			// `alias` is a symlinked directory (alias -> elsewhere/deep) and
			// final.yml is missing. The filesystem follows `alias` first and then
			// pops its PHYSICAL parent, landing on elsewhere/final.yml. Lexically
			// collapsing the absolute string up front turns `/base/alias/..` into
			// /base and would clobber /base/final.yml while leaving the real chain
			// dangling — the same bug already fixed for relative targets.
			const elsewhereDir = tempDir.join("elsewhere");
			const deepDir = path.join(elsewhereDir, "deep");
			fs.mkdirSync(deepDir, { recursive: true });
			const baseDir = tempDir.join("base");
			fs.mkdirSync(baseDir, { recursive: true });
			const aliasDir = path.join(baseDir, "alias");
			await fs.promises.symlink(deepDir, aliasDir, "dir");

			// Build the target string manually so path.join does not collapse the
			// `..` before the symlink can be written.
			const absTarget = `${aliasDir}${path.sep}..${path.sep}final-config.yml`;
			await fs.promises.symlink(absTarget, getConfigPath(), "file");

			const physicalFinal = path.join(elsewhereDir, "final-config.yml");
			const lexicalSibling = path.join(baseDir, "final-config.yml");

			const settings = await Settings.init({ cwd: projectDir, agentDir });
			settings.set("setupVersion", 9);
			await settings.flush();

			// The write lands on the physical target (fs semantics), recreating it,
			// while the lexically collapsed sibling stays untouched.
			expect(YAML.parse(await Bun.file(physicalFinal).text())).toEqual({ setupVersion: 9 });
			expect(fs.existsSync(lexicalSibling)).toBe(false);
			// The user-managed chain head survives as a symlink.
			expect(fs.lstatSync(getConfigPath()).isSymbolicLink()).toBe(true);
		});

		it("does not write to an unrelated sibling when a non-final component is missing before ..", async () => {
			// config.yml -> missing/../final.yml, where `missing` does not exist.
			// Filesystem lookup fails at `missing`, so a following `..` must NOT
			// pop a component that was never entered. Collapsing the target
			// lexically instead pops `missing` and lands on <configdir>/final.yml,
			// clobbering an unrelated sibling while the real (dangling) target is
			// never written. The resolver must not escape to that sibling.
			await fs.promises.symlink("missing/../final-config.yml", getConfigPath(), "file");
			const lexicalSibling = path.join(agentDir, "final-config.yml");

			const settings = await Settings.init({ cwd: projectDir, agentDir });
			settings.set("setupVersion", 10);
			// The resolved path sits under the never-entered `missing` dir (fs
			// semantics), whose parent does not exist, so the atomic write fails
			// rather than clobbering the sibling.
			await expect(settings.flush()).rejects.toThrow();

			expect(fs.existsSync(lexicalSibling)).toBe(false);
			// The user-managed chain head survives as a symlink.
			expect(fs.lstatSync(getConfigPath()).isSymbolicLink()).toBe(true);
		});

		it("does not mislocate when a dangling symlink component is followed by ..", async () => {
			// config.yml -> link/.., where `link -> missing` and `missing` does
			// not exist. The filesystem follows `link` to its missing referent, so
			// looking up `link/..` fails: there is no parent of a path that was
			// never entered. Leaving the accumulator on the dangling `link` and
			// then following it to `missing` would create a regular file at the
			// wrong path and report success while the config path still fails with
			// ENOTDIR. The resolver must surface the failure instead.
			await fs.promises.symlink("missing", path.join(agentDir, "link"), "file");
			await fs.promises.symlink("link/..", getConfigPath(), "file");
			const misplaced = path.join(agentDir, "missing");

			const settings = await Settings.init({ cwd: projectDir, agentDir });
			settings.set("setupVersion", 11);
			await expect(settings.flush()).rejects.toThrow();

			// No regular file was landed at the wrong resolved location.
			expect(fs.existsSync(misplaced)).toBe(false);
			// The user-managed chain head survives as a symlink.
			expect(fs.lstatSync(getConfigPath()).isSymbolicLink()).toBe(true);
		});

		it("does not mislocate when a dangling component precedes further names then ..", async () => {
			// config.yml -> missing/child/.., where `missing` does not exist. The
			// walk freezes at `missing`, appends `child` lexically, then hits `..`.
			// `missing` was never entered, so `child` is not a real component the
			// kernel can pop: `missing/child/..` fails with ENOTDIR. Lexically
			// popping `child` and returning `missing` would land a regular file at
			// the wrong path and report success while config.yml stays unusable.
			await fs.promises.symlink("missing/child/..", getConfigPath(), "file");
			const misplaced = path.join(agentDir, "missing");

			const settings = await Settings.init({ cwd: projectDir, agentDir });
			settings.set("setupVersion", 12);
			await expect(settings.flush()).rejects.toThrow();

			// No regular file was landed at the frozen component.
			expect(fs.existsSync(misplaced)).toBe(false);
			// The user-managed chain head survives as a symlink.
			expect(fs.lstatSync(getConfigPath()).isSymbolicLink()).toBe(true);
		});

		it("still pops correctly when a real child/.. was actually traversed", async () => {
			// config.yml -> realdir/child/final.yml, where realdir and
			// realdir/child both exist on disk and final.yml is missing. The `..`
			// after `child` pops a component that WAS entered, so the write must
			// still land on realdir/final.yml — proving the frozen-branch throw
			// does not over-reject a legitimate physically traversed `..`.
			const realDir = path.join(agentDir, "realdir");
			const childDir = path.join(realDir, "child");
			fs.mkdirSync(childDir, { recursive: true });
			await fs.promises.symlink("realdir/child/../final-config.yml", getConfigPath(), "file");
			const finalPath = path.join(realDir, "final-config.yml");

			const settings = await Settings.init({ cwd: projectDir, agentDir });
			settings.set("setupVersion", 13);
			await settings.flush();

			expect(YAML.parse(await Bun.file(finalPath).text())).toEqual({ setupVersion: 13 });
			// The user-managed chain head survives as a symlink.
			expect(fs.lstatSync(getConfigPath()).isSymbolicLink()).toBe(true);
		});

		it("does not mislocate when a dangling target ends in a trailing slash", async () => {
			// config.yml -> missing/, where `missing` does not exist. The trailing
			// slash demands `missing` be a traversable directory. Dropping the
			// terminal empty segment and returning `missing` would land a regular
			// file there and report success, while opening config.yml then fails
			// with ENOTDIR because a file is not a directory. Surface the failure.
			await fs.promises.symlink("missing/", getConfigPath(), "file");
			const misplaced = path.join(agentDir, "missing");

			const settings = await Settings.init({ cwd: projectDir, agentDir });
			settings.set("setupVersion", 14);
			await expect(settings.flush()).rejects.toThrow();

			// No regular file was landed at the frozen component.
			expect(fs.existsSync(misplaced)).toBe(false);
			// The user-managed chain head survives as a symlink.
			expect(fs.lstatSync(getConfigPath()).isSymbolicLink()).toBe(true);
		});

		it("rejects with ENOTDIR when a trailing-slash target is created as a regular file mid-walk", async () => {
			// config.yml -> racetarget/, where `racetarget` does not exist when the
			// initial realpath(config.yml) runs, so it reports ENOENT and the manual
			// segment walk begins. A concurrent process then creates `racetarget` as
			// a REGULAR FILE before the walk's realpath(candidate) reaches it, so
			// that realpath succeeds and the walk stays UNFROZEN. The trailing slash
			// still demands `racetarget` be a traversable directory; a regular file
			// is not, so opening config.yml really fails with ENOTDIR. Dropping the
			// terminal empty segment and returning the regular file would let the
			// atomic rename overwrite it and falsely report success. Surface it.
			await fs.promises.symlink("racetarget/", getConfigPath(), "file");
			const raceTarget = path.join(agentDir, "racetarget");
			const canonicalRaceTarget = await withCanonicalParent(raceTarget);

			const settings = await Settings.init({ cwd: projectDir, agentDir });
			const realpath = fs.promises.realpath.bind(fs.promises);
			let injected = false;
			vi.spyOn(fs.promises, "realpath").mockImplementation((async (target: fs.PathLike, ...rest: unknown[]) => {
				if (!injected && String(target) === canonicalRaceTarget) {
					injected = true;
					// Win the race: materialize the target as a regular file so this
					// realpath resolves it and the walk never freezes.
					await Bun.write(raceTarget, "not a dir");
				}
				return (realpath as (t: fs.PathLike, ...r: unknown[]) => Promise<string>)(target, ...rest);
			}) as typeof fs.promises.realpath);

			settings.set("setupVersion", 15);
			await expect(settings.flush()).rejects.toThrow(/ENOTDIR/);

			expect(injected).toBe(true);
			// The concurrently created regular file was NOT overwritten with YAML.
			expect(await Bun.file(raceTarget).text()).toBe("not a dir");
			// The user-managed chain head survives as a symlink.
			expect(fs.lstatSync(getConfigPath()).isSymbolicLink()).toBe(true);
		});

		it("rejects with ENOTDIR when a `..` target's component is created as a regular file mid-walk", async () => {
			// config.yml -> racetarget/../victim.yml, where `racetarget` does not
			// exist when the initial realpath(config.yml) runs, so it reports ENOENT
			// and the manual segment walk begins. A concurrent process then creates
			// `racetarget` as a REGULAR FILE before the walk's realpath(candidate)
			// reaches it, so that realpath succeeds and the walk stays UNFROZEN. The
			// following `..` demands `racetarget` be a traversable directory to pop
			// its parent; a regular file is not, so opening config.yml really fails
			// with ENOTDIR (the kernel rejects `regularfile/..`). Popping lexically
			// and continuing would resolve to victim.yml in the parent dir and let
			// the atomic rename overwrite an unrelated sibling while falsely
			// reporting success. Surface it.
			await fs.promises.symlink("racetarget/../victim.yml", getConfigPath(), "file");
			const raceTarget = path.join(agentDir, "racetarget");
			const canonicalRaceTarget = await withCanonicalParent(raceTarget);
			const victim = path.join(agentDir, "victim.yml");
			await Bun.write(victim, "keep: me");

			const settings = await Settings.init({ cwd: projectDir, agentDir });
			const realpath = fs.promises.realpath.bind(fs.promises);
			let injected = false;
			vi.spyOn(fs.promises, "realpath").mockImplementation((async (target: fs.PathLike, ...rest: unknown[]) => {
				if (!injected && String(target) === canonicalRaceTarget) {
					injected = true;
					// Win the race: materialize the component as a regular file so this
					// realpath resolves it and the walk never freezes.
					await Bun.write(raceTarget, "not a dir");
				}
				return (realpath as (t: fs.PathLike, ...r: unknown[]) => Promise<string>)(target, ...rest);
			}) as typeof fs.promises.realpath);

			settings.set("setupVersion", 16);
			await expect(settings.flush()).rejects.toThrow(/ENOTDIR/);

			expect(injected).toBe(true);
			// The unrelated sibling was NOT overwritten with YAML.
			expect(await Bun.file(victim).text()).toBe("keep: me");
			// The user-managed chain head survives as a symlink.
			expect(fs.lstatSync(getConfigPath()).isSymbolicLink()).toBe(true);
		});

		it("rejects with ENOTDIR when a trailing-slash target's directory is removed before the validation stat", async () => {
			// config.yml -> racetarget/, where `racetarget` does not exist when the
			// initial realpath(config.yml) runs, so the manual segment walk begins.
			// A concurrent process creates `racetarget` as a real DIRECTORY before
			// the walk's realpath(candidate) reaches it, so that realpath succeeds
			// and the walk stays UNFROZEN, reaching the trailing-slash
			// directory-requirement stat. The directory is then removed between that
			// realpath and this stat, so the stat throws ENOENT. The requirement —
			// `racetarget` must be a traversable directory — provably cannot hold
			// now the component is gone. Letting the ENOENT reach the outer catch
			// would swallow it and return path.resolve(config.yml), so the atomic
			// rename would replace config.yml ITSELF with a regular file while the
			// dangling symlink survives. Surface ENOTDIR instead.
			await fs.promises.symlink("racetarget/", getConfigPath(), "file");
			const raceTarget = path.join(agentDir, "racetarget");
			const canonicalRaceTarget = await withCanonicalParent(raceTarget);

			const settings = await Settings.init({ cwd: projectDir, agentDir });
			const realpath = fs.promises.realpath.bind(fs.promises);
			const stat = fs.promises.stat.bind(fs.promises);
			let created = false;
			let removed = false;
			vi.spyOn(fs.promises, "realpath").mockImplementation((async (target: fs.PathLike, ...rest: unknown[]) => {
				if (!created && String(target) === canonicalRaceTarget) {
					created = true;
					// Win the first half of the race: materialize the component as a
					// real directory so this realpath resolves it and the walk stays
					// unfrozen.
					fs.mkdirSync(raceTarget);
				}
				return (realpath as (t: fs.PathLike, ...r: unknown[]) => Promise<string>)(target, ...rest);
			}) as typeof fs.promises.realpath);
			vi.spyOn(fs.promises, "stat").mockImplementation((async (target: fs.PathLike, ...rest: unknown[]) => {
				if (!removed && String(target) === canonicalRaceTarget) {
					removed = true;
					// Win the second half: remove the required directory after
					// realpath resolved it but before this validation stat inspects
					// it, so the stat throws ENOENT.
					fs.rmSync(raceTarget, { recursive: true, force: true });
				}
				return (stat as (t: fs.PathLike, ...r: unknown[]) => Promise<fs.Stats>)(target, ...rest);
			}) as typeof fs.promises.stat);

			settings.set("setupVersion", 17);
			await expect(settings.flush()).rejects.toThrow(/ENOTDIR/);

			expect(created).toBe(true);
			expect(removed).toBe(true);
			// config.yml itself was NOT clobbered into a regular file.
			expect(fs.lstatSync(getConfigPath()).isSymbolicLink()).toBe(true);
		});

		it("rejects with ENOTDIR when a `..` target's directory is removed before the validation stat", async () => {
			// config.yml -> racetarget/../victim.yml, where `racetarget` does not
			// exist when the initial realpath(config.yml) runs, so the manual walk
			// begins. A concurrent process creates `racetarget` as a real DIRECTORY
			// before the walk's realpath(candidate) reaches it, so that realpath
			// succeeds and the walk stays UNFROZEN, reaching the `..`
			// directory-requirement stat. The directory is then removed between that
			// realpath and this stat, so the stat throws ENOENT. The `..` still
			// requires `racetarget` to be a traversable directory to pop its parent,
			// and that provably cannot hold now. Letting the ENOENT reach the outer
			// catch would swallow it and return path.resolve(config.yml), clobbering
			// config.yml itself while the dangling symlink survives. Surface ENOTDIR.
			await fs.promises.symlink("racetarget/../victim.yml", getConfigPath(), "file");
			const raceTarget = path.join(agentDir, "racetarget");
			const canonicalRaceTarget = await withCanonicalParent(raceTarget);
			const victim = path.join(agentDir, "victim.yml");
			await Bun.write(victim, "keep: me");

			const settings = await Settings.init({ cwd: projectDir, agentDir });
			const realpath = fs.promises.realpath.bind(fs.promises);
			const stat = fs.promises.stat.bind(fs.promises);
			let created = false;
			let removed = false;
			vi.spyOn(fs.promises, "realpath").mockImplementation((async (target: fs.PathLike, ...rest: unknown[]) => {
				if (!created && String(target) === canonicalRaceTarget) {
					created = true;
					// Win the first half of the race: materialize the component as a
					// real directory so this realpath resolves it and the walk stays
					// unfrozen.
					fs.mkdirSync(raceTarget);
				}
				return (realpath as (t: fs.PathLike, ...r: unknown[]) => Promise<string>)(target, ...rest);
			}) as typeof fs.promises.realpath);
			vi.spyOn(fs.promises, "stat").mockImplementation((async (target: fs.PathLike, ...rest: unknown[]) => {
				if (!removed && String(target) === canonicalRaceTarget) {
					removed = true;
					// Win the second half: remove the required directory after
					// realpath resolved it but before this validation stat inspects
					// it, so the stat throws ENOENT.
					fs.rmSync(raceTarget, { recursive: true, force: true });
				}
				return (stat as (t: fs.PathLike, ...r: unknown[]) => Promise<fs.Stats>)(target, ...rest);
			}) as typeof fs.promises.stat);

			settings.set("setupVersion", 18);
			await expect(settings.flush()).rejects.toThrow(/ENOTDIR/);

			expect(created).toBe(true);
			expect(removed).toBe(true);
			// The unrelated sibling was NOT overwritten with YAML.
			expect(await Bun.file(victim).text()).toBe("keep: me");
			// config.yml itself was NOT clobbered into a regular file.
			expect(fs.lstatSync(getConfigPath()).isSymbolicLink()).toBe(true);
		});

		it("does not re-emit the filesystem root as a segment for an absolute Windows target", async () => {
			// On Windows the flush walk seeds the accumulator at parse(target).root
			// (`C:\`) and then walks the segments. If the root is left in the string
			// that is split, it is re-emitted as a leading `C:` segment and joined
			// on top of the seeded root — `C:\managed\final.yml` resolves to
			// `C:\C:\managed\final.yml`, so flushing through a dangling absolute link
			// fails. Drive the splitter with the win32 engine so the bug reproduces
			// on this POSIX host.
			const segments = __physicalTargetSegmentsForTesting("C:\\managed\\final.yml", path.win32).filter(
				segment => segment !== "" && segment !== ".",
			);
			expect(segments).toEqual(["managed", "final.yml"]);
			// A UNC target seeds at the `\\server\share\` root, which must likewise
			// be stripped rather than re-walked as `server` / `share` segments.
			const uncSegments = __physicalTargetSegmentsForTesting(
				"\\\\server\\share\\managed\\final.yml",
				path.win32,
			).filter(segment => segment !== "" && segment !== ".");
			expect(uncSegments).toEqual(["managed", "final.yml"]);
			// A relative Windows target seeds at the link's real parent, so every
			// segment is preserved unchanged.
			expect(__physicalTargetSegmentsForTesting("managed\\final.yml", path.win32)).toEqual(["managed", "final.yml"]);
		});

		it("treats a backslash as a filename character on POSIX, not a separator", async () => {
			// `\` is a valid filename character on POSIX. A dangling target literally
			// named `managed\config.yml` must stay ONE segment; splitting it into
			// `managed`/`config.yml` makes flush either fail on the missing dir or
			// write an unrelated file while the real link stays dangling. Drive the
			// splitter with the posix engine so the bug reproduces on any host.
			expect(__physicalTargetSegmentsForTesting("managed\\config.yml", path.posix)).toEqual(["managed\\config.yml"]);
			// Forward slashes still split, and the leading `/` of an absolute POSIX
			// target strips to no extra segment (root seeded separately).
			const absSegments = __physicalTargetSegmentsForTesting("/managed/final.yml", path.posix).filter(
				segment => segment !== "" && segment !== ".",
			);
			expect(absSegments).toEqual(["managed", "final.yml"]);
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
