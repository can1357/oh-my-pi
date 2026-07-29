/**
 * Regression tests for #1496.
 *
 * The native `omp` discovery provider only walks `.ompk/` and `~/.ompk/agent/`.
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
import { getCapability } from "@pk-nerdsaver-ai/pi-coding-agent/capability";
import { clearCache } from "@pk-nerdsaver-ai/pi-coding-agent/capability/fs";
import { hookCapability } from "@pk-nerdsaver-ai/pi-coding-agent/capability/hook";
import { mcpCapability } from "@pk-nerdsaver-ai/pi-coding-agent/capability/mcp";
import { promptCapability } from "@pk-nerdsaver-ai/pi-coding-agent/capability/prompt";
import { ruleCapability } from "@pk-nerdsaver-ai/pi-coding-agent/capability/rule";
import { skillCapability } from "@pk-nerdsaver-ai/pi-coding-agent/capability/skill";
import { slashCommandCapability } from "@pk-nerdsaver-ai/pi-coding-agent/capability/slash-command";
import { toolCapability } from "@pk-nerdsaver-ai/pi-coding-agent/capability/tool";
import type { LoadContext, Provider } from "@pk-nerdsaver-ai/pi-coding-agent/capability/types";
// Register all discovery providers as a side effect.
import "@pk-nerdsaver-ai/pi-coding-agent/discovery";
import {
	clearOmpExtensionCliRoots,
	injectOmpExtensionCliRoots,
} from "@pk-nerdsaver-ai/pi-coding-agent/discovery/omp-extension-roots";
import { getConfigRootDir, setAgentDir } from "@pk-nerdsaver-ai/pi-utils";

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

function buildExtensionPackage(packageDir: string): void {
	writeFile(
		path.join(packageDir, "package.json"),
		JSON.stringify({ name: path.basename(packageDir), omp: { extensions: ["./src/main.ts"] } }),
	);
	writeFile(path.join(packageDir, "src", "main.ts"), "export default function (_pi) {}\n");
	writeFile(
		path.join(packageDir, "skills", "my-skill", "SKILL.md"),
		"---\nname: my-skill\ndescription: Hello from extension skill\n---\nbody\n",
	);
	writeFile(path.join(packageDir, "commands", "greet.md"), "---\ndescription: greet user\n---\nHello {{name}}\n");
	writeFile(path.join(packageDir, "rules", "style.md"), "---\ndescription: style rule\n---\nUse tabs.\n");
	writeFile(path.join(packageDir, "prompts", "review.md"), "Review this code.\n");
	writeFile(path.join(packageDir, "hooks", "pre", "bash.sh"), "#!/bin/sh\necho pre\n");
	writeFile(path.join(packageDir, "hooks", "post", "edit.sh"), "#!/bin/sh\necho post\n");
	writeFile(path.join(packageDir, "tools", "wcount.sh"), "#!/bin/sh\nwc -w\n");
	writeFile(path.join(packageDir, "tools", "deep-tool", "index.ts"), "export default { name: 'deep-tool' };\n");
	writeFile(
		path.join(packageDir, ".mcp.json"),
		JSON.stringify({ mcpServers: { lsp: { command: "lsp-server", args: ["--stdio"] } } }),
	);
}

function buildCodexPluginPackage(packageDir: string): void {
	writeFile(
		path.join(packageDir, "package.json"),
		JSON.stringify({ name: path.basename(packageDir), version: "4.12.1" }),
	);
	writeFile(
		path.join(packageDir, ".codex-plugin", "plugin.json"),
		JSON.stringify({ name: "omo", version: "4.12.1", description: "Codex plugin manifest" }),
	);
	writeFile(
		path.join(packageDir, "skills", "start-work", "SKILL.md"),
		"---\nname: start-work\ndescription: OMO start work\n---\nbody\n",
	);
	writeFile(
		path.join(packageDir, ".mcp.json"),
		JSON.stringify({
			mcpServers: {
				codegraph: {
					command: "node",
					args: ["components/codegraph/dist/serve.js"],
					cwd: ".",
				},
			},
		}),
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
	setAgentDir(path.join(home, ".ompk", "agent"));
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
	fs.rmSync(tempDir, { recursive: true, force: true });
});

function ctx(): LoadContext {
	return { cwd: project, home, repoRoot: project };
}

test("project settings.json#extensions surfaces every sub-directory", async () => {
	writeFile(path.join(project, ".ompk", "settings.json"), JSON.stringify({ extensions: [ext] }));

	const [skills, commands, rules, prompts, hooks, tools, mcps] = await Promise.all([
		loadFromPlugin<{ name: string }>(skillCapability.id, ctx()),
		loadFromPlugin<{ name: string }>(slashCommandCapability.id, ctx()),
		loadFromPlugin<{ name: string }>(ruleCapability.id, ctx()),
		loadFromPlugin<{ name: string }>(promptCapability.id, ctx()),
		loadFromPlugin<{ name: string; type: "pre" | "post" }>(hookCapability.id, ctx()),
		loadFromPlugin<{ name: string }>(toolCapability.id, ctx()),
		loadFromPlugin<{ name: string; command?: string }>(mcpCapability.id, ctx()),
	]);

	expect(skills.map(s => s.name)).toContain("my-skill");
	expect(commands.map(c => c.name)).toContain("greet");
	expect(rules.map(r => r.name)).toContain("style");
	expect(prompts.map(p => p.name)).toContain("review");
	expect(hooks.some(h => h.name === "bash.sh" && h.type === "pre")).toBe(true);
	expect(hooks.some(h => h.name === "edit.sh" && h.type === "post")).toBe(true);
	expect(tools.map(t => t.name)).toEqual(expect.arrayContaining(["wcount", "deep-tool"]));
	expect(mcps.find(m => m.name === "lsp")?.command).toBe("lsp-server");
});

test("user settings.json#extensions also feeds sub-discovery", async () => {
	writeFile(path.join(home, ".ompk", "agent", "settings.json"), JSON.stringify({ extensions: [ext] }));

	const skills = await loadFromPlugin<{ name: string }>(skillCapability.id, ctx());
	expect(skills.map(s => s.name)).toContain("my-skill");
});

test("`--extension` CLI injection is wired through the same provider", async () => {
	// Empty settings on disk; rely purely on CLI injection.
	injectOmpExtensionCliRoots([ext], home, project);

	const skills = await loadFromPlugin<{ name: string }>(skillCapability.id, ctx());
	const tools = await loadFromPlugin<{ name: string }>(toolCapability.id, ctx());
	expect(skills.map(s => s.name)).toContain("my-skill");
	expect(tools.map(t => t.name)).toEqual(expect.arrayContaining(["wcount", "deep-tool"]));
});

test("file-extension entrypoints contribute zero sub-surface (the file has no siblings to scan)", async () => {
	const standaloneFile = path.join(tempDir, "standalone.ts");
	fs.writeFileSync(standaloneFile, "export default function (_pi) {}\n");
	writeFile(path.join(project, ".ompk", "settings.json"), JSON.stringify({ extensions: [standaloneFile] }));

	const skills = await loadFromPlugin<{ name: string }>(skillCapability.id, ctx());
	expect(skills).toHaveLength(0);
});

test("relative paths in settings resolve against the project cwd", async () => {
	// Move the extension under the project root so a relative path is meaningful.
	const relative = "vendored/my-extension";
	const target = path.join(project, relative);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.cpSync(ext, target, { recursive: true });
	writeFile(path.join(project, ".ompk", "settings.json"), JSON.stringify({ extensions: [`./${relative}`] }));

	const skills = await loadFromPlugin<{ name: string }>(skillCapability.id, ctx());
	expect(skills.map(s => s.name)).toContain("my-skill");
});

test(".mcp.json with bare entries (no command/url) records a warning and is skipped", async () => {
	writeFile(
		path.join(ext, ".mcp.json"),
		JSON.stringify({ mcpServers: { broken: {}, ok: { command: "x", args: [] } } }),
	);
	writeFile(path.join(project, ".ompk", "settings.json"), JSON.stringify({ extensions: [ext] }));

	const result = await pluginProvider(mcpCapability.id).load(ctx());
	expect(result.items.map(s => (s as { name: string }).name)).toEqual(["ok"]);
	expect((result.warnings ?? []).some(w => w.includes('"broken"'))).toBe(true);
});

test("installed plugins under `<plugins>/node_modules/` are surfaced (e.g. via `omp plugin link`/`install`)", async () => {
	// Simulate what `plugin install` / `plugin link` produces: a plugins root
	// with `package.json#dependencies` and a populated `node_modules/<pkg>/`.
	const pluginsDir = path.join(home, ".ompk", "plugins");
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

test("installed Codex plugin packages with `.codex-plugin/plugin.json` are surfaced", async () => {
	const pluginsDir = path.join(home, ".ompk", "plugins");
	const nodeModules = path.join(pluginsDir, "node_modules");
	const installed = path.join(nodeModules, "@sisyphuslabs", "omo-codex-plugin");
	fs.mkdirSync(installed, { recursive: true });
	buildCodexPluginPackage(installed);
	writeFile(
		path.join(pluginsDir, "package.json"),
		JSON.stringify({ name: "omp-plugins", dependencies: { "@sisyphuslabs/omo-codex-plugin": "4.12.1" } }),
	);

	const [skills, mcps] = await Promise.all([
		loadFromPlugin<{ name: string; path: string }>(skillCapability.id, ctx()),
		loadFromPlugin<{ name: string; cwd?: string; args?: string[] }>(mcpCapability.id, ctx()),
	]);

	expect(skills.find(s => s.name === "start-work" && s.path.includes("omo-codex-plugin"))).toBeDefined();
	const codegraph = mcps.find(mcp => mcp.name === "codegraph");
	expect(codegraph?.cwd).toBe(installed);
	expect(codegraph?.args).toEqual(["components/codegraph/dist/serve.js"]);
});

test("disabled installed plugins do not contribute sub-discovery", async () => {
	const pluginsDir = path.join(home, ".ompk", "plugins");
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
	const pluginsDir = path.join(home, ".ompk", "plugins");
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
