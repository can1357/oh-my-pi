import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/capability";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import {
	AGENT_PLUGIN_MANIFEST_SCHEMA,
	AGENT_PLUGIN_MCP_SCHEMA,
	clearAgentPluginRootCache,
	parseAgentPluginManifest,
	parseAgentPluginMcp,
} from "@oh-my-pi/pi-coding-agent/discovery/agent-plugin-format";
import {
	clearClaudePluginRootsCache,
	injectPluginDirRoots,
	listClaudePluginRoots,
} from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { getPluginsDir, removeWithRetries } from "@oh-my-pi/pi-utils";
import { restoreEnvValue } from "../helpers/settings-test-state";
import "@oh-my-pi/pi-coding-agent/discovery/agent-plugins";
import "@oh-my-pi/pi-coding-agent/discovery/claude-plugins";
import type { MCPServer } from "@oh-my-pi/pi-coding-agent/capability/mcp";
import type { Skill } from "@oh-my-pi/pi-coding-agent/capability/skill";

// Concatenation avoids the noTemplateCurlyInString lint on literal placeholder names.
const PLUGIN_ROOT_VAR = "$" + "{PLUGIN_ROOT}";
const PLUGIN_DATA_VAR = "$" + "{PLUGIN_DATA}";
const HOME_VAR = "$" + "{HOME}";

describe("parseAgentPluginManifest", () => {
	const manifest = (fields: Record<string, unknown>) =>
		JSON.stringify({ $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, ...fields });

	test("accepts a minimal manifest", () => {
		const result = parseAgentPluginManifest(manifest({ name: "minimal-plugin" }));
		expect(result).toEqual({ status: "valid", manifest: { name: "minimal-plugin" }, warnings: [] });
	});

	test("accepts a full manifest with metadata", () => {
		const result = parseAgentPluginManifest(
			manifest({
				name: "acme.tools",
				version: "1.2.0",
				description: "desc",
				author: { name: "A", email: "a@example.com", url: "https://example.com" },
				homepage: "https://docs.example.com",
				repository: "https://github.com/example/plugin",
				license: "MIT",
				keywords: ["k1", "k2"],
				extensions: { "com.example.client": { setting: true } },
			}),
		);
		expect(result.status).toBe("valid");
		if (result.status === "valid") {
			expect(result.manifest.version).toBe("1.2.0");
			expect(result.manifest.extensions?.["com.example.client"]).toEqual({ setting: true });
		}
	});

	test("reports and ignores unknown top-level fields", () => {
		const result = parseAgentPluginManifest(manifest({ name: "a", mcpServers: {} }));
		expect(result.status).toBe("valid");
		if (result.status === "valid") {
			expect(result.warnings).toEqual([`Ignoring unknown plugin.json field "mcpServers"`]);
		}
	});

	test("reports and ignores a non-object extensions field", () => {
		const result = parseAgentPluginManifest(manifest({ name: "a", extensions: "nope" }));
		expect(result.status).toBe("valid");
		if (result.status === "valid") {
			expect(result.warnings).toEqual([`Ignoring non-object "extensions" field`]);
		}
	});

	test("rejects invalid plugin names", () => {
		for (const name of ["My-Plugin", "-start", "has--double", "too.many..dots", "", "a".repeat(65)]) {
			const result = parseAgentPluginManifest(manifest({ name }));
			expect(result.status).toBe("invalid");
		}
		for (const name of ["my-plugin", "acme.tools", "lint3r", "a"]) {
			expect(parseAgentPluginManifest(manifest({ name })).status).toBe("valid");
		}
	});

	test("rejects unsupported Agent Plugins versions", () => {
		const result = parseAgentPluginManifest(
			JSON.stringify({ $schema: "https://agent-plugins.org/schemas/2.0.0/plugin.schema.json", name: "a" }),
		);
		expect(result.status).toBe("invalid");
		if (result.status === "invalid") expect(result.reason).toContain("unsupported Agent Plugins version");
	});

	test("does not claim documents without an Agent Plugins $schema", () => {
		expect(parseAgentPluginManifest(JSON.stringify({ name: "claude-style" })).status).toBe("none");
		expect(
			parseAgentPluginManifest(JSON.stringify({ $schema: "https://json.schemastore.org/x", name: "a" })).status,
		).toBe("none");
		expect(parseAgentPluginManifest("not json").status).toBe("none");
	});

	test("treats other schema violations as fatal", () => {
		expect(parseAgentPluginManifest(manifest({ name: "a", version: 2 })).status).toBe("invalid");
		expect(parseAgentPluginManifest(manifest({ name: "a", keywords: [1] })).status).toBe("invalid");
		expect(parseAgentPluginManifest(manifest({ name: "a", author: { name: "x", extra: "y" } })).status).toBe(
			"invalid",
		);
		expect(parseAgentPluginManifest(manifest({ name: "a", author: "someone" })).status).toBe("invalid");
	});

	test("ignores unimplemented extension namespaces without validating their values", () => {
		// §8.1/§11.1: even a non-object member value (another client's
		// convention) never rejects the plugin in a client that does not
		// implement the namespace.
		const result = parseAgentPluginManifest(manifest({ name: "a", extensions: { "com.example": "flat" } }));
		expect(result.status).toBe("valid");
		if (result.status === "valid") expect(result.warnings).toEqual([]);
	});
});

