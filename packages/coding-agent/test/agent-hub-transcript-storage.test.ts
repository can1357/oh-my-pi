/**
 * The Agent Hub transcript viewer reads a parked subagent's transcript through
 * the session storage. Under `session.storage: sql` the transcript is a row
 * with no file behind it; a viewer that stats and reads the filesystem treats
 * it as missing and shows an empty transcript.
 */
import { SQL } from "bun";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { agentTranscriptSource } from "@oh-my-pi/pi-coding-agent/modes/agent-hub-runtime";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import {
	defaultSessionStorage,
	FileSessionStorage,
	type SessionStorage,
	setDefaultSessionStorage,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { AgentTranscriptViewer } from "@oh-my-pi/pi-tui/overlays/agent-transcript-viewer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";

const TS = "2026-11-02T00:00:00.000Z";
const AGENT_ID = "Worker";

function userLine(id: string, text: string): string {
	return JSON.stringify({
		type: "message",
		id,
		parentId: null,
		timestamp: TS,
		message: { role: "user", content: text, attribution: "user", timestamp: 0 },
	});
}

async function openStorage(kind: "file" | "sql"): Promise<{ storage: SessionStorage; close(): Promise<void> }> {
	if (kind === "file") return { storage: new FileSessionStorage(), close: async () => {} };
	const client = new SQL("sqlite::memory:");
	return { storage: await SqlSessionStorage.create({ client }), close: () => client.end() };
}

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	resetSettingsForTest();
});

describe("Agent Hub transcript viewer storage", () => {
	const cleanups: (() => Promise<void> | void)[] = [];

	afterEach(async () => {
		vi.useRealTimers();
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	});

	for (const kind of ["file", "sql"] as const) {
		it(`renders a parked subagent transcript held by ${kind} storage and tails what it appends`, async () => {
			const previous = defaultSessionStorage();
			const { storage, close } = await openStorage(kind);
			setDefaultSessionStorage(storage);
			cleanups.push(async () => {
				setDefaultSessionStorage(previous);
				await close();
			});
			const dir = TempDir.createSync("@omp-hub-transcript-storage-");
			cleanups.push(() => dir.removeSync());
			const sessionFile = dir.join("main", `${AGENT_ID}.jsonl`);
			const header = JSON.stringify({
				type: "session",
				version: CURRENT_SESSION_VERSION,
				id: AGENT_ID,
				timestamp: TS,
				cwd: "/tmp",
			});
			await storage.writeText(sessionFile, `${header}\n${userLine("u1", "FIRSTVIEWMARKER")}\n`);

			const agents = new AgentRegistry();
			agents.register({
				id: AGENT_ID,
				displayName: AGENT_ID,
				kind: "sub",
				parentId: "Main",
				session: null,
				sessionFile,
				status: "parked",
			});
			// The viewer asks for a render whenever loaded rows change: that is the signal to read the body.
			const renderWaiters: (() => void)[] = [];
			vi.useFakeTimers();
			const viewer = new AgentTranscriptViewer({
				transcript: agentTranscriptSource,
				agentId: AGENT_ID,
				registry: agents,
				ui: { requestRender: () => {}, requestComponentRender: () => {} } as never,
				cwd: "/tmp",
				expandKeys: ["ctrl+o"],
				hubKeys: ["ctrl+s"],
				requestRender: () => {
					for (const resolve of renderWaiters.splice(0)) resolve();
				},
				onClose: () => {},
				onHubClose: () => {},
			});
			cleanups.push(() => viewer.dispose());
			const body = () =>
				viewer
					.render(100)
					.map(line => Bun.stripANSI(line))
					.join("\n");
			const untilBodyShows = async (marker: string) => {
				while (!body().includes(marker)) {
					const { promise, resolve } = Promise.withResolvers<void>();
					renderWaiters.push(resolve);
					await promise;
				}
			};

			await untilBodyShows("FIRSTVIEWMARKER");

			const writer = storage.openWriter(sessionFile, { flags: "a" });
			await writer.append(`${userLine("u2", "APPENDEDVIEWMARKER")}\n`);
			await writer.close();
			// One poll interval notices the growth.
			vi.advanceTimersByTime(250);
			await untilBodyShows("APPENDEDVIEWMARKER");
			// The tail appends the new entry; it does not replay what was already shown.
			expect(body().match(/FIRSTVIEWMARKER/g)).toHaveLength(1);
		});
	}
});
