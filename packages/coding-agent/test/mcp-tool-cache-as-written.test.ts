/**
 * The tool cache keys a server's catalog on its config as the config file
 * wrote it, before the provider expanded `${VAR}` placeholders (or read an
 * env-forwarded value, a `{file:...}` reference, or a plugin root).
 *
 * Contract, for every discovery provider: a rotated credential keeps the
 * cached catalog, and an edited literal drops it. A lazy server has no
 * other way to get its tools: on a miss it starts with none, so nothing can
 * call it and connect it (PR #9793 review, manager.ts:818, credential
 * rotation). Each row runs the real provider through `loadAllMCPConfigs`,
 * the same path startup uses.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { disableUserSource, enableUserSource } from "@oh-my-pi/pi-coding-agent/capability";
import * as discoveryFs from "@oh-my-pi/pi-coding-agent/capability/fs";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import "@oh-my-pi/pi-coding-agent/discovery";
import {
	AGENT_PLUGIN_MANIFEST_SCHEMA,
	AGENT_PLUGIN_MCP_SCHEMA,
} from "@oh-my-pi/pi-coding-agent/discovery/agent-plugin-format";
import { clearClaudePluginRootsCache } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { getConfigRootDir, removeWithRetries, setAgentDir, stableStringifyJson } from "@oh-my-pi/pi-utils";
import { loadAllMCPConfigs } from "../src/mcp/config";
import { MCPToolCache, sameMcpServerIdentity } from "../src/mcp/tool-cache";
import type { MCPServerConfig, MCPToolDefinition } from "../src/mcp/types";
import type { AgentStorage } from "../src/session/agent-storage";
import { restoreEnvValue } from "./helpers/settings-test-state";

const TOKEN_VAR = "OMP_AS_WRITTEN_TOKEN";
/** A variable whose value is a path component the provider roots. */
const PATH_VAR = "OMP_AW_ROOT_PATH";
/** A variable nothing sets, so `${...}` naming it is literal text. */
const UNSET_VAR = "OMP_AW_NEVER_SET_TOKEN";

// Assembled, as the source files do, to keep oxlint's
// no-template-curly-in-string off a literal placeholder name.
const DOLLAR = "$";
/** The Agent Plugins placeholder for a plugin's install directory. */
const PLUGIN_ROOT_VAR = `${DOLLAR}{PLUGIN_ROOT}`;
/** A placeholder with a default, written inside one component of a relative path. */
const TAG_VAR = `${DOLLAR}{OMP_AW_BINARY_UNSET:-server}`;

