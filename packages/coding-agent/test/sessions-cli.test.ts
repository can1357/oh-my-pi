import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import { runSessionRootsCommand, runSessionsCommand } from "@oh-my-pi/pi-coding-agent/cli/sessions-cli";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as sessionPins from "@oh-my-pi/pi-coding-agent/session/session-pins";

function session(overrides: Partial<SessionInfo> = {}): SessionInfo {
	return {
		path: "/sessions/project/2026-09-06_local.jsonl",
		id: "local",
		cwd: "/project",
		title: "Local session",
		created: new Date("2026-09-06T10:00:00.000Z"),
		modified: new Date("2026-09-06T11:00:00.000Z"),
		messageCount: 4,
		size: 1_024,
		firstMessage: "Build a session list command",
		allMessagesText: "private searchable transcript text",
		status: "complete",
		...overrides,
	};
}

function captureOutput(): string[] {
	const output: string[] = [];
	spyOn(process.stdout, "write").mockImplementation(chunk => {
		output.push(String(chunk));
		return true;
	});
	return output;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("sessions list CLI", () => {
	it("lists only the current working directory's saved sessions as JSON", async () => {
		const output = captureOutput();
		const list = spyOn(SessionManager, "listReadOnly").mockResolvedValue([session()]);
		spyOn(SessionManager, "listAll").mockResolvedValue([]);
		spyOn(sessionPins, "loadPinnedSessionIds").mockResolvedValue(new Set(["local"]));

		await runSessionsCommand({ flags: { all: false, json: true } });

		expect(list).toHaveBeenCalledWith(process.cwd());
		expect(JSON.parse(output.join("\n"))).toEqual([
			{
				id: "local",
				pinned: true,
				title: "Local session",
				preview: "Build a session list command",
				cwd: "/project",
				path: "/sessions/project/2026-09-06_local.jsonl",
				createdAt: "2026-09-06T10:00:00.000Z",
				modifiedAt: "2026-09-06T11:00:00.000Z",
				status: "complete",
				messageCount: 4,
				sizeBytes: 1_024,
			},
		]);
	});

	it("lists sessions from the requested working directory", async () => {
		const output = captureOutput();
		const list = spyOn(SessionManager, "listReadOnly").mockResolvedValue([session({ cwd: "/other-project" })]);
		spyOn(sessionPins, "loadPinnedSessionIds").mockResolvedValue(new Set());

		await runSessionsCommand({ flags: { all: false, cwd: "/other-project", json: true } });

		expect(list).toHaveBeenCalledWith("/other-project");
		expect(JSON.parse(output.join("\n"))[0].cwd).toBe("/other-project");
	});

	it("includes sessions from every project only when --all is selected", async () => {
		const output = captureOutput();
		const local = spyOn(SessionManager, "listReadOnly").mockResolvedValue([]);
		const all = spyOn(SessionManager, "listAll").mockResolvedValue([
			session(),
			session({
				id: "other",
				cwd: "/other-project",
				path: "/sessions/other/2026-09-06_other.jsonl",
				title: "Other project session",
			}),
		]);
		spyOn(sessionPins, "loadPinnedSessionIds").mockResolvedValue(new Set());

		await runSessionsCommand({ flags: { all: true, json: true } });

		expect(local).not.toHaveBeenCalled();
		expect(all).toHaveBeenCalledTimes(1);
		expect(JSON.parse(output.join("\n")).map((entry: { cwd: string }) => entry.cwd)).toEqual([
			"/project",
			"/other-project",
		]);
	});

	it("sanitizes cwd control characters in the global session table", async () => {
		const output = captureOutput();
		spyOn(SessionManager, "listAll").mockResolvedValue([session({ cwd: "/project\u001b[2J" })]);
		spyOn(sessionPins, "loadPinnedSessionIds").mockResolvedValue(new Set());

		await runSessionsCommand({ flags: { all: true, json: false } });

		expect(output.join("\n")).not.toContain("\u001b");
	});

	it("keeps JSON output to public, bounded session metadata", async () => {
		const output = captureOutput();
		const preview = "long preview ".repeat(20);
		spyOn(SessionManager, "listReadOnly").mockResolvedValue([session({ firstMessage: preview })]);
		spyOn(sessionPins, "loadPinnedSessionIds").mockResolvedValue(new Set());

		await runSessionsCommand({ flags: { all: false, json: true } });

		const [entry] = JSON.parse(output.join("\n")) as [{ preview: string }];
		expect(output.join("\n")).not.toContain("private searchable transcript text");
		expect(entry.preview).not.toBe(preview);
		expect(Bun.stringWidth(entry.preview)).toBeLessThanOrEqual(80);
	});

	it("renders an empty JSON array when the selected scope has no sessions", async () => {
		const output = captureOutput();
		spyOn(SessionManager, "listReadOnly").mockResolvedValue([]);
		spyOn(sessionPins, "loadPinnedSessionIds").mockResolvedValue(new Set());

		await runSessionsCommand({ flags: { all: false, json: true } });

		expect(output).toEqual(["[]\n"]);
	});
});

describe("session roots CLI", () => {
	it("aggregates session roots with pinned counts and recency ordering", async () => {
		const output = captureOutput();
		spyOn(SessionManager, "listAll").mockResolvedValue([
			session(),
			session({
				id: "newer",
				cwd: "/project",
				modified: new Date("2026-09-06T12:00:00.000Z"),
			}),
			session({
				id: "other",
				cwd: "/other-project",
				modified: new Date("2026-09-06T09:00:00.000Z"),
			}),
			session({
				id: "unknown",
				cwd: "",
				modified: new Date("2026-09-06T08:00:00.000Z"),
			}),
		]);
		spyOn(sessionPins, "loadPinnedSessionIds").mockResolvedValue(new Set(["local", "newer"]));

		await runSessionRootsCommand(true);

		expect(JSON.parse(output.join("\n"))).toEqual([
			{
				cwd: "/project",
				sessionCount: 2,
				pinnedCount: 2,
				latestModifiedAt: "2026-09-06T12:00:00.000Z",
			},
			{
				cwd: "/other-project",
				sessionCount: 1,
				pinnedCount: 0,
				latestModifiedAt: "2026-09-06T09:00:00.000Z",
			},
			{
				cwd: "(unknown cwd)",
				sessionCount: 1,
				pinnedCount: 0,
				latestModifiedAt: "2026-09-06T08:00:00.000Z",
			},
		]);
	});

	it("sanitizes cwd control characters in the roots table", async () => {
		const output = captureOutput();
		spyOn(SessionManager, "listAll").mockResolvedValue([session({ cwd: "/project\u001b[2J" })]);
		spyOn(sessionPins, "loadPinnedSessionIds").mockResolvedValue(new Set());

		await runSessionRootsCommand(false);

		expect(output.join("\n")).not.toContain("\u001b");
	});

	it("renders an empty JSON array when no session roots exist", async () => {
		const output = captureOutput();
		spyOn(SessionManager, "listAll").mockResolvedValue([]);
		spyOn(sessionPins, "loadPinnedSessionIds").mockResolvedValue(new Set());

		await runSessionRootsCommand(true);

		expect(output).toEqual(["[]\n"]);
	});
});
