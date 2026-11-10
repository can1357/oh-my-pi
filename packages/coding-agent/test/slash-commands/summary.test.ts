import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { SessionEntry, SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SUMMARY_SLASH_COMMAND, listSessionSummaries } from "@oh-my-pi/pi-coding-agent/slash-commands/summary";
import type { TuiSlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInteractiveModeContext, createSessionStub } from "../helpers/interactive-mode-context";
import { makeAssistantMessage } from "../session-manager/helpers";

type SummaryManager = Pick<SessionManager, "getEntries" | "getSessionFile" | "getSessionId">;
let dir: TempDir;
const managers: SessionManager[] = [];
beforeEach(() => {
	dir = TempDir.createSync("omp-summary-test-");
});
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(managers.splice(0).map(manager => manager.close()));
	dir.removeSync();
});

function answer(
	text: string,
	timestamp: number,
	overrides: Partial<AssistantMessage> = {},
): SessionMessageEntry & { message: AssistantMessage } {
	return {
		type: "message",
		id: crypto.randomUUID(),
		parentId: null,
		timestamp: new Date(Number.isFinite(timestamp) ? timestamp : 0).toISOString(),
		message: { ...makeAssistantMessage(), content: [{ type: "text", text }], timestamp, ...overrides },
	};
}
function root(entries: SessionEntry[] = [], file?: string): SummaryManager {
	return { getEntries: () => entries, getSessionFile: () => file, getSessionId: () => "root" };
}
async function transcript(file: string, messages: SessionEntry[] = []): Promise<void> {
	const records = [
		{ type: "session", id: path.basename(file, ".jsonl"), timestamp: "2026-01-01T00:00:00Z", cwd: dir.path() },
		{
			type: "session_init",
			id: "init",
			parentId: null,
			timestamp: "2026-01-01T00:00:00Z",
			systemPrompt: [],
			tools: [],
		},
		...messages,
	];
	await Bun.write(file, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
}
function context(manager: SummaryManager): InteractiveModeContext {
	const ctx = createInteractiveModeContext({ sessionManager: manager, showCommandReport: vi.fn() });
	managers.push(ctx.sessionManager);
	return ctx;
}
const run = (ctx: InteractiveModeContext, args = "") =>
	SUMMARY_SLASH_COMMAND.handleTui?.({ name: "summary", args, text: `/summary ${args}` }, {
		ctx,
	} as TuiSlashCommandRuntime);

describe("/summary", () => {
	it.each([true, false])("deduplicates inherited replies (live consult=%s)", async liveConsult => {
		const main = path.join(dir.path(), "root.jsonl");
		const child = path.join(dir.path(), "root", "child.jsonl");
		const nested = path.join(dir.path(), "root", "child", "nested.jsonl");
		const outside = path.join(dir.path(), "other-root", "child.jsonl");
		const liveFile = path.join(dir.path(), "root", "live.jsonl");
		const entries = [
			answer("tie first", 100),
			answer("tie later", 100),
			answer("same words", 50),
			answer("same words", 60),
		];
		await transcript(main, entries);
		const childReply = answer("child tie", 100);
		const nestedReply = answer("nested newest", 120);
		await transcript(child, [...entries, childReply]);
		const consult = await SessionManager.forkFrom(child, dir.path(), dir.path(), undefined, {
			seance: true,
			suppressBreadcrumb: true,
			sessionFile: nested,
		});
		managers.push(consult);
		consult.appendSessionInit({ systemPrompt: [], task: "", tools: [] });
		consult.appendMessage(nestedReply.message);
		await consult.flush();
		await transcript(path.join(dir.path(), "root", "sibling.jsonl"), [answer("sibling branch", 90)]);
		await transcript(path.join(dir.path(), "root", "__advisor.review.jsonl"), [answer("private review", 200)]);
		await transcript(outside, [answer("outside root", 300)]);
		await transcript(liveFile, [answer("superseded disk reply", 400)]);
		const live = SessionManager.inMemory();
		managers.push(live);
		live.appendMessage(answer("unsaved child reply", 130).message);
		const registry = new AgentRegistry();
		registry.register({
			id: "child",
			displayName: "child",
			kind: "sub",
			session: null,
			sessionFile: outside,
			status: "parked",
		});
		registry.register({
			id: "nested",
			displayName: "nested",
			kind: "sub",
			session: liveConsult ? createSessionStub(consult, Settings.isolated()) : null,
			sessionFile: nested,
			status: liveConsult ? "idle" : "parked",
		});
		registry.register({
			id: "live",
			displayName: "live",
			kind: "sub",
			session: createSessionStub(live, Settings.isolated()),
			sessionFile: liveFile,
			status: "idle",
		});
		const beforeRefs = structuredClone(registry.list().map(ref => ({ ...ref, session: null })));
		const beforeEntries = structuredClone(live.getEntries());
		const beforeBytes = await Bun.file(liveFile).text();
		const result = await listSessionSummaries(root(entries, main), registry);
		expect(
			result.map(item => [item.agentName, path.basename(item.source), item.entryIndex, item.timestamp, item.text]),
		).toEqual([
			["live", "live.jsonl", 0, 130, "unsaved child reply"],
			["nested", "nested.jsonl", 7, 120, "nested newest"],
			["main", "root.jsonl", 1, 100, "tie later"],
			["main", "root.jsonl", 0, 100, "tie first"],
			["child", "child.jsonl", 5, 100, "child tie"],
			["sibling", "sibling.jsonl", 1, 90, "sibling branch"],
			["main", "root.jsonl", 3, 60, "same words"],
			["main", "root.jsonl", 2, 50, "same words"],
		]);
		expect(registry.list().map(ref => ({ ...ref, session: null }))).toEqual(beforeRefs);
		expect(live.getEntries()).toEqual(beforeEntries);
		expect(await Bun.file(liveFile).text()).toBe(beforeBytes);
	});

	it("extracts visible final text and orders legacy replies using timestamp fallbacks without persisting", async () => {
		const legacy = answer("legacy", Number.NaN);
		Reflect.deleteProperty(legacy, "id");
		legacy.timestamp = "invalid";
		const fallback = answer("entry timestamp", Number.NaN);
		fallback.timestamp = new Date(101).toISOString();
		const entries = [
			answer("", 100, {
				content: [
					{ type: "thinking", thinking: "secret" },
					{ type: "text", text: "Visible " },
					{ type: "text", text: "reply" },
				],
			}),
			...(["error", "aborted", "length"] as const).map(stopReason => answer("incomplete", 200, { stopReason })),
			answer("", 200, {
				stopReason: "toolUse",
				content: [{ type: "toolCall", id: "call", name: "yield", arguments: {} }],
			}),
			answer("", 200, { content: [{ type: "image", data: "abc", mimeType: "image/png" }] }),
			answer(" \n\t ", 200),
			legacy,
			structuredClone(legacy),
			fallback,
		];
		const result = await listSessionSummaries(root(entries), new AgentRegistry());
		expect(result.map(item => [item.text, item.timestamp])).toEqual([
			["entry timestamp", 101],
			["Visible reply", 100],
			["legacy", 0],
			["legacy", 0],
		]);
		expect(result.at(-1)?.entryIndex).toBe(entries.indexOf(legacy));
		expect(await fs.readdir(dir.path())).toEqual([]);
	});

	it("skips malformed and vanished children but surfaces real read errors instead of an empty report", async () => {
		const main = path.join(dir.path(), "root.jsonl");
		await transcript(main);
		const malformed = [null, [null], [{ type: "text" }]].map(content =>
			answer("", 200, { content: content as unknown as AssistantMessage["content"] }),
		);
		await transcript(path.join(dir.path(), "root", "valid.jsonl"), [...malformed, answer("kept reply", 100)]);
		const registry = new AgentRegistry();
		for (const id of ["malformed", "vanished"]) {
			const file = path.join(dir.path(), "root", `${id}.jsonl`);
			if (id === "malformed") await Bun.write(file, "not-json\n");
			registry.register({ id, displayName: id, kind: "sub", session: null, sessionFile: file, status: "parked" });
		}
		expect((await listSessionSummaries(root([], main), registry)).map(item => item.text)).toEqual(["kept reply"]);
		const blocked = path.join(dir.path(), "root", "blocked.jsonl");
		await fs.mkdir(blocked);
		registry.register({
			id: "blocked",
			displayName: "blocked",
			kind: "sub",
			session: null,
			sessionFile: blocked,
			status: "parked",
		});
		vi.spyOn(AgentRegistry, "global").mockReturnValue(registry);
		const ctx = context(root([], main));
		await run(ctx, "last");
		expect(ctx.showError).toHaveBeenCalled();
		expect(ctx.showCommandReport).not.toHaveBeenCalled();
	});

	it("does not open reports for empty, invalid, cancelled, or stale invocations", async () => {
		const ctx = context(root());
		await run(ctx);
		await run(ctx, "last");
		expect(ctx.showStatus).toHaveBeenCalled();
		expect(ctx.showHookSelector).not.toHaveBeenCalled();
		vi.spyOn(ctx.sessionManager, "getEntries").mockReturnValue([answer("available reply", 100)]);
		await run(ctx, "else");
		expect(ctx.showWarning).toHaveBeenCalled();
		expect(ctx.showHookSelector).not.toHaveBeenCalled();
		await run(ctx);
		vi.spyOn(ctx, "showHookSelector").mockImplementationOnce(async (_title, items) => {
			ctx.session = createSessionStub(ctx.sessionManager, Settings.isolated());
			const first = items[0];
			return typeof first === "string" ? first : first?.label;
		});
		await run(ctx);
		expect(ctx.showCommandReport).not.toHaveBeenCalled();
	});
});
