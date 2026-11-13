/**
 * The MCP stdio sandbox opt-in (`sandbox`, `sandboxNetwork`) must survive every OMP-owned config
 * path to the transport config, drop and report invalid values, keep contained and uncontained
 * entries for one command apart, and be accepted by the schema for stdio servers only.
 */
import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { validateJsonSchemaValue } from "@oh-my-pi/pi-ai/utils/schema/json-schema-validator";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { loadAllMCPConfigs, validateServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/config";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { logger, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import mcpSchema from "../../src/config/mcp-schema.json" with { type: "json" };
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

let state: SettingsTestState | undefined;
let tempAgentDir = "";
let tempCwd = "";
let tempHome = "";

beforeEach(async () => {
	state = beginSettingsTest();
	tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-sandbox-home-"));
	tempAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-sandbox-agent-"));
	tempCwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-sandbox-cwd-"));
	process.env.HOME = tempHome;
	vi.spyOn(os, "homedir").mockReturnValue(tempHome);
	setAgentDir(tempAgentDir);
	clearFsCache();
});

afterEach(async () => {
	// Restores mocks, HOME, PI_CODING_AGENT_DIR and the agent/project dirs.
	restoreSettingsTestState(state);
	state = undefined;
	clearFsCache();
	await removeWithRetries(tempHome);
	await removeWithRetries(tempAgentDir);
	await removeWithRetries(tempCwd);
});

for (const [provider, file] of [
	["native", ".omp/mcp.json"],
	["standalone", ".mcp.json"],
	["plugin", "plugin/.mcp.json"],
] as const) {
	test(`${provider} config carries the sandbox opt-in and warns about invalid values`, async () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		await Bun.write(
			path.join(tempCwd, file),
			JSON.stringify({
				mcpServers: {
					contained: { command: "/bin/echo", args: ["contained"], sandbox: true, sandboxNetwork: "deny" },
					plain: { command: "/bin/echo", args: ["plain"] },
					"quoted-bool": { command: "/bin/echo", args: ["quoted-bool"], sandbox: "true" },
					"bad-network": { command: "/bin/echo", args: ["bad-network"], sandbox: true, sandboxNetwork: "open" },
				},
			}),
		);
		const { configs } = await loadAllMCPConfigs(tempCwd, {
			extensionRoots: {
				explicit: provider === "plugin" ? [path.join(tempCwd, "plugin")] : [],
				mode: "explicit-only",
				configured: [],
				configuredLevel: "project",
			},
		});
		expect(Object.keys(configs).sort()).toEqual(["bad-network", "contained", "plain", "quoted-bool"]);
		expect(configs.contained).toMatchObject({ sandbox: true, sandboxNetwork: "deny" });
		expect(configs.plain).not.toHaveProperty("sandbox");
		expect(configs.plain).not.toHaveProperty("sandboxNetwork");
		// An invalid opt-in never turns containment on by accident, and is reported once.
		expect(configs["quoted-bool"]).not.toHaveProperty("sandbox");
		expect(configs["bad-network"]).toMatchObject({ sandbox: true });
		expect(configs["bad-network"]).not.toHaveProperty("sandboxNetwork");
		const warnings = warn.mock.calls.map(args =>
			args.map(arg => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "),
		);
		expect(warnings.filter(text => text.includes("quoted-bool") && text.includes("sandbox"))).toHaveLength(1);
		expect(warnings.filter(text => text.includes("bad-network") && text.includes("sandboxNetwork"))).toHaveLength(1);
	});
}

test("a contained and an uncontained entry for one command stay two connections", async () => {
	await Bun.write(
		path.join(tempCwd, ".omp", "mcp.json"),
		JSON.stringify({
			mcpServers: {
				contained: { command: "/bin/echo", sandbox: true },
				"contained-denied": { command: "/bin/echo", sandbox: true, sandboxNetwork: "deny" },
				plain: { command: "/bin/echo" },
			},
		}),
	);
	clearFsCache();
	const { configs } = await loadAllMCPConfigs(tempCwd);
	expect(Object.keys(configs).sort()).toEqual(["contained", "contained-denied", "plain"]);
});

test('an explicit sandboxNetwork "allow" is the default, so dedup collapses it with an unset alias', async () => {
	await Bun.write(
		path.join(tempCwd, ".omp", "mcp.json"),
		JSON.stringify({
			mcpServers: {
				explicit: { command: "/bin/echo", sandbox: true, sandboxNetwork: "allow" },
				implicit: { command: "/bin/echo", sandbox: true },
			},
		}),
	);
	clearFsCache();
	const { configs } = await loadAllMCPConfigs(tempCwd);
	expect(Object.keys(configs)).toHaveLength(1);
});

test("validateServerConfig rejects invalid sandbox fields", () => {
	const config = { command: "/bin/echo", sandbox: "yes", sandboxNetwork: "open" } as unknown as MCPServerConfig;
	expect(validateServerConfig("fixture", config)).toEqual([
		'Server "fixture": "sandbox" must be a boolean',
		'Server "fixture": "sandboxNetwork" must be "allowlist", "deny" or "allow"',
	]);
	expect(
		validateServerConfig("fixture", { command: "/bin/echo", sandbox: true, sandboxNetwork: "allowlist" }),
	).toEqual([]);
});

test("the schema accepts the sandbox opt-in on stdio servers only", () => {
	const valid = (server: Record<string, unknown>): boolean =>
		validateJsonSchemaValue(mcpSchema, { mcpServers: { fixture: server } }).success;
	expect(valid({ type: "stdio", command: "fixture", sandbox: true, sandboxNetwork: "allowlist" })).toBe(true);
	expect(valid({ type: "stdio", command: "fixture", sandbox: "true" })).toBe(false);
	expect(valid({ type: "stdio", command: "fixture", sandboxNetwork: "open" })).toBe(false);
	expect(valid({ type: "http", url: "https://example.com/mcp", sandbox: true })).toBe(false);
});
