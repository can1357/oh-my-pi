/**
 * A subagent spawned from a session without a session file gets a temporary
 * artifacts lease in the temp dir; its transcript (`<lease>/<Id>.jsonl`) and
 * its own children's (`<lease>/<Id>/<Id.Sub>.jsonl`) go to the session
 * storage. Under `session.storage: sql` those are rows, not files, so removing
 * the lease directory alone leaves them in the database forever. Cleanup must
 * remove the transcripts from the storage as well as the local directory.
 */
import { SQL } from "bun";
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resetRegisteredArtifactDirsForTests } from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import {
	defaultSessionStorage,
	FileSessionStorage,
	type SessionStorage,
	setDefaultSessionStorage,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { runStructuredSubagent } from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";

const AGENT: AgentDefinition = {
	name: "worker",
	description: "Test worker",
	systemPrompt: "Do the assigned work.",
	source: "bundled",
	tools: ["read"],
};

const previous = defaultSessionStorage();
const clients: SQL[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	resetRegisteredArtifactDirsForTests();
	setDefaultSessionStorage(previous);
	for (const client of clients.splice(0)) await client.end();
});

const backends: Array<[string, () => Promise<SessionStorage>]> = [
	["file", async () => new FileSessionStorage()],
	[
		"sql",
		async () => {
			const client = new SQL("sqlite::memory:");
			clients.push(client);
			return SqlSessionStorage.create({ client });
		},
	],
];

/** A session with no session file: the subagent's artifacts are leased in the temp dir. */
function sessionWithoutFile(): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated({ "task.isolation.enabled": false }),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getSessionAgents: () => [],
		getPlanModeState: () => undefined,
	} as unknown as ToolSession;
}

function result(id: string): SingleResult {
	return {
		index: 0,
		id,
		agent: "worker",
		agentSource: "bundled",
		task: "Inspect the target.",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 1,
	};
}

describe("temporary subagent artifacts lease", () => {
	it.each(backends)("leaves no transcript in the %s storage after cleanup", async (_name, open) => {
		const storage = await open();
		setDefaultSessionStorage(storage);
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [AGENT], projectAgentsDir: null });
		let artifactsDir = "";
		const transcripts: string[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			artifactsDir = options.artifactsDir ?? "";
			const own = path.join(artifactsDir, `${options.id}.jsonl`);
			const nested = path.join(artifactsDir, options.id, `${options.id}.Helper.jsonl`);
			await storage.writeText(own, '{"type":"session","id":"child"}\n');
			await storage.writeText(nested, '{"type":"session","id":"grandchild"}\n');
			transcripts.push(own, nested);
			await Bun.write(path.join(artifactsDir, `1.bash.log`), "tool output");
			return result(options.id);
		});

		await runStructuredSubagent({
			session: sessionWithoutFile(),
			invocationKind: "task",
			assignment: "Inspect the target.",
			agent: "worker",
		});

		expect(path.basename(artifactsDir)).toStartWith("omp-task-");
		expect(transcripts.filter(file => storage.existsSync(file))).toEqual([]);
		expect(fs.existsSync(artifactsDir)).toBe(false);
	});
});
