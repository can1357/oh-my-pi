import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Usage } from "@oh-my-pi/pi-ai";
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
import { FileSessionStorage, MemorySessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { getTerminalId } from "@oh-my-pi/pi-tui";
import { isTaskToolDetails, type TaskToolDetails } from "@oh-my-pi/pi-tui/tools/task";
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
				content: [{ type: "toolCall", id: "task-call-1", name: "task", arguments: { task: "inspect" } }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude",
				stopReason: "toolUse",
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
		const taskUsage = {
			input: 40,
			output: 10,
			cacheRead: 2,
			cacheWrite: 1,
			totalTokens: 53,
			premiumRequests: 3,
			credits: { cost: 10, committedCost: 10, acuCost: 2 },
			cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
		};
		const nestedUsage = {
			input: 5,
			output: 3,
			cacheRead: 1,
			cacheWrite: 2,
			totalTokens: 11,
			premiumRequests: 1,
			credits: { cost: 4, committedCost: 4, acuCost: 1 },
			cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
		};
		const nestedTaskSnapshot = (
			id: string,
			usage: typeof taskUsage,
			progressCost: number,
			nestedTask?: TaskToolDetails,
		): TaskToolDetails => ({
			projectAgentsDir: null,
			usage,
			totalDurationMs: 1,
			results: [
				{
					index: 0,
					id,
					agent: "worker",
					agentSource: "bundled",
					task: "inspect nested",
					exitCode: 0,
					output: "done",
					stderr: "",
					truncated: false,
					durationMs: 1,
					tokens: usage.totalTokens,
					requests: 1,
					usage,
					...(nestedTask ? { extractedToolData: { task: [nestedTask] } } : {}),
				},
			],
			progress: [
				{
					index: 0,
					id,
					agent: "worker",
					agentSource: "bundled",
					status: "completed",
					task: "inspect nested",
					recentTools: [],
					recentOutput: [],
					toolCount: 1,
					requests: 1,
					tokens: usage.totalTokens,
					cost: progressCost,
					durationMs: 1,
				},
			],
		});
		const grandchildUsage = { ...nestedUsage, input: 8, totalTokens: 16 };
		const inflightUsage = { ...nestedUsage, input: 6, totalTokens: 12 };
		const inflightGrandchildUsage = { ...nestedUsage, input: 9, totalTokens: 18 };
		const progressGrandchildUsage = { ...nestedUsage, input: 7, totalTokens: 14 };
		const grandchildDetails = nestedTaskSnapshot("grandchild", grandchildUsage, 17);
		const inflightGrandchildDetails = nestedTaskSnapshot("inflight-grandchild", inflightGrandchildUsage, 19);
		const inflightTaskDetails = nestedTaskSnapshot("inflight", inflightUsage, 9, inflightGrandchildDetails);
		const progressGrandchildDetails = nestedTaskSnapshot("progress-grandchild", progressGrandchildUsage, 21);
		const taskResultEntry = {
			type: "message",
			id: "task-result-1",
			parentId: "assistant-1",
			timestamp,
			message: {
				role: "toolResult",
				toolCallId: "task-call-1",
				toolName: "task",
				content: [{ type: "text", text: "completed worker" }],
				isError: false,
				timestamp: Date.now(),
				details: {
					usage: taskUsage,
					results: [
						{
							index: 0,
							id: "nested-agent",
							agent: "worker",
							agentSource: "bundled",
							task: "inspect",
							exitCode: 0,
							output: "done",
							stderr: "",
							truncated: false,
							durationMs: 1,
							tokens: 11,
							requests: 1,
							usage: nestedUsage,
							extractedToolData: { task: [grandchildDetails] },
						},
					],
					progress: [
						{
							index: 0,
							id: "nested-agent",
							agent: "worker",
							agentSource: "bundled",
							status: "completed",
							task: "inspect",
							recentTools: [],
							recentOutput: [],
							toolCount: 1,
							requests: 1,
							tokens: 11,
							cost: 10,
							inflightTaskDetails,
							extractedToolData: { task: [progressGrandchildDetails] },
							durationMs: 1,
						},
					],
				},
			},
		};
		await Bun.write(
			sourceFile,
			`${JSON.stringify(sourceHeader)}\n${JSON.stringify(assistantEntry)}\n${JSON.stringify(taskResultEntry)}\n`,
		);
		const sourceText = await Bun.file(sourceFile).text();
		const sourceManager = await SessionManager.open(sourceFile, sessionDir, undefined, { suppressBreadcrumb: true });

		const findAssistant = async (file: string) => {
			const entries = await loadEntriesFromFile(file);
			const entry = entries.find((e): e is SessionMessageEntry => e.type === "message");
			if (entry?.message.role !== "assistant") throw new Error("expected assistant message");
			return entry.message;
		};
		const findTaskDetails = async (file: string): Promise<TaskToolDetails> => {
			const entries = await loadEntriesFromFile(file);
			const entry = entries.find(
				(e): e is SessionMessageEntry =>
					e.type === "message" && e.message.role === "toolResult" && e.message.toolName === "task",
			);
			if (!entry || entry.message.role !== "toolResult") throw new Error("expected task tool result");
			if (!isTaskToolDetails(entry.message.details)) throw new Error("expected task tool details");
			return entry.message.details;
		};
		const findNestedTaskDetails = (extractedToolData: Record<string, unknown[]> | undefined): TaskToolDetails => {
			const nested = extractedToolData?.task?.[0];
			if (!isTaskToolDetails(nested)) throw new Error("expected nested task details");
			return nested;
		};
		const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
		const expectUsagePreserved = (actual: Usage | undefined, expected: Usage) => {
			expect(actual?.cost).toEqual(expected.cost);
			expect(actual?.credits).toEqual(expected.credits);
			expect(actual?.premiumRequests).toBe(expected.premiumRequests);
			expect(actual?.input).toBe(expected.input);
			expect(actual?.output).toBe(expected.output);
			expect(actual?.cacheRead).toBe(expected.cacheRead);
			expect(actual?.cacheWrite).toBe(expected.cacheWrite);
			expect(actual?.totalTokens).toBe(expected.totalTokens);
		};
		const expectUsageReset = (actual: Usage | undefined, expected: Usage) => {
			expect(actual?.cost).toEqual(zeroCost);
			expect(actual?.credits).toBeUndefined();
			expect(actual?.premiumRequests).toBeUndefined();
			expect(actual?.input).toBe(expected.input);
			expect(actual?.output).toBe(expected.output);
			expect(actual?.cacheRead).toBe(expected.cacheRead);
			expect(actual?.cacheWrite).toBe(expected.cacheWrite);
			expect(actual?.totalTokens).toBe(expected.totalTokens);
		};

		const preserved = await SessionManager.forkFrom(sourceFile, cwd, path.join(tempDir.path(), "keep"), undefined, {
			suppressBreadcrumb: true,
		});
		const preservedFile = preserved.getSessionFile();
		if (!preservedFile) throw new Error("expected preserved fork file");
		const preservedMessage = await findAssistant(preservedFile);
		expect(preservedMessage.usage.cost.total).toBe(6);
		expect(preservedMessage.usage.premiumRequests).toBe(2);
		const preservedTaskDetails = await findTaskDetails(preservedFile);
		expect(preserved.getUsageStatistics().cost).toBe(16);
		expect(preservedTaskDetails.usage?.cost).toEqual(taskUsage.cost);
		expect(preservedTaskDetails.usage?.credits).toEqual(taskUsage.credits);
		expect(preservedTaskDetails.usage?.premiumRequests).toBe(taskUsage.premiumRequests);
		expect(preservedTaskDetails.results[0]?.usage?.cost).toEqual(nestedUsage.cost);
		expect(preservedTaskDetails.results[0]?.usage?.credits).toEqual(nestedUsage.credits);
		expect(preservedTaskDetails.results[0]?.usage?.premiumRequests).toBe(nestedUsage.premiumRequests);
		expect(preservedTaskDetails.progress?.[0]?.cost).toBe(10);
		const preservedTaskResult = preservedTaskDetails.results[0];
		if (!preservedTaskResult) throw new Error("expected direct task result");
		const preservedGrandchild = findNestedTaskDetails(preservedTaskResult.extractedToolData);
		expectUsagePreserved(preservedGrandchild.usage, grandchildUsage);
		expectUsagePreserved(preservedGrandchild.results[0]?.usage, grandchildUsage);
		expect(preservedGrandchild.progress?.[0]?.cost).toBe(17);
		const preservedProgress = preservedTaskDetails.progress?.[0];
		if (!preservedProgress) throw new Error("expected task progress");
		const preservedInflight = preservedProgress.inflightTaskDetails;
		if (!preservedInflight) throw new Error("expected in-flight task details");
		expectUsagePreserved(preservedInflight.usage, inflightUsage);
		expectUsagePreserved(preservedInflight.results[0]?.usage, inflightUsage);
		expect(preservedInflight.progress?.[0]?.cost).toBe(9);
		const preservedInflightGrandchild = findNestedTaskDetails(preservedInflight.results[0]?.extractedToolData);
		expectUsagePreserved(preservedInflightGrandchild.usage, inflightGrandchildUsage);
		expectUsagePreserved(preservedInflightGrandchild.results[0]?.usage, inflightGrandchildUsage);
		expect(preservedInflightGrandchild.progress?.[0]?.cost).toBe(19);
		const preservedProgressGrandchild = findNestedTaskDetails(preservedProgress.extractedToolData);
		expectUsagePreserved(preservedProgressGrandchild.usage, progressGrandchildUsage);
		expectUsagePreserved(preservedProgressGrandchild.results[0]?.usage, progressGrandchildUsage);
		expect(preservedProgressGrandchild.progress?.[0]?.cost).toBe(21);

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
		const resetTaskDetails = await findTaskDetails(resetFile);
		expectUsageReset(resetTaskDetails.usage, taskUsage);
		expect(resetTaskDetails.results[0]?.usage?.cost).toEqual(zeroCost);
		expect(resetTaskDetails.results[0]?.usage?.credits).toBeUndefined();
		expect(resetTaskDetails.results[0]?.usage?.premiumRequests).toBeUndefined();
		expect(resetTaskDetails.progress?.[0]?.cost).toBe(0);
		expect(resetTaskDetails.progress?.[0]?.tokens).toBe(11);
		const resetTaskResult = resetTaskDetails.results[0];
		if (!resetTaskResult) throw new Error("expected direct task result");
		expectUsageReset(resetTaskResult.usage, nestedUsage);
		const resetGrandchild = findNestedTaskDetails(resetTaskResult.extractedToolData);
		expectUsageReset(resetGrandchild.usage, grandchildUsage);
		expectUsageReset(resetGrandchild.results[0]?.usage, grandchildUsage);
		expect(resetGrandchild.progress?.[0]?.cost).toBe(0);
		expect(resetGrandchild.progress?.[0]?.tokens).toBe(grandchildUsage.totalTokens);
		const resetProgress = resetTaskDetails.progress?.[0];
		if (!resetProgress) throw new Error("expected task progress");
		const resetInflight = resetProgress.inflightTaskDetails;
		if (!resetInflight) throw new Error("expected in-flight task details");
		expectUsageReset(resetInflight.usage, inflightUsage);
		expectUsageReset(resetInflight.results[0]?.usage, inflightUsage);
		expect(resetInflight.progress?.[0]?.cost).toBe(0);
		expect(resetInflight.progress?.[0]?.tokens).toBe(inflightUsage.totalTokens);
		const resetInflightGrandchild = findNestedTaskDetails(resetInflight.results[0]?.extractedToolData);
		expectUsageReset(resetInflightGrandchild.usage, inflightGrandchildUsage);
		expectUsageReset(resetInflightGrandchild.results[0]?.usage, inflightGrandchildUsage);
		expect(resetInflightGrandchild.progress?.[0]?.cost).toBe(0);
		expect(resetInflightGrandchild.progress?.[0]?.tokens).toBe(inflightGrandchildUsage.totalTokens);
		const resetProgressGrandchild = findNestedTaskDetails(resetProgress.extractedToolData);
		expectUsageReset(resetProgressGrandchild.usage, progressGrandchildUsage);
		expectUsageReset(resetProgressGrandchild.results[0]?.usage, progressGrandchildUsage);
		expect(resetProgressGrandchild.progress?.[0]?.cost).toBe(0);
		expect(resetProgressGrandchild.progress?.[0]?.tokens).toBe(progressGrandchildUsage.totalTokens);
		// Token counts are context, not spend — compaction anchors depend on them.
		expect(resetTaskDetails.usage?.input).toBe(40);
		expect(resetTaskDetails.usage?.cacheRead).toBe(2);
		expect(resetTaskDetails.usage?.totalTokens).toBe(53);
		expect(resetTaskDetails.results[0]?.usage?.input).toBe(5);
		expect(resetTaskDetails.results[0]?.usage?.cacheRead).toBe(1);
		expect(resetTaskDetails.results[0]?.usage?.totalTokens).toBe(11);
		const sourceMessage = sourceManager.getEntries().find(entry => entry.type === "message");
		if (sourceMessage?.type !== "message" || sourceMessage.message.role !== "assistant") {
			throw new Error("expected source assistant message");
		}
		expect(sourceMessage.message.usage.cost.total).toBe(6);
		expect(sourceMessage.message.usage.premiumRequests).toBe(2);
		expect(await Bun.file(sourceFile).text()).toBe(sourceText);
		await sourceManager.close();
	});

	for (const { name, createStorage, padding } of [
		{ name: "buffered file", createStorage: () => new FileSessionStorage(), padding: "" },
		{ name: "streamed file", createStorage: () => new FileSessionStorage(), padding: "x".repeat(8 * 1024 * 1024) },
		{ name: "memory", createStorage: () => new MemorySessionStorage(), padding: "" },
	]) {
		it(`keeps independently loaded ${name} entries unchanged when the fork migrates and branches`, async () => {
			using tempDir = TempDir.createSync("@omp-session-fork-ownership-");
			const cwd = tempDir.path();
			const sessionDir = path.join(cwd, "sessions");
			const sourceFile = path.join(sessionDir, "source.jsonl");
			const storage = createStorage();
			const timestamp = new Date().toISOString();
			const sourceText =
				[
					{ type: "session", version: 2, id: "legacy-source", timestamp, cwd },
					{
						type: "message",
						id: "user",
						parentId: null,
						timestamp,
						message: { role: "user", content: "source", timestamp: 1 },
					},
					{
						type: "message",
						id: "hook",
						parentId: "user",
						timestamp,
						message: {
							role: "hookMessage",
							customType: "legacy",
							content: padding || "legacy output",
							display: true,
							timestamp: 2,
						},
					},
				]
					.map(entry => JSON.stringify(entry))
					.join("\n") + "\n";
			await storage.writeText(sourceFile, sourceText);
			const loadedBeforeFork = await loadEntriesFromFile(sourceFile, storage);
			const forked = await SessionManager.forkFrom(sourceFile, cwd, path.join(cwd, "forks"), storage, {
				suppressBreadcrumb: true,
				copyArtifacts: false,
			});
			const migrated = forked.getEntries().find(entry => entry.id === "hook");
			expect(migrated).toMatchObject({ type: "message", message: { role: "custom", customType: "legacy" } });
			forked.branch("user");
			forked.appendMessage({ role: "user", content: "fork-only continuation", timestamp: 3 });
			expect(forked.buildSessionContext().messages).toMatchObject([
				{ role: "user", content: "source" },
				{ role: "user", content: "fork-only continuation" },
			]);
			await forked.close();
			expect(loadedBeforeFork[0]).toMatchObject({ type: "session", version: 2 });
			expect(loadedBeforeFork[2]).toMatchObject({ type: "message", message: { role: "hookMessage" } });
			expect(loadedBeforeFork).toEqual(await loadEntriesFromFile(sourceFile, storage));
			expect(await storage.readText(sourceFile)).toBe(sourceText);
		});
	}

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
