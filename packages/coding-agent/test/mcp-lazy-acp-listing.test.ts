/**
 * `/mcp resources` and `/mcp prompts` over the shared ACP/RPC/text dispatcher
 * list what the configured servers offer. A `lazy: true` server starts only
 * on its first tool call or an explicit `/mcp test`, so listing must neither
 * launch its command nor run its `!command` secret values. Eager servers stay
 * queried, which is also the control that a launch would be seen. Once the
 * session has started a lazy server, the listing reads it over that live
 * connection.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { invalidateCommandConfig } from "@oh-my-pi/pi-coding-agent/config/resolve-config-value";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { cfgMcpEnableProjectConfig } from "@oh-my-pi/pi-coding-agent/mcp/settings";
import type { MCPStdioServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { handleMcpAcp } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/mcp";
import type { ParsedSlashCommand, SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { Process } from "@oh-my-pi/pi-natives";
import {
	getConfigRootDir,
	getMCPConfigPath,
	getProjectDir,
	isEnoent,
	isRecord,
	removeWithRetries,
	setAgentDir,
	setProjectDir,
} from "@oh-my-pi/pi-utils";

const peer = path.join(import.meta.dir, "fixtures/rpc-mcp-server.ts");
const originalProjectDir = getProjectDir();
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

async function spawnedPids(audit: string): Promise<number[]> {
	let text: string;
	try {
		text = await Bun.file(audit).text();
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
	const entries: unknown[] = Bun.JSONL.parse(text);
	return entries.flatMap(entry =>
		isRecord(entry) && entry.event === "spawn" && typeof entry.pid === "number" ? [entry.pid] : [],
	);
}

/** How many times a `!command` secret ran (one line per run). */
async function secretRuns(log: string): Promise<number> {
	try {
		return (await Bun.file(log).text()).split("\n").filter(line => line === "resolved").length;
	} catch (error) {
		if (isEnoent(error)) return 0;
		throw error;
	}
}

