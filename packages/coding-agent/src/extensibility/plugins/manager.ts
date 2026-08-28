import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	getPluginsDir,
	getPluginsLockfile,
	getPluginsNodeModules,
	getPluginsPackageJson,
	getProjectDir,
	getProjectPluginOverridesPath,
	isEnoent,
	logger,
} from "@oh-my-pi/pi-utils";
import { resolveActiveProjectRegistryPath } from "../../discovery/helpers";
import { loadExtensions } from "../extensions/loader";
import { refreshBunGitCache } from "./bun-git-cache";
import { type GitSource, parseGitUrl } from "./git-url";
import { resolvePluginManifestEntries } from "./loader";
import { getInstalledPluginsRegistryPath, readInstalledPluginsRegistry } from "./marketplace/registry";
import { parsePluginId } from "./marketplace/types";
import { extractPackageName, parsePluginSpec } from "./parser";
import { normalizePluginRuntimeConfig } from "./runtime-config";
import type {
	DoctorCheck,
	DoctorOptions,
	InstalledPlugin,
	InstallOptions,
	PluginManifest,
	PluginRuntimeConfig,
	PluginSettingSchema,
	ProjectPluginOverrides,
} from "./types";

// =============================================================================
// Validation
// =============================================================================

/** Valid npm package name pattern (scoped and unscoped, with optional version) */
const VALID_PACKAGE_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(@[a-z0-9-._^~>=<]+)?$/i;

