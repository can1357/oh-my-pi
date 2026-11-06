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
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import "@oh-my-pi/pi-coding-agent/discovery";
import {
	AGENT_PLUGIN_MANIFEST_SCHEMA,
	AGENT_PLUGIN_MCP_SCHEMA,
} from "@oh-my-pi/pi-coding-agent/discovery/agent-plugin-format";
import { clearClaudePluginRootsCache } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { getConfigRootDir, removeWithRetries, setAgentDir, stableStringifyJson } from "@oh-my-pi/pi-utils";
import { loadAllMCPConfigs } from "../src/mcp/config";
import { MCPToolCache } from "../src/mcp/tool-cache";
import type { MCPServerConfig, MCPToolDefinition } from "../src/mcp/types";
import type { AgentStorage } from "../src/session/agent-storage";
import { restoreEnvValue } from "./helpers/settings-test-state";

const TOKEN_VAR = "OMP_AS_WRITTEN_TOKEN";

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
});
