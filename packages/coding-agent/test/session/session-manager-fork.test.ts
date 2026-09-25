import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isSyntheticToolResultMessage } from "@oh-my-pi/pi-agent-core";
import { collectPendingToolCalls } from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import {
	CURRENT_SESSION_VERSION,
	type SessionEntry,
	type SessionHeader,
	type SessionMessageEntry,
} from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getTerminalId } from "@oh-my-pi/pi-tui";
import { getAgentDir, getTerminalSessionsDir, removeWithRetries, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

interface JsonlMessageEntry {
	type: "message";
	id: string;
	parentId: string | null;
	timestamp: string;
	message: {
		role: "user";
		content: string;
		timestamp: number;
	};
}

async function createSessionWithArtifacts(root: string): Promise<{
	cwd: string;
	sessionDir: string;
	sourceFile: string;
	sourceArtifactsDir: string;
}> {
	const cwd = path.join(root, "project");
	const sessionDir = path.join(root, "sessions");
	const sourceFile = path.join(sessionDir, "source.jsonl");
	const sourceArtifactsDir = sourceFile.slice(0, -".jsonl".length);
	const sourceHeader: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: "source-with-artifacts",
		timestamp: new Date().toISOString(),
		cwd,
	};
	await fs.mkdir(path.join(sourceArtifactsDir, "nested"), { recursive: true });
	await Bun.write(sourceFile, `${JSON.stringify(sourceHeader)}\n`);
	await Bun.write(path.join(sourceArtifactsDir, "1.read.log"), "tool output");
	await Bun.write(path.join(sourceArtifactsDir, "nested", "result.txt"), "nested output");
	return { cwd, sessionDir, sourceFile, sourceArtifactsDir };
}

/** Load a session file's transcript entries, dropping the non-entry session header. */
async function loadHistory(file: string): Promise<SessionEntry[]> {
	const entries = await loadEntriesFromFile(file);
	return entries.filter((entry): entry is SessionEntry => entry.type !== "session");
}

