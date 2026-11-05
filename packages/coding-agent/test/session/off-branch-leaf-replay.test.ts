import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const tempDirs: TempDir[] = [];

function makeTempDir(prefix: string): string {
	const dir = TempDir.createSync(prefix);
	tempDirs.push(dir);
	return dir.path();
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

const user = (text: string) => ({ role: "user" as const, content: text, timestamp: 0 });
const answer = (text: string) => ({
	role: "assistant" as const,
	content: [{ type: "text" as const, text }],
	api: "anthropic-messages" as const,
	provider: "anthropic" as const,
	model: "claude-sonnet-4-20250514",
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop" as const,
	timestamp: 0,
});
const bashResult = {
	role: "bashExecution" as const,
	command: "sleep 5 && echo done",
	output: "done",
	exitCode: 0,
	cancelled: false,
	truncated: false,
	timestamp: 0,
};

describe("off-branch leaf replay", () => {
	it("keeps the active branch when a late bash result lands on an abandoned branch", async () => {
		const root = makeTempDir("@pi-off-branch-leaf-");
		const manager = SessionManager.create(root, path.join(root, "sessions"));
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file path");

		const firstUser = manager.appendMessage(user("first prompt"));
		const firstAnswer = manager.appendMessage(answer("first answer"));
		manager.branch(firstUser);
		const secondUser = manager.appendMessage(user("second prompt"));

		// A standalone `!` command started on the abandoned path finishes after
		// the rewind and is delivered back to the branch it started on.
		manager.appendMessageToBranch(bashResult, firstAnswer);

		expect(manager.getLeafId()).toBe(secondUser);
		expect(manager.buildSessionContext().messages.map(message => message.role)).toEqual(["user", "user"]);
		await manager.close();

		const reopened = await SessionManager.open(sessionFile);
		expect(reopened.getLeafId()).toBe(secondUser);
		expect(reopened.buildSessionContext().messages.map(message => message.role)).toEqual(["user", "user"]);
	});
});
