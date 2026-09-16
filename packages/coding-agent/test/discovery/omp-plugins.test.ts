/**
 * Regression tests for #1496.
 *
 * The native `omp` discovery provider only walks `.omp/` and `~/.omp/agent/`.
 * Extension packages registered via `extensions:` in settings or
 * `--extension` on the CLI ship their own `skills/`, `hooks/`, `tools/`,
 * `commands/`, `rules/`, `prompts/`, and `.mcp.json`. The `omp-plugins`
 * provider (`src/discovery/omp-plugins.ts`) is what wires those sub-trees
 * into the standard capability surfaces.
 *
 * The provider is invoked directly so the `LoadContext` uses a tempdir as
 * `home` instead of `os.homedir()`. Module-level CLI injection state is
 * reset between cases so they cannot poison each other.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getCapability, loadCapability } from "@oh-my-pi/pi-coding-agent/capability";
import { clearCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { hookCapability } from "@oh-my-pi/pi-coding-agent/capability/hook";
import { mcpCapability } from "@oh-my-pi/pi-coding-agent/capability/mcp";
import { promptCapability } from "@oh-my-pi/pi-coding-agent/capability/prompt";
import { ruleCapability } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { skillCapability } from "@oh-my-pi/pi-coding-agent/capability/skill";
import { slashCommandCapability } from "@oh-my-pi/pi-coding-agent/capability/slash-command";
import { toolCapability } from "@oh-my-pi/pi-coding-agent/capability/tool";
import type { LoadContext, Provider } from "@oh-my-pi/pi-coding-agent/capability/types";
// Register all discovery providers as a side effect.
import "@oh-my-pi/pi-coding-agent/discovery";
import {
	clearOmpExtensionCliRoots,
	injectOmpExtensionCliRoots,
	listOmpExtensionRoots,
	setInvocationConfiguredExtensions,
	withOmpExtensionRootScope,
} from "@oh-my-pi/pi-coding-agent/discovery/omp-extension-roots";
import { discoverExtensionPaths } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { getConfigRootDir, removeSyncWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

const PROVIDER_ID = "omp-plugins";

let tempDir: string;
let home: string;
let project: string;
let ext: string;

const originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

function writeFile(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
}

function pluginProvider(capabilityId: string): Provider<unknown> {
	const cap = getCapability(capabilityId);
	if (!cap) throw new Error(`capability ${capabilityId} missing`);
	const provider = cap.providers.find(p => p.id === PROVIDER_ID);
	if (!provider) throw new Error(`provider ${PROVIDER_ID} not registered for ${capabilityId}`);
	return provider as Provider<unknown>;
}

async function loadFromPlugin<T>(capabilityId: string, ctx: LoadContext): Promise<T[]> {
	const result = await pluginProvider(capabilityId).load(ctx);
	return result.items as T[];
}

function buildExtensionPackage(packageDir: string, skillName = "my-skill"): void {
	writeFile(
		path.join(packageDir, "package.json"),
		JSON.stringify({ name: path.basename(packageDir), omp: { extensions: ["./src/main.ts"] } }),
	);
	writeFile(path.join(packageDir, "src", "main.ts"), "export default function (_pi) {}\n");
	writeFile(
		path.join(packageDir, "skills", skillName, "SKILL.md"),
		`---\nname: ${skillName}\ndescription: Hello from extension skill\n---\nbody\n`,
	);
	writeFile(path.join(packageDir, "commands", "greet.md"), "---\ndescription: greet user\n---\nHello {{name}}\n");
	writeFile(path.join(packageDir, "rules", "style.md"), "---\ndescription: style rule\n---\nUse tabs.\n");
	writeFile(path.join(packageDir, "prompts", "review.md"), "Review this code.\n");
	writeFile(path.join(packageDir, "hooks", "pre", "bash.sh"), "#!/bin/sh\necho pre\n");
	writeFile(path.join(packageDir, "hooks", "post", "edit.sh"), "#!/bin/sh\necho post\n");
	writeFile(path.join(packageDir, "hooks", "pre", "extension.ts"), "export default function (_pi) {}\n");
	writeFile(path.join(packageDir, "tools", "wcount.sh"), "#!/bin/sh\nwc -w\n");
	writeFile(path.join(packageDir, "tools", "deep-tool", "index.ts"), "export default { name: 'deep-tool' };\n");
	writeFile(
		path.join(packageDir, ".mcp.json"),
		JSON.stringify({ mcpServers: { lsp: { command: "lsp-server", args: ["--stdio"] } } }),
	);
}

beforeEach(() => {
	clearCache();
	clearOmpExtensionCliRoots();
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-plugins-"));
	home = path.join(tempDir, "home");
	project = path.join(tempDir, "project");
	ext = path.join(tempDir, "my-extension");
	fs.mkdirSync(home, { recursive: true });
	fs.mkdirSync(project, { recursive: true });
	fs.mkdirSync(path.join(project, ".git"), { recursive: true });
	buildExtensionPackage(ext);
	setAgentDir(path.join(home, ".omp", "agent"));
});

afterEach(() => {
	clearCache();
	clearOmpExtensionCliRoots();
	if (originalAgentDirEnv) {
		setAgentDir(originalAgentDirEnv);
	} else {
		setAgentDir(fallbackAgentDir);
		delete process.env.PI_CODING_AGENT_DIR;
	}
	removeSyncWithRetries(tempDir);
});

function ctx(): LoadContext {
	return { cwd: project, home, repoRoot: project };
}

async function expectExtensionSubDirectoriesLoaded(context: LoadContext): Promise<void> {
	const [skills, commands, rules, prompts, hooks, tools, mcps] = await Promise.all([
		loadFromPlugin<{ name: string }>(skillCapability.id, context),
		loadFromPlugin<{ name: string }>(slashCommandCapability.id, context),
		loadFromPlugin<{ name: string }>(ruleCapability.id, context),
		loadFromPlugin<{ name: string }>(promptCapability.id, context),
		loadFromPlugin<{ name: string; type: "pre" | "post" }>(hookCapability.id, context),
		loadFromPlugin<{ name: string }>(toolCapability.id, context),
		loadFromPlugin<{ name: string; command?: string }>(mcpCapability.id, context),
	]);

	expect(skills.map(s => s.name)).toContain("my-skill");
	expect(commands.map(c => c.name)).toContain("greet");
	expect(rules.map(r => r.name)).toContain("style");
	expect(prompts.map(p => p.name)).toContain("review");
	expect(hooks.some(h => h.name === "bash.sh" && h.type === "pre")).toBe(true);
	expect(hooks.some(h => h.name === "edit.sh" && h.type === "post")).toBe(true);
	expect(tools.map(t => t.name)).toEqual(expect.arrayContaining(["wcount", "deep-tool"]));
	expect(mcps.find(m => m.name === "lsp")?.command).toBe("lsp-server");
}

test("project settings.json#extensions surfaces every sub-directory", async () => {
	writeFile(path.join(project, ".omp", "settings.json"), JSON.stringify({ extensions: [ext] }));
	await expectExtensionSubDirectoriesLoaded(ctx());
});

test("user settings.json#extensions also feeds sub-discovery", async () => {
	writeFile(path.join(home, ".omp", "agent", "settings.json"), JSON.stringify({ extensions: [ext] }));

	const skills = await loadFromPlugin<{ name: string }>(skillCapability.id, ctx());
	expect(skills.map(s => s.name)).toContain("my-skill");
});

test("project config.yml#extensions surfaces every sub-directory (#9768)", async () => {
	writeFile(path.join(project, ".omp", "config.yml"), `extensions:\n  - "${ext}"\n`);
	await expectExtensionSubDirectoriesLoaded(ctx());
});

test("user config.yaml#extensions feeds sub-discovery", async () => {
	// User scope also honors the legacy-compatible `config.yaml` filename.
	writeFile(path.join(home, ".omp", "agent", "config.yaml"), `extensions:\n  - "${ext}"\n`);

	const skills = await loadFromPlugin<{ name: string }>(skillCapability.id, ctx());
	expect(skills.map(s => s.name)).toContain("my-skill");
});

test("project config.yml#extensions replaces lower-precedence configured roots", async () => {
	const userExt = path.join(tempDir, "user-extension");
	const projectSettingsExt = path.join(tempDir, "project-settings-extension");
	const projectConfigExt = path.join(tempDir, "project-config-extension");
	buildExtensionPackage(userExt, "user-skill");
	buildExtensionPackage(projectSettingsExt, "project-settings-skill");
	buildExtensionPackage(projectConfigExt, "project-config-skill");
	writeFile(path.join(home, ".omp", "agent", "config.yml"), `extensions:\n  - "${userExt}"\n`);
	writeFile(path.join(project, ".omp", "settings.json"), JSON.stringify({ extensions: [projectSettingsExt] }));
	writeFile(path.join(project, ".omp", "config.yml"), `extensions:\n  - "${projectConfigExt}"\n`);

	const skills = await loadFromPlugin<{ name: string }>(skillCapability.id, ctx());
	const names = skills.map(skill => skill.name);
	expect(names).toContain("project-config-skill");
	expect(names).not.toContain("project-settings-skill");
	expect(names).not.toContain("user-skill");
});

test("effective extensions replace persisted roots for overlays and runtime overrides", async () => {
	const persistedExt = path.join(tempDir, "persisted-extension");
	const overrideExt = path.join(tempDir, "override-extension");
	buildExtensionPackage(persistedExt, "persisted-skill");
	buildExtensionPackage(overrideExt, "override-skill");
	writeFile(path.join(project, ".omp", "config.yml"), `extensions:\n  - "${persistedExt}"\n`);

	const context: LoadContext = {
		...ctx(),
		extensionRoots: { explicit: [], mode: "merge", configured: [overrideExt], configuredLevel: "user" },
	};
	const skills = await loadFromPlugin<{ name: string }>(skillCapability.id, context);
	const names = skills.map(skill => skill.name);
	expect(names).toContain("override-skill");
	expect(names).not.toContain("persisted-skill");

	const emptyOverride: LoadContext = {
		...ctx(),
		extensionRoots: { explicit: [], mode: "merge", configured: [], configuredLevel: "user" },
	};
	const emptySkills = await loadFromPlugin<{ name: string }>(skillCapability.id, emptyOverride);
	expect(emptySkills.map(skill => skill.name)).not.toContain("persisted-skill");
});

test("empty project config.yml#extensions suppresses user roots", async () => {
	const userExt = path.join(tempDir, "user-extension");
	buildExtensionPackage(userExt, "user-skill");
	writeFile(path.join(home, ".omp", "agent", "config.yml"), `extensions:\n  - "${userExt}"\n`);
	writeFile(path.join(project, ".omp", "config.yml"), "extensions: []\n");

	const skills = await loadFromPlugin<{ name: string }>(skillCapability.id, ctx());
	expect(skills.map(skill => skill.name)).not.toContain("user-skill");
});

test("user YAML config suppresses its legacy settings.json migration source", async () => {
	const legacyExt = path.join(tempDir, "legacy-extension");
	buildExtensionPackage(legacyExt, "legacy-skill");
	writeFile(path.join(home, ".omp", "agent", "settings.json"), JSON.stringify({ extensions: [legacyExt] }));
	writeFile(path.join(home, ".omp", "agent", "config.yml"), "theme:\n  dark: default\n");

	const skills = await loadFromPlugin<{ name: string }>(skillCapability.id, ctx());
	expect(skills.map(skill => skill.name)).not.toContain("legacy-skill");
});

test("`--extension` CLI injection is wired through the same provider", async () => {
	// Empty settings on disk; rely purely on CLI injection.
	injectOmpExtensionCliRoots([ext], home, project);

	const skills = await loadFromPlugin<{ name: string }>(skillCapability.id, ctx());
	const tools = await loadFromPlugin<{ name: string }>(toolCapability.id, ctx());
	expect(skills.map(s => s.name)).toContain("my-skill");
	expect(tools.map(t => t.name)).toEqual(expect.arrayContaining(["wcount", "deep-tool"]));
});

test("relative CLI roots rebind when resume switches projects", async () => {
	const relativeRoot = "relative-extension";
	const launchRoot = path.join(project, relativeRoot);
	const destination = path.join(tempDir, "destination");
	const destinationRoot = path.join(destination, relativeRoot);
	buildExtensionPackage(launchRoot, "launch-skill");
	buildExtensionPackage(destinationRoot, "destination-skill");

	injectOmpExtensionCliRoots([`./${relativeRoot}`], home, project);

	const destinationContext = { cwd: destination, home, repoRoot: destination };
	const roots = await listOmpExtensionRoots(destinationContext);
	const skills = await loadFromPlugin<{ name: string }>(skillCapability.id, destinationContext);
	expect(roots.map(root => root.path)).toEqual([destinationRoot]);
	expect(skills.map(skill => skill.name)).toContain("destination-skill");
	expect(skills.map(skill => skill.name)).not.toContain("launch-skill");
});

test("explicit-only CLI roots replace stale state and exclude every ambient package source", async () => {
	const stale = path.join(tempDir, "stale-extension");
	const projectExt = path.join(tempDir, "project-extension");
	const userExt = path.join(tempDir, "user-extension");
	const installed = path.join(home, ".omp", "plugins", "node_modules", "installed-extension");
	buildExtensionPackage(stale, "stale-skill");
	buildExtensionPackage(projectExt, "project-skill");
	buildExtensionPackage(userExt, "user-skill");
	buildExtensionPackage(installed, "installed-skill");
	writeFile(path.join(project, ".omp", "settings.json"), JSON.stringify({ extensions: [projectExt] }));
	writeFile(path.join(home, ".omp", "agent", "settings.json"), JSON.stringify({ extensions: [userExt] }));
	writeFile(
		path.join(home, ".omp", "plugins", "package.json"),
		JSON.stringify({ name: "omp-plugins", dependencies: { "installed-extension": "1.0.0" } }),
	);

	injectOmpExtensionCliRoots([stale], home, project);
	injectOmpExtensionCliRoots([ext], home, project, { mode: "explicit-only", replace: true });

	const roots = await listOmpExtensionRoots(ctx());
	const skills = await loadFromPlugin<{ name: string }>(skillCapability.id, ctx());
	const extensionPaths = await discoverExtensionPaths([ext], project, undefined, { ambient: false });

	expect(roots).toHaveLength(1);
	expect(path.basename(roots[0].path)).toBe("my-extension");
	expect(skills.map(skill => skill.name)).toContain("my-skill");
	expect(skills.map(skill => skill.name)).not.toEqual(
		expect.arrayContaining(["stale-skill", "project-skill", "user-skill", "installed-skill"]),
	);
	expect(extensionPaths).toContain(path.join(ext, "hooks", "pre", "extension.ts"));
	expect(
		extensionPaths.some(candidate =>
			[stale, projectExt, userExt, installed].some(ambientRoot => candidate.startsWith(ambientRoot)),
		),
	).toBe(false);
});

test("invocation scopes isolate concurrent SDK roots and merge ambient roots only when requested", async () => {
	const otherExplicit = path.join(tempDir, "other-explicit-extension");
	const projectExt = path.join(tempDir, "project-extension");
	const installed = path.join(home, ".omp", "plugins", "node_modules", "installed-extension");
	const staleCli = path.join(tempDir, "stale-cli-extension");
	buildExtensionPackage(otherExplicit, "other-explicit-skill");
	buildExtensionPackage(projectExt, "project-skill");
	buildExtensionPackage(installed, "installed-skill");
	buildExtensionPackage(staleCli, "stale-cli-skill");
	writeFile(path.join(project, ".omp", "settings.json"), JSON.stringify({ extensions: [projectExt] }));
	writeFile(
		path.join(home, ".omp", "plugins", "package.json"),
		JSON.stringify({ name: "omp-plugins", dependencies: { "installed-extension": "1.0.0" } }),
	);
	injectOmpExtensionCliRoots([staleCli], home, project);

	const firstEntered = Promise.withResolvers<void>();
	const secondEntered = Promise.withResolvers<void>();
	const [firstRoots, secondRoots] = await Promise.all([
		withOmpExtensionRootScope([ext], "explicit-only", async () => {
			firstEntered.resolve();
			await secondEntered.promise;
			return listOmpExtensionRoots(ctx());
		}),
		withOmpExtensionRootScope([otherExplicit], "explicit-only", async () => {
			secondEntered.resolve();
			await firstEntered.promise;
			return listOmpExtensionRoots(ctx());
		}),
	]);

	expect(firstRoots.map(root => root.path)).toEqual([ext]);
	expect(secondRoots.map(root => root.path)).toEqual([otherExplicit]);

	const mergedRoots = await withOmpExtensionRootScope([ext], "merge", () => listOmpExtensionRoots(ctx()));
	expect(mergedRoots.map(root => root.path)).toEqual(expect.arrayContaining([ext, projectExt, installed]));
	expect(mergedRoots.map(root => root.path)).not.toContain(staleCli);
});

test("concurrent scopes snapshot their own effective extensions (no cross-session leak)", async () => {
	// Reproduces the P1 concurrency hazard: two SDK sessions with different
	// effective `extensions` must each discover only their own roots, even when
	// their capability loads interleave during startup.
	const firstExt = path.join(tempDir, "first-session-extension");
	const secondExt = path.join(tempDir, "second-session-extension");
	buildExtensionPackage(firstExt, "first-session-skill");
	buildExtensionPackage(secondExt, "second-session-skill");

	const firstEntered = Promise.withResolvers<void>();
	const secondEntered = Promise.withResolvers<void>();
	const [firstRoots, secondRoots] = await Promise.all([
		withOmpExtensionRootScope([], "merge", async () => {
			setInvocationConfiguredExtensions([firstExt]);
			firstEntered.resolve();
			await secondEntered.promise;
			return listOmpExtensionRoots(ctx());
		}),
		withOmpExtensionRootScope([], "merge", async () => {
			setInvocationConfiguredExtensions([secondExt]);
			secondEntered.resolve();
			await firstEntered.promise;
			return listOmpExtensionRoots(ctx());
		}),
	]);

	expect(firstRoots.map(root => root.path)).toEqual([firstExt]);
	expect(secondRoots.map(root => root.path)).toEqual([secondExt]);
});

test("explicit-only mode drops the configured lane and installed roots (#9769)", async () => {
	// A disableExtensionDiscovery / `--no-extensions` session must honor only its
	// explicit roots on reload — never the ambient `extensions:` (configured
	// lane) or installed plugins the caller opted out of, even when the struct
	// still carries a nonempty configured array (round-8 leak).
	const explicitExt = path.join(tempDir, "explicit-extension");
	const configuredExt = path.join(tempDir, "configured-extension");
	const installed = path.join(home, ".omp", "plugins", "node_modules", "installed-extension");
	buildExtensionPackage(explicitExt, "explicit-skill");
	buildExtensionPackage(configuredExt, "configured-skill");
	buildExtensionPackage(installed, "installed-skill");
	writeFile(
		path.join(home, ".omp", "plugins", "package.json"),
		JSON.stringify({ name: "omp-plugins", dependencies: { "installed-extension": "1.0.0" } }),
	);

	const mergeRoots = await listOmpExtensionRoots({
		...ctx(),
		extensionRoots: {
			explicit: [explicitExt],
			mode: "merge",
			configured: [configuredExt],
			configuredLevel: "project",
		},
	});
	expect(mergeRoots.map(root => path.basename(root.path))).toEqual(
		expect.arrayContaining(["explicit-extension", "configured-extension", "installed-extension"]),
	);

	const explicitOnlyRoots = await listOmpExtensionRoots({
		...ctx(),
		extensionRoots: {
			explicit: [explicitExt],
			mode: "explicit-only",
			configured: [configuredExt],
			configuredLevel: "project",
		},
	});
	expect(explicitOnlyRoots.map(root => root.path)).toEqual([explicitExt]);
});

test("configured lane takes its level from the authority's configuredLevel, not the disk scan (#9769)", async () => {
	// A project provider Settings can't see on the `.omp` disk scan (e.g.
	// `.claude/settings.json`) still yields a project-level root because the
	// session carries the Settings-resolved provenance in the struct.
	const configuredExt = path.join(tempDir, "provenance-extension");
	buildExtensionPackage(configuredExt, "provenance-skill");
	// Nothing on `.omp` disk configures it — the old deepEquals scan would label it `user`.

	const asProject = await listOmpExtensionRoots({
		...ctx(),
		extensionRoots: { explicit: [], mode: "merge", configured: [configuredExt], configuredLevel: "project" },
	});
	expect(asProject.find(root => root.path === configuredExt)?.level).toBe("project");

	const asUser = await listOmpExtensionRoots({
		...ctx(),
		extensionRoots: { explicit: [], mode: "merge", configured: [configuredExt], configuredLevel: "user" },
	});
	expect(asUser.find(root => root.path === configuredExt)?.level).toBe("user");
});

test("scopeless reload with session roots equals the construction-time scoped load (#9769 invariant)", async () => {
	// The single invariant that retires the per-surface regressions: for any
	// session, listOmpExtensionRoots outside the construction scope with
	// session.effectiveExtensionRoots returns byte-identical roots (paths,
	// levels, order) to the construction-time scoped call — across the whole
	// 2×2 grid of explicit-only × has-configured.
	const explicitExt = path.join(tempDir, "invariant-explicit");
	const configuredExt = path.join(tempDir, "invariant-configured");
	const installed = path.join(home, ".omp", "plugins", "node_modules", "invariant-installed");
	buildExtensionPackage(explicitExt, "invariant-explicit-skill");
	buildExtensionPackage(configuredExt, "invariant-configured-skill");
	buildExtensionPackage(installed, "invariant-installed-skill");
	// Persist the configured lane at project scope so its provenance resolves to `project`.
	writeFile(path.join(project, ".omp", "config.yml"), `extensions:\n  - "${configuredExt}"\n`);
	writeFile(
		path.join(home, ".omp", "plugins", "package.json"),
		JSON.stringify({ name: "omp-plugins", dependencies: { "invariant-installed": "1.0.0" } }),
	);

	for (const mode of ["merge", "explicit-only"] as const) {
		for (const configured of [[configuredExt], []]) {
			for (const configuredLevel of ["user", "project"] as const) {
				const roots = { explicit: [explicitExt], mode, configured, configuredLevel };
				const scoped = await withOmpExtensionRootScope(roots.explicit, roots.mode, () => {
					setInvocationConfiguredExtensions(roots.configured, roots.configuredLevel);
					return listOmpExtensionRoots(ctx());
				});
				const reloaded = await listOmpExtensionRoots({ ...ctx(), extensionRoots: roots });
				expect(reloaded).toEqual(scoped);
			}
		}
	}
});

test("loadCapability extensionRoots surfaces override extensions outside any scope (#9769)", async () => {
	// refreshSkills / slash-command reloads run outside the construction-time
	// invocation scope. The effective roots must arrive via the explicit option
	// so overlay/override extensions survive; omitting it falls back to disk.
	const overrideExt = path.join(tempDir, "runtime-override-extension");
	buildExtensionPackage(overrideExt, "runtime-override-skill");

	const withOption = await loadCapability<{ name: string }>(skillCapability.id, {
		cwd: project,
		extensionRoots: { explicit: [], mode: "merge", configured: [overrideExt], configuredLevel: "user" },
	});
	expect(withOption.items.map(skill => skill.name)).toContain("runtime-override-skill");

	const withoutOption = await loadCapability<{ name: string }>(skillCapability.id, { cwd: project });
	expect(withoutOption.items.map(skill => skill.name)).not.toContain("runtime-override-skill");
});

test("file-extension entrypoints contribute zero sub-surface (the file has no siblings to scan)", async () => {
	const standaloneFile = path.join(tempDir, "standalone.ts");
	fs.writeFileSync(standaloneFile, "export default function (_pi) {}\n");
	writeFile(path.join(project, ".omp", "settings.json"), JSON.stringify({ extensions: [standaloneFile] }));

	const skills = await loadFromPlugin<{ name: string }>(skillCapability.id, ctx());
	expect(skills).toHaveLength(0);
});

test("relative paths in settings resolve against the project cwd", async () => {
	// Move the extension under the project root so a relative path is meaningful.
	const relative = "vendored/my-extension";
	const target = path.join(project, relative);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.cpSync(ext, target, { recursive: true });
	writeFile(path.join(project, ".omp", "settings.json"), JSON.stringify({ extensions: [`./${relative}`] }));

	const skills = await loadFromPlugin<{ name: string }>(skillCapability.id, ctx());
	expect(skills.map(s => s.name)).toContain("my-skill");
});

test(".mcp.json with bare entries (no command/url) records a warning and is skipped", async () => {
	writeFile(
		path.join(ext, ".mcp.json"),
		JSON.stringify({ mcpServers: { broken: {}, ok: { command: "x", args: [] } } }),
	);
	writeFile(path.join(project, ".omp", "settings.json"), JSON.stringify({ extensions: [ext] }));

	const result = await pluginProvider(mcpCapability.id).load(ctx());
	expect(result.items.map(s => (s as { name: string }).name)).toEqual(["ok"]);
	expect((result.warnings ?? []).some(w => w.includes('"broken"'))).toBe(true);
});

test("regression: .mcp.json forwards lazy through plugin discovery", async () => {
	writeFile(
		path.join(ext, ".mcp.json"),
		JSON.stringify({
			mcpServers: {
				deferred: { command: "lazy-server", lazy: true },
				immediate: { command: "eager-server" },
				stringForm: { command: "string-lazy-server", lazy: "true", enabled: "false" },
			},
		}),
	);
	writeFile(path.join(project, ".omp", "settings.json"), JSON.stringify({ extensions: [ext] }));

	const servers = await loadFromPlugin<{ name: string; lazy?: boolean; enabled?: boolean }>(mcpCapability.id, ctx());
	expect(servers.find(s => s.name === "deferred")?.lazy).toBe(true);
	expect(servers.find(s => s.name === "immediate")?.lazy).toBeUndefined();
	expect(servers.find(s => s.name === "stringForm")?.lazy).toBe(true);
	expect(servers.find(s => s.name === "stringForm")?.enabled).toBe(false);
});

test(".mcp.json expands environment placeholders recursively", async () => {
	const variables = {
		OMP_PLUGIN_COMMAND: "expanded-command",
		OMP_PLUGIN_ARG: "expanded-arg",
		OMP_PLUGIN_ENV: "expanded-env",
		OMP_PLUGIN_CWD: path.join(tempDir, "expanded-cwd"),
		OMP_PLUGIN_URL: "https://mcp.example.test",
		OMP_PLUGIN_HEADER: "expanded-header",
		OMP_PLUGIN_CLIENT_ID: "expanded-client-id",
	};
	const placeholder = (name: string) => `\${${name}}`;
	Object.assign(process.env, variables);
	try {
		writeFile(
			path.join(ext, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					stdio: {
						command: placeholder("OMP_PLUGIN_COMMAND"),
						args: [placeholder("OMP_PLUGIN_ARG")],
						env: { TOKEN: placeholder("OMP_PLUGIN_ENV") },
						cwd: placeholder("OMP_PLUGIN_CWD"),
					},
					http: {
						type: "http",
						url: placeholder("OMP_PLUGIN_URL"),
						headers: { Authorization: `Bearer ${placeholder("OMP_PLUGIN_HEADER")}` },
						oauth: { clientId: placeholder("OMP_PLUGIN_CLIENT_ID") },
					},
				},
			}),
		);
		writeFile(path.join(project, ".omp", "settings.json"), JSON.stringify({ extensions: [ext] }));

		const servers = await loadFromPlugin<{
			name: string;
			command?: string;
			args?: string[];
			env?: Record<string, string>;
			cwd?: string;
			url?: string;
			headers?: Record<string, string>;
			oauth?: { clientId?: string };
		}>(mcpCapability.id, ctx());
		const stdio = servers.find(server => server.name === "stdio");
		const http = servers.find(server => server.name === "http");

		expect(stdio).toMatchObject({
			command: variables.OMP_PLUGIN_COMMAND,
			args: [variables.OMP_PLUGIN_ARG],
			env: { TOKEN: variables.OMP_PLUGIN_ENV },
			cwd: variables.OMP_PLUGIN_CWD,
		});
		expect(http).toMatchObject({
			url: variables.OMP_PLUGIN_URL,
			headers: { Authorization: `Bearer ${variables.OMP_PLUGIN_HEADER}` },
			oauth: { clientId: variables.OMP_PLUGIN_CLIENT_ID },
		});
	} finally {
		for (const key of Object.keys(variables)) delete process.env[key];
	}
});

test("relative path-like command and cwd resolve against the plugin config directory", async () => {
	writeFile(
		path.join(ext, ".mcp.json"),
		JSON.stringify({
			mcpServers: {
				local: { command: "./bin/server", args: ["mcp"], cwd: "." },
				bare: { command: "npx", args: ["-y", "@some/mcp"] },
			},
		}),
	);
	writeFile(path.join(project, ".omp", "settings.json"), JSON.stringify({ extensions: [ext] }));

	const servers = await loadFromPlugin<{ name: string; command?: string; cwd?: string }>(mcpCapability.id, ctx());
	const local = servers.find(s => s.name === "local");
	const bare = servers.find(s => s.name === "bare");
	// Path-like command and "." cwd rebase onto the .mcp.json directory (ext),
	// not the session cwd (project). Bare executables are left untouched.
	expect(local?.command).toBe(path.join(ext, "bin", "server"));
	expect(local?.cwd).toBe(ext);
	expect(bare?.command).toBe("npx");
	expect(bare?.cwd).toBeUndefined();
});

test("path-like command stays rooted at the plugin package root even with a subdirectory cwd", async () => {
	// Plugin .mcp.json commands are relative to the plugin package root, not the
	// declared cwd: a plugin may ship its executable at the root yet run from a
	// data subdir. cwd rebases to <ext>/work but command stays <ext>/bin/server.
	writeFile(
		path.join(ext, ".mcp.json"),
		JSON.stringify({
			mcpServers: {
				local: { command: "./bin/server", args: ["mcp"], cwd: "work" },
			},
		}),
	);
	writeFile(path.join(project, ".omp", "settings.json"), JSON.stringify({ extensions: [ext] }));

	const servers = await loadFromPlugin<{ name: string; command?: string; cwd?: string }>(mcpCapability.id, ctx());
	const local = servers.find(s => s.name === "local");
	expect(local?.command).toBe(path.join(ext, "bin", "server"));
	expect(local?.cwd).toBe(path.join(ext, "work"));
});

test("installed plugins under `<plugins>/node_modules/` are surfaced (e.g. via `omp plugin link`/`install`)", async () => {
	// Simulate what `plugin install` / `plugin link` produces: a plugins root
	// with `package.json#dependencies` and a populated `node_modules/<pkg>/`.
	const pluginsDir = path.join(home, ".omp", "plugins");
	const nodeModules = path.join(pluginsDir, "node_modules");
	const installed = path.join(nodeModules, "my-installed-ext");
	fs.mkdirSync(installed, { recursive: true });
	fs.cpSync(ext, installed, { recursive: true });
	writeFile(
		path.join(pluginsDir, "package.json"),
		JSON.stringify({ name: "omp-plugins", dependencies: { "my-installed-ext": "1.0.0" } }),
	);
	// Plugin's own package.json must carry an `omp`/`pi` manifest for the
	// loader to recognise it; the buildExtensionPackage fixture already wrote
	// one with `omp.extensions`, which is sufficient.

	const skills = await loadFromPlugin<{ name: string; path: string }>(skillCapability.id, ctx());
	const found = skills.find(s => s.name === "my-skill" && s.path.includes("my-installed-ext"));
	expect(found).toBeDefined();
});

test("project-scoped installed plugins surface project-level sub-discovery", async () => {
	const pluginsDir = path.join(project, ".omp", "plugins");
	const installed = path.join(pluginsDir, "node_modules", "my-project-ext");
	fs.mkdirSync(installed, { recursive: true });
	fs.cpSync(ext, installed, { recursive: true });
	writeFile(
		path.join(pluginsDir, "omp-plugins.lock.json"),
		JSON.stringify({
			plugins: { "my-project-ext": { version: "1.0.0", enabled: true, enabledFeatures: null } },
			settings: {},
		}),
	);

	const skills = await loadFromPlugin<{ name: string; path: string; level: "user" | "project" }>(
		skillCapability.id,
		ctx(),
	);
	const found = skills.find(s => s.name === "my-skill" && s.path.includes("my-project-ext"));
	expect(found?.level).toBe("project");
});

test("disabled installed plugins do not contribute sub-discovery", async () => {
	const pluginsDir = path.join(home, ".omp", "plugins");
	const installed = path.join(pluginsDir, "node_modules", "my-disabled-ext");
	fs.mkdirSync(installed, { recursive: true });
	fs.cpSync(ext, installed, { recursive: true });
	writeFile(
		path.join(pluginsDir, "package.json"),
		JSON.stringify({ name: "omp-plugins", dependencies: { "my-disabled-ext": "1.0.0" } }),
	);
	writeFile(
		path.join(pluginsDir, "omp-plugins.lock.json"),
		JSON.stringify({ plugins: { "my-disabled-ext": { enabled: false } }, settings: {} }),
	);

	const skills = await loadFromPlugin<{ name: string; path: string }>(skillCapability.id, ctx());
	expect(skills.find(s => s.path.includes("my-disabled-ext"))).toBeUndefined();
});

test("linked plugins (only in lockfile, not in package.json#dependencies) are surfaced", async () => {
	// `omp plugin link ./local-ext` creates a symlink under
	// `<plugins>/node_modules/<pkg>` plus a lockfile entry, but it never
	// touches `<plugins>/package.json#dependencies`. The discovery path must
	// still find the package — otherwise the documented `omp install
	// ./local-extension` workflow leaves the sibling skills/hooks/tools
	// invisible (see PR #1498 review).
	const pluginsDir = path.join(home, ".omp", "plugins");
	const nodeModules = path.join(pluginsDir, "node_modules");
	fs.mkdirSync(nodeModules, { recursive: true });
	const linkTarget = path.join(nodeModules, "my-linked-ext");
	fs.symlinkSync(ext, linkTarget);
	// Intentionally NO `<plugins>/package.json` — matches a fresh `plugin link`
	// against a setup that has never run `plugin install`.
	writeFile(
		path.join(pluginsDir, "omp-plugins.lock.json"),
		JSON.stringify({
			plugins: { "my-linked-ext": { version: "1.0.0", enabled: true, enabledFeatures: null } },
			settings: {},
		}),
	);

	const skills = await loadFromPlugin<{ name: string; path: string }>(skillCapability.id, ctx());
	const tools = await loadFromPlugin<{ name: string; path: string }>(toolCapability.id, ctx());
	expect(skills.find(s => s.name === "my-skill" && s.path.includes("my-linked-ext"))).toBeDefined();
	expect(tools.find(t => t.name === "wcount" && t.path.includes("my-linked-ext"))).toBeDefined();
});
