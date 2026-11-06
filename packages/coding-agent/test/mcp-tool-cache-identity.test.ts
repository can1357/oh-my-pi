/**
 * The tool cache keys a server's catalog on its *effective* config — the
 * command, arguments, environment, directory, URL, headers and credentials
 * the connection really uses, after every provider has expanded whatever it
 * expands.
 *
 * Contract, for every discovery provider: two different effective configs
 * are two different cache keys. Rotating a credential therefore drops that
 * server's cached catalogue and it reconnects once on next use, exactly as
 * an eager server does today; editing a literal drops it too. A `lazy`
 * server pays that one reconnect and then re-caches.
 *
 * The rows below run the real provider through `loadAllMCPConfigs`, the
 * same path startup uses.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { disableUserSource, enableUserSource } from "@oh-my-pi/pi-coding-agent/capability";
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

const TOKEN_VAR = "OMP_CACHE_IDENTITY_TOKEN";
/** A variable whose value is a path component the provider roots. */
const PATH_VAR = "OMP_CACHE_IDENTITY_ROOT_PATH";
/** A variable nothing sets, so `${...}` naming it is literal text. */
const UNSET_VAR = "OMP_CACHE_IDENTITY_NEVER_SET";

// Assembled, as the source files do, to keep oxlint's
// no-template-curly-in-string off a literal placeholder name.
const DOLLAR = "$";

/** Policy keys the current scheme excludes from identity; see `tool-cache.ts`. */
const POLICY_KEYS = ["lazy", "enabled", "timeout", "requestIdFormat", "instructions"] as const;

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
const stdioCommand = (config: MCPServerConfig) => (config.type === "stdio" ? config.command : undefined);

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