describe("/mcp listing over the shared dispatcher and lazy servers", () => {
	let root = "";
	let authStorage: AuthStorage | undefined;
	const managers: MCPManager[] = [];

	function makeRuntime(
		mcpManager?: MCPManager,
		settings = Settings.isolated(),
	): { output: string[]; runtime: SlashCommandRuntime } {
		const output: string[] = [];
		const runtime = {
			session: { modelRegistry: { authStorage }, getEvalPreludes: () => [], effectiveExtensionRoots: undefined },
			sessionManager: {},
			settings,
			cwd: getProjectDir(),
			mcpManager,
			output: (text: string) => {
				output.push(text);
			},
			refreshCommands: () => {},
			reloadPlugins: () => Promise.resolve(),
		} as unknown as SlashCommandRuntime;
		return { output, runtime };
	}

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-lazy-acp-"));
		// An empty agent dir: no real user servers join the listing.
		const agentDir = path.join(root, "agent");
		const project = path.join(root, "project");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.mkdir(project, { recursive: true });
		setAgentDir(agentDir);
		setProjectDir(project);
		authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
	});

	afterEach(async () => {
		await Promise.all(managers.splice(0).map(manager => manager.disconnectAll()));
		for (const audit of ["eager.jsonl", "lazy.jsonl", "project.jsonl"]) {
			for (const pid of await spawnedPids(path.join(root, audit))) {
				await Process.fromPid(pid)?.terminate({ gracefulMs: 0 });
			}
		}
		authStorage?.close();
		authStorage = undefined;
		setProjectDir(originalProjectDir);
		setAgentDir(originalAgentDir ?? path.join(getConfigRootDir(), "agent"));
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		await removeWithRetries(root);
	});

	for (const verb of ["resources", "prompts"] as const) {
		test(`/mcp ${verb} queries eager servers and leaves a lazy server and its secrets alone`, async () => {
			const project = getProjectDir();
			const eagerAudit = path.join(root, "eager.jsonl");
			const lazyAudit = path.join(root, "lazy.jsonl");
			const secretLog = path.join(root, "lazy-secret.log");
			await Bun.write(
				getMCPConfigPath("project", project),
				JSON.stringify({
					mcpServers: {
						eager: { command: process.execPath, args: [peer, eagerAudit] },
						dormant: {
							command: process.execPath,
							args: [peer, lazyAudit],
							lazy: true,
							// A `!command` value runs only when the server is about to start.
							env: { LAZY_TOKEN: `!printf resolved >> '${secretLog}'; printf token` },
						},
					},
				}),
			);
			const { output, runtime } = makeRuntime();

			expect(await handleMcpAcp({ args: verb } as ParsedSlashCommand, runtime)).toEqual({ consumed: true });

			expect(await spawnedPids(eagerAudit), output.join("\n")).toHaveLength(1);
			expect(await spawnedPids(lazyAudit)).toEqual([]);
			expect(await Bun.file(secretLog).exists()).toBe(false);
		}, 120_000);
	}

	// `mcp.enableProjectConfig: false` excludes the project file at startup. A
	// listing must read the servers the same way, or a same-named project entry
	// shadows the lazy user server and the listing starts the excluded command
	// (PR #9793 review, round 2).
	for (const verb of ["resources", "prompts"] as const) {
		test(`/mcp ${verb} never starts a server the session's discovery excludes`, async () => {
			const project = getProjectDir();
			const userAudit = path.join(root, "lazy.jsonl");
			const projectAudit = path.join(root, "project.jsonl");
			const projectSecret = path.join(root, "project-secret.log");
			await Bun.write(
				getMCPConfigPath("user", project),
				JSON.stringify({ mcpServers: { dup: { command: process.execPath, args: [peer, userAudit], lazy: true } } }),
			);
			await Bun.write(
				getMCPConfigPath("project", project),
				JSON.stringify({
					mcpServers: {
						dup: {
							command: process.execPath,
							args: [peer, projectAudit],
							env: { PROJECT_TOKEN: `!printf resolved >> '${projectSecret}'; printf token` },
						},
					},
				}),
			);
			const settings = Settings.isolated();
			cfgMcpEnableProjectConfig.set(settings, false);
			const { output, runtime } = makeRuntime(undefined, settings);

			expect(await handleMcpAcp({ args: verb } as ParsedSlashCommand, runtime)).toEqual({ consumed: true });

			expect(await spawnedPids(projectAudit), output.join("\n")).toEqual([]);
			expect(await Bun.file(projectSecret).exists()).toBe(false);
			expect(await spawnedPids(userAudit)).toEqual([]);
		}, 120_000);
	}

	test("a lazy server the session already started is listed over its live connection", async () => {
		const lazyAudit = path.join(root, "lazy.jsonl");
		const secretLog = path.join(root, "lazy-secret.log");
		const secret = `!echo resolved >> '${secretLog}'; printf token`;
		const dormant: MCPStdioServerConfig = {
			type: "stdio",
			command: process.execPath,
			args: [peer, lazyAudit, "--catalog"],
			env: { LAZY_TOKEN: secret },
			lazy: true,
		};
		await Bun.write(getMCPConfigPath("project", getProjectDir()), JSON.stringify({ mcpServers: { dormant } }));
		const manager = new MCPManager(getProjectDir());
		managers.push(manager);
		// Registration leaves it dormant; the session's first use starts it.
		await manager.connectServers({ dormant }, {});
		expect(await spawnedPids(lazyAudit)).toEqual([]);
		const connection = await manager.reconnectServer("dormant", { manual: true });
		expect(connection).not.toBeNull();
		expect(await spawnedPids(lazyAudit)).toHaveLength(1);
		expect(await secretRuns(secretLog)).toBe(1);
		// Resolving the config again would now rerun the command instead of reusing its cached value.
		invalidateCommandConfig(secret);

		const { output, runtime } = makeRuntime(manager);
		await handleMcpAcp({ args: "resources" } as ParsedSlashCommand, runtime);
		await handleMcpAcp({ args: "prompts" } as ParsedSlashCommand, runtime);

		expect(output.join("\n")).toContain("dormant/rpc-regression://marker");
		expect(output.join("\n")).toContain("dormant/regression_prompt");
		expect(await spawnedPids(lazyAudit)).toHaveLength(1);
		expect(await secretRuns(secretLog)).toBe(1);
	}, 120_000);
});