/** Characters that are never valid in any plugin install spec — git or npm. */
const SHELL_METACHARS = /[;&|`$(){}<>\\\n\r\t]/;

/**
 * Validate package name to prevent command injection. npm specs only — git
 * specs (`github:user/repo`, `https://github.com/...`, ...) MUST go through
 * {@link validateGitSpec} instead because they contain characters npm rejects
 * (`:`, `/`, `#`, `+`, `@` in non-version positions).
 */
function validatePackageName(name: string): void {
	// Remove version specifier for validation
	const baseName = extractPackageName(name);
	if (!VALID_PACKAGE_NAME.test(baseName)) {
		throw new Error(`Invalid package name: ${name}`);
	}
	// Extra safety: no shell metacharacters
	if (/[;&|`$(){}[\]<>\\]/.test(name)) {
		throw new Error(`Invalid characters in package name: ${name}`);
	}
}

/**
 * Validate a git install spec — accepts `:`, `/`, `#`, `+`, `.`, `-`, `_`,
 * `~`, `@` (which would all fail {@link validatePackageName}) but rejects
 * shell metacharacters so the spec stays safe when forwarded to bun install.
 * `Bun.spawn` does not invoke a shell, but defense-in-depth keeps things
 * obvious for future readers.
 */
function validateGitSpec(spec: string): void {
	if (SHELL_METACHARS.test(spec)) {
		throw new Error(`Invalid characters in plugin source: ${spec}`);
	}
}

function gitInstallSpec(original: string, source: GitSource): string {
	if (/^github:/i.test(original) || !/^[a-z]+:[^/]/i.test(original)) {
		return original;
	}
	if (!source.ref || source.repo.includes("#")) {
		return source.repo;
	}
	return `${source.repo}#${source.ref}`;
}

function findGitPackageName(source: GitSource, deps: Record<string, string>): string | undefined {
	for (const [key, value] of Object.entries(deps)) {
		if (typeof value !== "string") {
			continue;
		}
		const installedSource = parseGitUrl(value);
		if (installedSource && installedSource.host === source.host && installedSource.path === source.path) {
			return key;
		}
	}
	return undefined;
}

interface PluginPackageSnapshot {
	readonly actualName: string;
	readonly packagePath: string;
	readonly backupRoot: string;
	readonly backupPath: string;
}

interface RuntimePackageJson {
	name?: unknown;
	version: string;
	omp?: PluginManifest;
	pi?: PluginManifest;
}
// =============================================================================
// Plugin Manager
// =============================================================================

export class PluginManager {
	#runtimeConfig: PluginRuntimeConfig | null = null;
	#cwd: string;

	constructor(cwd: string = getProjectDir()) {
		this.#cwd = cwd;
	}

	// ==========================================================================
	// Runtime Config Management
	// ==========================================================================

	async #readRuntimeConfigAt(lockPath: string): Promise<PluginRuntimeConfig> {
		try {
			return normalizePluginRuntimeConfig(await Bun.file(lockPath).json());
		} catch (err) {
			if (isEnoent(err)) return normalizePluginRuntimeConfig({});
			logger.warn("Failed to load plugin runtime config", { path: lockPath, error: String(err) });
			return normalizePluginRuntimeConfig({});
		}
	}

	async #loadRuntimeConfig(): Promise<PluginRuntimeConfig> {
		return this.#readRuntimeConfigAt(getPluginsLockfile());
	}

	async #ensureConfigLoaded(): Promise<PluginRuntimeConfig> {
		if (!this.#runtimeConfig) {
			this.#runtimeConfig = await this.#loadRuntimeConfig();
		}
		return this.#runtimeConfig;
	}

	async #saveRuntimeConfig(): Promise<void> {
		await this.#ensureConfigLoaded();
		await Bun.write(getPluginsLockfile(), JSON.stringify(this.#runtimeConfig, null, 2));
	}

	async #loadProjectOverrides(): Promise<ProjectPluginOverrides> {
		const overridesPath = getProjectPluginOverridesPath(this.#cwd);
		try {
			return await Bun.file(overridesPath).json();
		} catch (err) {
			if (isEnoent(err)) return {};
			logger.warn("Failed to load project plugin overrides", { path: overridesPath, error: String(err) });
			return {};
		}
	}

	// ==========================================================================
	// Directory Management
	// ==========================================================================

	async #ensurePluginsDir(): Promise<void> {
		await fs.promises.mkdir(getPluginsDir(), { recursive: true });
		await fs.promises.mkdir(getPluginsNodeModules(), { recursive: true });
	}

	async #ensurePackageJson(): Promise<void> {
		const pkgJsonPath = getPluginsPackageJson();
		try {
			await Bun.file(pkgJsonPath).json();
		} catch (err) {
			if (isEnoent(err)) {
				await Bun.write(
					pkgJsonPath,
					JSON.stringify(
						{
							name: "omp-plugins",
							private: true,
							dependencies: {},
						},
						null,
						2,
					),
				);
				return;
			}
			throw err;
		}
	}

	/**
	 * Read the `dependencies` map from `plugins/package.json`. Returns an empty
	 * object when the file does not exist yet so callers can diff `before`
	 * against `after` to discover the package bun just installed under its
	 * real name (git specs do not encode the package name in the spec itself).
	 */
	async #readDeps(pkgJsonPath: string): Promise<Record<string, string>> {
		try {
			const json = await Bun.file(pkgJsonPath).json();
			return (json.dependencies as Record<string, string>) ?? {};
		} catch (err) {
			if (isEnoent(err)) return {};
			throw err;
		}
	}

	async #removeDependencyEntry(pkgJsonPath: string, name: string): Promise<void> {
		const pkgJson: { dependencies?: Record<string, string>; [key: string]: unknown } =
			await Bun.file(pkgJsonPath).json();
		if (!pkgJson.dependencies || !(name in pkgJson.dependencies)) {
			return;
		}
		delete pkgJson.dependencies[name];
		await Bun.write(pkgJsonPath, JSON.stringify(pkgJson, null, 2));
	}

	#collectInstalledNames(deps: Record<string, string>, config: PluginRuntimeConfig): Set<string> {
		const installedNames = new Set<string>();
		for (const name of Object.keys(deps)) {
			installedNames.add(name);
		}
		for (const name of Object.keys(config.plugins)) {
			installedNames.add(name);
		}
		return installedNames;
	}
	async #resolvePlugin(
		fallbackName: string,
		pluginPath: string,
		config: PluginRuntimeConfig,
		projectOverrides: ProjectPluginOverrides,
	): Promise<InstalledPlugin | undefined> {
		let pluginPkg: RuntimePackageJson;
		try {
			pluginPkg = await Bun.file(path.join(pluginPath, "package.json")).json();
		} catch (err) {
			if (isEnoent(err)) return undefined;
			throw err;
		}

		const name = typeof pluginPkg.name === "string" && pluginPkg.name.length > 0 ? pluginPkg.name : fallbackName;
		const manifest: PluginManifest = pluginPkg.omp || pluginPkg.pi || { version: pluginPkg.version };
		manifest.version = pluginPkg.version;
		const runtimeState = config.plugins[name] || {
			version: pluginPkg.version,
			enabledFeatures: null,
			enabled: true,
		};
		const isDisabledInProject = projectOverrides.disabled?.includes(name) ?? false;

		return {
			name,
			version: pluginPkg.version,
			path: pluginPath,
			manifest,
			enabledFeatures: projectOverrides.features?.[name] ?? runtimeState.enabledFeatures,
			enabled: runtimeState.enabled && !isDisabledInProject,
		};
	}
	async #collectMarketplaceRuntimePackageRealpaths(): Promise<Map<string, Set<string>>> {
		const registry = await readInstalledPluginsRegistry(getInstalledPluginsRegistryPath());
		const packageRealpaths = new Map<string, Set<string>>();
		await Promise.all(
			Object.entries(registry.plugins).flatMap(([pluginId, entries]) =>
				entries.map(async entry => {
					// Legacy registries written before `scope` was added omit the field;
					// `listClaudePluginRoots` treats those as user-scoped, so do the same.
					if ((entry.scope ?? "user") !== "user") return;
					const packageJsonPath = path.join(entry.installPath, "package.json");
					const parsedId = parsePluginId(pluginId);
					let packageName = parsedId?.name ?? pluginId;
					try {
						const pkg: RuntimePackageJson = await Bun.file(packageJsonPath).json();
						if (typeof pkg.name === "string" && pkg.name.length > 0) {
							packageName = pkg.name;
						}
					} catch (err) {
						if (!isEnoent(err)) {
							logger.debug("Failed to inspect marketplace plugin package path", {
								path: entry.installPath,
								error: String(err),
							});
							return;
						}
					}

					try {
						const installRealpath = await fs.promises.realpath(entry.installPath);
						const realpaths = packageRealpaths.get(packageName) ?? new Set<string>();
						realpaths.add(installRealpath);
						packageRealpaths.set(packageName, realpaths);
					} catch (err) {
						if (isEnoent(err)) return;
						throw err;
					}
				}),
			),
		);
		return packageRealpaths;
	}

	async #isMarketplaceRuntimeLink(
		name: string,
		deps: Record<string, string>,
		marketplaceRuntimeRealpaths: Map<string, Set<string>>,
		pluginPath: string,
	): Promise<boolean> {
		if (name in deps) return false;
		const realpaths = marketplaceRuntimeRealpaths.get(name);
		if (!realpaths) return false;
		try {
			return realpaths.has(await fs.promises.realpath(pluginPath));
		} catch (err) {
			if (isEnoent(err)) return false;
			throw err;
		}
	}

	async #snapshotInstalledPackage(actualName: string | undefined): Promise<PluginPackageSnapshot | null> {
		if (!actualName) {
			return null;
		}
		const packagePath = path.join(getPluginsNodeModules(), actualName);
		try {
			await fs.promises.lstat(packagePath);
		} catch (err) {
			if (isEnoent(err)) {
				return null;
			}
			throw err;
		}

		const backupRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-plugin-backup-"));
		const backupPath = path.join(backupRoot, "package");
		await fs.promises.cp(packagePath, backupPath, { recursive: true, verbatimSymlinks: true });
		return { actualName, packagePath, backupRoot, backupPath };
	}

	async #cleanupSnapshot(snapshot: PluginPackageSnapshot | null): Promise<void> {
		if (!snapshot) {
			return;
		}
		try {
			await fs.promises.rm(snapshot.backupRoot, { recursive: true, force: true });
		} catch (err) {
			logger.warn("Failed to remove plugin install backup", { plugin: snapshot.actualName, error: String(err) });
		}
	}

	async #rollbackFailedInstall(
		actualName: string | undefined,
		packageJsonBefore: string,
		bunLockBefore: string | null,
		snapshot: PluginPackageSnapshot | null,
	): Promise<void> {
		await Bun.write(getPluginsPackageJson(), packageJsonBefore);

		// Restore (or remove) bun's lockfile. Without this, a `bun install` +
		// `bun update` pair that successfully rewrote `bun.lock` would leave the
		// rejected commit pinned even when validation rolls everything else back.
		const bunLockPath = path.join(getPluginsDir(), "bun.lock");
		if (bunLockBefore === null) {
			await fs.promises.rm(bunLockPath, { force: true });
		} else {
			await Bun.write(bunLockPath, bunLockBefore);
		}

		// `actualName` may be undefined when the install failed before the dep
		// key was resolved — package.json + bun.lock restoration above is the
		// complete rollback in that case.
		if (!actualName) {
			return;
		}
		const packagePath = path.join(getPluginsNodeModules(), actualName);
		await fs.promises.rm(packagePath, { recursive: true, force: true });
		if (!snapshot) {
			return;
		}
		await fs.promises.mkdir(path.dirname(snapshot.packagePath), { recursive: true });
		await fs.promises.cp(snapshot.backupPath, snapshot.packagePath, { recursive: true, verbatimSymlinks: true });
	}

	async #validateInstalledExtensions(plugin: InstalledPlugin): Promise<void> {
		const declaredEntries = resolvePluginManifestEntries(plugin, "extensions");
		if (declaredEntries.length === 0) {
			return;
		}

		const errors: string[] = [];
		const loadable: string[] = [];
		for (const { entry, resolvedPath } of declaredEntries) {
			if (resolvedPath === null) {
				errors.push(`${entry}: declared extension entry not found on disk`);
			} else {
				loadable.push(resolvedPath);
			}
		}

		if (loadable.length > 0) {
			const result = await loadExtensions(loadable, this.#cwd);
			for (const failure of result.errors) {
				errors.push(`${failure.path}: ${failure.error}`);
			}
		}

		if (errors.length > 0) {
			throw new Error(`Plugin ${plugin.name} extension validation failed:\n${errors.join("\n")}`);
		}
	}

	// ==========================================================================
	// Install / Uninstall
	// ==========================================================================

	/**
	 * Install a plugin with optional feature selection.
	 *
	 * Accepts:
	 * - npm specs: `pkg`, `pkg@1.2.3`, `@scope/pkg`, `pkg[features]`
	 * - namespaced git shorthand: `github:user/repo[#ref]`, `gitlab:`, `bitbucket:`,
	 *   `codeberg:`, `sourcehut:`/`srht:`
	 * - full git URLs: `https://github.com/user/repo`, `git@github.com:user/repo`,
	 *   `ssh://…`, `git+https://…`
	 *
	 * For git specs the package name is not knowable from the spec, so the
	 * installer diffs `plugins/package.json` `dependencies` before and after
	 * to find the newly added key.
	 *
	 * @param specString - Package specifier with optional features: "pkg", "pkg[feat]", "pkg[*]", "pkg[]"
	 * @param options - Install options
	 * @returns Installed plugin metadata
	 */
	async install(specString: string, options: InstallOptions = {}): Promise<InstalledPlugin> {
		const spec = parsePluginSpec(specString);
		const gitSource = parseGitUrl(spec.packageName);
		if (gitSource) {
			validateGitSpec(spec.packageName);
		} else {
			validatePackageName(spec.packageName);
		}

		await this.#ensurePackageJson();

		if (options.dryRun) {
			return {
				name: spec.packageName,
				version: "0.0.0-dryrun",
				path: "",
				manifest: { version: "0.0.0-dryrun" },
				enabledFeatures: spec.features === "*" ? null : (spec.features as string[] | null),
				enabled: true,
			};
		}
		const pkgJsonPath = getPluginsPackageJson();
		const packageJsonBefore = await Bun.file(pkgJsonPath).text();
		// Snapshot bun's lockfile so the rollback path can restore the pin. Every
		// step below — `bun install`, `bun update`, feature/extension validation,
		// runtime-config save — must either complete entirely or leave the
		// lockfile pointing at its pre-install state. Absent before install means
		// "remove on rollback".
		const bunLockPath = path.join(getPluginsDir(), "bun.lock");
		let bunLockBefore: string | null;
		try {
			bunLockBefore = await Bun.file(bunLockPath).text();
		} catch (err) {
			if (!isEnoent(err)) throw err;
			bunLockBefore = null;
		}
		const depsBefore = await this.#readDeps(pkgJsonPath);
		const packageInstallSpec = gitSource ? gitInstallSpec(spec.packageName, gitSource) : spec.packageName;
		const existingActualName = gitSource
			? findGitPackageName(gitSource, depsBefore)
			: extractPackageName(spec.packageName);
		const packageSnapshot = await this.#snapshotInstalledPackage(existingActualName);

		// `actualName` is hoisted so the rollback handler can clean up the right
		// node_modules entry even if a step between `bun install` and the final
		// validation throws.
		let actualName: string | undefined;
		try {
			// Bun treats a dependency replacement from `repo#old-ref` to the same
			// package at `repo`/`repo#new-ref` as a self-edge and bails with
			// DependencyLoop. Remove only the stale manifest edge; rollback restores
			// the original package.json and node_modules snapshot on failure.
			if (gitSource && existingActualName) {
				const installedSource = parseGitUrl(depsBefore[existingActualName] ?? "");
				if (installedSource && installedSource.ref !== gitSource.ref) {
					await this.#removeDependencyEntry(pkgJsonPath, existingActualName);
				}
			}

			// Step 1: write the spec into plugins/package.json + node_modules.
			const installProc = Bun.spawn(["bun", "install", packageInstallSpec], {
				cwd: getPluginsDir(),
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				windowsHide: true,
			});
			// Drain stdout+stderr concurrently with proc.exited. Awaiting exited
			// before reading either pipe risks a >64 KiB OS-pipe-buffer deadlock
			// once bun install prints enough progress; even where Bun currently
			// buffers eagerly, doing this leaks unbounded memory.
			const [installExit, , installStderr] = await Promise.all([
				installProc.exited,
				new Response(installProc.stdout).text(),
				new Response(installProc.stderr).text(),
			]);
			if (installExit !== 0) {
				throw new Error(`bun install failed: ${installStderr}`);
			}
			// Resolve actual package name. npm specs encode the name (strip version);
			// git specs do not, so diff plugins/package.json deps to find the new entry.
			if (gitSource) {
				const depsAfter = await this.#readDeps(pkgJsonPath);
				let resolved: string | undefined;
				for (const key of Object.keys(depsAfter)) {
					if (!(key in depsBefore)) {
						resolved = key;
						break;
					}
				}
				// Fallback: a force-reinstall of an already-present git plugin will not
				// add a new key, just rewrite the existing one to the new spec value.
				// Match by repository identity, not by ref, so failed upgrades from
				// one ref to another still resolve to the original package name.
				if (!resolved) {
					resolved = findGitPackageName(gitSource, depsAfter);
				}
				if (!resolved) {
					throw new Error(
						`Installed ${spec.packageName} but could not determine package name from plugins/package.json`,
					);
				}
				actualName = resolved;
			} else {
				actualName = extractPackageName(spec.packageName);
			}

			// Step 2: refresh the git lockfile pin when re-installing an existing
			// git plugin. `bun install <spec>` is a no-op when the spec matches the
			// lockfile entry, while `bun update <name>` resolves through Bun's bare
			// clone cache. Fetch the matching cache clone first so a stale cached
			// ref cannot silently preserve the old pin (#3063, #5401). First-time
			// installs skip this because the initial `bun install` populated the
			// cache from the remote. Rollback is handled by the outer catch.
			if (gitSource && existingActualName) {
				await refreshBunGitCache(gitSource, getPluginsDir());
				const updateProc = Bun.spawn(["bun", "update", actualName], {
					cwd: getPluginsDir(),
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
					windowsHide: true,
				});
				// Same drain-concurrent-with-exit pattern as the bun install above.
				const [updateExit, , updateStderr] = await Promise.all([
					updateProc.exited,
					new Response(updateProc.stdout).text(),
					new Response(updateProc.stderr).text(),
				]);
				if (updateExit !== 0) {
					throw new Error(`bun update ${actualName} failed: ${updateStderr}`);
				}
			}

			const pkgPath = path.join(getPluginsNodeModules(), actualName, "package.json");
			let pkg: { name: string; version: string; omp?: PluginManifest; pi?: PluginManifest };
			try {
				pkg = await Bun.file(pkgPath).json();
			} catch (err) {
				if (isEnoent(err)) {
					throw new Error(`Package installed but package.json not found at ${pkgPath}`);
				}
				throw err;
			}
			const manifest: PluginManifest = pkg.omp || pkg.pi || { version: pkg.version };
			manifest.version = pkg.version;

			// Resolve enabled features
			let enabledFeatures: string[] | null = null;
			if (spec.features === "*") {
				// All features
				enabledFeatures = manifest.features ? Object.keys(manifest.features) : null;
			} else if (Array.isArray(spec.features)) {
				if (spec.features.length > 0) {
					// Validate requested features exist
					if (manifest.features) {
						for (const feat of spec.features) {
							if (!(feat in manifest.features)) {
								throw new Error(
									`Unknown feature "${feat}" in ${actualName}. Available: ${Object.keys(manifest.features).join(", ")}`,
								);
							}
						}
					}
					enabledFeatures = spec.features;
				} else {
					// Empty array = no optional features
					enabledFeatures = [];
				}
			}
			// null = use defaults

			const installedPlugin: InstalledPlugin = {
				name: pkg.name,
				version: pkg.version,
				path: path.join(getPluginsNodeModules(), actualName),
				manifest,
				enabledFeatures,
				enabled: true,
			};

			await this.#validateInstalledExtensions(installedPlugin);

			// Update runtime config
			const config = await this.#ensureConfigLoaded();
			config.plugins[pkg.name] = {
				version: pkg.version,
				enabledFeatures,
				enabled: true,
			};
			await this.#saveRuntimeConfig();

			return installedPlugin;
		} catch (err) {
			try {
				await this.#rollbackFailedInstall(
					actualName ?? existingActualName,
					packageJsonBefore,
					bunLockBefore,
					packageSnapshot,
				);
			} catch (rollbackErr) {
				const message = err instanceof Error ? err.message : String(err);
				const rollbackMessage = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
				throw new Error(`${message}\nRollback failed: ${rollbackMessage}`);
			}
			throw err;
		} finally {
			await this.#cleanupSnapshot(packageSnapshot);
		}
	}

	/**
	 * Uninstall a plugin.
	 */
	async uninstall(name: string): Promise<void> {
		validatePackageName(name);
		await this.#ensurePackageJson();

		const proc = Bun.spawn(["bun", "uninstall", name], {
			cwd: getPluginsDir(),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
		});

		// Drain both pipes concurrently with proc.exited to avoid a pipe-buffer
		// deadlock if bun uninstall floods stdout/stderr.
		const [exitCode] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		if (exitCode !== 0) {
			throw new Error(`npm uninstall failed for ${name}`);
		}

		// Remove from runtime config
		const config = await this.#ensureConfigLoaded();
		delete config.plugins[name];
		delete config.settings[name];
		await this.#saveRuntimeConfig();
	}

	/**
	 * Resolve one installed plugin, including a marketplace runtime package that
	 * is intentionally omitted from {@link list}.
	 *
	 * Resolution order mirrors {@link getEnabledPlugins}: an explicit trusted
	 * `options.path` (marketplace registry entry) wins; otherwise the active
	 * enabled project plugin root shadows the user root — so inside a project
	 * where the same package name exists in both scopes, config reads and writes
	 * act on the package copy active at runtime.
	 */
	async getPlugin(name: string, options: { path?: string } = {}): Promise<InstalledPlugin | undefined> {
		const [config, projectOverrides] = await Promise.all([this.#ensureConfigLoaded(), this.#loadProjectOverrides()]);
		if (options.path) {
			return this.#resolvePlugin(name, options.path, config, projectOverrides);
		}
		const projectPlugin = await this.#resolvePluginAtActiveProjectRoot(name, projectOverrides);
		const deps = await this.#readDeps(getPluginsPackageJson());
		const userPlugin = this.#collectInstalledNames(deps, config).has(name)
			? await this.#resolvePlugin(name, path.join(getPluginsNodeModules(), name), config, projectOverrides)
			: undefined;
		if (projectPlugin?.enabled || !userPlugin) {
			return projectPlugin;
		}
		return userPlugin;
	}

	/**
	 * Resolve a plugin from the active project plugin root
	 * (`<anchor>/.omp/plugins`). Project npm/link/marketplace installs all record
	 * their runtime state and `node_modules` symlink there — invisible to the
	 * user-root lookup — so this reads the project's own `package.json`
	 * dependencies plus `omp-plugins.lock.json`, and resolves the package from
	 * the project `node_modules`. Returns undefined when there is no active
	 * project, when it coincides with the user root, or when the package is not
	 * installed there.
	 */
	async #resolvePluginAtActiveProjectRoot(
		name: string,
		projectOverrides: ProjectPluginOverrides,
	): Promise<InstalledPlugin | undefined> {
		const registryPath = await resolveActiveProjectRegistryPath(this.#cwd);
		if (!registryPath) return undefined;
		const projectRoot = path.dirname(registryPath);
		if (path.resolve(projectRoot) === path.resolve(getPluginsDir())) return undefined;
		const [projectDeps, projectConfig] = await Promise.all([
			this.#readDeps(path.join(projectRoot, "package.json")),
			this.#readRuntimeConfigAt(path.join(projectRoot, "omp-plugins.lock.json")),
		]);
		if (!this.#collectInstalledNames(projectDeps, projectConfig).has(name)) return undefined;
		return this.#resolvePlugin(name, path.join(projectRoot, "node_modules", name), projectConfig, projectOverrides);
	}

	/**
	 * List all installed plugins.
	 */
	async list(): Promise<InstalledPlugin[]> {
		const pkgJsonPath = getPluginsPackageJson();
		let deps: Record<string, string> = {};
		try {
			const pkg: { dependencies?: Record<string, string> } = await Bun.file(pkgJsonPath).json();
			deps = pkg.dependencies ?? {};
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}

		const [projectOverrides, config, marketplaceRuntimeRealpaths] = await Promise.all([
			this.#loadProjectOverrides(),
			this.#ensureConfigLoaded(),
			this.#collectMarketplaceRuntimePackageRealpaths(),
		]);
		const plugins: InstalledPlugin[] = [];
		const installedNames = this.#collectInstalledNames(deps, config);
		for (const name of installedNames) {
			const pluginPath = path.join(getPluginsNodeModules(), name);
			if (await this.#isMarketplaceRuntimeLink(name, deps, marketplaceRuntimeRealpaths, pluginPath)) continue;
			const plugin = await this.#resolvePlugin(name, pluginPath, config, projectOverrides);
			if (plugin) {
				plugins.push(plugin);
			}
		}

		return plugins;
	}

	/**
	 * Link a local plugin for development.
	 */
	async link(localPath: string): Promise<InstalledPlugin> {
		const absolutePath = path.resolve(this.#cwd, localPath);

		const pkgFilePath = path.join(absolutePath, "package.json");
		let pkg: { name?: string; version: string; omp?: PluginManifest; pi?: PluginManifest };
		try {
			pkg = await Bun.file(pkgFilePath).json();
		} catch (err) {
			if (isEnoent(err)) throw new Error(`package.json not found at ${absolutePath}`);
			throw err;
		}
		if (!pkg.name) {
			throw new Error("package.json must have a name field");
		}

		await this.#ensurePluginsDir();

		const linkPath = path.join(getPluginsNodeModules(), pkg.name);

		// Handle scoped packages
		if (pkg.name.startsWith("@")) {
			const scopeDir = path.join(getPluginsNodeModules(), pkg.name.split("/")[0]);
			await fs.promises.mkdir(scopeDir, { recursive: true });
		}

		// Remove existing
		try {
			const stats = await fs.promises.lstat(linkPath);
			if (stats.isSymbolicLink() || stats.isDirectory()) {
				await fs.promises.unlink(linkPath);
			}
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}

		await fs.promises.symlink(absolutePath, linkPath);

		const manifest: PluginManifest = pkg.omp || pkg.pi || { version: pkg.version };
		manifest.version = pkg.version;

		// Add to runtime config
		const config = await this.#ensureConfigLoaded();
		config.plugins[pkg.name] = {
			version: pkg.version,
			enabledFeatures: null,
			enabled: true,
		};
		await this.#saveRuntimeConfig();

		return {
			name: pkg.name,
			version: pkg.version,
			path: absolutePath,
			manifest,
			enabledFeatures: null,
			enabled: true,
		};
	}

	// ==========================================================================
	// Enable / Disable
	// ==========================================================================

	/**
	 * Enable or disable a plugin globally.
	 */
	async setEnabled(name: string, enabled: boolean): Promise<void> {
		const config = await this.#ensureConfigLoaded();
		if (!config.plugins[name]) {
			throw new Error(`Plugin ${name} not found in runtime config`);
		}
		config.plugins[name].enabled = enabled;
		await this.#saveRuntimeConfig();
	}

	// ==========================================================================
	// Features
	// ==========================================================================

	/**
	 * Get enabled features for a plugin.
	 */
	async getEnabledFeatures(name: string): Promise<string[] | null> {
		const config = await this.#ensureConfigLoaded();
		return config.plugins[name]?.enabledFeatures ?? null;
	}

	/**
	 * Set enabled features for a plugin.
	 */
	async setEnabledFeatures(name: string, features: string[] | null): Promise<void> {
		const config = await this.#ensureConfigLoaded();
		if (!config.plugins[name]) {
			throw new Error(`Plugin ${name} not found in runtime config`);
		}

		// Validate features if setting specific ones
		if (features && features.length > 0) {
			const plugins = await this.list();
			const plugin = plugins.find(p => p.name === name);
			if (plugin?.manifest.features) {
				for (const feat of features) {
					if (!(feat in plugin.manifest.features)) {
						throw new Error(
							`Unknown feature "${feat}" in ${name}. Available: ${Object.keys(plugin.manifest.features).join(", ")}`,
						);
					}
				}
			}
		}

		config.plugins[name].enabledFeatures = features;
		await this.#saveRuntimeConfig();
	}

	// ==========================================================================
	// Settings
	// ==========================================================================

	/**
	 * Get all settings for a plugin.
	 */
	async getPluginSettings(name: string): Promise<Record<string, unknown>> {
		const config = await this.#ensureConfigLoaded();
		const global = config.settings[name] || {};
		const projectOverrides = await this.#loadProjectOverrides();
		const project = projectOverrides.settings?.[name] || {};

		// Project settings override global
		return { ...global, ...project };
	}

	/**
	 * Set a plugin setting value.
	 */
	async setPluginSetting(name: string, key: string, value: unknown): Promise<void> {
		const config = await this.#ensureConfigLoaded();
		if (!config.settings[name]) {
			config.settings[name] = {};
		}
		config.settings[name][key] = value;
		await this.#saveRuntimeConfig();
	}

	/**
	 * Delete a plugin setting.
	 */
	async deletePluginSetting(name: string, key: string): Promise<void> {
		const config = await this.#ensureConfigLoaded();
		if (config.settings[name]) {
			delete config.settings[name][key];
			await this.#saveRuntimeConfig();
		}
	}

	// ==========================================================================
	// Doctor
	// ==========================================================================

	/**
	 * Run health checks on the plugin system.
	 */
	async doctor(options: DoctorOptions = {}): Promise<DoctorCheck[]> {
		const checks: DoctorCheck[] = [];

		// Check 1: Plugins directory exists
		const pluginsDir = getPluginsDir();
		const pluginsDirExists = fs.existsSync(pluginsDir);
		checks.push({
			name: "plugins_directory",
			status: pluginsDirExists ? "ok" : "warning",
			message: pluginsDirExists ? `Found at ${pluginsDir}` : "Not created yet",
		});

		// Check 2: package.json exists
		const pkgJsonPath = getPluginsPackageJson();
		let pkg: { dependencies?: Record<string, string> };
		let hasPkgJson = true;
		try {
			pkg = await Bun.file(pkgJsonPath).json();
		} catch (err) {
			if (isEnoent(err)) {
				hasPkgJson = false;
				pkg = {};
			} else {
				throw err;
			}
		}
		checks.push({
			name: "package_manifest",
			status: hasPkgJson ? "ok" : "warning",
			message: hasPkgJson ? "Found" : "Not created yet",
		});

		// Check 3: node_modules exists
		const nodeModulesPath = getPluginsNodeModules();
		const hasNodeModules = fs.existsSync(nodeModulesPath);
		checks.push({
			name: "node_modules",
			status: hasNodeModules ? "ok" : hasPkgJson ? "error" : "warning",
			message: hasNodeModules ? "Found" : "Missing (run npm install in plugins dir)",
		});

		const deps = pkg.dependencies || {};
		const [config, marketplaceRuntimeRealpaths] = await Promise.all([
			this.#ensureConfigLoaded(),
			this.#collectMarketplaceRuntimePackageRealpaths(),
		]);
		const installedNames = this.#collectInstalledNames(deps, config);

		for (const name of installedNames) {
			const pluginPath = path.join(nodeModulesPath, name);
			if (await this.#isMarketplaceRuntimeLink(name, deps, marketplaceRuntimeRealpaths, pluginPath)) continue;
			const pluginPkgPath = path.join(pluginPath, "package.json");
			const fromDependencies = name in deps;

			let pluginPkg: { version: string; description?: string; omp?: PluginManifest; pi?: PluginManifest };
			try {
				pluginPkg = await Bun.file(pluginPkgPath).json();
			} catch (err) {
				if (isEnoent(err)) {
					if (!fs.existsSync(pluginPath)) {
						if (fromDependencies) {
							const fixed = options.fix ? await this.#fixMissingPlugin() : false;
							checks.push({
								name: `plugin:${name}`,
								status: "error",
								message: "Missing from node_modules",
								fixed,
							});
						} else {
							const fixed = options.fix ? await this.#removeOrphanedConfig(name) : false;
							checks.push({
								name: `orphan:${name}`,
								status: "warning",
								message: "Plugin in config but not installed",
								fixed,
							});
						}
					} else {
						checks.push({
							name: `plugin:${name}`,
							status: "error",
							message: "Missing package.json",
						});
					}
					continue;
				}
				throw err;
			}
			const hasManifest = !!(pluginPkg.omp || pluginPkg.pi);
			const manifest: PluginManifest | undefined = pluginPkg.omp || pluginPkg.pi;

			checks.push({
				name: `plugin:${name}`,
				status: hasManifest ? "ok" : "warning",
				message: hasManifest
					? `v${pluginPkg.version}${pluginPkg.description ? ` - ${pluginPkg.description}` : ""}`
					: `v${pluginPkg.version} - No omp/pi manifest (not an omp plugin)`,
			});

			// Check tools path exists if specified
			if (manifest?.tools) {
				const toolsPath = path.join(pluginPath, manifest.tools);
				if (!fs.existsSync(toolsPath)) {
					checks.push({
						name: `plugin:${name}:tools`,
						status: "error",
						message: `Tools entry "${manifest.tools}" not found`,
					});
				}
			}

			// Check hooks path exists if specified
			if (manifest?.hooks) {
				const hooksPath = path.join(pluginPath, manifest.hooks);
				if (!fs.existsSync(hooksPath)) {
					checks.push({
						name: `plugin:${name}:hooks`,
						status: "error",
						message: `Hooks entry "${manifest.hooks}" not found`,
					});
				}
			}

			// Check extension entry paths exist if specified
			if (manifest?.extensions) {
				for (const extensionPath of manifest.extensions) {
					const resolvedExtensionPath = path.join(pluginPath, extensionPath);
					if (!fs.existsSync(resolvedExtensionPath)) {
						checks.push({
							name: `plugin:${name}:extension:${extensionPath}`,
							status: "error",
							message: `Extension entry "${extensionPath}" not found`,
						});
					}
				}
			}

			// Check enabled features exist in manifest
			const runtimeState = config.plugins[name];
			if (runtimeState?.enabledFeatures && manifest?.features) {
				for (const feat of runtimeState.enabledFeatures) {
					if (!(feat in manifest.features)) {
						const fixed = options.fix ? await this.#removeInvalidFeature(name, feat) : false;
						checks.push({
							name: `plugin:${name}:feature:${feat}`,
							status: "warning",
							message: `Enabled feature "${feat}" not in manifest`,
							fixed,
						});
					}
				}
			}
		}

		return checks;
	}

	async #fixMissingPlugin(): Promise<boolean> {
		try {
			const proc = Bun.spawn(["bun", "install"], {
				cwd: getPluginsDir(),
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				windowsHide: true,
			});
			// Drain pipes concurrently with proc.exited; otherwise a chatty
			// bun install can block on a full OS pipe buffer.
			const [exit] = await Promise.all([
				proc.exited,
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			]);
			return exit === 0;
		} catch {
			return false;
		}
	}

	async #removeInvalidFeature(name: string, feat: string): Promise<boolean> {
		const config = await this.#ensureConfigLoaded();
		const state = config.plugins[name];
		if (state?.enabledFeatures) {
			state.enabledFeatures = state.enabledFeatures.filter(f => f !== feat);
			await this.#saveRuntimeConfig();
			return true;
		}
		return false;
	}

	async #removeOrphanedConfig(name: string): Promise<boolean> {
		const config = await this.#ensureConfigLoaded();
		delete config.plugins[name];
		delete config.settings[name];
		await this.#saveRuntimeConfig();
		return true;
	}
}

// =============================================================================
// Setting Validation
// =============================================================================

export interface ValidationResult {
	valid: boolean;
	error?: string;
}

/**
 * Validate a setting value against its schema.
 */
export function validateSetting(value: unknown, schema: PluginSettingSchema): ValidationResult {
	switch (schema.type) {
		case "string":
			if (typeof value !== "string") {
				return { valid: false, error: "Expected string" };
			}
			break;

		case "number":
			if (typeof value !== "number" || Number.isNaN(value)) {
				return { valid: false, error: "Expected number" };
			}
			if (schema.min !== undefined && value < schema.min) {
				return { valid: false, error: `Must be >= ${schema.min}` };
			}
			if (schema.max !== undefined && value > schema.max) {
				return { valid: false, error: `Must be <= ${schema.max}` };
			}
			break;

		case "boolean":
			if (typeof value !== "boolean") {
				return { valid: false, error: "Expected boolean" };
			}
			break;

		case "enum":
			if (!schema.values.includes(String(value))) {
				return { valid: false, error: `Must be one of: ${schema.values.join(", ")}` };
			}
			break;
	}

	return { valid: true };
}

/**
 * Parse a string value according to a setting schema's type.
 */
export function parseSettingValue(valueStr: string, schema: PluginSettingSchema): unknown {
	switch (schema.type) {
		case "number":
			return Number(valueStr);

		case "boolean":
			return valueStr === "true" || valueStr === "yes" || valueStr === "1";
		default:
			return valueStr;
	}
}
