import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { SessionEntry, SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	SUMMARY_SLASH_COMMAND,
	listSessionSummaries,
	type SessionSummary,
} from "@oh-my-pi/pi-coding-agent/slash-commands/summary";
import type { ParsedSlashCommand, TuiSlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

type SummaryManager = Pick<SessionManager, "getEntries" | "getSessionFile" | "getSessionId">;
let tempDir = "";
const openManagers: SessionManager[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(openManagers.splice(0).map(manager => manager.close()));
	if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
	tempDir = "";
});

async function fixtureDir(): Promise<string> {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-summary-test-"));
	return tempDir;
}

function textAnswer(
	text: string,
	timestamp: number,
	options: { stopReason?: string; content?: unknown[]; errorMessage?: string } = {},
): SessionMessageEntry {
	return {
		type: "message",
		id: crypto.randomUUID(),
		parentId: null,
		timestamp: new Date(Number.isFinite(timestamp) ? timestamp : 0).toISOString(),
		message: {
			role: "assistant",
			content: options.content ?? [{ type: "text", text }],
			stopReason: options.stopReason ?? "stop",
			timestamp,
			...(options.errorMessage ? { errorMessage: options.errorMessage } : {}),
		},
	} as unknown as SessionMessageEntry;
}

function entryAt(entry: SessionEntry, ordinal: number, id = `entry-${ordinal}`): SessionEntry {
	return { ...entry, id } as SessionEntry;
}

function rootManager(entries: SessionEntry[], sessionFile: string | undefined, sessionId = "root"): SummaryManager {
	return {
		getEntries: () => entries,
		getSessionFile: () => sessionFile,
		getSessionId: () => sessionId,
	} as SummaryManager;
}

async function writeTranscript(file: string, id: string, messages: SessionEntry[] = []): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	const records = [
		{ type: "session", id, timestamp: "2026-01-01T00:00:00.000Z", cwd: path.dirname(file) },
		{
			type: "session_init",
			id: `init-${id}`,
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			systemPrompt: [],
			tools: [],
		},
		...messages,
	];
	await fs.writeFile(file, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
}

function summaryEntries(items: SessionSummary[]) {
	return items.map(({ agentName, source, entryIndex, timestamp, text }) => ({
		agentName,
		source: path.basename(source),
		entryIndex,
		timestamp,
		text,
	}));
}