describe("parseAgentPluginMcp", () => {
	let pluginRoot: string;
	let pluginData: string;

	beforeEach(async () => {
		pluginRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-plugin-mcp-")));
		pluginData = path.join(pluginRoot, "data-dir");
	});

	afterEach(async () => {
		await removeWithRetries(pluginRoot);
	});

	const mcp = (servers: Record<string, unknown>, top: Record<string, unknown> = {}) =>
		JSON.stringify({ $schema: AGENT_PLUGIN_MCP_SCHEMA, mcpServers: servers, ...top });

	test("resolves a stdio server with placeholder expansion and reserved env", async () => {
		const result = await parseAgentPluginMcp(
			mcp({
				validator: {
					type: "stdio",
					command: "./bin/validator",
					args: ["--data", `${PLUGIN_DATA_VAR}/validator`, `${HOME_VAR}/literal`],
					env: { CONFIG: `${PLUGIN_ROOT_VAR}/config.json` },
					cwd: PLUGIN_ROOT_VAR,
				},
			}),
			{ pluginRoot, pluginData },
		);
		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		expect(result.warnings).toEqual([]);
		const [server] = result.servers;
		expect(server.transport).toBe("stdio");
		expect(server.command).toBe(path.join(pluginRoot, "bin", "validator"));
		// ${PLUGIN_DATA} expands; unrecognized placeholder-like text stays literal (§9.2).
		expect(server.args).toEqual(["--data", `${pluginData}/validator`, `${HOME_VAR}/literal`]);
		expect(server.env).toEqual({
			CONFIG: `${pluginRoot}/config.json`,
			PLUGIN_ROOT: pluginRoot,
			PLUGIN_DATA: pluginData,
		});
		expect(server.cwd).toBe(pluginRoot);
	});

	test("defaults cwd to the plugin root and keeps bare commands unresolved", async () => {
		const result = await parseAgentPluginMcp(mcp({ db: { type: "stdio", command: "npx" } }), {
			pluginRoot,
			pluginData,
		});
		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		expect(result.servers[0].command).toBe("npx");
		expect(result.servers[0].cwd).toBe(pluginRoot);
	});

	test("disables MCP for a mismatched or missing $schema", async () => {
		const noSchema = await parseAgentPluginMcp(JSON.stringify({ mcpServers: {} }), { pluginRoot, pluginData });
		expect(noSchema.status).toBe("disabled");
		const wrongVersion = await parseAgentPluginMcp(
			JSON.stringify({ $schema: "https://agent-plugins.org/schemas/2.0.0/mcp.schema.json", mcpServers: {} }),
			{ pluginRoot, pluginData },
		);
		expect(wrongVersion.status).toBe("disabled");
	});

	test("disables MCP for unknown top-level fields or invalid JSON", async () => {
		const extra = await parseAgentPluginMcp(mcp({}, { servers: {} }), { pluginRoot, pluginData });
		expect(extra.status).toBe("disabled");
		const invalid = await parseAgentPluginMcp("not json", { pluginRoot, pluginData });
		expect(invalid.status).toBe("disabled");
	});

	test("skips invalid server entries while keeping valid siblings", async () => {
		const result = await parseAgentPluginMcp(
			mcp({
				"unknown-field": { type: "stdio", command: "ok", timeout: 5 },
				"escaping-command": { type: "stdio", command: "../bin/server" },
				"relative-command": { type: "stdio", command: "bin/server" },
				"reserved-env": { type: "stdio", command: "ok", env: { PLUGIN_ROOT: "/x" } },
				"bad-cwd": { type: "stdio", command: "ok", cwd: "data" },
				"escaping-cwd": { type: "stdio", command: "ok", cwd: "./.." },
				"unknown-type": { type: "websocket", url: "wss://example.com" },
				good: { type: "stdio", command: "ok" },
			}),
			{ pluginRoot, pluginData },
		);
		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		expect(result.servers.map(server => server.name)).toEqual(["good"]);
		expect(result.warnings).toHaveLength(7);
	});

	test("resolves PLUGIN_DATA-rooted cwd within the data directory", async () => {
		const result = await parseAgentPluginMcp(
			mcp({
				ok: { type: "stdio", command: "ok", cwd: `${PLUGIN_DATA_VAR}/work` },
				escape: { type: "stdio", command: "ok", cwd: `${PLUGIN_DATA_VAR}/../outside` },
			}),
			{ pluginRoot, pluginData },
		);
		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		expect(result.servers.map(server => server.name)).toEqual(["ok"]);
		expect(result.servers[0].cwd).toBe(path.join(pluginData, "work"));
	});

	test("enforces remote URL and header requirements", async () => {
		const result = await parseAgentPluginMcp(
			mcp({
				https: { type: "streamable-http", url: "https://deploy.example.com/mcp", headers: { "X-Tenant": "t" } },
				loopback: { type: "streamable-http", url: "http://localhost:8080/mcp" },
				"loopback-ip": { type: "sse", url: "http://127.0.0.1/sse" },
				"plain-http": { type: "streamable-http", url: "http://deploy.example.com/mcp" },
				userinfo: { type: "streamable-http", url: "https://user:pw@example.com/mcp" },
				fragment: { type: "streamable-http", url: "https://example.com/mcp#frag" },
				"dup-headers": {
					type: "streamable-http",
					url: "https://example.com/mcp",
					headers: { "x-a": "1", "X-A": "2" },
				},
			}),
			{ pluginRoot, pluginData },
		);
		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		expect(result.servers.map(server => server.name).sort()).toEqual(["https", "loopback", "loopback-ip"]);
		const https = result.servers.find(server => server.name === "https");
		expect(https?.transport).toBe("http");
		expect(https?.headers).toEqual({ "X-Tenant": "t" });
		expect(result.servers.find(server => server.name === "loopback-ip")?.transport).toBe("sse");
	});
});

