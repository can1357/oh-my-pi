import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AssistantMessage, Message } from "@oh-my-pi/pi-ai";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { getAgentTombstonePath } from "@oh-my-pi/pi-coding-agent/registry/agent-tombstone";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { restoreSession } from "@oh-my-pi/pi-coding-agent/task/restore";
import type { SingleResult, TaskReportReference } from "@oh-my-pi/pi-tui/tools/task";
import { TempDir } from "@oh-my-pi/pi-utils";

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(fields: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: zeroUsage,
		stopReason: "stop",
		timestamp: Date.now(),
		...fields,
	};
}

/** A turn the process died in, mid tool call (no result, no exit record). */
const cutOff: Message[] = [
	{ role: "user", content: "work", timestamp: Date.now() },
	assistant({
		content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } }],
		stopReason: "toolUse",
	}),
];
/** A turn that ended on the model's own answer. */
const finished: Message[] = [
	{ role: "user", content: "work", timestamp: Date.now() },
	assistant({ content: [{ type: "text", text: "all done" }] }),
];

/** Writes subagent `id`'s transcript under the main session `mainFile`, with its spawn contract. */
async function writeSubagent(
	mainFile: string,
	cwd: string,
	id: string,
	messages: Message[],
	agent?: string,
): Promise<string> {
	const file = path.join(mainFile.slice(0, -6), `${id}.jsonl`);
	const manager = await SessionManager.open(file, undefined, undefined, {
		initialCwd: cwd,
		parentSession: mainFile,
		suppressBreadcrumb: true,
	});
	manager.appendSessionInit({ systemPrompt: ["sub prompt"], task: `${id} task`, tools: ["read", "yield"], agent });
	for (const message of messages) manager.appendMessage(message);
	await manager.close();
	return file;
}

describe("restoreSession (omp --restore)", () => {
	const ids = ["Cut", "Done", "Killed"];
	let tempDir: TempDir | undefined;
	let manager: AsyncJobManager | undefined;

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const id of ids) AgentRegistry.global().unregister(id);
		await manager?.dispose({ timeoutMs: 1000 });
		manager = undefined;
		tempDir?.removeSync();
		tempDir = undefined;
	});

	it.each([0, 1])(
		"goes on with each subagent cut off mid-turn as a job its parent receives, not with finished or killed ones (exitCode %i)",
		async exitCode => {
			tempDir = TempDir.createSync("@pi-restore-subagents-");
			const cwd = tempDir.path();
			const main = SessionManager.create(cwd, path.join(cwd, "sessions"));
			main.appendMessage({ role: "user", content: "fan out", timestamp: Date.now() });
			const mainFile = main.getSessionFile();
			if (!mainFile) throw new Error("Expected a persisted session file");
			await main.close();
			await writeSubagent(mainFile, cwd, "Cut", cutOff, "scout");
			await writeSubagent(mainFile, cwd, "Done", finished);
			const killed = await writeSubagent(mainFile, cwd, "Killed", cutOff);
			await fs.writeFile(getAgentTombstonePath(killed), "");

			manager = new AsyncJobManager({});
			const delivered: string[] = [];
			const deliveredReports: (TaskReportReference | undefined)[] = [];
			manager.registerDeliverySink(MAIN_AGENT_ID, jobId => {
				delivered.push(jobId);
				deliveredReports.push(manager!.getJob(jobId)?.report);
			});
			const artifact = Object.freeze({
				id: "42",
				uri: "artifact://42",
				sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
				bytes: 5,
			});
			const report: Readonly<TaskReportReference> = Object.freeze({
				version: 1,
				runId: "restore-cut-report-run",
				artifact,
				...(exitCode === 0
					? { status: "complete" as const }
					: { status: "partial" as const, reason: "failed" as const }),
			});
			const result: SingleResult = {
				index: 0,
				id: "Cut",
				agent: "Cut",
				agentSource: "user",
				task: "Cut task",
				exitCode,
				report,
				output: exitCode === 0 ? "finished after the restart" : "failed after the restart",
				stderr: "",
				truncated: false,
				durationMs: 5,
				tokens: 0,
				requests: 1,
			};
			const followUp = vi.spyOn(executorModule, "runSubagentFollowUpTurn").mockResolvedValue(result);
			const restoreTurn = vi.fn(async () => true);
			const session = {
				sessionManager: { getSessionFile: () => mainFile, getArtifactManager: () => null },
				asyncJobManager: manager,
				settings: Settings.isolated(),
				restoreInterruptedTurn: restoreTurn,
			} as unknown as AgentSession;

			const outcome = await restoreSession(session);

			expect(outcome).toEqual({ turn: true, subagents: ["Cut"] });
			expect(followUp).toHaveBeenCalledTimes(1);
			expect(followUp.mock.calls[0]![0]).toMatchObject({
				id: "Cut",
				agent: { name: "Cut" },
				restore: true,
				message: "Cut task",
				softRequestBudget: 100,
			});
			const job = manager.getJob("Cut")!;
			await job.promise;
			expect(job.status).toBe(exitCode === 0 ? "completed" : "failed");
			expect(job.report).toBe(report);
			await manager.drainDeliveries({ filter: { ownerId: MAIN_AGENT_ID } });
			expect(delivered).toEqual(["Cut"]);
			expect(deliveredReports[0]).toBe(report);
			expect(job.report).toBe(report);
		},
	);
});
