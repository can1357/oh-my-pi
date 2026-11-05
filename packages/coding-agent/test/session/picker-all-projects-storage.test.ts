/**
 * The all-projects resume picker lists the sessions the configured storage
 * holds. Under `session.storage: sql` a session is a row with no file on disk,
 * so a listing that scanned the sessions directory showed nothing.
 */
import { SQL } from "bun";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage, type SessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { getSessionsDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

const clients: SQL[] = [];
let tempDir: TempDir | undefined;
let settingsState: SettingsTestState | undefined;

beforeEach(() => {
	settingsState = beginSettingsTest();
});

afterEach(async () => {
	for (const client of clients.splice(0)) await client.end();
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
	tempDir?.removeSync();
	tempDir = undefined;
});

const backends: [string, (dir: TempDir) => Promise<SessionStorage>][] = [
	["file", async () => new FileSessionStorage()],
	[
		"sql",
		async dir => {
			const client = new SQL(`sqlite:${dir.join("sessions.db")}`);
			clients.push(client);
			return SqlSessionStorage.create({ client });
		},
	],
];

describe("all-projects resume picker over the session storage", () => {
	it.each(backends)("lists a session of another project that the %s storage holds", async (_name, open) => {
		tempDir = TempDir.createSync("@omp-picker-all-");
		setAgentDir(tempDir.join("agent"));
		const storage = await open(tempDir);
		const cwd = tempDir.join("other-project");
		const manager = SessionManager.create(cwd, path.join(getSessionsDir(), "--other-project--"), storage);
		manager.appendMessage({ role: "user", content: "question", timestamp: Date.now() });
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "answer" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test-model",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		await manager.flush();
		await manager.close();

		const listing = await SessionManager.listAllForPicker(storage);

		expect((await listing.complete).map(session => session.id)).toEqual([manager.getSessionId()]);
	});
});
