/**
 * MED-29: `loadCapability` reads the sandbox-created ledger after its providers ran, so project config
 * a contained command created while discovery was running (ledgered meanwhile) is still skipped.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { defineCapability, loadCapability, registerProvider } from "@oh-my-pi/pi-coding-agent/capability";
import type { SourceMeta } from "@oh-my-pi/pi-coding-agent/capability/types";
import { recordSandboxCreated } from "@oh-my-pi/pi-coding-agent/sandbox/ledger";
import { __resetDirsFromEnvForTests, removeSyncWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

interface Item {
	name: string;
	_source: SourceMeta;
}

const capabilityId = "sandbox-ledger-during-load-test";
/** What the provider ledgers while it loads, and the items it returns. */
let duringLoad: { ledgered: string[]; items: Item[] } = { ledgered: [], items: [] };

defineCapability<Item>({
	id: capabilityId,
	displayName: "Ledger during load",
	description: "",
	key: item => item.name,
});
registerProvider<Item>(capabilityId, {
	id: capabilityId,
	displayName: "Ledger during load",
	description: "",
	priority: 1,
	load: async () => {
		// A contained command finishes while discovery runs; its new protected path is ledgered now.
		if (duringLoad.ledgered.length > 0) {
			recordSandboxCreated(
				duringLoad.ledgered.map(target => ({ path: target, real: target, workspace, at: Date.now() })),
			);
		}
		return { items: duringLoad.items, warnings: [] };
	},
});

let root: string;
let workspace: string;

const item = (name: string, file: string): Item => ({
	name,
	_source: { provider: capabilityId, providerName: "", path: file, level: "project" },
});

beforeEach(() => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-cap-ledger-")));
	workspace = path.join(root, "project");
	fs.mkdirSync(workspace, { recursive: true });
	// The ledger lives in the agent dir; a fresh one per test starts nothing ledgered.
	setAgentDir(path.join(root, "agent"));
});

afterEach(() => {
	duringLoad = { ledgered: [], items: [] };
	__resetDirsFromEnvForTests();
	removeSyncWithRetries(root);
});

describe("loadCapability and the sandbox-created ledger", () => {
	it("skips a project item ledgered while its provider loads", async () => {
		const created = path.join(workspace, ".omp", "mcp.json");
		duringLoad = { ledgered: [created], items: [item("created", created)] };
		const result = await loadCapability<Item>(capabilityId, { cwd: workspace });
		expect(result.items).toEqual([]);
		expect(result.warnings).toContainEqual(
			expect.stringMatching(
				new RegExp(`Skipped ${RegExp.escape(created)}: a sandboxed command created or replaced`),
			),
		);
	});

	it("keeps a project item nothing ledgered", async () => {
		const kept = path.join(workspace, ".omp", "mcp.json");
		duringLoad = { ledgered: [], items: [item("kept", kept)] };
		const result = await loadCapability<Item>(capabilityId, { cwd: workspace });
		expect(result.items.map(loaded => loaded.name)).toEqual(["kept"]);
		expect(result.warnings).toEqual([]);
	});
});
