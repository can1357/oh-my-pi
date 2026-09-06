import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import { runSessionsCommand } from "@oh-my-pi/pi-coding-agent/cli/sessions-cli";
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
		const list = spyOn(SessionManager, "list").mockResolvedValue([session()]);
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

	it("includes sessions from every project only when --all is selected", async () => {
		const output = captureOutput();
		const local = spyOn(SessionManager, "list").mockResolvedValue([]);
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

	it("keeps JSON output to public, bounded session metadata", async () => {
		const output = captureOutput();
		const preview = "long preview ".repeat(20);
		spyOn(SessionManager, "list").mockResolvedValue([session({ firstMessage: preview })]);
		spyOn(sessionPins, "loadPinnedSessionIds").mockResolvedValue(new Set());

		await runSessionsCommand({ flags: { all: false, json: true } });

		const [entry] = JSON.parse(output.join("\n")) as [{ preview: string }];
		expect(output.join("\n")).not.toContain("private searchable transcript text");
		expect(entry.preview).not.toBe(preview);
		expect(Bun.stringWidth(entry.preview)).toBeLessThanOrEqual(80);
	});

	it("renders an empty JSON array when the selected scope has no sessions", async () => {
		const output = captureOutput();
		spyOn(SessionManager, "list").mockResolvedValue([]);
		spyOn(sessionPins, "loadPinnedSessionIds").mockResolvedValue(new Set());

		await runSessionsCommand({ flags: { all: false, json: true } });

		expect(output).toEqual(["[]\n"]);
	});
});
