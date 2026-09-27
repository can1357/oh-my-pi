/**
 * `requestIdFormat` must survive the documented config path, and must not be lost
 * to connection-equivalence deduplication.
 *
 * The option is only useful if a value written in config actually reaches the
 * transport: discovery parses config into the canonical `MCPServer` shape and
 * `convertToLegacyConfig()` turns that back into the `MCPServerConfig` the
 * transports read. A field missing from either step silently degrades to the
 * snowflake-string default, which is the hang the option exists to avoid.
 *
 * Both OMP-native loaders are covered: `.omp/mcp.json` (native provider) and a
 * standalone project-root `.mcp.json` (mcp-json provider).
 *
 * Separately, `isSameMCPConnection` treats two differently-named entries with the
 * same command/args/env/cwd as aliases of one connection, keeping only the
 * higher-priority one. `requestIdFormat` changes the bytes sent on the wire, so it
 * must be part of that comparison — otherwise a discovered alias lacking the field
 * could shadow a `.mcp.json` entry that set it, silently reverting to string ids.
 */
import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { validateJsonSchemaValue } from "@oh-my-pi/pi-ai/utils/schema/json-schema-validator";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { loadAllMCPConfigs } from "@oh-my-pi/pi-coding-agent/mcp/config";
import { getConfigRootDir, logger, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import mcpSchema from "../../src/config/mcp-schema.json" with { type: "json" };

const originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

let tempAgentDir = "";
let tempCwd = "";
let tempHome = "";
let originalHome: string | undefined;

beforeEach(async () => {
	originalHome = process.env.HOME;
	tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-reqid-home-"));
	tempAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-reqid-agent-"));
	tempCwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-reqid-cwd-"));
	process.env.HOME = tempHome;
	vi.spyOn(os, "homedir").mockReturnValue(tempHome);
	setAgentDir(tempAgentDir);
	clearFsCache();
});

afterEach(async () => {
	vi.restoreAllMocks();
	if (originalAgentDirEnv) {
		setAgentDir(originalAgentDirEnv);
	} else {
		setAgentDir(fallbackAgentDir);
		delete process.env.PI_CODING_AGENT_DIR;
	}
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	clearFsCache();
	await removeWithRetries(tempHome);
	await removeWithRetries(tempAgentDir);
	await removeWithRetries(tempCwd);
});

async function loadFrom(file: string, mcpServers: Record<string, unknown>) {
	await Bun.write(path.join(tempCwd, file), JSON.stringify({ mcpServers }));
	clearFsCache();
	const { configs } = await loadAllMCPConfigs(tempCwd);
	return configs;
}

test("requestIdFormat from .omp/mcp.json reaches the transport config", async () => {
	const configs = await loadFrom(path.join(".omp", "mcp.json"), {
		xcode: { type: "stdio", command: "/usr/bin/xcrun", args: ["mcpbridge"], requestIdFormat: "number" },
		plain: { type: "stdio", command: "/bin/echo" },
	});

	expect(configs.xcode?.requestIdFormat).toBe("number");
	// Unset stays unset so the allocator keeps its integer default.
	expect(configs.plain?.requestIdFormat).toBeUndefined();
});

test("requestIdFormat from a standalone .mcp.json reaches the transport config", async () => {
	const configs = await loadFrom(".mcp.json", {
		xcode: { type: "stdio", command: "/usr/bin/xcrun", args: ["mcpbridge"], requestIdFormat: "number" },
	});

	expect(configs.xcode?.requestIdFormat).toBe("number");
});

test("an unrecognized requestIdFormat is dropped rather than passed through", async () => {
	const configs = await loadFrom(path.join(".omp", "mcp.json"), {
		bogus: { type: "stdio", command: "/bin/echo", requestIdFormat: "integer" },
	});

	expect(configs.bogus).toBeDefined();
	expect(configs.bogus?.requestIdFormat).toBeUndefined();
});

test("differing requestIdFormat prevents equivalence dedup from collapsing two aliases", async () => {
	const configs = await loadFrom(path.join(".omp", "mcp.json"), {
		"xcode-string": { type: "stdio", command: "/usr/bin/xcrun", args: ["mcpbridge"], requestIdFormat: "string" },
		"xcode-default": { type: "stdio", command: "/usr/bin/xcrun", args: ["mcpbridge"] },
	});

	// Same command/args would previously make these equivalent, so the second
	// entry (whichever loads later) would shadow the first and its distinct
	// requestIdFormat setting would vanish. Both must survive as separate
	// servers — assert key presence directly, since optional chaining on a
	// shadowed (absent) key would otherwise make this pass vacuously.
	expect(Object.keys(configs).sort()).toEqual(["xcode-default", "xcode-string"]);
	expect(configs["xcode-string"]?.requestIdFormat).toBe("string");
	expect(configs["xcode-default"]?.requestIdFormat).toBeUndefined();
});

test('an explicit "number" is the default, so dedup collapses it with an unset alias', async () => {
	const configs = await loadFrom(path.join(".omp", "mcp.json"), {
		"xcode-numeric": { type: "stdio", command: "/usr/bin/xcrun", args: ["mcpbridge"], requestIdFormat: "number" },
		"xcode-default": { type: "stdio", command: "/usr/bin/xcrun", args: ["mcpbridge"] },
	});

	// Explicit "number" matches the allocator default, so both entries name the
	// same connection and only one survives.
	expect(Object.keys(configs)).toHaveLength(1);
});

for (const [provider, file] of [
	["native", ".omp/mcp.json"],
	["standalone", ".mcp.json"],
	["plugin", "plugin/.mcp.json"],
] as const) {
	test(provider + " config keeps boolean instructions and warns about invalid options", async () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		await Bun.write(
			path.join(tempCwd, file),
			JSON.stringify({
				mcpServers: {
					disabled: { command: "/bin/echo", args: ["disabled"], instructions: false },
					enabled: { command: "/bin/echo", args: ["enabled"], instructions: true },
					"quoted-bool": { command: "/bin/echo", args: ["quoted-bool"], instructions: "false" },
					"integer-ids": { command: "/bin/echo", args: ["integer-ids"], requestIdFormat: "integer" },
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
		expect(Object.keys(configs).sort()).toEqual(["disabled", "enabled", "integer-ids", "quoted-bool"]);
		expect(configs.disabled?.instructions).toBe(false);
		expect(configs.enabled?.instructions).toBe(true);
		expect(configs["quoted-bool"]?.instructions).toBeUndefined();
		expect(configs["integer-ids"]?.requestIdFormat).toBeUndefined();
		// A dropped value is reported once, naming the server and the option, so
		// a typo cannot silently re-enable instructions or revert the id encoding.
		const warnings = warn.mock.calls.map(args =>
			args.map(arg => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "),
		);
		expect(warnings.filter(text => text.includes("quoted-bool") && text.includes("instructions"))).toHaveLength(1);
		expect(warnings.filter(text => text.includes("integer-ids") && text.includes("requestIdFormat"))).toHaveLength(1);
	});
}

test("instructions does not split one endpoint into two connections", async () => {
	const configs = await loadFrom(".omp/mcp.json", {
		quiet: { command: "/bin/echo", instructions: false },
		loud: { command: "/bin/echo" },
	});

	// A prompt-inclusion setting is not a transport input. Two names for one
	// endpoint still collapse, so an alias cannot reconnect the server with its
	// instructions restored.
	expect(Object.keys(configs)).toHaveLength(1);
});

for (const server of [
	{ type: "stdio", command: "fixture" },
	{ type: "http", url: "https://example.com/mcp" },
	{ type: "sse", url: "https://example.com/sse" },
]) {
	test(server.type + " schema accepts instructions opt-out and rejects a non-boolean", () => {
		expect(
			validateJsonSchemaValue(mcpSchema, { mcpServers: { fixture: { ...server, instructions: false } } }).success,
		).toBe(true);
		expect(
			validateJsonSchemaValue(mcpSchema, { mcpServers: { fixture: { ...server, instructions: "false" } } }).success,
		).toBe(false);
	});

	test(server.type + " schema accepts every shared server field and still rejects unknown keys", () => {
		// Each transport closes its properties with `additionalProperties: false`,
		// which does not see `serverBase` through `allOf`; shared fields must stay
		// allowlisted there or valid configs fail validation.
		const shared = {
			enabled: false,
			timeout: 120_000,
			requestIdFormat: "string",
			instructions: false,
			auth: { type: "oauth" },
			oauth: { clientId: "client" },
		};
		expect(validateJsonSchemaValue(mcpSchema, { mcpServers: { fixture: { ...server, ...shared } } }).success).toBe(
			true,
		);
		expect(validateJsonSchemaValue(mcpSchema, { mcpServers: { fixture: { ...server, timeout: -1 } } }).success).toBe(
			false,
		);
		expect(validateJsonSchemaValue(mcpSchema, { mcpServers: { fixture: { ...server, bogus: true } } }).success).toBe(
			false,
		);
	});
}