describe("SessionManager.forkFrom", () => {
	it("suppresses terminal breadcrumbs while preserving source history under a new parented session", async () => {
		using tempDir = TempDir.createSync("@omp-session-fork-");
		const previousAgentDir = getAgentDir();
		const previousTermSessionId = process.env.TERM_SESSION_ID;
		setAgentDir(path.join(tempDir.path(), "agent"));
		process.env.TERM_SESSION_ID = "omp-fork-test";
		try {
			const cwd = path.join(tempDir.path(), "project");
			const sessionDir = path.join(tempDir.path(), "sessions");
			await fs.mkdir(sessionDir, { recursive: true });
			const sourceFile = path.join(sessionDir, "source.jsonl");
			const timestamp = new Date().toISOString();
			const sourceHeader: SessionHeader = {
				type: "session",
				version: CURRENT_SESSION_VERSION,
				id: "source-session",
				timestamp,
				cwd,
			};
			const sourceMessage: JsonlMessageEntry = {
				type: "message",
				id: "message-1",
				parentId: null,
				timestamp,
				message: { role: "user", content: "hello", timestamp: Date.now() },
			};
			const sourceText = `${JSON.stringify(sourceHeader)}\n${JSON.stringify(sourceMessage)}\n`;
			await Bun.write(sourceFile, sourceText);

			const terminalId = getTerminalId();
			expect(terminalId).toBeString();
			const breadcrumbFile = path.join(getTerminalSessionsDir(), terminalId ?? "missing");
			await removeWithRetries(breadcrumbFile);

			const forked = await SessionManager.forkFrom(sourceFile, cwd, sessionDir, undefined, {
				suppressBreadcrumb: true,
			});
			await Bun.sleep(10);
			const cloneFile = forked.getSessionFile();
			expect(cloneFile).toBeString();
			if (!cloneFile) throw new Error("expected forked session file");

			expect(await Bun.file(sourceFile).text()).toBe(sourceText);
			expect(await Bun.file(breadcrumbFile).exists()).toBe(false);
			expect(cloneFile).not.toBe(sourceFile);

			const cloneEntries = await loadEntriesFromFile(cloneFile);
			const cloneHeader = cloneEntries.find((entry): entry is SessionHeader => entry.type === "session");
			const cloneMessage = cloneEntries.find((entry): entry is SessionMessageEntry => entry.type === "message");
			expect(cloneHeader?.id).not.toBe(sourceHeader.id);
			expect(cloneHeader?.parentSession).toBe(sourceHeader.id);
			expect(cloneHeader?.cwd).toBe(cwd);
			if (cloneMessage?.message.role !== "user") throw new Error("expected forked user message");
			expect(cloneMessage.message.content).toBe("hello");
		} finally {
			if (previousTermSessionId === undefined) {
				delete process.env.TERM_SESSION_ID;
			} else {
				process.env.TERM_SESSION_ID = previousTermSessionId;
			}
			setAgentDir(previousAgentDir);
		}
	});

	it("copies source artifacts recursively into the fork by default", async () => {
		using tempDir = TempDir.createSync("@omp-session-fork-artifacts-");
		const { cwd, sessionDir, sourceFile, sourceArtifactsDir } = await createSessionWithArtifacts(tempDir.path());

		const forked = await SessionManager.forkFrom(sourceFile, cwd, sessionDir, undefined, {
			suppressBreadcrumb: true,
		});
		const forkFile = forked.getSessionFile();
		if (!forkFile) throw new Error("expected forked session file");
		const forkArtifactsDir = forkFile.slice(0, -".jsonl".length);

		expect(await Bun.file(path.join(forkArtifactsDir, "1.read.log")).text()).toBe("tool output");
		expect(await Bun.file(path.join(forkArtifactsDir, "nested", "result.txt")).text()).toBe("nested output");
		expect(await Bun.file(path.join(sourceArtifactsDir, "1.read.log")).text()).toBe("tool output");
	});

	it("does not copy artifacts when the caller opts out", async () => {
		using tempDir = TempDir.createSync("@omp-session-fork-no-artifacts-");
		const { cwd, sessionDir, sourceFile } = await createSessionWithArtifacts(tempDir.path());

		const forked = await SessionManager.forkFrom(sourceFile, cwd, sessionDir, undefined, {
			copyArtifacts: false,
			suppressBreadcrumb: true,
		});
		const forkFile = forked.getSessionFile();
		if (!forkFile) throw new Error("expected forked session file");
		const forkArtifactsDir = forkFile.slice(0, -".jsonl".length);

		expect(await Bun.file(path.join(forkArtifactsDir, "1.read.log")).exists()).toBe(false);
	});

	it("does not treat an extensionless source's parent directory as artifacts", async () => {
		using tempDir = TempDir.createSync("@omp-session-fork-extensionless-");
		const cwd = path.join(tempDir.path(), "project");
		const sessionDir = path.join(tempDir.path(), "sessions");
		const forkDir = path.join(tempDir.path(), "forks");
		const sourceFile = path.join(sessionDir, "source");
		const unrelatedFile = path.join(sessionDir, "unrelated.txt");
		const sourceHeader: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "extensionless-source",
			timestamp: new Date().toISOString(),
			cwd,
		};
		await fs.mkdir(sessionDir, { recursive: true });
		await Bun.write(sourceFile, `${JSON.stringify(sourceHeader)}\n`);
		await Bun.write(unrelatedFile, "must not be copied");

		const forked = await SessionManager.forkFrom(sourceFile, cwd, forkDir, undefined, {
			suppressBreadcrumb: true,
		});
		const forkFile = forked.getSessionFile();
		if (!forkFile) throw new Error("expected forked session file");
		const forkArtifactsDir = forkFile.slice(0, -".jsonl".length);

		expect(await Bun.file(path.join(forkArtifactsDir, "unrelated.txt")).exists()).toBe(false);
		expect(await Bun.file(unrelatedFile).text()).toBe("must not be copied");
	});

	it("zeroes inherited cost while preserving token counts only when reset is requested", async () => {
		using tempDir = TempDir.createSync("@omp-session-fork-cost-");
		const cwd = path.join(tempDir.path(), "project");
		const sessionDir = path.join(tempDir.path(), "sessions");
		await fs.mkdir(sessionDir, { recursive: true });
		const sourceFile = path.join(sessionDir, "source.jsonl");
		const timestamp = new Date().toISOString();
		const sourceHeader: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "cost-source",
			timestamp,
			cwd,
		};
		const assistantEntry = {
			type: "message",
			id: "assistant-1",
			parentId: null,
			timestamp,
			message: {
				role: "assistant",
				content: [],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude",
				stopReason: "stop",
				timestamp: Date.now(),
				usage: {
					input: 100,
					output: 50,
					cacheRead: 10,
					cacheWrite: 5,
					totalTokens: 165,
					premiumRequests: 2,
					credits: { cost: 3, committedCost: 3, acuCost: 1 },
					cost: { input: 1, output: 4, cacheRead: 0.5, cacheWrite: 0.5, total: 6 },
				},
			},
		};
		await Bun.write(sourceFile, `${JSON.stringify(sourceHeader)}\n${JSON.stringify(assistantEntry)}\n`);

		const findAssistant = async (file: string) => {
			const entries = await loadEntriesFromFile(file);
			const entry = entries.find((e): e is SessionMessageEntry => e.type === "message");
			if (entry?.message.role !== "assistant") throw new Error("expected assistant message");
			return entry.message;
		};

		const preserved = await SessionManager.forkFrom(sourceFile, cwd, path.join(tempDir.path(), "keep"), undefined, {
			suppressBreadcrumb: true,
		});
		const preservedFile = preserved.getSessionFile();
		if (!preservedFile) throw new Error("expected preserved fork file");
		const preservedMessage = await findAssistant(preservedFile);
		expect(preservedMessage.usage.cost.total).toBe(6);
		expect(preservedMessage.usage.premiumRequests).toBe(2);

		const reset = await SessionManager.forkFrom(sourceFile, cwd, path.join(tempDir.path(), "reset"), undefined, {
			suppressBreadcrumb: true,
			resetInheritedCost: true,
		});
		const resetFile = reset.getSessionFile();
		if (!resetFile) throw new Error("expected reset fork file");
		const resetMessage = await findAssistant(resetFile);
		expect(resetMessage.usage.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
		expect(resetMessage.usage.credits).toBeUndefined();
		expect(resetMessage.usage.premiumRequests).toBeUndefined();
		// Token counts are context, not spend — compaction anchors depend on them.
		expect(resetMessage.usage.input).toBe(100);
		expect(resetMessage.usage.output).toBe(50);
		expect(resetMessage.usage.totalTokens).toBe(165);
	});

	it("pairs an unresolved tool call with a synthetic aborted result only when repair is requested", async () => {
		using tempDir = TempDir.createSync("@omp-session-fork-repair-");
		const cwd = path.join(tempDir.path(), "project");
		const sessionDir = path.join(tempDir.path(), "sessions");
		await fs.mkdir(sessionDir, { recursive: true });
		const sourceFile = path.join(sessionDir, "source.jsonl");
		const timestamp = new Date().toISOString();
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "live-parent",
			timestamp,
			cwd,
		};
		// Parent is mid-turn: the assistant emitted a tool call whose result was
		// delivered only to the parent, so the forked tail is non-terminal.
		const assistant = {
			type: "message",
			id: "m1",
			parentId: null,
			timestamp,
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "toolu_live", name: "bash", arguments: { command: "sleep 40" } }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude",
				stopReason: "toolUse",
				timestamp: Date.now(),
				usage: {
					input: 10,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 15,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
		};
		await Bun.write(sourceFile, `${JSON.stringify(header)}\n${JSON.stringify(assistant)}\n`);

		const untouched = await SessionManager.forkFrom(
			sourceFile,
			cwd,
			path.join(tempDir.path(), "untouched"),
			undefined,
			{
				suppressBreadcrumb: true,
			},
		);
		const untouchedEntries = await loadHistory(untouched.getSessionFile()!);
		expect(collectPendingToolCalls(untouchedEntries).map(call => call.toolCallId)).toEqual(["toolu_live"]);

		const repaired = await SessionManager.forkFrom(
			sourceFile,
			cwd,
			path.join(tempDir.path(), "repaired"),
			undefined,
			{
				suppressBreadcrumb: true,
				repairInterruptedTail: true,
			},
		);
		const repairedEntries = await loadHistory(repaired.getSessionFile()!);
		expect(collectPendingToolCalls(repairedEntries)).toEqual([]);
		const result = repairedEntries.find(
			(entry): entry is SessionMessageEntry => entry.type === "message" && entry.message.role === "toolResult",
		);
		if (!result || result.message.role !== "toolResult") throw new Error("expected a synthetic tool result");
		expect(result.message.toolCallId).toBe("toolu_live");
		expect(result.message.isError).toBe(true);
		expect(isSyntheticToolResultMessage(result.message)).toBe(true);
	});

	it("repairs only the active branch when sibling paths contain assistants and results", async () => {
		using tempDir = TempDir.createSync("@omp-session-fork-branch-repair-");
		const cwd = path.join(tempDir.path(), "project");
		const sessionDir = path.join(tempDir.path(), "sessions");
		await fs.mkdir(sessionDir, { recursive: true });
		const sourceFile = path.join(sessionDir, "source.jsonl");
		const timestamp = new Date().toISOString();
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "branched-parent",
			timestamp,
			cwd,
		};
		const usage = {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const activeAssistant = {
			type: "message",
			id: "active-assistant",
			parentId: null,
			timestamp,
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "toolu_active", name: "bash", arguments: { command: "sleep 40" } }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude",
				stopReason: "toolUse",
				timestamp: Date.now(),
				usage,
			},
		};
		const siblingResult = {
			type: "message",
			id: "sibling-result",
			parentId: "active-assistant",
			timestamp,
			message: {
				role: "toolResult",
				toolCallId: "toolu_active",
				toolName: "bash",
				content: [{ type: "text", text: "completed on abandoned branch" }],
				isError: false,
				timestamp: Date.now(),
			},
		};
		const siblingAssistant = {
			type: "message",
			id: "sibling-assistant",
			parentId: null,
			timestamp,
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "toolu_sibling", name: "read", arguments: { path: "old.txt" } }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude",
				stopReason: "toolUse",
				timestamp: Date.now(),
				usage,
			},
		};
		const activeLeaf = {
			type: "message",
			id: "active-leaf",
			parentId: "active-assistant",
			timestamp,
			message: { role: "user", content: "continue on this branch", timestamp: Date.now() },
		};
		await Bun.write(
			sourceFile,
			`${JSON.stringify(header)}\n${JSON.stringify(activeAssistant)}\n${JSON.stringify(siblingResult)}\n${JSON.stringify(siblingAssistant)}\n${JSON.stringify(activeLeaf)}\n`,
		);

		const forked = await SessionManager.forkFrom(sourceFile, cwd, path.join(tempDir.path(), "fork"), undefined, {
			suppressBreadcrumb: true,
			repairInterruptedTail: true,
		});
		const branch = forked.getBranch();
		expect(collectPendingToolCalls(branch)).toEqual([]);
		const syntheticResults = branch.filter(
			(entry): entry is SessionMessageEntry =>
				entry.type === "message" && isSyntheticToolResultMessage(entry.message),
		);
		expect(syntheticResults).toHaveLength(1);
		const result = syntheticResults[0]!.message;
		if (result.role !== "toolResult") throw new Error("expected a synthetic tool result");
		expect(result.toolCallId).toBe("toolu_active");
		expect(
			(await loadHistory(forked.getSessionFile()!)).some(
				entry =>
					entry.type === "message" &&
					isSyntheticToolResultMessage(entry.message) &&
					entry.message.toolCallId === "toolu_sibling",
			),
		).toBe(false);
	});

	it("leaves an already-terminal tail untouched when repair is requested", async () => {
		using tempDir = TempDir.createSync("@omp-session-fork-terminal-");
		const cwd = path.join(tempDir.path(), "project");
		const sessionDir = path.join(tempDir.path(), "sessions");
		await fs.mkdir(sessionDir, { recursive: true });
		const sourceFile = path.join(sessionDir, "source.jsonl");
		const timestamp = new Date().toISOString();
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "settled-parent",
			timestamp,
			cwd,
		};
		const assistant = {
			type: "message",
			id: "m1",
			parentId: null,
			timestamp,
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "toolu_done", name: "bash", arguments: { command: "echo hi" } }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude",
				stopReason: "toolUse",
				timestamp: Date.now(),
				usage: {
					input: 10,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 15,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
		};
		const toolResult = {
			type: "message",
			id: "m2",
			parentId: "m1",
			timestamp,
			message: {
				role: "toolResult",
				toolCallId: "toolu_done",
				toolName: "bash",
				content: [{ type: "text", text: "hi" }],
				isError: false,
				timestamp: Date.now(),
			},
		};
		await Bun.write(
			sourceFile,
			`${JSON.stringify(header)}\n${JSON.stringify(assistant)}\n${JSON.stringify(toolResult)}\n`,
		);

		const forked = await SessionManager.forkFrom(sourceFile, cwd, path.join(tempDir.path(), "fork"), undefined, {
			suppressBreadcrumb: true,
			repairInterruptedTail: true,
		});
		const forkedEntries = await loadHistory(forked.getSessionFile()!);
		const messageEntries = forkedEntries.filter(entry => entry.type === "message");
		expect(messageEntries).toHaveLength(2);
		expect(collectPendingToolCalls(forkedEntries)).toEqual([]);
		expect(forkedEntries.some(entry => entry.type === "message" && isSyntheticToolResultMessage(entry.message))).toBe(
			false,
		);
	});
});