const TOOL: MCPToolDefinition = {
	name: "lookup",
	description: "A cached tool.",
	inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

const originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

function memoryStorage(): { storage: AgentStorage; store: Map<string, string> } {
	const store = new Map<string, string>();
	const storage = {
		getCache: (key: string) => store.get(key) ?? null,
		setCache: (key: string, value: string, _expiresAtSec: number) => {
			store.set(key, value);
		},
	} as unknown as AgentStorage;
	return { storage, store };
}

interface Dirs {
	root: string;
	home: string;
	project: string;
}

interface Row {
	id: string;
	/** Write the provider's config file with `literal` in an identity field. */
	write(dirs: Dirs, literal: string): Promise<void>;
	/** Change the value the provider reads at load time (an env var, a file, a plugin location). */
	rotate(dirs: Dirs, value: string): Promise<void>;
	/** The loaded value that carries the rotated input, to show the provider really expanded it. */
	expanded(config: MCPServerConfig): unknown;
	/** Providers that read a user-level source need it switched on. */
	userSource?: "claude";
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
	await Bun.write(filePath, JSON.stringify(value));
}

const setToken = async (_dirs: Dirs, value: string) => {
	process.env[TOKEN_VAR] = value;
};

const remoteHeaders = (config: MCPServerConfig) =>
	config.type === "http" || config.type === "sse" ? config.headers : undefined;
const authorization = (config: MCPServerConfig) => remoteHeaders(config)?.Authorization;
const envToken = (config: MCPServerConfig) => (config.type === "stdio" ? config.env?.AW_TOKEN : undefined);

async function writeClaudeRegistry(dirs: Dirs, installPath: string, id: string): Promise<void> {
	await writeJson(path.join(dirs.home, ".claude", "plugins", "installed_plugins.json"), {
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
	});
}

/** One remote OpenCode server, written as raw text so each escape reaches the parser as spelled. */
const opencodeText = (header: string) =>
	`{"mcp":{"aw":{"type":"remote","url":"https://mcp.example.test/aw","headers":{"Authorization":"${header}"}}}}`;

/** A project of its own holding that server, for the pairs that need two. */
async function opencodeProject(dirs: Dirs, slot: string, header: string): Promise<string> {
	const root = path.join(dirs.root, slot);
	await fs.mkdir(path.join(root, ".git"), { recursive: true });
	await Bun.write(path.join(root, "opencode.json"), opencodeText(header));
	return root;
}

/** A project whose OMP extension package declares one stdio server. */
async function ompExtensionProject(dirs: Dirs, slot: string, entry: Record<string, unknown>): Promise<string> {
	const root = path.join(dirs.root, slot);
	const extension = path.join(root, "aw-extension");
	await fs.mkdir(path.join(root, ".git"), { recursive: true });
	await writeJson(path.join(extension, "package.json"), { name: "aw-extension", omp: { extensions: ["./main.ts"] } });
	await Bun.write(path.join(extension, "main.ts"), "export default function (_pi) {}\n");
	await writeJson(path.join(extension, ".mcp.json"), { mcpServers: { aw: entry } });
	await writeJson(path.join(root, ".omp", "settings.json"), { extensions: [extension] });
	return root;
}

/** Where the agent-plugins row keeps its plugin: the registry points at one of two copies. */
const agentPluginPath = (dirs: Dirs, slot: string) => path.join(dirs.root, "plugins", slot, "aw-plugin");

async function writeAgentPlugin(dirs: Dirs, slot: string, literal: string): Promise<void> {
	const pluginPath = agentPluginPath(dirs, slot);
	await writeJson(path.join(pluginPath, "plugin.json"), { $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: "aw-plugin" });
	await Bun.write(path.join(pluginPath, "bin", "aw"), "#!/bin/sh\n");
	await writeJson(path.join(pluginPath, "mcp.json"), {
		$schema: AGENT_PLUGIN_MCP_SCHEMA,
		mcpServers: {
			aw: { type: "stdio", command: "./bin/aw", args: ["--config", "${PLUGIN_ROOT}/aw.json", "--profile", literal] },
		},
	});
}

const ROWS: Row[] = [
	{
		id: "builtin (.omp/mcp.json)",
		write: (dirs, literal) =>
			writeJson(path.join(dirs.project, ".omp", "mcp.json"), {
				mcpServers: {
					aw: { command: "aw-server", args: ["--profile", literal], env: { AW_TOKEN: `\${${TOKEN_VAR}}` } },
				},
			}),
		rotate: setToken,
		expanded: envToken,
	},
	{
		id: "mcp-json (mcp.json)",
		write: (dirs, literal) =>
			writeJson(path.join(dirs.project, "mcp.json"), {
				mcpServers: {
					aw: {
						type: "http",
						url: `https://mcp.example.test/${literal}`,
						headers: { Authorization: `Bearer \${${TOKEN_VAR}}` },
					},
				},
			}),
		rotate: setToken,
		expanded: authorization,
	},
	{
		id: "claude (.claude/mcp.json)",
		write: (dirs, literal) =>
			writeJson(path.join(dirs.project, ".claude", "mcp.json"), {
				mcpServers: {
					aw: { command: "aw-server", args: ["--profile", literal], env: { AW_TOKEN: `\${${TOKEN_VAR}}` } },
				},
			}),
		rotate: setToken,
		expanded: envToken,
	},
	{
		id: "cursor (.cursor/mcp.json)",
		write: (dirs, literal) =>
			writeJson(path.join(dirs.project, ".cursor", "mcp.json"), {
				mcpServers: {
					aw: {
						type: "http",
						url: `https://mcp.example.test/${literal}`,
						headers: { Authorization: `Bearer \${${TOKEN_VAR}}` },
					},
				},
			}),
		rotate: setToken,
		expanded: authorization,
	},
	{
		id: "gemini (.gemini/settings.json)",
		write: (dirs, literal) =>
			writeJson(path.join(dirs.project, ".gemini", "settings.json"), {
				mcpServers: {
					aw: { command: "aw-server", args: ["--profile", literal], env: { AW_TOKEN: `\${${TOKEN_VAR}}` } },
				},
			}),
		rotate: setToken,
		expanded: envToken,
	},
	{
		id: "vscode (.vscode/mcp.json)",
		write: (dirs, literal) =>
			writeJson(path.join(dirs.project, ".vscode", "mcp.json"), {
				mcp: {
					servers: {
						aw: {
							transport: "http",
							url: `https://mcp.example.test/${literal}`,
							headers: { Authorization: `Bearer \${${TOKEN_VAR}}` },
						},
					},
				},
			}),
		rotate: setToken,
		expanded: authorization,
	},
	{
		id: "windsurf (.windsurf/mcp_config.json)",
		write: (dirs, literal) =>
			writeJson(path.join(dirs.project, ".windsurf", "mcp_config.json"), {
				mcpServers: { aw: { command: "aw-server", args: ["--profile", literal, "--token", `\${${TOKEN_VAR}}`] } },
			}),
		rotate: setToken,
		expanded: config => (config.type === "stdio" ? config.args?.[3] : undefined),
	},
	{
		id: "codex (bearer_token_env_var, env_http_headers)",
		write: (dirs, literal) =>
			Bun.write(
				path.join(dirs.project, ".codex", "config.toml"),
				[
					"[mcp_servers.aw]",
					`url = "https://mcp.example.test/${literal}"`,
					`bearer_token_env_var = "${TOKEN_VAR}"`,
					"[mcp_servers.aw.env_http_headers]",
					`X-Api-Key = "${TOKEN_VAR}"`,
					"",
				].join("\n"),
			).then(() => {}),
		rotate: setToken,
		expanded: config => [remoteHeaders(config)?.Authorization, remoteHeaders(config)?.["X-Api-Key"]],
	},
	{
		id: "codex (env_vars)",
		write: (dirs, literal) =>
			Bun.write(
				path.join(dirs.project, ".codex", "config.toml"),
				[
					"[mcp_servers.aw]",
					'command = "aw-server"',
					`args = ["--profile", "${literal}"]`,
					`env_vars = ["${TOKEN_VAR}"]`,
					"",
				].join("\n"),
			).then(() => {}),
		rotate: setToken,
		expanded: config => (config.type === "stdio" ? config.env?.[TOKEN_VAR] : undefined),
	},
	{
		id: "opencode ({env:VAR})",
		write: (dirs, literal) =>
			writeJson(path.join(dirs.project, "opencode.json"), {
				mcp: {
					aw: {
						type: "remote",
						url: `https://mcp.example.test/${literal}`,
						headers: { Authorization: `Bearer {env:${TOKEN_VAR}}` },
					},
				},
			}),
		rotate: setToken,
		expanded: authorization,
	},
	{
		id: "opencode ({file:path})",
		write: (dirs, literal) =>
			writeJson(path.join(dirs.project, "opencode.json"), {
				mcp: {
					aw: {
						type: "remote",
						url: `https://mcp.example.test/${literal}`,
						headers: { Authorization: "Bearer {file:./aw-token.txt}" },
					},
				},
			}),
		rotate: (dirs, value) => Bun.write(path.join(dirs.project, "aw-token.txt"), `${value}\n`).then(() => {}),
		expanded: authorization,
	},
	{
		id: "omp-plugins (extension .mcp.json)",
		write: async (dirs, literal) => {
			const ext = path.join(dirs.root, "aw-extension");
			await writeJson(path.join(ext, "package.json"), { name: "aw-extension", omp: { extensions: ["./main.ts"] } });
			await Bun.write(path.join(ext, "main.ts"), "export default function (_pi) {}\n");
			await writeJson(path.join(ext, ".mcp.json"), {
				mcpServers: {
					aw: { command: "aw-server", args: ["--profile", literal], env: { AW_TOKEN: `\${${TOKEN_VAR}}` } },
				},
			});
			await writeJson(path.join(dirs.project, ".omp", "settings.json"), { extensions: [ext] });
		},
		rotate: setToken,
		expanded: envToken,
	},
	{
		id: "claude-plugins (marketplace .mcp.json)",
		userSource: "claude",
		write: async (dirs, literal) => {
			const pluginPath = path.join(dirs.root, "claude-plugins", "aw-plugin");
			await writeJson(path.join(pluginPath, ".mcp.json"), {
				aw: {
					type: "http",
					url: `https://mcp.example.test/${literal}`,
					headers: { Authorization: `Bearer \${${TOKEN_VAR}}` },
				},
			});
			await writeClaudeRegistry(dirs, pluginPath, "aw-plugin@claude-plugins-official");
		},
		rotate: setToken,
		expanded: authorization,
	},
	{
		id: "agent-plugins (${PLUGIN_ROOT})",
		write: async (dirs, literal) => {
			// Rewrite whichever copy the registry points at; `rotate` moves it.
			const registry = await Bun.file(path.join(dirs.home, ".claude", "plugins", "installed_plugins.json"))
				.json()
				.catch(() => null);
			const current = registry?.plugins?.["aw-plugin@market"]?.[0]?.installPath as string | undefined;
			const slot = current === agentPluginPath(dirs, "b") ? "b" : "a";
			await writeAgentPlugin(dirs, slot, literal);
			await writeClaudeRegistry(dirs, agentPluginPath(dirs, slot), "aw-plugin@market");
		},
		rotate: async (dirs, value) => {
			// The first call keeps slot "a"; later calls move the plugin to slot "b".
			if (value === "token-a") return;
			const from = agentPluginPath(dirs, "a");
			const to = agentPluginPath(dirs, "b");
			await fs.cp(from, to, { recursive: true });
			await writeClaudeRegistry(dirs, to, "aw-plugin@market");
		},
		expanded: config => (config.type === "stdio" ? config.command : undefined),
	},
];

function findServer(configs: Record<string, MCPServerConfig>): [string, MCPServerConfig] {
	const entry = Object.entries(configs).find(([name]) => name === "aw" || name.endsWith(":aw"));
	if (!entry) throw new Error(`server "aw" not discovered; got ${JSON.stringify(Object.keys(configs))}`);
	return entry;
}

describe("the tool cache keys a discovered server on its config as written", () => {
	let dirs: Dirs;
	let originalHome: string | undefined;
	let originalToken: string | undefined;
	let originalPath: string | undefined;
	let originalUnset: string | undefined;
	let originalClaudeConfigDir: string | undefined;

	const reload = async (): Promise<[string, MCPServerConfig]> => {
		clearFsCache();
		clearClaudePluginRootsCache();
		const { configs } = await loadAllMCPConfigs(dirs.project, { filterExa: false });
		return findServer(configs);
	};

	beforeEach(async () => {
		const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-as-written-")));
		dirs = { root, home: path.join(root, "home"), project: path.join(root, "project") };
		await fs.mkdir(path.join(dirs.project, ".git"), { recursive: true });
		await fs.mkdir(dirs.home, { recursive: true });
		originalHome = process.env.HOME;
		originalToken = process.env[TOKEN_VAR];
		originalPath = process.env[PATH_VAR];
		originalUnset = process.env[UNSET_VAR];
		originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
		delete process.env.CLAUDE_CONFIG_DIR;
		process.env.HOME = dirs.home;
		vi.spyOn(os, "homedir").mockReturnValue(dirs.home);
		setAgentDir(path.join(dirs.home, ".omp", "agent"));
	});

	afterEach(async () => {
		disableUserSource("claude");
		vi.restoreAllMocks();
		clearFsCache();
		clearClaudePluginRootsCache();
		if (originalAgentDirEnv) {
			setAgentDir(originalAgentDirEnv);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		restoreEnvValue("HOME", originalHome);
		restoreEnvValue(TOKEN_VAR, originalToken);
		restoreEnvValue(PATH_VAR, originalPath);
		restoreEnvValue(UNSET_VAR, originalUnset);
		restoreEnvValue("CLAUDE_CONFIG_DIR", originalClaudeConfigDir);
		await removeWithRetries(dirs.root);
	});

	for (const row of ROWS) {
		test(`${row.id}: a rotated value keeps the cached catalog, an edited literal drops it`, async () => {
			if (row.userSource) enableUserSource(row.userSource);
			await row.rotate(dirs, "token-a");
			await row.write(dirs, "v1");
			const [name, first] = await reload();
			const cache = new MCPToolCache(memoryStorage().storage);
			await cache.set(name, first, [TOOL]);

			await row.rotate(dirs, "token-b");
			const [, rotated] = await reload();
			// The provider really read the new value: the connect config changed.
			expect(stableStringifyJson(row.expanded(rotated))).not.toBe(stableStringifyJson(row.expanded(first)));
			expect(await cache.get(name, rotated)).toEqual([TOOL]);

			await row.write(dirs, "v2");
			const [, edited] = await reload();
			expect(await cache.get(name, edited)).toBeNull();
		});
	}

	test("a cache written under the expanded-config identity still hits after the upgrade", async () => {
		// Builds before this change hashed the expanded config (policy keys
		// excluded). A lazy server cached by one of them must keep its catalog.
		await setToken(dirs, "token-a");
		await ROWS[1]!.write(dirs, "v1");
		const [name, config] = await reload();
		const identity: Record<string, unknown> = { ...config };
		for (const key of ["lazy", "enabled", "timeout", "requestIdFormat", "instructions"]) delete identity[key];
		const configHash = Bun.SHA256.hash(stableStringifyJson(identity), "hex");
		const { storage, store } = memoryStorage();
		store.set(`mcp_tools:${name}`, JSON.stringify({ version: 1, configHash, tools: [TOOL] }));

		expect(await new MCPToolCache(storage).get(name, config)).toEqual([TOOL]);
	});

	test("an in-memory edit of an identity field falls back to the edited config", async () => {
		// The as-written identity describes the config discovery produced. A
		// copy with a changed command or URL is a different server: it must not
		// borrow the original's identity and its cached catalog.
		await setToken(dirs, "token-a");
		await ROWS[1]!.write(dirs, "v1");
		const [name, config] = await reload();
		const cache = new MCPToolCache(memoryStorage().storage);
		await cache.set(name, config, [TOOL]);

		expect(await cache.get(name, { ...config, enabled: true })).toEqual([TOOL]);
		if (config.type !== "http") throw new Error("expected an http server");
		expect(await cache.get(name, { ...config, url: "https://other.example.test/mcp" })).toBeNull();
	});

	/**
	 * Round 8 (roboomp, `discovery/codex.ts:245`). Codex forwards a value from
	 * the environment only when the variable is set; the as-written form
	 * substituted `${VAR}` either way. With the variable unset, two different
	 * effective configurations — the explicit literal the connection really
	 * uses — therefore hashed to the same key, so editing it left a lazy
	 * server serving the previous configuration's catalog.
	 *
	 * Both directions are asserted per form, because they pull against each
	 * other: a placeholder must stand in wherever a value *was* taken (so a
	 * rotated secret keeps the catalog), and nowhere else (so an edited
	 * literal drops it).
	 */
	const CODEX_FORWARDS = [
		{
			id: "env_vars",
			toml: (literal: string) =>
				[
					"[mcp_servers.aw]",
					'command = "aw-server"',
					`env_vars = ["${TOKEN_VAR}"]`,
					"[mcp_servers.aw.env]",
					`${TOKEN_VAR} = "${literal}"`,
					"",
				].join("\n"),
			effective: (config: MCPServerConfig) => (config.type === "stdio" ? config.env?.[TOKEN_VAR] : undefined),
		},
		{
			id: "env_http_headers",
			toml: (literal: string) =>
				[
					"[mcp_servers.aw]",
					'url = "https://mcp.example.test/aw"',
					"[mcp_servers.aw.http_headers]",
					`X-Api-Key = "${literal}"`,
					"[mcp_servers.aw.env_http_headers]",
					`X-Api-Key = "${TOKEN_VAR}"`,
					"",
				].join("\n"),
			effective: (config: MCPServerConfig) => remoteHeaders(config)?.["X-Api-Key"],
		},
		{
			id: "bearer_token_env_var",
			toml: (literal: string) =>
				[
					"[mcp_servers.aw]",
					'url = "https://mcp.example.test/aw"',
					`bearer_token_env_var = "${TOKEN_VAR}"`,
					"[mcp_servers.aw.http_headers]",
					`Authorization = "Bearer ${literal}"`,
					"",
				].join("\n"),
			effective: authorization,
		},
	];

	for (const form of CODEX_FORWARDS) {
		test(`codex ${form.id}: the key follows the value the connection uses, set or unset`, async () => {
			const codexToml = path.join(dirs.project, ".codex", "config.toml");
			delete process.env[TOKEN_VAR];
			delete Bun.env[TOKEN_VAR];

			// Unset: nothing is forwarded, so the explicit literal is the
			// connection, and editing it is editing the connection.
			await Bun.write(codexToml, form.toml("literal-a"));
			const [name, literalA] = await reload();
			expect(form.effective(literalA)).toContain("literal-a");
			const literalCache = new MCPToolCache(memoryStorage().storage);
			await literalCache.set(name, literalA, [TOOL]);

			await Bun.write(codexToml, form.toml("literal-b"));
			const [, literalB] = await reload();
			expect(form.effective(literalB)).toContain("literal-b");
			expect(await literalCache.get(name, literalB)).toBeNull();

			// Set: the variable overrides the literal, so the literal is not
			// the connection — editing it must change neither, and rotating
			// the variable must keep the catalog (the as-written rule).
			process.env[TOKEN_VAR] = "token-a";
			await Bun.write(codexToml, form.toml("literal-a"));
			const [, forwarded] = await reload();
			expect(form.effective(forwarded)).toContain("token-a");
			const forwardedCache = new MCPToolCache(memoryStorage().storage);
			await forwardedCache.set(name, forwarded, [TOOL]);

			await Bun.write(codexToml, form.toml("literal-c"));
			const [, overridden] = await reload();
			expect(form.effective(overridden)).toBe(form.effective(forwarded));
			expect(await forwardedCache.get(name, overridden)).toEqual([TOOL]);

			process.env[TOKEN_VAR] = "token-b";
			const [, rotated] = await reload();
			expect(form.effective(rotated)).toContain("token-b");
			expect(await forwardedCache.get(name, rotated)).toEqual([TOOL]);
		});
	}

	/**
	 * Round 9 (Anthropic arm, B2). Codex roots a relative `command`/`cwd`
	 * against the directory of the `config.toml` that declared it, so two
	 * projects writing the same entry spawn two different programs in two
	 * different directories. The as-written identity recorded them raw, and
	 * the cache key is the server name alone, so the two shared one entry and
	 * the second project started with the first project's catalogue mounted —
	 * which for a `lazy` server is the whole tool list it serves.
	 */
	test("codex: two projects declaring one server name with a relative command keep separate catalogues", async () => {
		const other = path.join(dirs.root, "other-project");
		await fs.mkdir(path.join(other, ".git"), { recursive: true });
		const toml = ["[mcp_servers.aw]", 'command = "./bin/aw"', 'cwd = "srv"', ""].join("\n");
		await Bun.write(path.join(dirs.project, ".codex", "config.toml"), toml);
		await Bun.write(path.join(other, ".codex", "config.toml"), toml);

		clearFsCache();
		const [name, here] = findServer((await loadAllMCPConfigs(dirs.project, { filterExa: false })).configs);
		clearFsCache();
		const [, there] = findServer((await loadAllMCPConfigs(other, { filterExa: false })).configs);

		// Two different programs, each in its own working directory: whatever
		// the file says, these are not the same server.
		const stdio = (config: MCPServerConfig) =>
			config.type === "stdio" ? { command: config.command, cwd: config.cwd } : undefined;
		expect(stdio(here)?.command).toContain(path.join("project", ".codex", "srv", "bin", "aw"));
		expect(stdio(there)?.command).toContain(path.join("other-project", ".codex", "srv", "bin", "aw"));

		const cache = new MCPToolCache(memoryStorage().storage);
		await cache.set(name, here, [TOOL]);
		expect(await cache.get(name, there)).toBeNull();
		// The project that wrote the entry still hits its own.
		expect(await cache.get(name, here)).toEqual([TOOL]);
	});

	/**
	 * Round 10 (both arms, blocking class). Codex was fixed by rooting its
	 * own record; the shared helper that every other provider uses records
	 * whatever the entry wrote, so `./bin/aw` under two projects' extension
	 * directories is one identity and the cache row is the server name
	 * alone. The second project started with the first project's catalogue
	 * mounted, which for a `lazy` server is its whole tool list.
	 */
	test("omp-plugins: two projects declaring one server name with a relative command keep separate catalogues", async () => {
		const project = async (slot: string): Promise<string> => {
			const root = path.join(dirs.root, slot);
			const ext = path.join(root, "aw-extension");
			await fs.mkdir(path.join(root, ".git"), { recursive: true });
			await writeJson(path.join(ext, "package.json"), { name: "aw-extension", omp: { extensions: ["./main.ts"] } });
			await Bun.write(path.join(ext, "main.ts"), "export default function (_pi) {}\n");
			await writeJson(path.join(ext, ".mcp.json"), {
				mcpServers: { aw: { command: "./bin/aw", cwd: "srv" } },
			});
			await writeJson(path.join(root, ".omp", "settings.json"), { extensions: [ext] });
			return root;
		};
		const projectA = await project("proj-a");
		const projectB = await project("proj-b");

		clearFsCache();
		const [name, here] = findServer((await loadAllMCPConfigs(projectA, { filterExa: false })).configs);
		clearFsCache();
		const [, there] = findServer((await loadAllMCPConfigs(projectB, { filterExa: false })).configs);

		// Two different programs, each in its own working directory.
		const stdio = (config: MCPServerConfig) =>
			config.type === "stdio" ? { command: config.command, cwd: config.cwd } : undefined;
		expect(stdio(here)?.command).toContain(path.join("proj-a", "aw-extension", "bin", "aw"));
		expect(stdio(there)?.command).toContain(path.join("proj-b", "aw-extension", "bin", "aw"));

		const cache = new MCPToolCache(memoryStorage().storage);
		await cache.set(name, here, [TOOL]);
		expect(await cache.get(name, there)).toBeNull();
		// The project that wrote the entry still hits its own.
		expect(await cache.get(name, here)).toEqual([TOOL]);
	});

	/**
	 * Round 10, the other half of the same rule. A plugin that wants its
	 * install directory kept out of its identity says so — Claude plugins
	 * with `${CLAUDE_PLUGIN_ROOT}`, Agent Plugins with `${PLUGIN_ROOT}`
	 * (covered by the `agent-plugins` row above) — and then an upgrade into
	 * a new directory keeps the catalogue. A plugin that writes a bare
	 * relative path has declared nothing, and two installs of it are two
	 * programs.
	 *
	 * All three arms are asserted together because they pull against each
	 * other: making the relative form root-dependent is only right if the
	 * declared form stays root-independent, and a declaration covers only
	 * the fields it is written on — a declared `command` beside a relative
	 * `cwd` still names a directory that moved.
	 */
	test("claude-plugins: a declared plugin root survives a move, a bare relative path does not", async () => {
		enableUserSource("claude");
		const install = async (slot: string, command: string, cwd: string): Promise<MCPServerConfig> => {
			const pluginPath = path.join(dirs.root, "claude-plugins", slot, "aw-plugin");
			await writeJson(path.join(pluginPath, ".mcp.json"), { aw: { type: "stdio", command, cwd } });
			await Bun.write(path.join(pluginPath, "bin", "aw"), "#!/bin/sh\n");
			await writeClaudeRegistry(dirs, pluginPath, "aw-plugin@claude-plugins-official");
			clearFsCache();
			clearClaudePluginRootsCache();
			return findServer((await loadAllMCPConfigs(dirs.project, { filterExa: false })).configs)[1];
		};
		// Concatenated, as the source does, to keep oxlint's
		// no-template-curly-in-string off a literal placeholder name.
		const ROOT = "$" + "{CLAUDE_PLUGIN_ROOT}";

		// Declared on both rooted fields: the install directory is not part
		// of this plugin's identity, so moving it keeps the catalogue.
		const declaredA = await install("a", `${ROOT}/bin/aw`, `${ROOT}/srv`);
		const declaredB = await install("b", `${ROOT}/bin/aw`, `${ROOT}/srv`);
		expect(declaredA.type === "stdio" && declaredA.command).not.toBe(declaredB.type === "stdio" && declaredB.command);
		const declaredCache = new MCPToolCache(memoryStorage().storage);
		await declaredCache.set("aw-plugin:aw", declaredA, [TOOL]);
		expect(await declaredCache.get("aw-plugin:aw", declaredB)).toEqual([TOOL]);

		// Declared nowhere: two installs are two programs in two directories.
		const bareA = await install("a", "./bin/aw", "srv");
		const bareB = await install("b", "./bin/aw", "srv");
		const bareCache = new MCPToolCache(memoryStorage().storage);
		await bareCache.set("aw-plugin:aw", bareA, [TOOL]);
		expect(await bareCache.get("aw-plugin:aw", bareB)).toBeNull();
		expect(await bareCache.get("aw-plugin:aw", bareA)).toEqual([TOOL]);

		// Declared on one of the two: the relative `cwd` still moved.
		const halfA = await install("a", `${ROOT}/bin/aw`, "srv");
		const halfB = await install("b", `${ROOT}/bin/aw`, "srv");
		const halfCache = new MCPToolCache(memoryStorage().storage);
		await halfCache.set("aw-plugin:aw", halfA, [TOOL]);
		expect(await halfCache.get("aw-plugin:aw", halfB)).toBeNull();
	});

	/**
	 * Round 11 (confirm pass, F2). A declaration inside one path *component*
	 * is not a declaration about the path's root. Two extension packages
	 * shipping `./bin/${TAG:-server}/aw` resolve to two different programs
	 * under two different roots, but the whole raw command was recorded, so
	 * both hashed to `./bin/${TAG:-server}/aw` and project B mounted project
	 * A's catalogue — for a `lazy` server, its whole tool list.
	 *
	 * The line the repair draws: a declaration that *begins* the value is the
	 * root (`${PLUGIN_ROOT}/bin/aw`, asserted above and in the `agent-plugins`
	 * row), and anything later leaves the root as written, so the recorded
	 * form keeps the directory the provider resolved it against and keeps the
	 * placeholder where the entry put it.
	 */
	test("omp-plugins: a placeholder inside a relative command keeps each project's root", async () => {
		const project = async (slot: string): Promise<string> => {
			const root = path.join(dirs.root, slot);
			const ext = path.join(root, "aw-extension");
			await fs.mkdir(path.join(root, ".git"), { recursive: true });
			await writeJson(path.join(ext, "package.json"), { name: "aw-extension", omp: { extensions: ["./main.ts"] } });
			await Bun.write(path.join(ext, "main.ts"), "export default function (_pi) {}\n");
			await writeJson(path.join(ext, ".mcp.json"), {
				mcpServers: { aw: { command: `./bin/${TAG_VAR}/aw`, lazy: true } },
			});
			await writeJson(path.join(root, ".omp", "settings.json"), { extensions: [ext] });
			return root;
		};
		const projectA = await project("tag-a");
		const projectB = await project("tag-b");

		clearFsCache();
		const [name, here] = findServer((await loadAllMCPConfigs(projectA, { filterExa: false })).configs);
		clearFsCache();
		const [, there] = findServer((await loadAllMCPConfigs(projectB, { filterExa: false })).configs);

		// The placeholder really expanded, and each root really differs.
		const command = (config: MCPServerConfig) => (config.type === "stdio" ? config.command : undefined);
		expect(command(here)).toContain(path.join("tag-a", "aw-extension", "bin", "server", "aw"));
		expect(command(there)).toContain(path.join("tag-b", "aw-extension", "bin", "server", "aw"));

		const cache = new MCPToolCache(memoryStorage().storage);
		await cache.set(name, here, [TOOL]);
		expect(await cache.get(name, there)).toBeNull();
		expect(await cache.get(name, here)).toEqual([TOOL]);
	});

	/**
	 * Round 11 (confirm pass, F2, the other direction). The substitution
	 * forms are per provider. `{env:...}`, `{file:...}` and the empty `${}`
	 * are literal text to every OMP-owned provider — `expandEnvVarsDeep`
	 * expands a non-empty, colon-free `${NAME}` and nothing else — so a path
	 * beginning with one declares no root of its own and stays rooted where
	 * the provider rooted it. Reading them as declarations handed the second
	 * install the first one's catalogue, the same defect as above with no
	 * placeholder in sight.
	 *
	 * The command is a bare executable here on purpose: `resolvePluginStdioPaths`
	 * leaves `aw-server` alone, so the rooted `cwd` is the only thing telling
	 * the two installs apart and the decision under test is the only thing
	 * deciding.
	 */
	for (const literal of ["{env:AW_TAG}", `${DOLLAR}{}`]) {
		test(`claude-plugins: "${literal}" is literal text here, so two installs stay two servers`, async () => {
			enableUserSource("claude");
			const install = async (slot: string): Promise<MCPServerConfig> => {
				const pluginPath = path.join(dirs.root, "claude-plugins", slot, "aw-plugin");
				await writeJson(path.join(pluginPath, ".mcp.json"), {
					aw: { type: "stdio", command: "aw-server", cwd: `${literal}/srv` },
				});
				await writeClaudeRegistry(dirs, pluginPath, "aw-plugin@claude-plugins-official");
				clearFsCache();
				clearClaudePluginRootsCache();
				return findServer((await loadAllMCPConfigs(dirs.project, { filterExa: false })).configs)[1];
			};

			const slotA = await install("a");
			const slotB = await install("b");
			// Nothing expanded it: the token survives into the resolved path,
			// which the provider rooted at each install directory.
			const cwd = (config: MCPServerConfig) => (config.type === "stdio" ? config.cwd : undefined);
			expect(cwd(slotA)).toContain(path.join("a", "aw-plugin", `${literal}`, "srv"));
			expect(cwd(slotB)).toContain(path.join("b", "aw-plugin", `${literal}`, "srv"));

			const cache = new MCPToolCache(memoryStorage().storage);
			await cache.set("aw-plugin:aw", slotA, [TOOL]);
			expect(await cache.get("aw-plugin:aw", slotB)).toBeNull();
			expect(await cache.get("aw-plugin:aw", slotA)).toEqual([TOOL]);
		});
	}

	/**
	 * Round 11 (confirm pass, F3). OpenCode substitutes its config *text*
	 * before parsing it, so a reference is as real in an object key as in a
	 * value. Reading the parsed value's `Object.values` alone made a header
	 * name built from a rotating variable look like an edited literal, and
	 * the catalogue was dropped on every rotation — which for a `lazy`
	 * server means it starts with no tools at all.
	 */
	test("opencode: a declaration in a header name keeps the catalogue across a rotation", async () => {
		const write = () =>
			writeJson(path.join(dirs.project, "opencode.json"), {
				mcp: {
					aw: {
						type: "remote",
						url: "https://mcp.example.test/aw",
						headers: { [`X-{env:${TOKEN_VAR}}`]: "same-literal" },
					},
				},
			});

		await setToken(dirs, "one");
		await write();
		const [name, first] = await reload();
		await setToken(dirs, "two");
		const [, rotated] = await reload();

		// The provider really substituted the key, and only the key moved.
		expect(Object.keys(remoteHeaders(first) ?? {})).toEqual(["X-one"]);
		expect(Object.keys(remoteHeaders(rotated) ?? {})).toEqual(["X-two"]);

		const cache = new MCPToolCache(memoryStorage().storage);
		await cache.set(name, first, [TOOL]);
		expect(await cache.get(name, rotated)).toEqual([TOOL]);

		// An edited literal still drops it: the key is identity, not noise.
		await writeJson(path.join(dirs.project, "opencode.json"), {
			mcp: {
				aw: {
					type: "remote",
					url: "https://mcp.example.test/aw",
					headers: { [`X-Other-{env:${TOKEN_VAR}}`]: "same-literal" },
				},
			},
		});
		const [, edited] = await reload();
		expect(await cache.get(name, edited)).toBeNull();
	});

	/**
	 * Round 11 (confirm pass, F4). Agent Plugins §7.2.1 puts the install
	 * directory outside a plugin's identity, so `agent-plugin-format` records
	 * `cwd` as the placeholder the spec gives for it rather than the resolved
	 * path: `${PLUGIN_ROOT}` when the entry omits it, `${PLUGIN_ROOT}/x` for
	 * the plugin-relative `./x`, and the entry's own text when it already
	 * names a root. Only the `command` half of that rule was pinned, so
	 * reverting the `cwd` half left every suite green while an upgrade into a
	 * new directory silently dropped the catalogue of every plugin that sets
	 * one — and a `lazy` plugin server then starts with no tools at all.
	 *
	 * All three forms are asserted together because the rule is one rule, and
	 * the move is the test: each is written into two install directories and
	 * has to be one server across them.
	 */
	for (const cwd of [undefined, "./srv", `${PLUGIN_ROOT_VAR}/srv`]) {
		test(`agent-plugins: a plugin whose cwd is ${JSON.stringify(cwd) ?? "unset"} survives a move`, async () => {
			const install = async (slot: string): Promise<MCPServerConfig> => {
				const pluginPath = agentPluginPath(dirs, slot);
				await writeJson(path.join(pluginPath, "plugin.json"), {
					$schema: AGENT_PLUGIN_MANIFEST_SCHEMA,
					name: "aw-plugin",
				});
				await Bun.write(path.join(pluginPath, "bin", "aw"), "#!/bin/sh\n");
				await fs.mkdir(path.join(pluginPath, "srv"), { recursive: true });
				await writeJson(path.join(pluginPath, "mcp.json"), {
					$schema: AGENT_PLUGIN_MCP_SCHEMA,
					mcpServers: { aw: { type: "stdio", command: "./bin/aw", ...(cwd !== undefined && { cwd }) } },
				});
				await writeClaudeRegistry(dirs, pluginPath, "aw-plugin@market");
				clearFsCache();
				clearClaudePluginRootsCache();
				return findServer((await loadAllMCPConfigs(dirs.project, { filterExa: false })).configs)[1];
			};

			const slotA = await install("a");
			const slotB = await install("b");
			// The plugin really moved: both rooted fields followed it.
			const stdio = (config: MCPServerConfig) =>
				config.type === "stdio" ? { command: config.command, cwd: config.cwd } : undefined;
			expect(stdio(slotA)).not.toEqual(stdio(slotB));
			expect(stdio(slotA)?.cwd).toContain(path.join("a", "aw-plugin"));
			expect(stdio(slotB)?.cwd).toContain(path.join("b", "aw-plugin"));

			const cache = new MCPToolCache(memoryStorage().storage);
			await cache.set("aw-plugin:aw", slotA, [TOOL]);
			expect(await cache.get("aw-plugin:aw", slotB)).toEqual([TOOL]);
		});
	}

	/**
	 * Round 12 (OpenAI arm, S1). `identityRecord` normalises the *written*
	 * config too, and a scope list was split on whitespace without regard
	 * for what wrote it, so the words inside one declaration's default
	 * became separate grant tokens. Two projects asking for different
	 * grants then sorted to the same multiset and shared one catalogue.
	 */
	test("oauth: two scope declarations differing inside their defaults are two grants", async () => {
		const SCOPE_SET = "OMP_AW_SCOPE_SET";
		const SCOPE_UNSET = "OMP_AW_SCOPE_UNSET";
		const originalSet = process.env[SCOPE_SET];
		const originalUnset = process.env[SCOPE_UNSET];
		process.env[SCOPE_SET] = "fixed";
		delete process.env[SCOPE_UNSET];
		try {
			const project = async (slot: string, first: string, second: string): Promise<string> => {
				const root = path.join(dirs.root, slot);
				await fs.mkdir(path.join(root, ".git"), { recursive: true });
				await writeJson(path.join(root, ".omp", "mcp.json"), {
					mcpServers: {
						aw: {
							type: "http",
							url: "https://mcp.example.test/aw",
							oauth: {
								scope: `${DOLLAR}{${SCOPE_SET}:-first ${first}} ${DOLLAR}{${SCOPE_UNSET}:-second ${second}}`,
							},
						},
					},
				});
				return root;
			};
			const projectA = await project("scope-a", "read", "write");
			const projectB = await project("scope-b", "write", "read");

			clearFsCache();
			const [name, here] = findServer((await loadAllMCPConfigs(projectA, { filterExa: false })).configs);
			clearFsCache();
			const [, there] = findServer((await loadAllMCPConfigs(projectB, { filterExa: false })).configs);

			// The set variable really won and the unset one really defaulted:
			// the two connections ask the authorization server for different grants.
			expect(here.oauth?.scope).toBe("fixed second write");
			expect(there.oauth?.scope).toBe("fixed second read");

			const cache = new MCPToolCache(memoryStorage().storage);
			await cache.set(name, here, [TOOL]);
			expect(await cache.get(name, there)).toBeNull();
			expect(await cache.get(name, here)).toEqual([TOOL]);
		} finally {
			restoreEnvValue(SCOPE_SET, originalSet);
			restoreEnvValue(SCOPE_UNSET, originalUnset);
		}
	});

	/**
	 * Round 12 (OpenAI arm, S3). `claude-plugins` substitutes only its two
	 * plugin-root placeholders in `command`/`cwd`; every other `${...}` form
	 * is literal text it hands to the OS. Reading those paths with the OMP
	 * grammar called them declarations and left them unrooted, so two
	 * installs recorded one written `cwd` while running in two directories.
	 *
	 * The manifest points the server map at a nested file on purpose: this
	 * provider roots a relative path at the config file's own directory, not
	 * at the plugin directory, and the written form has to follow the same base.
	 */
	for (const declared of [`${DOLLAR}{HOME}`, `${DOLLAR}{OMP_AW_UNSET_TAG:-tag}`]) {
		test(`claude-plugins: "${declared}/srv" is literal text in a path field, so two installs stay two servers`, async () => {
			enableUserSource("claude");
			const install = async (slot: string): Promise<MCPServerConfig> => {
				const pluginPath = path.join(dirs.root, "claude-plugins", slot, "aw-plugin");
				await writeJson(path.join(pluginPath, ".claude-plugin", "plugin.json"), {
					name: "aw-plugin",
					mcpServers: "nested/mcp.json",
				});
				await writeJson(path.join(pluginPath, "nested", "mcp.json"), {
					aw: { type: "stdio", command: "aw-server", cwd: `${declared}/srv` },
				});
				await writeClaudeRegistry(dirs, pluginPath, "aw-plugin@claude-plugins-official");
				clearFsCache();
				clearClaudePluginRootsCache();
				return findServer((await loadAllMCPConfigs(dirs.project, { filterExa: false })).configs)[1];
			};

			const slotA = await install("a");
			const slotB = await install("b");
			// Nothing expanded it: the text survives into the path the provider
			// rooted at each install's own nested config directory.
			const cwd = (config: MCPServerConfig) => (config.type === "stdio" ? config.cwd : undefined);
			expect(cwd(slotA)).toContain(path.join("a", "aw-plugin", "nested", declared, "srv"));
			expect(cwd(slotB)).toContain(path.join("b", "aw-plugin", "nested", declared, "srv"));

			const cache = new MCPToolCache(memoryStorage().storage);
			await cache.set("aw-plugin:aw", slotA, [TOOL]);
			expect(await cache.get("aw-plugin:aw", slotB)).toBeNull();
			expect(await cache.get("aw-plugin:aw", slotA)).toEqual([TOOL]);
		});
	}

	/**
	 * Round 12 (OpenAI arm, S4). OpenCode substitutes its config *text*
	 * before parsing it, so an escaped brace and a real one parse to the
	 * same string while only the second is a reference. Recognising the
	 * reference in the parsed value made the literal one and the same as the
	 * reference, and the project sending the brace verbatim mounted the
	 * other project's catalogue.
	 */
	test("opencode: a header that only spells a reference is not one, so two projects stay two servers", async () => {
		const project = async (slot: string, brace: string): Promise<string> => {
			const root = path.join(dirs.root, slot);
			await fs.mkdir(path.join(root, ".git"), { recursive: true });
			await Bun.write(
				path.join(root, "opencode.json"),
				`{"mcp":{"aw":{"type":"remote","url":"https://mcp.example.test/aw","headers":{"Authorization":"Bearer ${brace}env:${TOKEN_VAR}}"}}}}`,
			);
			return root;
		};
		await setToken(dirs, "token-a");
		const spelledRoot = await project("spelled", "\\u007b");
		const referencedRoot = await project("referenced", "{");

		clearFsCache();
		const [name, spelled] = findServer((await loadAllMCPConfigs(spelledRoot, { filterExa: false })).configs);
		clearFsCache();
		const [, referenced] = findServer((await loadAllMCPConfigs(referencedRoot, { filterExa: false })).configs);

		// One header reaches the transport verbatim, the other carries the token.
		expect(authorization(spelled)).toBe(`Bearer {env:${TOKEN_VAR}}`);
		expect(authorization(referenced)).toBe("Bearer token-a");

		const cache = new MCPToolCache(memoryStorage().storage);
		await cache.set(name, spelled, [TOOL]);
		expect(await cache.get(name, referenced)).toBeNull();
		expect(await cache.get(name, spelled)).toEqual([TOOL]);
	});

	/**
	 * The same question one level down. The as-written record encodes a
	 * substituted span with U+0000, and doubles that character wherever a
	 * value really contains it, so the encoding stays injective: a config
	 * that writes the marker by hand is literal text like any other, not the
	 * reference it spells.
	 */
	test("opencode: a value spelling the as-written marker is still only a literal", async () => {
		const project = async (slot: string, header: string): Promise<string> => {
			const root = path.join(dirs.root, slot);
			await fs.mkdir(path.join(root, ".git"), { recursive: true });
			await Bun.write(
				path.join(root, "opencode.json"),
				`{"mcp":{"aw":{"type":"remote","url":"https://mcp.example.test/aw","headers":{"Authorization":"${header}"}}}}`,
			);
			return root;
		};
		await setToken(dirs, "token-a");
		// A hand-written marker around an escaped-brace reference: nothing
		// here is substituted, so all of it reaches the transport verbatim.
		const spelledRoot = await project("marker", String.raw`Bearer \u0000(\u007benv:${TOKEN_VAR}}\u0000)`);
		const referencedRoot = await project("real-ref", `Bearer {env:${TOKEN_VAR}}`);

		clearFsCache();
		const [name, spelled] = findServer((await loadAllMCPConfigs(spelledRoot, { filterExa: false })).configs);
		clearFsCache();
		const [, referenced] = findServer((await loadAllMCPConfigs(referencedRoot, { filterExa: false })).configs);

		expect(authorization(spelled)).toBe(`Bearer \u0000({env:${TOKEN_VAR}}\u0000)`);
		expect(authorization(referenced)).toBe("Bearer token-a");

		const cache = new MCPToolCache(memoryStorage().storage);
		await cache.set(name, spelled, [TOOL]);
		expect(await cache.get(name, referenced)).toBeNull();
		expect(await cache.get(name, spelled)).toEqual([TOOL]);
	});

	/**
	 * Round 12 (OpenAI arm, S5). A declaration that *begins* a value is not
	 * therefore the value's root: its default may end inside the first path
	 * component, or supply a relative component the provider still roots.
	 * Each row below resolves to a different program or directory per
	 * project, so each is two servers however it is written.
	 */
	const LEADING_DECLARATIONS: Array<{ id: string; entry: Record<string, unknown>; shows: string[] }> = [
		{
			id: "a declaration ending inside the first path component",
			entry: { command: `${DOLLAR}{OMP_AW_UNSET_TAG:-./tag}-server/bin/aw` },
			shows: ["aw-extension", "tag-server", "bin", "aw"],
		},
		{
			id: "a declaration whose default is the whole first component",
			entry: { command: `${DOLLAR}{OMP_AW_UNSET_REL:-./server}/bin/aw` },
			shows: ["aw-extension", "server", "bin", "aw"],
		},
		{
			id: "a declaration beginning a relative cwd beside an absolute command",
			entry: { command: "/usr/bin/aw-server", cwd: `${DOLLAR}{OMP_AW_UNSET_TAG:-tag}-server/srv` },
			shows: ["aw-extension", "tag-server", "srv"],
		},
	];
	for (const row of LEADING_DECLARATIONS) {
		test(`omp-plugins: ${row.id} still roots the path at its own project`, async () => {
			const project = async (slot: string): Promise<string> => {
				const root = path.join(dirs.root, slot);
				const ext = path.join(root, "aw-extension");
				await fs.mkdir(path.join(root, ".git"), { recursive: true });
				await writeJson(path.join(ext, "package.json"), {
					name: "aw-extension",
					omp: { extensions: ["./main.ts"] },
				});
				await Bun.write(path.join(ext, "main.ts"), "export default function (_pi) {}\n");
				await writeJson(path.join(ext, ".mcp.json"), { mcpServers: { aw: { ...row.entry, lazy: true } } });
				await writeJson(path.join(root, ".omp", "settings.json"), { extensions: [ext] });
				return root;
			};
			const projectA = await project("lead-a");
			const projectB = await project("lead-b");

			clearFsCache();
			const [name, here] = findServer((await loadAllMCPConfigs(projectA, { filterExa: false })).configs);
			clearFsCache();
			const [, there] = findServer((await loadAllMCPConfigs(projectB, { filterExa: false })).configs);

			// The default really expanded, and the rooted field really differs.
			const rooted = (config: MCPServerConfig) =>
				config.type === "stdio" ? (row.entry.cwd === undefined ? config.command : config.cwd) : undefined;
			expect(rooted(here)).toContain(path.join("lead-a", ...row.shows));
			expect(rooted(there)).toContain(path.join("lead-b", ...row.shows));

			const cache = new MCPToolCache(memoryStorage().storage);
			await cache.set(name, here, [TOOL]);
			expect(await cache.get(name, there)).toBeNull();
			expect(await cache.get(name, here)).toEqual([TOOL]);
		});
	}

	/**
	 * Round 14 (Anthropic arm, F1). OpenCode's grammar lives in the config
	 * *text*, so that is where it recognises a reference — but it escaped
	 * the record there too, and the text can spell one character several
	 * ways. `\x00` is a NUL the six-character escaper never matched, and
	 * `\u003a` is a colon it could not see, so a value that parses to a real
	 * marker around a real `{env:...}` recorded as that marker, and the
	 * project sending the braces verbatim mounted the other's catalogue.
	 */
	test("opencode: an escape that hides a reference from the text pass still only writes a literal", async () => {
		await setToken(dirs, "token-a");
		const forgedRoot = await opencodeProject(dirs, "forged", String.raw`\x00({env\u003a${TOKEN_VAR}}\x00)`);
		const realRoot = await opencodeProject(dirs, "real", `{env:${TOKEN_VAR}}`);

		clearFsCache();
		const [name, forged] = findServer((await loadAllMCPConfigs(forgedRoot, { filterExa: false })).configs);
		clearFsCache();
		const [, real] = findServer((await loadAllMCPConfigs(realRoot, { filterExa: false })).configs);

		// Neither escape is a reference to OpenCode: the braces go on the wire.
		expect(forged.type === "http" && forged.headers?.Authorization).toBe(`\u0000({env:${TOKEN_VAR}}\u0000)`);
		expect(authorization(real)).toBe("token-a");

		const cache = new MCPToolCache(memoryStorage().storage);
		await cache.set(name, real, [TOOL]);
		expect(await cache.get(name, forged)).toBeNull();
		expect(await cache.get(name, real)).toEqual([TOOL]);
	});

	/**
	 * Round 14 (OpenAI arm, Finding 2). `"\\u0000("` and `"\u005cu0000("`
	 * are two JSON spellings of one six-character value, and a lazy server
	 * must not lose its catalogue to a re-spelling that changes nothing it
	 * sends.
	 */
	test("opencode: two JSON spellings of one value keep the cached catalogue", async () => {
		const config = path.join(dirs.project, "opencode.json");
		await Bun.write(config, opencodeText(String.raw`\\u0000(`));
		clearFsCache();
		const [name, backslash] = findServer((await loadAllMCPConfigs(dirs.project, { filterExa: false })).configs);
		await Bun.write(config, opencodeText(String.raw`\u005cu0000(`));
		clearFsCache();
		const [, escaped] = findServer((await loadAllMCPConfigs(dirs.project, { filterExa: false })).configs);

		expect(authorization(backslash)).toBe(String.raw`\u0000(`);
		expect(authorization(escaped)).toBe(authorization(backslash));

		const cache = new MCPToolCache(memoryStorage().storage);
		await cache.set(name, backslash, [TOOL]);
		expect(await cache.get(name, escaped)).toEqual([TOOL]);
	});

	/**
	 * Round 14 (Anthropic arm, F2; the same cause as the two above, with no
	 * exotic escape). A value whose *text* is `\u0000(lit` contains no NUL,
	 * and the record must not invent one: the pass that doubled the escape
	 * in the source text put a real NUL in front of the `(`, which is the
	 * record of the value one character along — the one that really holds a
	 * NUL there — so the two hashed alike while sending different bytes.
	 */
	test("opencode: a record holds no U+0000 the parsed value did not", async () => {
		const spelledRoot = await opencodeProject(dirs, "spelled", String.raw`\\u0000(lit`);
		const realRoot = await opencodeProject(dirs, "real-nul", String.raw`\u005cu0000\x00(lit`);

		clearFsCache();
		const [name, spelled] = findServer((await loadAllMCPConfigs(spelledRoot, { filterExa: false })).configs);
		clearFsCache();
		const [, withNul] = findServer((await loadAllMCPConfigs(realRoot, { filterExa: false })).configs);

		expect(authorization(spelled)).toBe(String.raw`\u0000(lit`);
		expect(authorization(withNul)).toBe(`${String.raw`\u0000`}\u0000(lit`);

		const cache = new MCPToolCache(memoryStorage().storage);
		await cache.set(name, withNul, [TOOL]);
		expect(await cache.get(name, spelled)).toBeNull();
		expect(await cache.get(name, withNul)).toEqual([TOOL]);
	});

	/**
	 * Round 14 (OpenAI arm, Finding 3). The effective value and the record
	 * are two readings of one config file; reading the file twice let an
	 * edit land between them and keyed the server that was connected on the
	 * definition that replaced it.
	 */
	test("opencode: the config file is read once, so no record comes from a later one", async () => {
		const config = path.join(dirs.project, "opencode.json");
		const entry = (command: string, value: string) =>
			JSON.stringify({ mcp: { aw: { type: "local", command: [command], environment: { K: value } } } });
		await Bun.write(config, entry("server-a", "A"));

		const read = discoveryFs.readFile;
		let reads = 0;
		vi.spyOn(discoveryFs, "readFile").mockImplementation(async (filePath: string) => {
			if (path.resolve(filePath) !== config) return read(filePath);
			reads++;
			return reads === 1 ? entry("server-a", "A") : entry("server-b", "B");
		});
		clearFsCache();
		const [name, torn] = findServer((await loadAllMCPConfigs(dirs.project, { filterExa: false })).configs);
		vi.restoreAllMocks();
		vi.spyOn(os, "homedir").mockReturnValue(dirs.home);

		expect(reads).toBe(1);
		expect(torn.type === "stdio" && torn.command).toBe("server-a");

		await Bun.write(config, entry("server-b", "B"));
		clearFsCache();
		const [, replacement] = findServer((await loadAllMCPConfigs(dirs.project, { filterExa: false })).configs);
		const cache = new MCPToolCache(memoryStorage().storage);
		await cache.set(name, replacement, [TOOL]);
		expect(await cache.get(name, torn)).toBeNull();
	});

	/**
	 * Round 14 (OpenAI arm, Finding 1). A declaration is not a path. The
	 * record is rooted by the base the effective value got, and `..` inside
	 * a default the expansion never used must not walk out of the project
	 * that rooting just named — it does not walk there in the value the
	 * connection uses either.
	 */
	test("omp-plugins: a `..` in an unused default does not leave the project it rooted", async () => {
		process.env[PATH_VAR] = "./local";
		const entry = { command: `${DOLLAR}{${PATH_VAR}:-tag/../../../shared}/bin/aw`, lazy: true };
		const projectA = await ompExtensionProject(dirs, "unused-a", entry);
		const projectB = await ompExtensionProject(dirs, "unused-b", entry);

		clearFsCache();
		const [name, here] = findServer((await loadAllMCPConfigs(projectA, { filterExa: false })).configs);
		clearFsCache();
		const [, there] = findServer((await loadAllMCPConfigs(projectB, { filterExa: false })).configs);

		// The default is unused, so each project runs its own copy.
		expect(here.type === "stdio" && here.command).toBe(
			path.join(dirs.root, "unused-a", "aw-extension", "local", "bin", "aw"),
		);
		expect(there.type === "stdio" && there.command).toBe(
			path.join(dirs.root, "unused-b", "aw-extension", "local", "bin", "aw"),
		);

		const cache = new MCPToolCache(memoryStorage().storage);
		await cache.set(name, here, [TOOL]);
		expect(await cache.get(name, there)).toBeNull();
		expect(await cache.get(name, here)).toEqual([TOOL]);

		// And the declaration is still a declaration: rotating it keeps the catalogue.
		process.env[PATH_VAR] = "./other";
		clearFsCache();
		const [, rotated] = findServer((await loadAllMCPConfigs(projectA, { filterExa: false })).configs);
		expect(rotated.type === "stdio" && rotated.command).toContain(path.join("unused-a", "aw-extension", "other"));
		expect(await cache.get(name, rotated)).toEqual([TOOL]);
	});

	/**
	 * Round 14 (Anthropic arm, M1). The encoding doubles a literal U+0000
	 * so no value can spell a recorded substitution. One provider's
	 * substitution syntax is another's literal text, which is where a
	 * forgery comes from: `${VAR}` is a reference in `.mcp.json` and plain
	 * characters to OpenCode.
	 */
	test("a literal spelling another provider's recorded substitution is still a literal", async () => {
		await setToken(dirs, "token-a");
		const forgedRoot = await opencodeProject(dirs, "forged-marker", `\\u0000(${DOLLAR}{${TOKEN_VAR}}\\u0000)`);
		const referenceRoot = path.join(dirs.root, "reference");
		await fs.mkdir(path.join(referenceRoot, ".git"), { recursive: true });
		await writeJson(path.join(referenceRoot, ".mcp.json"), {
			mcpServers: {
				aw: {
					type: "http",
					url: "https://mcp.example.test/aw",
					headers: { Authorization: `${DOLLAR}{${TOKEN_VAR}}` },
				},
			},
		});

		clearFsCache();
		const [name, forged] = findServer((await loadAllMCPConfigs(forgedRoot, { filterExa: false })).configs);
		clearFsCache();
		const [, reference] = findServer((await loadAllMCPConfigs(referenceRoot, { filterExa: false })).configs);

		expect(authorization(forged)).toBe(`\u0000(${DOLLAR}{${TOKEN_VAR}}\u0000)`);
		expect(authorization(reference)).toBe("token-a");

		const cache = new MCPToolCache(memoryStorage().storage);
		await cache.set(name, reference, [TOOL]);
		expect(await cache.get(name, forged)).toBeNull();
		expect(await cache.get(name, reference)).toEqual([TOOL]);
	});

	/**
	 * Round 14 (Anthropic arm, M6). Codex forwards a variable into a header
	 * it records as a substitution; a header the config writes out as the
	 * same text is a literal, and the two must not hash alike — the first
	 * carries a secret that rotates, the second sends `${VAR}` on the wire.
	 */
	test("codex: a forwarded variable and a header spelling it are two servers", async () => {
		await setToken(dirs, "token-a");
		const codexProject = async (slot: string, lines: string[]): Promise<string> => {
			const root = path.join(dirs.root, slot);
			await fs.mkdir(path.join(root, ".git"), { recursive: true });
			await Bun.write(path.join(root, ".codex", "config.toml"), lines.join("\n"));
			return root;
		};
		const forwardedRoot = await codexProject("forwarded", [
			"[mcp_servers.aw]",
			'url = "https://mcp.example.test/aw"',
			`bearer_token_env_var = "${TOKEN_VAR}"`,
			"",
		]);
		const spelledRoot = await codexProject("spelled-header", [
			"[mcp_servers.aw]",
			'url = "https://mcp.example.test/aw"',
			"[mcp_servers.aw.http_headers]",
			`Authorization = "Bearer ${DOLLAR}{${TOKEN_VAR}}"`,
			"",
		]);

		clearFsCache();
		const [name, forwarded] = findServer((await loadAllMCPConfigs(forwardedRoot, { filterExa: false })).configs);
		clearFsCache();
		const [, spelled] = findServer((await loadAllMCPConfigs(spelledRoot, { filterExa: false })).configs);

		expect(authorization(forwarded)).toBe("Bearer token-a");
		expect(authorization(spelled)).toBe(`Bearer ${DOLLAR}{${TOKEN_VAR}}`);

		const cache = new MCPToolCache(memoryStorage().storage);
		await cache.set(name, forwarded, [TOOL]);
		expect(await cache.get(name, spelled)).toBeNull();
		expect(await cache.get(name, forwarded)).toEqual([TOOL]);
	});

	/**
	 * Round 14 (Anthropic arm, M7). An Agent Plugin's install directory is
	 * outside its identity, which the parse says by recording
	 * `${PLUGIN_ROOT}`/`${PLUGIN_DATA}` as substitutions. A config whose
	 * values are those characters has declared nothing — the plugin format
	 * is the only thing that expands them, and it reserves both names, so
	 * nothing else can resolve one — and names a program that is not the
	 * plugin's. It must not inherit the plugin's catalogue.
	 */
	test(`agent-plugins: a config spelling ${PLUGIN_ROOT_VAR} does not inherit a plugin's catalogue`, async () => {
		enableUserSource("claude");
		await writeAgentPlugin(dirs, "a", "v1");
		await writeClaudeRegistry(dirs, agentPluginPath(dirs, "a"), "aw-plugin@market");
		clearFsCache();
		clearClaudePluginRootsCache();
		const [name, plugin] = findServer((await loadAllMCPConfigs(dirs.project, { filterExa: false })).configs);
		if (plugin.type !== "stdio") throw new Error("expected a stdio server");
		expect(plugin.command).toBe(path.join(agentPluginPath(dirs, "a"), "bin", "aw"));

		const spelled: MCPServerConfig = {
			...plugin,
			command: `${PLUGIN_ROOT_VAR}/bin/aw`,
			args: ["--config", `${PLUGIN_ROOT_VAR}/aw.json`, "--profile", "v1"],
			cwd: PLUGIN_ROOT_VAR,
			env: { PLUGIN_ROOT: PLUGIN_ROOT_VAR, PLUGIN_DATA: `${DOLLAR}{PLUGIN_DATA}` },
		};

		const cache = new MCPToolCache(memoryStorage().storage);
		await cache.set(name, plugin, [TOOL]);
		expect(await cache.get(name, spelled)).toBeNull();
		expect(await cache.get(name, plugin)).toEqual([TOOL]);

		// And the declaration is a declaration: a move keeps the catalogue.
		await fs.cp(agentPluginPath(dirs, "a"), agentPluginPath(dirs, "b"), { recursive: true });
		await writeClaudeRegistry(dirs, agentPluginPath(dirs, "b"), "aw-plugin@market");
		clearFsCache();
		clearClaudePluginRootsCache();
		const [, moved] = findServer((await loadAllMCPConfigs(dirs.project, { filterExa: false })).configs);
		expect(moved.type === "stdio" && moved.command).toBe(path.join(agentPluginPath(dirs, "b"), "bin", "aw"));
		expect(await cache.get(name, moved)).toEqual([TOOL]);
	});

	/**
	 * Round 14 (Anthropic arm, M8). A `${VAR}` with no default and no
	 * variable expands to nothing: the characters reach the server. Exporting
	 * the variable therefore changes what the connection sends, and the
	 * catalogue the literal earned does not carry over to the secret.
	 */
	test(`an unset ${DOLLAR}{VAR} with no default is literal text, so setting it is a new server`, async () => {
		delete process.env[UNSET_VAR];
		delete Bun.env[UNSET_VAR];
		await writeJson(path.join(dirs.project, ".omp", "mcp.json"), {
			mcpServers: {
				aw: {
					type: "http",
					url: "https://mcp.example.test/aw",
					headers: { Authorization: `Bearer ${DOLLAR}{${UNSET_VAR}}` },
				},
			},
		});
		clearFsCache();
		const [name, literal] = findServer((await loadAllMCPConfigs(dirs.project, { filterExa: false })).configs);
		expect(authorization(literal)).toBe(`Bearer ${DOLLAR}{${UNSET_VAR}}`);

		const cache = new MCPToolCache(memoryStorage().storage);
		await cache.set(name, literal, [TOOL]);

		process.env[UNSET_VAR] = "token-a";
		clearFsCache();
		const [, resolved] = findServer((await loadAllMCPConfigs(dirs.project, { filterExa: false })).configs);
		expect(authorization(resolved)).toBe("Bearer token-a");
		expect(await cache.get(name, resolved)).toBeNull();
	});

	/**
	 * Round 14 (OpenAI arm, scope boundary). An effective `oauth.scope` is
	 * plain text: a U+0000 a server really asks for opens nothing. Reading
	 * it as a recorded substitution swallowed the rest of the list, so
	 * reordering one grant's tokens read as a different server — which, for
	 * {@link sameMcpServerIdentity}'s other caller, retires the crash-burst
	 * window a server had already filled.
	 */
	test("oauth: an effective scope carrying U+0000 is still a space-delimited set", async () => {
		const write = (scope: string) =>
			writeJson(path.join(dirs.project, ".omp", "mcp.json"), {
				mcpServers: {
					aw: { type: "http", url: "https://mcp.example.test/aw", oauth: { scope } },
				},
			});
		await write("\u0000(read write admin");
		clearFsCache();
		const [, first] = findServer((await loadAllMCPConfigs(dirs.project, { filterExa: false })).configs);
		expect(first.oauth?.scope).toBe("\u0000(read write admin");
		await write("admin write \u0000(read");
		clearFsCache();
		const [, reordered] = findServer((await loadAllMCPConfigs(dirs.project, { filterExa: false })).configs);
		await write("admin write \u0000(read offline_access");
		clearFsCache();
		const [, widened] = findServer((await loadAllMCPConfigs(dirs.project, { filterExa: false })).configs);

		expect(sameMcpServerIdentity(first, reordered)).toBe(true);
		// A scope the first grant does not ask for is still a different grant.
		expect(sameMcpServerIdentity(first, widened)).toBe(false);
	});
});
