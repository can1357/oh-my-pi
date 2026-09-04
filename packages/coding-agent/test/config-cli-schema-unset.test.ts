import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { runConfigCommand } from "@oh-my-pi/pi-coding-agent/cli/config-cli";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SETTINGS_SCHEMA } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { getConfigRootDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

let agentDir: TempDir | undefined;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

beforeEach(() => {
	resetSettingsForTest();
	agentDir = TempDir.createSync("@omp-config-cli-schema-unset-");
	setAgentDir(agentDir.path());
});

afterEach(async () => {
	vi.restoreAllMocks();
	AgentStorage.close();
	resetSettingsForTest();
	if (originalAgentDir) setAgentDir(originalAgentDir);
	else {
		setAgentDir(fallbackAgentDir);
		delete process.env.PI_CODING_AGENT_DIR;
	}
	if (agentDir) {
		try {
			await agentDir.remove();
		} catch {}
		agentDir = undefined;
	}
});

interface SchemaEntryJson {
	key: string;
	type: string;
	default: unknown;
	values: string[] | null;
	tab: string | null;
	group: string | null;
	label: string | null;
	description: string | null;
	warning: string | null;
	options: unknown;
	ordered: boolean;
	secret: boolean;
	condition: Record<string, unknown> | null;
}

interface SchemaEnvelopeJson {
	version: string;
	tabs: Array<{ id: string; label: string; groups: string[] }>;
	settings: SchemaEntryJson[];
}

/** Both `list --json` and `schema --json` write directly to stdout rather than console.log. */
async function jsonStdout<T>(run: () => Promise<void>): Promise<T> {
	let raw = "";
	const write = vi.spyOn(process.stdout, "write").mockImplementation(((
		chunk: string | Uint8Array,
		...rest: unknown[]
	) => {
		raw += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		const done = rest.find(argument => typeof argument === "function");
		if (typeof done === "function") (done as (error?: Error | null) => void)(null);
		return true;
	}) as typeof process.stdout.write);
	await run();
	write.mockRestore();
	return JSON.parse(raw) as T;
}

describe("config schema --json", () => {
	it("covers every key that config list --json reports", async () => {
		const listed = await jsonStdout<Record<string, unknown>>(() =>
			runConfigCommand({ action: "list", flags: { json: true } }),
		);
		const schema = await jsonStdout<SchemaEnvelopeJson>(() =>
			runConfigCommand({ action: "schema", flags: { json: true } }),
		);

		const listedKeys = Object.keys(listed).sort();
		const schemaKeys = schema.settings.map(entry => entry.key).sort();
		expect(schemaKeys).toEqual(listedKeys);
		expect(schemaKeys).toEqual(Object.keys(SETTINGS_SCHEMA).sort());
	});

	it("reports the running package version and the ten declared tabs in SETTING_TABS order", async () => {
		const schema = await jsonStdout<SchemaEnvelopeJson>(() =>
			runConfigCommand({ action: "schema", flags: { json: true } }),
		);
		expect(schema.version).toMatch(/^\d+\.\d+\.\d+/);
		expect(schema.tabs.map(tab => tab.id)).toEqual([
			"appearance",
			"model",
			"interaction",
			"context",
			"memory",
			"files",
			"shell",
			"tools",
			"tasks",
			"providers",
		]);
		expect(schema.tabs.every(tab => Array.isArray(tab.groups))).toBe(true);
	});

	it("carries a declarative condition object, never an evaluated boolean, for a gated setting", async () => {
		const schema = await jsonStdout<SchemaEnvelopeJson>(() =>
			runConfigCommand({ action: "schema", flags: { json: true } }),
		);
		const advisorGated = schema.settings.find(entry => entry.key === "advisor.syncBacklog");
		expect(advisorGated?.condition).toEqual({ kind: "setting", dependsOn: "advisor.enabled", equals: true });

		const macGated = schema.settings.find(entry => entry.key === "spelling.typoDetection");
		expect(macGated?.condition).toEqual({ kind: "platform", platform: "darwin" });

		const terminalGated = schema.settings.find(entry => entry.key === "terminal.showImages");
		expect(terminalGated?.condition).toEqual({ kind: "terminal", capability: "imageProtocol" });

		const ungated = schema.settings.find(entry => entry.key === "autoResume");
		expect(ungated?.condition).toBeNull();
	});

	it("emits null (not a missing field) for a setting with no ui metadata", async () => {
		const schema = await jsonStdout<SchemaEnvelopeJson>(() =>
			runConfigCommand({ action: "schema", flags: { json: true } }),
		);
		const noUi = schema.settings.find(entry => entry.key === "shellPath");
		expect(noUi).toBeDefined();
		expect(noUi?.tab).toBeNull();
		expect(noUi?.label).toBeNull();
		expect(noUi && Object.hasOwn(noUi, "tab")).toBe(true);
	});
});

describe("config unset", () => {
	it("removes the explicit value so a following get reports the schema default", async () => {
		await runConfigCommand({ action: "set", key: "autoResume", value: "true", flags: { json: true } });
		expect(Settings.instance.get("autoResume")).toBe(true);

		await runConfigCommand({ action: "unset", key: "autoResume", flags: { json: true } });
		expect(Settings.instance.get("autoResume")).toBe(false);
	});

	it("persists the removal to disk rather than writing a null placeholder", async () => {
		await runConfigCommand({ action: "set", key: "autoResume", value: "true", flags: { json: true } });
		await runConfigCommand({ action: "unset", key: "autoResume", flags: { json: true } });

		// Reload a fresh instance from disk: a leftover `autoResume: null` in
		// config.yml would resolve here as null, not the schema default `false`.
		resetSettingsForTest();
		await Settings.init();
		expect(Settings.instance.get("autoResume")).toBe(false);
		expect(Settings.instance.isConfigured("autoResume")).toBe(false);
	});

	it("rejects an unknown key in the same style set uses", async () => {
		const exit = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("process.exit");
		}) as typeof process.exit);
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(runConfigCommand({ action: "unset", key: "not.a.real.setting", flags: {} })).rejects.toThrow(
			"process.exit",
		);

		expect(exit).toHaveBeenCalledWith(1);
		const messages = errorLog.mock.calls.map(call => Bun.stripANSI(String(call[0] ?? ""))).join("\n");
		expect(messages).toContain("Unknown setting: not.a.real.setting");
	});
});
