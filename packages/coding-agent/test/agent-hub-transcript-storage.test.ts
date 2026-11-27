/**
 * The Agent Hub transcript viewer reads a parked subagent's transcript through
 * the session storage. Under `session.storage: sql` the transcript is a row
 * with no file behind it; a viewer that stats and reads the filesystem treats
 * it as missing and shows an empty transcript. A long transcript is read in
 * windows of at most 8 MiB, and the viewer reads on from each window at the
 * next poll, also when it re-reads the whole transcript to verify it.
 */
import { SQL } from "bun";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { agentTranscriptSource, createAgentHubRuntime } from "@oh-my-pi/pi-coding-agent/modes/agent-hub-runtime";
import type { AgentTranscriptSource } from "@oh-my-pi/pi-coding-agent/modes/view-model/overlays/agent-transcript-viewer";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import {
	defaultSessionStorage,
	FileSessionStorage,
	type SessionStorage,
	setDefaultSessionStorage,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { initTheme } from "@oh-my-pi/pi-coding-agent/ui/theme/service";
import { TempDir } from "@oh-my-pi/pi-utils";
import { AgentTranscriptViewer } from "../src/ui/overlays/panels/agent-transcript-viewer";
import { AgentTranscriptViewerModel } from "../src/ui/overlays/panels/agent-transcript-viewer-model";
import { mountLayer } from "./helpers/layer-terminal";

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

type StoreKind = "file" | "sqlite" | "postgres";
const POSTGRES_URL = process.env.OMP_TEST_SQL_POSTGRES_URL;
/** File storage and SQLite always; PostgreSQL when `OMP_TEST_SQL_POSTGRES_URL` names a throwaway database. */
const STORE_KINDS: StoreKind[] = ["file", "sqlite", ...(POSTGRES_URL ? (["postgres"] as const) : [])];
let tableSeq = 0;

async function openStore(kind: StoreKind): Promise<{ storage: SessionStorage; close(): Promise<void> }> {
	if (kind === "file") return { storage: new FileSessionStorage(), close: async () => {} };
	if (kind === "sqlite") return openStorage("sql");
	const client = new SQL(POSTGRES_URL!);
	const table = `omp_hub_window_${process.pid}_${Date.now().toString(36)}_${tableSeq++}`;
	const storage = await SqlSessionStorage.create({ client, table, adapter: "postgres" });
	return {
		storage,
		close: async () => {
			await client.unsafe(`DROP TABLE IF EXISTS ${table}_parts`);
			await client.unsafe(`DROP TABLE IF EXISTS ${table}`);
			await client.end();
		},
	};
}

/** The bytes of one read window (`TRANSCRIPT_WINDOW_BYTES` in session-storage.ts). */
const WINDOW_BYTES = 8 * 1024 * 1024;

function sessionHeader(): string {
	return JSON.stringify({
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: AGENT_ID,
		timestamp: TS,
		cwd: "/tmp",
	});
}

/** The ids of the user blocks the model renders, in order. */
function userIds(model: AgentTranscriptViewerModel): string[] {
	return model.blocks().flatMap(block => (block.kind === "user" ? [block.id] : []));
}

function viewerModel(transcript: AgentTranscriptSource, sessionFile: string): AgentTranscriptViewerModel {
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
	return new AgentTranscriptViewerModel({
		transcript,
		agentId: AGENT_ID,
		registry: agents,
		terminalRows: () => 40,
		expandKeys: ["ctrl+o"],
		hubKeys: ["ctrl+s"],
		onClose: () => {},
		onHubClose: () => {},
		// The test polls by hand.
		pollMs: 3_600_000,
	});
}

/** Waits until every read the model started has landed, including reads a landed read started. */
async function settle(reads: { mock: { results: { value: unknown }[] } }): Promise<void> {
	for (let seen = -1; seen !== reads.mock.results.length;) {
		seen = reads.mock.results.length;
		for (const result of reads.mock.results) await result.value;
		await new Promise(resolve => setImmediate(resolve));
	}
}

/** Polls until a poll starts no read (the viewer idles); returns the polls that read. */
async function pollUntilIdle(
	model: AgentTranscriptViewerModel,
	reads: { mock: { calls: unknown[]; results: { value: unknown }[] } },
): Promise<number> {
	for (let polls = 0; polls < 100; polls++) {
		const before = reads.mock.calls.length;
		model.poll();
		await settle(reads);
		if (reads.mock.calls.length === before) return polls;
	}
	throw new Error("the viewer still read after 100 polls");
}

/**
 * A transcript source over `content` that answers every read with at most
 * `window` bytes, as the storage source does for a long transcript, and
 * records where each read ended.
 */
function windowedSource(
	content: { bytes: Buffer; mtimeMs: number },
	window: number,
): { source: AgentTranscriptSource; readFrom: ReturnType<typeof vi.fn>; readEnds: number[] } {
	const readEnds: number[] = [];
	const readFrom = vi.fn(async (_file: string, offset: number) => {
		const end = Math.min(content.bytes.byteLength, offset + window);
		readEnds.push(end);
		return content.bytes.subarray(offset, end).toString("utf-8");
	});
	const source: AgentTranscriptSource = {
		stat: () => ({ size: content.bytes.byteLength, mtimeMs: content.mtimeMs }),
		readFrom,
		parseEntries: agentTranscriptSource.parseEntries,
	};
	return { source, readFrom, readEnds };
}

function windowedTranscript(lines: number): Buffer {
	const all = [sessionHeader()];
	for (let n = 0; n < lines; n++) all.push(userLine(`u${n}`, `WINDOWLINE${n}MARK ${"w".repeat(300)}`));
	return Buffer.from(`${all.join("\n")}\n`);
}

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	initTheme();
});