/** A project of its own holding one remote OpenCode server, written as raw text. */
async function opencodeProject(dirs: Dirs, slot: string, header: string): Promise<string> {
	const root = path.join(dirs.root, slot);
	await fs.mkdir(path.join(root, ".git"), { recursive: true });
	await Bun.write(
		path.join(root, "opencode.json"),
		`{"mcp":{"aw":{"type":"remote","url":"https://mcp.example.test/aw","headers":{"Authorization":"${header}"}}}}`,
	);
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

/** Where the agent-plugins rows keep their plugin: the registry points at one of two copies. */
const agentPluginPath = (dirs: Dirs, slot: string) => path.join(dirs.root, "plugins", slot, "aw-plugin");

async function writeAgentPlugin(dirs: Dirs, slot: string, literal: string): Promise<void> {
	const pluginPath = agentPluginPath(dirs, slot);
	await writeJson(path.join(pluginPath, "plugin.json"), { $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: "aw-plugin" });
	await Bun.write(path.join(pluginPath, "bin", "aw"), "#!/bin/sh\n");
	await writeJson(path.join(pluginPath, "mcp.json"), {
		$schema: AGENT_PLUGIN_MCP_SCHEMA,
		mcpServers: {
			aw: {
				type: "stdio",
				command: "./bin/aw",
				args: ["--config", `${DOLLAR}{PLUGIN_ROOT}/aw.json`, "--profile", literal],
			},
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
		id: "agent-plugins (plugin install directory)",
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
		expanded: stdioCommand,
	},
];

function findServer(configs: Record<string, MCPServerConfig>): [string, MCPServerConfig] {
	const entry = Object.entries(configs).find(([name]) => name === "aw" || name.endsWith(":aw"));
	if (!entry) throw new Error(`server "aw" not discovered; got ${JSON.stringify(Object.keys(configs))}`);
	return entry;
}

/** The digest released builds wrote: the whole effective config, nothing stripped. */
function releasedDigest(config: MCPServerConfig): string {
	return Bun.SHA256.hash(stableStringifyJson({ ...config }), "hex");
}

/** The digest of the tier just before `identityRecord` normalised anything. */
function strippedDigest(config: MCPServerConfig): string {
	const identity: Record<string, unknown> = { ...config };
	for (const key of POLICY_KEYS) delete identity[key];
	return Bun.SHA256.hash(stableStringifyJson(identity), "hex");
}

describe("the tool cache keys a discovered server on its effective config", () => {
	let dirs: Dirs;
	let originalHome: string | undefined;
	let originalToken: string | undefined;
	let originalPath: string | undefined;
	let originalUnset: string | undefined;
	let originalClaudeConfigDir: string | undefined;

	const load = async (projectDir: string): Promise<[string, MCPServerConfig]> => {
		clearFsCache();
		clearClaudePluginRootsCache();
		const { configs } = await loadAllMCPConfigs(projectDir, { filterExa: false });
		return findServer(configs);
	};
	const reload = () => load(dirs.project);

	beforeEach(async () => {
		const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-cache-identity-")));
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

	/**
	 * The contract, per provider. Whatever a provider resolves at load time —
	 * an env var, a `{file:...}` reference, a plugin's install directory — is
	 * part of the connection, so changing it is a different server and the
	 * cached catalogue does not carry over. The server reconnects once and
	 * re-caches; nothing else changes.
	 */
	for (const row of ROWS) {
		test(`${row.id}: a rotated value and an edited literal each drop the cached catalog`, async () => {
			if (row.userSource) enableUserSource(row.userSource);
			await row.rotate(dirs, "token-a");
			await row.write(dirs, "v1");
			const [name, first] = await reload();
			const cache = new MCPToolCache(memoryStorage().storage);
			await cache.set(name, first, [TOOL]);
			expect(await cache.get(name, first)).toEqual([TOOL]);

			await row.rotate(dirs, "token-b");
			const [, rotated] = await reload();
			// The provider really read the new value: the connect config changed.
			expect(stableStringifyJson(row.expanded(rotated))).not.toBe(stableStringifyJson(row.expanded(first)));
			expect(await cache.get(name, rotated)).toBeNull();

			// One reconnect, and the rotated server has its catalogue again.
			await cache.set(name, rotated, [TOOL]);
			expect(await cache.get(name, rotated)).toEqual([TOOL]);

			await row.write(dirs, "v2");
			const [, edited] = await reload();
			expect(await cache.get(name, edited)).toBeNull();
		});
	}

	/**
	 * A policy edit is not a different server. Flipping `lazy` on an
	 * already-cached server must still hit, or the transition orphans the
	 * cache and a lazy server starts tool-less.
	 */
	test("a policy edit keeps the catalog, an edit to a connection field drops it", async () => {
		await setToken(dirs, "token-a");
		await ROWS[1]!.write(dirs, "v1");
		const [name, config] = await reload();
		const cache = new MCPToolCache(memoryStorage().storage);
		await cache.set(name, config, [TOOL]);

		expect(await cache.get(name, { ...config, lazy: true, enabled: true })).toEqual([TOOL]);
		if (config.type !== "http") throw new Error("expected an http server");
		expect(await cache.get(name, { ...config, url: "https://other.example.test/mcp" })).toBeNull();
	});

	/**
	 * Released builds hashed the whole effective config; the tier just
	 * before this one hashed it with the policy keys stripped. Both are
	 * still enumerated on a miss (`hashLegacyConfigs`), so no upgrade
	 * orphans an entry — which matters most for a `lazy` server, whose only
	 * source of tools at startup is this cache.
	 *
	 * Five provider kinds, three of them with a `command`/`cwd` the provider
	 * roots at the config file's directory. The wrong-digest arm keeps the
	 * probe honest.
	 */
	const RELEASED_KINDS: Array<{ id: string; setup(dirs: Dirs): Promise<string>; rooted: boolean }> = [
		{
			id: "plain .mcp.json, http, lazy",
			rooted: false,
			async setup(dirs) {
				await writeJson(path.join(dirs.project, ".mcp.json"), {
					mcpServers: {
						aw: { type: "http", url: "https://mcp.example.test/aw", lazy: true, headers: { "X-Api": "k" } },
					},
				});
				return dirs.project;
			},
		},
		{
			id: "opencode remote with an {env:...} header",
			rooted: false,
			async setup(dirs) {
				process.env[TOKEN_VAR] = "token-a";
				await writeJson(path.join(dirs.project, "opencode.json"), {
					mcp: {
						aw: {
							type: "remote",
							url: "https://mcp.example.test/aw",
							headers: { Authorization: `Bearer {env:${TOKEN_VAR}}` },
						},
					},
				});
				return dirs.project;
			},
		},
		{
			id: "codex config.toml with a rooted command and cwd",
			rooted: true,
			async setup(dirs) {
				process.env[TOKEN_VAR] = "token-a";
				await Bun.write(
					path.join(dirs.project, ".codex", "config.toml"),
					["[mcp_servers.aw]", 'command = "./bin/aw"', 'cwd = "srv"', `env_vars = ["${TOKEN_VAR}"]`, ""].join(
						"\n",
					),
				);
				return dirs.project;
			},
		},
		{
			id: "omp extension .mcp.json with a rooted command and cwd",
			rooted: true,
			setup: dirs => ompExtensionProject(dirs, "released-omp", { command: "./bin/aw", cwd: "./srv", lazy: true }),
		},
		{
			id: "agent plugin via the Claude marketplace registry",
			rooted: true,
			async setup(dirs) {
				enableUserSource("claude");
				await writeAgentPlugin(dirs, "a", "v1");
				await writeClaudeRegistry(dirs, agentPluginPath(dirs, "a"), "aw-plugin@market");
				return dirs.project;
			},
		},
	];
	for (const kind of RELEASED_KINDS) {
		test(`${kind.id}: a catalog cached by a retired scheme still hits`, async () => {
			const projectDir = await kind.setup(dirs);
			const [name, config] = await load(projectDir);
			if (kind.rooted) {
				// The rooted value really is an absolute path under this project.
				expect(stdioCommand(config)).toContain(path.sep);
				expect(path.isAbsolute(stdioCommand(config) ?? "")).toBe(true);
			}

			for (const digest of [releasedDigest(config), strippedDigest(config)]) {
				const { storage, store } = memoryStorage();
				store.set(`mcp_tools:${name}`, JSON.stringify({ version: 1, configHash: digest, tools: [TOOL] }));
				expect(await new MCPToolCache(storage).get(name, config)).toEqual([TOOL]);
			}

			// Non-vacuous: a released digest of a *different* config misses.
			const { storage, store } = memoryStorage();
			const other = releasedDigest({ ...config, url: "https://other.example.test/mcp" } as MCPServerConfig);
			store.set(`mcp_tools:${name}`, JSON.stringify({ version: 1, configHash: other, tools: [TOOL] }));
			expect(await new MCPToolCache(storage).get(name, config)).toBeNull();

			// And the current scheme round-trips.
			const cache = new MCPToolCache(memoryStorage().storage);
			await cache.set(name, config, [TOOL]);
			expect(await cache.get(name, config)).toEqual([TOOL]);
		});
	}

	// =========================================================================
	// The cross-project collision class, closed by construction.
	//
	// Every one of these was a real defect while the cache keyed on the config
	// *as written*: a value in one project spelled another project's recorded
	// substitution, or a rooted path lost the directory that rooted it, and —
	// since a cache row is the server name alone — one project served the
	// other project's tool catalogue. On the effective config they cannot
	// collide: two different connections are two different records.
	// =========================================================================

	/**
	 * Door 1: a codex `url` forged out of the marker characters a recorded
	 * substitution used. `Bun.TOML.parse` accepts `\u0000`, so this needed no
	 * exotic escape — and codex built its record by hand, leaving `url`,
	 * `command`, `cwd` and `args` in it as raw effective text.
	 */
	test("codex: a url spelling another project's substitution is a different server", async () => {
		await setToken(dirs, "token-a");
		const forgedRoot = path.join(dirs.root, "codex-forged");
		await fs.mkdir(path.join(forgedRoot, ".git"), { recursive: true });
		await Bun.write(
			path.join(forgedRoot, ".codex", "config.toml"),
			[
				"[mcp_servers.aw]",
				`url = "https://mcp.example.test/\\u0000(${DOLLAR}{${TOKEN_VAR}}\\u0000)"`,
				`bearer_token_env_var = "${TOKEN_VAR}"`,
				"",
			].join("\n"),
		);
		const referenceRoot = path.join(dirs.root, "codex-reference");
		await fs.mkdir(path.join(referenceRoot, ".git"), { recursive: true });
		await writeJson(path.join(referenceRoot, ".mcp.json"), {
			mcpServers: {
				aw: {
					type: "http",
					url: `https://mcp.example.test/${DOLLAR}{${TOKEN_VAR}}`,
					headers: { Authorization: `Bearer ${DOLLAR}{${TOKEN_VAR}}` },
				},
			},
		});

		const [name, forged] = await load(forgedRoot);
		const [, reference] = await load(referenceRoot);

		// Two different URLs really reach the wire.
		expect(forged.type === "http" && forged.url).toBe(
			`https://mcp.example.test/\u0000(${DOLLAR}{${TOKEN_VAR}}\u0000)`,
		);
		expect(reference.type === "http" && reference.url).toBe("https://mcp.example.test/token-a");

		const cache = new MCPToolCache(memoryStorage().storage);
		await cache.set(name, reference, [TOOL]);
		expect(await cache.get(name, forged)).toBeNull();
		expect(await cache.get(name, reference)).toEqual([TOOL]);
	});

	/**
	 * Door 2: an OpenCode header whose escaped brace hides a reference from
	 * the text pass. OpenCode substitutes config *text* before parsing it, so
	 * `\u007benv:VAR}` is not a reference and reaches the transport verbatim
	 * while `{env:VAR}` carries the secret. The two parse to strings that
	 * differ, so they are two keys.
	 */
	test("opencode: an escaped brace is literal text on the wire and a different server", async () => {
		await setToken(dirs, "token-a");
		const spelledRoot = await opencodeProject(dirs, "oc-spelled", `Bearer \\u007benv:${TOKEN_VAR}}`);
		const referencedRoot = await opencodeProject(dirs, "oc-referenced", `Bearer {env:${TOKEN_VAR}}`);

		const [name, spelled] = await load(spelledRoot);
		const [, referenced] = await load(referencedRoot);

		expect(authorization(spelled)).toBe(`Bearer {env:${TOKEN_VAR}}`);
		expect(authorization(referenced)).toBe("Bearer token-a");

		const cache = new MCPToolCache(memoryStorage().storage);
		await cache.set(name, spelled, [TOOL]);
		expect(await cache.get(name, referenced)).toBeNull();
		expect(await cache.get(name, spelled)).toEqual([TOOL]);
	});

	/**
	 * Door 3: one relative `command`/`cwd` written into two projects. The
	 * provider roots each at its own extension directory, so these are two
	 * programs in two directories — ordinary config text, no special
	 * characters anywhere.
	 */
	test("omp-plugins: one relative command under two project roots is two servers", async () => {
		const entry = { command: "./bin/aw", cwd: "srv", lazy: true };
		const projectA = await ompExtensionProject(dirs, "rel-a", entry);
		const projectB = await ompExtensionProject(dirs, "rel-b", entry);

		const [name, here] = await load(projectA);
		const [, there] = await load(projectB);

		expect(stdioCommand(here)).toBe(path.join(dirs.root, "rel-a", "aw-extension", "bin", "aw"));
		expect(stdioCommand(there)).toBe(path.join(dirs.root, "rel-b", "aw-extension", "bin", "aw"));

		const cache = new MCPToolCache(memoryStorage().storage);
		await cache.set(name, here, [TOOL]);
		expect(await cache.get(name, there)).toBeNull();
		expect(await cache.get(name, here)).toEqual([TOOL]);
	});

	/**
	 * Door 4: a `..` inside a placeholder's *unused* default. Normalising the
	 * written path walked those components out of the directory rooting had
	 * just established; the effective value never walks there, so the two
	 * projects stay apart.
	 */
	test("omp-plugins: a `..` in an unused default does not leave the project it rooted", async () => {
		process.env[PATH_VAR] = "./local";
		const entry = { command: `${DOLLAR}{${PATH_VAR}:-tag/../../../shared}/bin/aw`, lazy: true };
		const projectA = await ompExtensionProject(dirs, "unused-a", entry);
		const projectB = await ompExtensionProject(dirs, "unused-b", entry);

		const [name, here] = await load(projectA);
		const [, there] = await load(projectB);

		// The default is unused, so each project runs its own copy.
		expect(stdioCommand(here)).toBe(path.join(dirs.root, "unused-a", "aw-extension", "local", "bin", "aw"));
		expect(stdioCommand(there)).toBe(path.join(dirs.root, "unused-b", "aw-extension", "local", "bin", "aw"));

		const cache = new MCPToolCache(memoryStorage().storage);
		await cache.set(name, here, [TOOL]);
		expect(await cache.get(name, there)).toBeNull();
		expect(await cache.get(name, here)).toEqual([TOOL]);
	});

	/**
	 * A `${VAR}` with no default and no variable expands to nothing: the
	 * characters reach the server. Exporting the variable changes what the
	 * connection sends, so it is a different server.
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
		const [name, literal] = await reload();
		expect(authorization(literal)).toBe(`Bearer ${DOLLAR}{${UNSET_VAR}}`);

		const cache = new MCPToolCache(memoryStorage().storage);
		await cache.set(name, literal, [TOOL]);

		process.env[UNSET_VAR] = "token-a";
		const [, resolved] = await reload();
		expect(authorization(resolved)).toBe("Bearer token-a");
		expect(await cache.get(name, resolved)).toBeNull();
	});

	/**
	 * `oauth.scope` is a space-delimited *set* (RFC 6749 §3.3), so the order
	 * of its values carries no information and two spellings of one grant
	 * must hash alike — including when a scope token contains a U+0000, which
	 * opens nothing here. A grant that asks for more is still a different
	 * server. {@link sameMcpServerIdentity}'s other caller is the manager's
	 * crash-burst breaker, which must not hand a reordered scope a fresh
	 * spawn budget.
	 */
	test("oauth: a scope is a set, so reordering is one server and widening is two", async () => {
		const write = (scope: string) =>
			writeJson(path.join(dirs.project, ".omp", "mcp.json"), {
				mcpServers: { aw: { type: "http", url: "https://mcp.example.test/aw", oauth: { scope } } },
			});
		await write("\u0000(read write admin");
		const [, first] = await reload();
		expect(first.oauth?.scope).toBe("\u0000(read write admin");
		await write("admin write \u0000(read");
		const [, reordered] = await reload();
		await write("admin write \u0000(read offline_access");
		const [, widened] = await reload();

		expect(sameMcpServerIdentity(first, reordered)).toBe(true);
		expect(sameMcpServerIdentity(first, widened)).toBe(false);
	});

	/**
	 * Two projects whose `oauth.scope` differs only inside one declaration's
	 * default ask the authorization server for different grants, so they are
	 * two servers.
	 */
	test("oauth: two scope declarations differing inside their defaults are two grants", async () => {
		const SCOPE_SET = "OMP_CACHE_IDENTITY_SCOPE_SET";
		const SCOPE_UNSET = "OMP_CACHE_IDENTITY_SCOPE_UNSET";
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

			const [name, here] = await load(projectA);
			const [, there] = await load(projectB);

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
});