describe("/summary collector", () => {
	it("collects every retained tree reply, orders deterministically, and scopes colliding ids to the root", async () => {
		const dir = await fixtureDir();
		const rootFile = path.join(dir, "root.jsonl");
		const childFile = path.join(dir, "root", "child.jsonl");
		const nestedFile = path.join(dir, "root", "child", "nested.jsonl");
		const siblingFile = path.join(dir, "root", "sibling.jsonl");
		const outsideFile = path.join(dir, "other-root", "collision.jsonl");
		const tie = Date.parse("2026-05-01T00:00:00.000Z");
		const rootEntries = [
			entryAt(textAnswer("root old", tie - 100), 0),
			entryAt(textAnswer("root tie first", tie), 1),
			entryAt(textAnswer("root tie later", tie), 2),
			entryAt(textAnswer("same words", tie - 50), 3),
			entryAt(textAnswer("same words", tie - 40), 4),
		];
		await writeTranscript(rootFile, "root", rootEntries);
		await writeTranscript(childFile, "child", [
			entryAt(textAnswer("child tie", tie), 2),
			entryAt(textAnswer("child newer", tie + 10), 3),
		]);
		await writeTranscript(nestedFile, "nested", [entryAt(textAnswer("nested newest", tie + 20), 2)]);
		await writeTranscript(siblingFile, "sibling", [entryAt(textAnswer("sibling branch", tie - 5), 2)]);
		await writeTranscript(path.join(dir, "root", "__advisor.review.jsonl"), "advisor", [
			entryAt(textAnswer("private review", tie + 100), 2),
		]);
		await writeTranscript(outsideFile, "child", [entryAt(textAnswer("outside root", tie + 200), 2)]);

		const registry = new AgentRegistry();
		registry.register({
			id: "child",
			displayName: "Outside collision",
			kind: "sub",
			parentId: "other",
			session: null,
			sessionFile: outsideFile,
			status: "parked",
		});
		const entries = await listSessionSummaries(rootManager(rootEntries, rootFile), registry);
		expect(summaryEntries(entries)).toEqual([
			{ agentName: "nested", source: "nested.jsonl", entryIndex: 1, timestamp: tie + 20, text: "nested newest" },
			{ agentName: "child", source: "child.jsonl", entryIndex: 2, timestamp: tie + 10, text: "child newer" },
			{ agentName: "main", source: "root.jsonl", entryIndex: 2, timestamp: tie, text: "root tie later" },
			{ agentName: "main", source: "root.jsonl", entryIndex: 1, timestamp: tie, text: "root tie first" },
			{ agentName: "child", source: "child.jsonl", entryIndex: 1, timestamp: tie, text: "child tie" },
			{ agentName: "sibling", source: "sibling.jsonl", entryIndex: 1, timestamp: tie - 5, text: "sibling branch" },
			{ agentName: "main", source: "root.jsonl", entryIndex: 4, timestamp: tie - 40, text: "same words" },
			{ agentName: "main", source: "root.jsonl", entryIndex: 3, timestamp: tie - 50, text: "same words" },
			{ agentName: "main", source: "root.jsonl", entryIndex: 0, timestamp: tie - 100, text: "root old" },
		]);
		expect(registry.get("child")?.sessionFile).toBe(outsideFile);
		expect(entries.some(item => item.text === "outside root" || item.text === "private review")).toBe(false);
	});

	it("includes only terminal visible text, tolerates legacy ids, and uses timestamp fallbacks", async () => {
		const now = Date.parse("2026-06-01T00:00:00.000Z");
		const eligible = [
			textAnswer("Visible one", now, {
				content: [
					{ type: "thinking", thinking: "secret" },
					{ type: "text", text: "Visible " },
					{ type: "text", text: "one" },
				],
			}),
			textAnswer("Visible fallback", now, { content: [{ type: "text", text: "Visible fallback" }] }),
			textAnswer("", now, { content: [{ type: "text", text: "  \n\t " }] }),
			textAnswer("error", now, { stopReason: "error" }),
			textAnswer("aborted", now, { stopReason: "aborted" }),
			textAnswer("length", now, { stopReason: "length" }),
			textAnswer("tool", now, {
				stopReason: "toolUse",
				content: [{ type: "toolCall", id: "call", name: "yield", arguments: {} }],
			}),
			textAnswer("generated image", now, { content: [{ type: "image", data: "abc", mimeType: "image/png" }] }),
			textAnswer("yield result", now, {
				content: [{ type: "toolResult", toolName: "yield", content: [{ type: "text", text: "structured" }] }],
			}),
		];
		const entries = eligible.map((entry, i) => entryAt(entry, i));
		const legacy = textAnswer("legacy", Number.NaN);
		const legacyRecord = legacy as unknown as { id?: string; message: { timestamp?: number }; timestamp: string };
		delete legacyRecord.id;
		delete legacyRecord.message.timestamp;
		legacyRecord.timestamp = "not a timestamp";
		entries.push(legacy);
		const fallback = textAnswer("entry timestamp", Number.NaN);
		const fallbackRecord = fallback as unknown as { message: { timestamp?: number }; timestamp: string };
		delete fallbackRecord.message.timestamp;
		fallbackRecord.timestamp = new Date(now + 1).toISOString();
		entries.push(entryAt(fallback, entries.length));

		const result = await listSessionSummaries(rootManager(entries, undefined), new AgentRegistry());
		expect(result.map(item => item.text)).toEqual(["entry timestamp", "Visible fallback", "Visible one", "legacy"]);
		expect(result.find(item => item.text === "legacy")).toMatchObject({ entryIndex: 9, timestamp: 0 });
		expect(result.some(item => item.text.includes("secret"))).toBe(false);
	});

	it("uses only in-memory root entries when unpersisted and handles empty, malformed, missing, and read-error sources", async () => {
		const dir = await fixtureDir();
		const unpersisted = await listSessionSummaries(
			rootManager([textAnswer("memory only", 100)], undefined, "memory-root"),
			new AgentRegistry(),
		);
		expect(summaryEntries(unpersisted)).toEqual([
			{ agentName: "main", source: "memory-root", entryIndex: 0, timestamp: 100, text: "memory only" },
		]);
		expect(await fs.readdir(dir)).toEqual([]);
		expect(await listSessionSummaries(rootManager([], undefined), new AgentRegistry())).toEqual([]);

		const rootFile = path.join(dir, "root.jsonl");
		const validChild = path.join(dir, "root", "valid.jsonl");
		const malformedChild = path.join(dir, "root", "malformed.jsonl");
		const missingChild = path.join(dir, "root", "vanished.jsonl");
		await writeTranscript(rootFile, "root", []);
		await writeTranscript(validChild, "valid", [entryAt(textAnswer("kept despite malformed sibling", 200), 2)]);
		await fs.mkdir(path.dirname(malformedChild), { recursive: true });
		await fs.writeFile(malformedChild, "not-json\n");
		const registry = new AgentRegistry();
		registry.register({
			id: "malformed",
			displayName: "Malformed",
			kind: "sub",
			session: null,
			sessionFile: malformedChild,
			status: "parked",
		});
		registry.register({
			id: "vanished",
			displayName: "Vanished",
			kind: "sub",
			session: null,
			sessionFile: missingChild,
			status: "parked",
		});
		await expect(listSessionSummaries(rootManager([], rootFile), registry)).resolves.toEqual([
			expect.objectContaining({ text: "kept despite malformed sibling" }),
		]);

		const inaccessible = path.join(dir, "root", "blocked.jsonl");
		await fs.mkdir(inaccessible, { recursive: true });
		registry.register({
			id: "blocked",
			displayName: "Blocked",
			kind: "sub",
			session: null,
			sessionFile: inaccessible,
			status: "parked",
		});
		await expect(listSessionSummaries(rootManager([], rootFile), registry)).rejects.toBeDefined();
	});
});