afterAll(() => {
	resetSettingsForTest();
});

describe("Agent Hub transcript viewer storage", () => {
	const cleanups: (() => Promise<void> | void)[] = [];

	afterEach(async () => {
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
			const reads = vi.spyOn(agentTranscriptSource, "readFrom");
			cleanups.push(() => reads.mockRestore());
			const model = new AgentTranscriptViewerModel({
				transcript: agentTranscriptSource,
				agentId: AGENT_ID,
				registry: agents,
				terminalRows: () => 40,
				expandKeys: ["ctrl+o"],
				hubKeys: ["ctrl+s"],
				onClose: () => {},
				onHubClose: () => {},
				// The test polls by hand.
				pollMs: 3_600_000,
			});
			cleanups.push(() => model.dispose());
			const viewer = mountLayer(() => AgentTranscriptViewer({ model }), { columns: 100, rows: 40 });
			cleanups.push(() => viewer.dispose());
			const body = () => viewer.text(100);
			// Every read the viewer started has landed, including one a landed read chained.
			// A read's own continuation registered first, so it has run when the await resumes.
			const settleReads = async () => {
				for (const result of reads.mock.results) await result.value;
			};

			await settleReads();
			expect(body()).toContain("FIRSTVIEWMARKER");

			const writer = storage.openWriter(sessionFile, { flags: "a" });
			await writer.append(`${userLine("u2", "APPENDEDVIEWMARKER")}\n`);
			await writer.close();
			// One poll notices the growth.
			model.poll();
			await settleReads();
			expect(body()).toContain("APPENDEDVIEWMARKER");
			// The tail appends the new entry; it does not replay what was already shown.
			expect(body().match(/FIRSTVIEWMARKER/g)).toHaveLength(1);
		});
	}

	it("reads on at each poll from a source that answers a long transcript in windows", async () => {
		const content = { bytes: windowedTranscript(100), mtimeMs: 1 };
		const { source, readFrom, readEnds } = windowedSource(content, 16 * 1024);
		const model = viewerModel(source, "/sessions/main/Worker.jsonl");
		cleanups.push(() => model.dispose());
		await settle(readFrom);

		await pollUntilIdle(model, readFrom);

		// No poll idled while a window stopped short of the end: the reads reached it.
		expect(readEnds.at(-1)).toBe(content.bytes.byteLength);
		expect(readEnds.length).toBeGreaterThan(2);
		expect(userIds(model)).toEqual(Array.from({ length: 100 }, (_, n) => `u${n}`));
	});

	it("keeps an unchanged long transcript at its whole-transcript verify, reading it window by window", async () => {
		const content = { bytes: windowedTranscript(100), mtimeMs: 1 };
		const { source, readFrom, readEnds } = windowedSource(content, 16 * 1024);
		const model = viewerModel(source, "/sessions/main/Worker.jsonl");
		cleanups.push(() => model.dispose());
		await settle(readFrom);
		await pollUntilIdle(model, readFrom);
		const all = Array.from({ length: 100 }, (_, n) => `u${n}`);
		expect(userIds(model)).toEqual(all);

		// Idle polls: every 5th re-reads the anchor, the 20th re-reads the whole transcript from byte 0.
		const before = readFrom.mock.calls.length;
		for (let poll = 0; poll < 20; poll++) {
			model.poll();
			await settle(readFrom);
			expect(userIds(model)).toEqual(all);
		}
		const verify = readFrom.mock.calls.slice(before).map(([, offset]) => offset as number);
		// The verify read from 0 and on, window after window, to the end of what was rendered.
		expect(verify.filter(offset => offset === 0)).toHaveLength(1);
		expect(verify.length).toBeGreaterThan(4);
		expect(readEnds.at(-1)).toBe(content.bytes.byteLength);
	});

	it("rebuilds at its whole-transcript verify when a line past the first window changed at the same size", async () => {
		const content = { bytes: windowedTranscript(100), mtimeMs: 1 };
		const { source, readFrom } = windowedSource(content, 16 * 1024);
		const model = viewerModel(source, "/sessions/main/Worker.jsonl");
		cleanups.push(() => model.dispose());
		await settle(readFrom);
		await pollUntilIdle(model, readFrom);
		const changedAt = content.bytes.indexOf("WINDOWLINE80MARK");
		expect(changedAt).toBeGreaterThan(16 * 1024);

		// An edit that keeps the size and the mtime: only the whole-transcript verify can see it.
		content.bytes = Buffer.concat([
			content.bytes.subarray(0, changedAt),
			Buffer.from("REWRITTEN80MARK!"),
			content.bytes.subarray(changedAt + "WINDOWLINE80MARK".length),
		]);
		for (let poll = 0; poll < 20; poll++) {
			model.poll();
			await settle(readFrom);
		}
		await pollUntilIdle(model, readFrom);

		const texts = model.blocks().flatMap(block => (block.kind === "user" ? [block.text] : []));
		expect(texts).toHaveLength(100);
		expect(texts.filter(text => text.startsWith("REWRITTEN80MARK!"))).toHaveLength(1);
		expect(texts.filter(text => text.startsWith("WINDOWLINE80MARK"))).toHaveLength(0);
	});

	for (const kind of STORE_KINDS) {
		it(`reads a transcript longer than one window held by ${kind} storage in windows, and follows a rewrite`, async () => {
			const { storage, close } = await openStore(kind);
			cleanups.push(close);
			const dir = TempDir.createSync("@omp-hub-transcript-window-");
			cleanups.push(() => dir.removeSync());
			const sessionFile = dir.join("main", `${AGENT_ID}.jsonl`);
			const transcriptOf = (prefix: string, lines: number, bytes: number) => {
				const all = [sessionHeader()];
				for (let n = 0; n < lines; n++) all.push(userLine(`${prefix}${n}`, `${prefix}${n} ${"x".repeat(bytes)}`));
				return `${all.join("\n")}\n`;
			};
			// Three windows' worth: 20 lines of 1 MiB.
			await storage.writeText(sessionFile, transcriptOf("first", 20, 1024 * 1024));
			const { transcript } = createAgentHubRuntime({ storage, registry: new AgentRegistry() });
			// Each answer's size, read through the storage source the Agent Hub hands its viewer.
			const answers: number[] = [];
			const reads = vi.fn(async (file: string, offset: number) => {
				const text = await transcript.readFrom(file, offset);
				answers.push(Buffer.byteLength(text, "utf-8"));
				return text;
			});
			const model = viewerModel({ ...transcript, readFrom: reads }, sessionFile);
			cleanups.push(() => model.dispose());
			await settle(reads);

			await pollUntilIdle(model, reads);

			expect(userIds(model)).toEqual(Array.from({ length: 20 }, (_, n) => `first${n}`));
			// No read took the whole transcript: each answered one window at most, and it took several.
			expect(Math.max(...answers)).toBeLessThanOrEqual(WINDOW_BYTES);
			expect(answers.length).toBeGreaterThan(2);

			// A rewrite with other entries: the viewer rebuilds from the start and reads on to the new end.
			await storage.writeText(sessionFile, transcriptOf("second", 22, 1024 * 1024));
			answers.length = 0;
			await pollUntilIdle(model, reads);

			expect(userIds(model)).toEqual(Array.from({ length: 22 }, (_, n) => `second${n}`));
			expect(Math.max(...answers)).toBeLessThanOrEqual(WINDOW_BYTES);
			expect(answers.length).toBeGreaterThan(2);
		}, 60_000);

		it(`returns the next line to a read inside rendered text, though that line is longer than a window, from ${kind} storage`, async () => {
			const { storage, close } = await openStore(kind);
			cleanups.push(close);
			const dir = TempDir.createSync("@omp-hub-transcript-window-");
			cleanups.push(() => dir.removeSync());
			const sessionFile = dir.join("main", `${AGENT_ID}.jsonl`);
			const shown = [sessionHeader()];
			for (let n = 0; n < 20; n++) shown.push(userLine(`u${n}`, `shown ${n} ${"s".repeat(400)}`));
			const rendered = `${shown.join("\n")}\n`;
			const after: string[] = [];
			for (let n = 0; n < 20; n++) after.push(userLine(`tail${n}`, "t".repeat(1024 * 1024)));
			await storage.writeText(
				sessionFile,
				`${rendered}${userLine("long", "l".repeat(9 * 1024 * 1024))}\n${after.join("\n")}\n`,
			);
			const { transcript } = createAgentHubRuntime({ storage, registry: new AgentRegistry() });

			// The viewer reads again from up to 4096 characters before the end of what it rendered.
			const anchor = 4096;
			const text = await transcript.readFrom(sessionFile, Buffer.byteLength(rendered) - anchor);
			const unseen = text.slice(anchor, text.lastIndexOf("\n") + 1);
			const ids = unseen
				.split("\n")
				.filter(line => line.length > 0)
				.map(line => {
					const entry: unknown = JSON.parse(line);
					return typeof entry === "object" && entry !== null && "id" in entry ? entry.id : undefined;
				});
			// The window grew to take the long line whole, and the line after it, but not the whole rest.
			expect(ids.slice(0, 2)).toEqual(["long", "tail0"]);
			expect(Buffer.byteLength(text, "utf-8")).toBeLessThanOrEqual(2 * WINDOW_BYTES);
		}, 60_000);
	}
});