describe("agent-plugins discovery", () => {
	let tempDir: string;
	let pluginPath: string;
	let originalClaudeConfigDir: string | undefined;

	const writeRegistry = async (installPath: string, id = "std-plugin@market") => {
		const pluginsDir = path.join(tempDir, ".claude", "plugins");
		await fs.mkdir(pluginsDir, { recursive: true });
		await fs.writeFile(
			path.join(pluginsDir, "installed_plugins.json"),
			JSON.stringify({
				version: 2,
				plugins: {
					[id]: [
						{
							scope: "user",
							installPath,
							version: "1.0.0",
							installedAt: "2026-01-01T00:00:00Z",
							lastUpdated: "2026-01-01T00:00:00Z",
						},
					],
				},
			}),
		);
	};

	const writeManifest = async (fields: Record<string, unknown> = {}) => {
		await fs.writeFile(
			path.join(pluginPath, "plugin.json"),
			JSON.stringify({ $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: "std-plugin", ...fields }),
		);
	};

	const writeSkill = async (dirName: string, frontmatter: string) => {
		const dir = path.join(pluginPath, "skills", dirName);
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(path.join(dir, "SKILL.md"), `---\n${frontmatter}\n---\nBody\n`);
	};

	beforeEach(async () => {
		clearClaudePluginRootsCache();
		clearAgentPluginRootCache();
		clearFsCache();
		originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
		delete process.env.CLAUDE_CONFIG_DIR;
		delete Bun.env.CLAUDE_CONFIG_DIR;
		tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-plugins-test-")));
		pluginPath = path.join(tempDir, "plugins", "std-plugin");
		await fs.mkdir(pluginPath, { recursive: true });
		vi.spyOn(os, "homedir").mockReturnValue(tempDir);
	});

	afterEach(async () => {
		clearClaudePluginRootsCache();
		clearAgentPluginRootCache();
		clearFsCache();
		vi.restoreAllMocks();
		restoreEnvValue("CLAUDE_CONFIG_DIR", originalClaudeConfigDir);
		await removeWithRetries(tempDir);
	});

	test("discovers skills and MCP servers from a standard plugin", async () => {
		await writeManifest();
		await writeSkill("deploy", "name: deploy\ndescription: Deploy things");
		await fs.mkdir(path.join(pluginPath, "bin"), { recursive: true });
		await fs.writeFile(
			path.join(pluginPath, "mcp.json"),
			JSON.stringify({
				$schema: AGENT_PLUGIN_MCP_SCHEMA,
				mcpServers: {
					validator: { type: "stdio", command: "./bin/validator", args: ["--cfg", `${PLUGIN_ROOT_VAR}/cfg.json`] },
					api: { type: "streamable-http", url: "https://deploy.example.com/mcp" },
				},
			}),
		);
		await writeRegistry(pluginPath);

		const skills = await loadCapability<Skill>("skills", { cwd: tempDir });
		const deploy = skills.all.find(skill => skill.name === "deploy");
		expect(deploy).toBeDefined();
		// The standard governs the package: the agent-plugins provider loads the
		// skill and the legacy claude-plugins provider skips the root.
		expect(deploy?._source.provider).toBe("agent-plugins");
		// §4.1: plugin skills carry the resolved plugin root so every skill://
		// resource access enforces realpath containment.
		expect(deploy?.containRoot).toBe(pluginPath);
		expect(skills.all.filter(skill => skill.name === "deploy")).toHaveLength(1);

		const mcps = await loadCapability<MCPServer>("mcps", { cwd: tempDir });
		const validator = mcps.all.find(server => server.name === "std-plugin:validator");
		expect(validator).toBeDefined();
		expect(validator?.transport).toBe("stdio");
		expect(validator?.command).toBe(path.join(pluginPath, "bin", "validator"));
		expect(validator?.args).toEqual(["--cfg", `${pluginPath}/cfg.json`]);
		expect(validator?.env?.PLUGIN_ROOT).toBe(pluginPath);
		const pluginData = validator?.env?.PLUGIN_DATA ?? "";
		// Instance-keyed: readable manifest-name prefix plus identity digest (§9.1).
		expect(pluginData.startsWith(path.join(getPluginsDir(tempDir), "data", "std-plugin-"))).toBe(true);
		expect(validator?.cwd).toBe(pluginPath);
		// §9.1: the data directory exists before any subprocess launch.
		expect((await fs.stat(pluginData)).isDirectory()).toBe(true);

		const api = mcps.all.find(server => server.name === "std-plugin:api");
		expect(api?.transport).toBe("http");
		expect(api?.url).toBe("https://deploy.example.com/mcp");
	});

	test("rejects a fatally invalid manifest without discovering any components", async () => {
		await writeManifest({ name: "Bad--Name" });
		await writeSkill("deploy", "name: deploy\ndescription: Deploy things");
		await writeRegistry(pluginPath, "bad-plugin@market");

		const skills = await loadCapability<Skill>("skills", { cwd: tempDir });
		// Neither the standard loader nor legacy providers may load its skills (§5.2).
		expect(skills.all.find(skill => skill.name === "deploy")).toBeUndefined();
		expect(skills.warnings.some(warning => warning.includes("Rejected plugin"))).toBe(true);
	});

	test("keeps loading skills when mcp.json is invalid", async () => {
		await writeManifest();
		await writeSkill("deploy", "name: deploy\ndescription: Deploy things");
		await fs.writeFile(path.join(pluginPath, "mcp.json"), "not json");
		await writeRegistry(pluginPath);

		const skills = await loadCapability<Skill>("skills", { cwd: tempDir });
		expect(skills.all.find(skill => skill.name === "deploy")).toBeDefined();

		const mcps = await loadCapability<MCPServer>("mcps", { cwd: tempDir });
		expect(mcps.all.filter(server => server.name.startsWith("std-plugin:"))).toEqual([]);
		expect(mcps.warnings.some(warning => warning.includes("MCP disabled"))).toBe(true);
	});

	test("reports unknown manifest fields while loading the plugin", async () => {
		await writeManifest({ commands: "./commands" });
		await writeSkill("deploy", "name: deploy\ndescription: Deploy things");
		await writeRegistry(pluginPath);

		const skills = await loadCapability<Skill>("skills", { cwd: tempDir });
		expect(skills.all.find(skill => skill.name === "deploy")).toBeDefined();
		expect(skills.warnings.some(warning => warning.includes(`unknown plugin.json field "commands"`))).toBe(true);
	});

	test("does not search deeper than immediate children of skills/", async () => {
		await writeManifest();
		await writeSkill("deploy", "name: deploy\ndescription: Deploy things");
		const nested = path.join(pluginPath, "skills", "group", "nested");
		await fs.mkdir(nested, { recursive: true });
		await fs.writeFile(path.join(nested, "SKILL.md"), "---\nname: nested\ndescription: Nested\n---\nBody\n");
		await writeRegistry(pluginPath);

		const skills = await loadCapability<Skill>("skills", { cwd: tempDir });
		expect(skills.all.find(skill => skill.name === "deploy")).toBeDefined();
		expect(skills.all.find(skill => skill.name === "nested")).toBeUndefined();
	});

	test("skips each non-conforming skill independently and keeps the rest", async () => {
		await writeManifest();
		await writeSkill("good", "name: good\ndescription: Good skill");
		await writeSkill("no-description", "name: no-description");
		await writeSkill("no-name", "description: Anonymous skill");
		await writeSkill("dir-mismatch", "name: other-name\ndescription: Name does not match directory");
		await writeSkill("bad-pattern", "name: Bad--Pattern\ndescription: Invalid name characters");
		await writeSkill("long-description", `name: long-description\ndescription: ${"x".repeat(1025)}`);
		await writeSkill("long-compat", `name: long-compat\ndescription: ok\ncompatibility: ${"y".repeat(501)}`);
		await writeSkill("bad-metadata", "name: bad-metadata\ndescription: ok\nmetadata:\n  version: 2");
		// Closed schema per skills-ref: client conventions are unexpected fields.
		await writeSkill("unknown-field", "name: unknown-field\ndescription: ok\nenabled: false");
		await writeRegistry(pluginPath);

		const skills = await loadCapability<Skill>("skills", { cwd: tempDir });
		const fromPlugin = skills.all.filter(skill => skill._source.provider === "agent-plugins");
		// §7.1: every invalid skill is skipped independently; the valid one loads.
		expect(fromPlugin.map(skill => skill.name)).toEqual(["good"]);
		const warned = (needle: string) => skills.warnings.some(warning => warning.includes(needle));
		expect(warned(`missing required "description"`)).toBe(true);
		expect(warned(`missing required "name"`)).toBe(true);
		expect(warned(`does not match directory "dir-mismatch"`)).toBe(true);
		expect(warned(`"name" must be lowercase`)).toBe(true);
		expect(warned(`"description" exceeds 1024 characters`)).toBe(true);
		expect(warned(`"compatibility" exceeds 500 characters`)).toBe(true);
		expect(warned(`"metadata.version" must be a string`)).toBe(true);
		expect(warned(`unexpected frontmatter field "enabled"`)).toBe(true);
	});

	test("rejects an escaping plugin.json symlink without consuming outside content", async () => {
		// A fully valid Agent Plugins manifest OUTSIDE the package: if the client
		// read it through the symlink, classification would succeed and the
		// bundled skill would load. Rejection proves the bytes were never used.
		const outside = path.join(tempDir, "outside");
		await fs.mkdir(outside, { recursive: true });
		await fs.writeFile(
			path.join(outside, "manifest.json"),
			JSON.stringify({ $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: "std-plugin" }),
		);
		await fs.symlink(path.join(outside, "manifest.json"), path.join(pluginPath, "plugin.json"));
		await writeSkill("deploy", "name: deploy\ndescription: Deploy things");
		await writeRegistry(pluginPath);

		const skills = await loadCapability<Skill>("skills", { cwd: tempDir });
		expect(skills.all.find(skill => skill.name === "deploy")).toBeUndefined();
		expect(skills.warnings.some(warning => warning.includes("plugin.json resolves outside"))).toBe(true);
	});

	test("skips an escaping skill symlink without consuming outside content", async () => {
		await writeManifest();
		await writeSkill("good", "name: good\ndescription: Good skill");
		// A valid skill OUTSIDE the package, reachable only through a symlinked
		// skill directory. Loading it would prove outside content was consumed.
		const outside = path.join(tempDir, "outside", "evil");
		await fs.mkdir(outside, { recursive: true });
		await fs.writeFile(path.join(outside, "SKILL.md"), "---\nname: evil\ndescription: Escaped\n---\nBody\n");
		await fs.symlink(outside, path.join(pluginPath, "skills", "evil"));
		await writeRegistry(pluginPath);

		const skills = await loadCapability<Skill>("skills", { cwd: tempDir });
		const fromPlugin = skills.all.filter(skill => skill._source.provider === "agent-plugins");
		expect(fromPlugin.map(skill => skill.name)).toEqual(["good"]);
		expect(skills.warnings.some(warning => warning.includes("SKILL.md resolves outside"))).toBe(true);
	});

	test("disables MCP for an escaping mcp.json symlink without consuming outside content", async () => {
		await writeManifest();
		await writeSkill("deploy", "name: deploy\ndescription: Deploy things");
		// A valid MCP config OUTSIDE the package: any registered server would
		// prove the escaping file was read.
		const outside = path.join(tempDir, "outside");
		await fs.mkdir(outside, { recursive: true });
		await fs.writeFile(
			path.join(outside, "mcp.json"),
			JSON.stringify({
				$schema: AGENT_PLUGIN_MCP_SCHEMA,
				mcpServers: { escaped: { type: "stdio", command: "server" } },
			}),
		);
		await fs.symlink(path.join(outside, "mcp.json"), path.join(pluginPath, "mcp.json"));
		await writeRegistry(pluginPath);

		const mcps = await loadCapability<MCPServer>("mcps", { cwd: tempDir });
		expect(mcps.all.filter(server => server.name.startsWith("std-plugin:"))).toEqual([]);
		expect(mcps.warnings.some(warning => warning.includes("mcp.json resolves outside"))).toBe(true);
		// Skills keep loading — the failure is isolated to the MCP component type.
		const skills = await loadCapability<Skill>("skills", { cwd: tempDir });
		expect(skills.all.find(skill => skill.name === "deploy")).toBeDefined();
	});

	test("treats missing component locations as valid absence", async () => {
		await writeManifest();
		await writeRegistry(pluginPath);

		const skills = await loadCapability<Skill>("skills", { cwd: tempDir });
		const mcps = await loadCapability<MCPServer>("mcps", { cwd: tempDir });
		// §6.2: absent fixed locations are not errors — no agent-plugins warnings.
		expect(skills.warnings.filter(warning => warning.includes("[agent-plugins]"))).toEqual([]);
		expect(mcps.warnings.filter(warning => warning.includes("[agent-plugins]"))).toEqual([]);
		expect(mcps.all.filter(server => server.name.startsWith("std-plugin:"))).toEqual([]);
	});

	test("loads a plugin from a directory via --plugin-dir with the manifest name", async () => {
		const dirPath = path.join(tempDir, "plugins", "some-dir");
		await fs.mkdir(path.join(dirPath, "skills", "greet"), { recursive: true });
		await fs.writeFile(
			path.join(dirPath, "plugin.json"),
			JSON.stringify({ $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: "renamed-plugin" }),
		);
		await fs.writeFile(
			path.join(dirPath, "skills", "greet", "SKILL.md"),
			"---\nname: greet\ndescription: Greet the user\n---\nGreet.\n",
		);

		try {
			await injectPluginDirRoots(tempDir, [dirPath], tempDir);
			// The synthetic root takes its plugin name from the standard manifest,
			// not the directory basename.
			const { roots } = await listClaudePluginRoots(tempDir, tempDir);
			expect(roots.find(root => root.path === dirPath)?.plugin).toBe("renamed-plugin");

			const skills = await loadCapability<Skill>("skills", { cwd: tempDir });
			const greet = skills.all.find(skill => skill.name === "greet");
			expect(greet?._source.provider).toBe("agent-plugins");
		} finally {
			await injectPluginDirRoots(tempDir, []);
		}
	});

	test("falls back to the directory name when --plugin-dir plugin.json escapes the root", async () => {
		// A valid manifest OUTSIDE the plugin dir: consuming it would name the
		// synthetic root "renamed-plugin" instead of the directory basename.
		const outside = path.join(tempDir, "outside");
		await fs.mkdir(outside, { recursive: true });
		await fs.writeFile(
			path.join(outside, "manifest.json"),
			JSON.stringify({ $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: "renamed-plugin" }),
		);
		const dirPath = path.join(tempDir, "plugins", "escape-dir");
		await fs.mkdir(dirPath, { recursive: true });
		await fs.symlink(path.join(outside, "manifest.json"), path.join(dirPath, "plugin.json"));

		try {
			await injectPluginDirRoots(tempDir, [dirPath], tempDir);
			const { roots } = await listClaudePluginRoots(tempDir, tempDir);
			expect(roots.find(root => root.path === dirPath)?.plugin).toBe("escape-dir");
		} finally {
			await injectPluginDirRoots(tempDir, []);
		}
	});

	test("rejects malformed or repaired YAML frontmatter per skill", async () => {
		await writeManifest();
		await writeSkill("good", "name: good\ndescription: Good skill");
		// Strict YAML rejects an unquoted nested-colon scalar; the lenient repair
		// path would quote it and accept the skill.
		await writeSkill("repairable", "name: repairable\ndescription: Use when: extracting text");
		// A leading HTML comment means the file does not start with frontmatter;
		// only the lenient comment-stripping repair would accept it.
		const commented = path.join(pluginPath, "skills", "commented");
		await fs.mkdir(commented, { recursive: true });
		await fs.writeFile(
			path.join(commented, "SKILL.md"),
			"<!-- note -->\n---\nname: commented\ndescription: Hidden by comment\n---\nBody\n",
		);
		await writeRegistry(pluginPath);

		const skills = await loadCapability<Skill>("skills", { cwd: tempDir });
		const fromPlugin = skills.all.filter(skill => skill._source.provider === "agent-plugins");
		expect(fromPlugin.map(skill => skill.name)).toEqual(["good"]);
		expect(skills.warnings.some(warning => warning.includes(`"repairable": malformed YAML frontmatter`))).toBe(true);
		expect(skills.warnings.some(warning => warning.includes(`"commented": missing required "name"`))).toBe(true);
	});

	test("closes skill frontmatter to the six standard fields", async () => {
		await writeManifest();
		// Standard key with a non-string value → non-conforming, skipped.
		await writeSkill("bad-tools", "name: bad-tools\ndescription: ok\nallowed-tools: 5");
		// Nonstandard camelCase alias is an unexpected field → skipped (skills-ref).
		await writeSkill("camel-alias", "name: camel-alias\ndescription: ok\nallowedTools: Read");
		// All six standard fields together → conforming.
		await writeSkill(
			"full",
			[
				"name: full",
				"description: ok",
				"license: MIT",
				"compatibility: Requires git",
				"metadata:",
				"  author: example",
				"allowed-tools: Read Bash(git:*)",
			].join("\n"),
		);
		await writeRegistry(pluginPath);

		const skills = await loadCapability<Skill>("skills", { cwd: tempDir });
		const fromPlugin = skills.all.filter(skill => skill._source.provider === "agent-plugins");
		expect(fromPlugin.map(skill => skill.name)).toEqual(["full"]);
		expect(skills.warnings.some(warning => warning.includes(`"allowed-tools" must be a string`))).toBe(true);
		expect(skills.warnings.some(warning => warning.includes(`unexpected frontmatter field "allowedTools"`))).toBe(
			true,
		);
	});

	test("gives same-name installs distinct, stable persistent data directories", async () => {
		const otherPath = path.join(tempDir, "plugins", "std-plugin-b");
		await fs.mkdir(otherPath, { recursive: true });
		await writeManifest();
		await fs.writeFile(
			path.join(otherPath, "plugin.json"),
			JSON.stringify({ $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: "std-plugin" }),
		);
		const mcpDoc = (server: string) =>
			JSON.stringify({
				$schema: AGENT_PLUGIN_MCP_SCHEMA,
				mcpServers: { [server]: { type: "stdio", command: "server" } },
			});
		await fs.writeFile(path.join(pluginPath, "mcp.json"), mcpDoc("a"));
		await fs.writeFile(path.join(otherPath, "mcp.json"), mcpDoc("b"));
		const pluginsDir = path.join(tempDir, ".claude", "plugins");
		await fs.mkdir(pluginsDir, { recursive: true });
		const entry = (installPath: string) => [
			{
				scope: "user",
				installPath,
				version: "1.0.0",
				installedAt: "2026-01-01T00:00:00Z",
				lastUpdated: "2026-01-01T00:00:00Z",
			},
		];
		await fs.writeFile(
			path.join(pluginsDir, "installed_plugins.json"),
			JSON.stringify({
				version: 2,
				plugins: { "std-plugin@market1": entry(pluginPath), "std-plugin@market2": entry(otherPath) },
			}),
		);

		const dataDirOf = async (server: string) => {
			const mcps = await loadCapability<MCPServer>("mcps", { cwd: tempDir });
			return mcps.all.find(item => item.name === `std-plugin:${server}`)?.env?.PLUGIN_DATA;
		};
		const first = await dataDirOf("a");
		const second = await dataDirOf("b");
		// §9.1: each installed instance gets a dedicated data directory even when
		// manifest names collide across marketplaces.
		expect(first).toBeDefined();
		expect(second).toBeDefined();
		expect(first).not.toBe(second);

		// Stability across reloads: a fresh discovery pass maps each instance to
		// the same directory, so persisted state survives.
		clearClaudePluginRootsCache();
		clearAgentPluginRootCache();
		clearFsCache();
		expect(await dataDirOf("a")).toBe(first as string);
		expect(await dataDirOf("b")).toBe(second as string);
	});
});