function commandHarness(manager: SummaryManager) {
	const editor = { setText: vi.fn(), getText: () => "" };
	const showCommandReport = vi.fn();
	const showStatus = vi.fn();
	const showError = vi.fn();
	const showWarning = vi.fn();
	const showHookSelector = vi.fn(
		async (_title: string, items: Array<{ label: string; preview?: string }>) => items[0]?.label,
	);
	const mainSession = {};
	const ctx = {
		session: mainSession,
		sessionManager: manager,
		editor,
		keybindings: { getKeys: () => ["ctrl+alt+r"] },
		showCommandReport,
		showStatus,
		showError,
		showWarning,
		showHookSelector,
	} as unknown as InteractiveModeContext;
	return {
		ctx,
		mainSession,
		showCommandReport,
		showStatus,
		showError,
		showWarning,
		showHookSelector,
		runtime: { ctx } as TuiSlashCommandRuntime,
	};
}

const parsed = (args: string): ParsedSlashCommand => ({
	name: "summary",
	args,
	text: `/summary${args ? ` ${args}` : ""}`,
});

describe("/summary command", () => {
	it("opens /last directly, and maps a picker selection to its item rather than preview text", async () => {
		const dir = await fixtureDir();
		const manager = SessionManager.create(dir, dir);
		openManagers.push(manager);
		manager.appendSessionInit({ systemPrompt: [], task: "summary test", tools: [] });
		manager.appendMessage(
			textAnswer(`same preview ${"x".repeat(180)} ROOT EARLIER BODY`, 100).message as AssistantMessage,
		);
		manager.appendMessage(
			textAnswer(`same preview ${"x".repeat(180)} ROOT NEWEST BODY`, 200).message as AssistantMessage,
		);
		const rootFile = manager.getSessionFile();
		if (!rootFile) throw new Error("Expected real root transcript");
		const childFile = path.join(rootFile.slice(0, -".jsonl".length), "same-preview.jsonl");
		await writeTranscript(childFile, "same-preview", [
			entryAt(textAnswer(`same preview ${"x".repeat(180)} CHILD EARLIER BODY`, 100), 2),
			entryAt(textAnswer(`same preview ${"x".repeat(180)} CHILD NEWEST BODY`, 300), 3),
		]);
		const registry = new AgentRegistry();
		vi.spyOn(AgentRegistry, "global").mockReturnValue(registry);
		const beforeBytes = await fs.readFile(rootFile);
		const beforeChildBytes = await fs.readFile(childFile);
		const beforeEntries = manager.getEntries().slice();
		const beforeLeaf = manager.getLeafId();
		const beforeRefs = registry.list().slice();
		const beforeSessionId = manager.getSessionId();
		const last = commandHarness(manager);
		await SUMMARY_SLASH_COMMAND.handleTui?.(parsed("last"), last.runtime);
		expect(last.showHookSelector).not.toHaveBeenCalled();
		expect(last.showCommandReport).toHaveBeenCalledTimes(1);
		expect(last.showCommandReport.mock.calls[0]?.[0].title).toContain("same-preview");

		const picker = commandHarness(manager);
		picker.showHookSelector.mockImplementationOnce(async (_title, items) => items[3]?.label);
		await SUMMARY_SLASH_COMMAND.handleTui?.(parsed(""), picker.runtime);
		expect(picker.showHookSelector).toHaveBeenCalledTimes(1);
		const options = picker.showHookSelector.mock.calls[0]?.[1] ?? [];
		expect(options).toHaveLength(4);
		expect(picker.showCommandReport).toHaveBeenCalledTimes(1);
		expect(picker.showCommandReport.mock.calls[0]?.[0].title).toContain("same-preview");
		const reportBody = picker.showCommandReport.mock.calls[0]?.[0].body;
		expect(reportBody.render(100).join("\n")).toContain("CHILD EARLIER BODY");
		expect(await fs.readFile(rootFile)).toEqual(beforeBytes);
		expect(await fs.readFile(childFile)).toEqual(beforeChildBytes);
		expect(manager.getEntries()).toEqual(beforeEntries);
		expect(manager.getLeafId()).toBe(beforeLeaf);
		expect(registry.list()).toEqual(beforeRefs);
		expect(manager.getSessionId()).toBe(beforeSessionId);
	});

	it("keeps empty and invalid invocations out of reports and ignores a picker result after session change", async () => {
		const empty = commandHarness(rootManager([], undefined));
		await SUMMARY_SLASH_COMMAND.handleTui?.(parsed(""), empty.runtime);
		await SUMMARY_SLASH_COMMAND.handleTui?.(parsed("last"), empty.runtime);
		expect(empty.showStatus).toHaveBeenCalled();
		expect(empty.showHookSelector).not.toHaveBeenCalled();
		expect(empty.showCommandReport).not.toHaveBeenCalled();

		const invalid = commandHarness(rootManager([textAnswer("present", 1)], undefined));
		await SUMMARY_SLASH_COMMAND.handleTui?.(parsed("else"), invalid.runtime);
		expect(invalid.showWarning).toHaveBeenCalled();
		expect(invalid.showCommandReport).not.toHaveBeenCalled();
		expect(invalid.showHookSelector).not.toHaveBeenCalled();

		const dir = await fixtureDir();
		const rootFile = path.join(dir, "root.jsonl");
		await writeTranscript(rootFile, "root", []);
		const blockedFile = path.join(dir, "root", "blocked.jsonl");
		await fs.mkdir(blockedFile, { recursive: true });
		const registry = new AgentRegistry();
		registry.register({
			id: "blocked",
			displayName: "Blocked",
			kind: "sub",
			session: null,
			sessionFile: blockedFile,
			status: "parked",
		});
		vi.spyOn(AgentRegistry, "global").mockReturnValue(registry);
		const failed = commandHarness(rootManager([], rootFile));
		await SUMMARY_SLASH_COMMAND.handleTui?.(parsed("last"), failed.runtime);
		expect(failed.showError).toHaveBeenCalled();
		expect(failed.showCommandReport).not.toHaveBeenCalled();

		const staleFile = path.join(dir, "stale.jsonl");
		await writeTranscript(staleFile, "stale", []);
		const manager = rootManager([textAnswer("stale reply", 1)], staleFile);
		const stale = commandHarness(manager);
		stale.showHookSelector.mockImplementationOnce(async (_title, items) => {
			stale.ctx.sessionManager = rootManager([], undefined) as SessionManager;
			return items[0]?.label;
		});
		await SUMMARY_SLASH_COMMAND.handleTui?.(parsed(""), stale.runtime);
		expect(stale.showHookSelector).toHaveBeenCalled();
		expect(stale.showCommandReport).not.toHaveBeenCalled();
	});
});
