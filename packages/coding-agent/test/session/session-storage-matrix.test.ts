/**
 * The same session lifecycle under file storage and under SQL storage
 * (`session.storage: sql`), asserting the same observable outcome for each
 * step. A path that still reaches session transcripts through the filesystem
 * sees nothing under SQL, so it fails here, on the `sql` row, rather than in
 * review.
 */
import { SQL } from "bun";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { runGcCommand } from "@oh-my-pi/pi-coding-agent/cli/gc-cli";
import { resolveSessionFileArg } from "@oh-my-pi/pi-coding-agent/cli/session-arg";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { exportSessionToHtml } from "@oh-my-pi/pi-coding-agent/export/html";
import { createSessionManager } from "@oh-my-pi/pi-coding-agent/main";
import { readRpcSubagentTranscript } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-subagents";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { registerPersistedSubagents } from "@oh-my-pi/pi-coding-agent/registry/persisted-agents";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { listAllSessions, resolveResumableSession } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	defaultSessionStorage,
	FileSessionStorage,
	type SessionStorage,
	setDefaultSessionStorage,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { collectSubSessions } from "@oh-my-pi/pi-coding-agent/session/sub-sessions";
import {
	getBlobsDir,
	getCustomSessionFilesDir,
	getSessionsDir,
	hashPath,
	setAgentDir,
	TempDir,
} from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

type Kind = "file" | "sql";

interface Fixture {
	kind: Kind;
	tempDir: TempDir;
	/** Agent dir `omp gc` maintains; its config selects the storage. */
	agentDir: string;
	cwd: string;
	sessionDir: string;
	storage: SessionStorage;
	/** A second client of the same store, as another omp process would hold. */
	otherClient(): Promise<SessionStorage>;
}

interface Seeded {
	manager: SessionManager;
	file: string;
	artifactsDir: string;
	child: string;
	grandchild: string;
	/** A tool artifact: a local file under file and SQL storage alike. */
	toolArtifact: string;
}

const CHILDREN = ["Worker", "Worker/Worker.Helper"];
const STEP_TIMEOUT_MS = 30_000;

let settingsState: SettingsTestState | undefined;
let previousStorage: SessionStorage;
let fixture: Fixture | undefined;
const clients: SQL[] = [];

beforeEach(() => {
	settingsState = beginSettingsTest();
	delete process.env.OMP_SESSION_STORAGE;
	delete process.env.OMP_SESSION_SQL_DSN_FILE;
	previousStorage = defaultSessionStorage();
	AgentRegistry.resetGlobalForTests();
});

afterEach(async () => {
	setDefaultSessionStorage(previousStorage);
	AgentRegistry.resetGlobalForTests();
	for (const client of clients.splice(0)) await client.end();
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
	AgentStorage.close();
	fixture?.tempDir.removeSync();
	fixture = undefined;
});

async function openFixture(kind: Kind): Promise<Fixture> {
	const tempDir = TempDir.createSync(`@omp-storage-matrix-${kind}-`);
	const agentDir = tempDir.join("agent");
	setAgentDir(agentDir);
	const cwd = tempDir.join("project");
	await fs.mkdir(cwd, { recursive: true });
	const sessionDir = path.join(getSessionsDir(agentDir), "--project--");
	let storage: SessionStorage;
	let otherClient: () => Promise<SessionStorage>;
	if (kind === "file") {
		storage = new FileSessionStorage();
		otherClient = async () => new FileSessionStorage();
	} else {
		const url = `sqlite:${tempDir.join("sessions.db")}`;
		const dsnFile = tempDir.join("session.dsn");
		await Bun.write(dsnFile, url);
		await Bun.write(
			path.join(agentDir, "config.yml"),
			["session:", "  storage: sql", "  sql:", `    dsnFile: ${dsnFile}`, ""].join("\n"),
		);
		const open = async (): Promise<SessionStorage> => {
			const client = new SQL(url);
			clients.push(client);
			return SqlSessionStorage.create({ client });
		};
		storage = await open();
		otherClient = open;
	}
	setDefaultSessionStorage(storage);
	fixture = { kind, tempDir, agentDir, cwd, sessionDir, storage, otherClient };
	return fixture;
}

function transcript(id: string, cwd: string, text: string): string {
	return `${[
		{ type: "session", version: 3, id, timestamp: "2026-11-01T00:00:00.000Z", cwd },
		{
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: "2026-11-01T00:00:01.000Z",
			message: { role: "user", content: text, timestamp: 1 },
		},
	]
		.map(entry => JSON.stringify(entry))
		.join("\n")}\n`;
}

function addTurn(manager: SessionManager, user: string, reply: string): void {
	manager.appendMessage({ role: "user", content: user, timestamp: Date.now() });
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: reply }],
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
}

/** A persisted session with one turn, a subagent, a grandchild, and a local tool artifact. */
async function seed(fx: Fixture, options: { childText?: string } = {}): Promise<Seeded> {
	const manager = SessionManager.create(fx.cwd, fx.sessionDir, fx.storage);
	addTurn(manager, "root question", "root answer");
	await manager.flush();
	const file = manager.getSessionFile()!;
	const artifactsDir = file.slice(0, -".jsonl".length);
	const child = path.join(artifactsDir, "Worker.jsonl");
	const grandchild = path.join(artifactsDir, "Worker", "Worker.Helper.jsonl");
	await fx.storage.writeText(child, transcript("worker", fx.cwd, options.childText ?? "worker brief"));
	await fx.storage.writeText(grandchild, transcript("helper", fx.cwd, "helper brief"));
	await fx.storage.drain();
	const toolArtifact = path.join(artifactsDir, "1.bash.log");
	await Bun.write(toolArtifact, "tool output");
	return { manager, file, artifactsDir, child, grandchild, toolArtifact };
}

async function childKeys(storage: SessionStorage, sessionFile: string): Promise<string[]> {
	return Object.keys(await collectSubSessions(sessionFile, { storage })).sort();
}

async function messageTexts(storage: SessionStorage, file: string): Promise<string[]> {
	const reopened = await SessionManager.open(file, path.dirname(file), storage);
	try {
		return reopened.getEntries().flatMap(entry => {
			if (entry.type !== "message") return [];
			const content = "content" in entry.message ? entry.message.content : undefined;
			if (typeof content === "string") return [content];
			return Array.isArray(content) ? content.flatMap(part => (part.type === "text" ? [part.text] : [])) : [];
		});
	} finally {
		await reopened.close();
	}
}

/** What `omp <args>` resumes or forks into: the session file it opened, or the error it reports. */
async function launchSession(args: string[], cwd: string): Promise<string> {
	try {
		const manager = await createSessionManager(parseArgs(args), cwd, Settings.isolated());
		const file = manager?.getSessionFile() ?? "no session";
		await manager?.close();
		return file;
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}

/**
 * The shortest prefix of `id`, at least 8 characters, that `other` does not
 * share. Session ids are UUIDv7: two sessions made within a minute share
 * their first 8 characters, so a fixed-length prefix would name both.
 */
function uniquePrefix(id: string, other: string): string {
	let length = 8;
	while (other.startsWith(id.slice(0, length))) length++;
	return id.slice(0, length);
}

function hashFor(label: string): string {
	return new Bun.SHA256().update(label).digest("hex");
}

async function agedBlob(agentDir: string, label: string): Promise<string> {
	const blob = path.join(getBlobsDir(agentDir), hashFor(label));
	await Bun.write(blob, label);
	const old = new Date(Date.now() - 86_400_000);
	await fs.utimes(blob, old, old);
	return blob;
}

for (const kind of ["file", "sql"] as const) {
	describe(`session lifecycle on ${kind} storage`, () => {
		test(
			"create: the session is stored and listed with its first message",
			async () => {
				const fx = await openFixture(kind);
				const { manager, file } = await seed(fx);
				await manager.close();

				expect(await fx.storage.exists(file)).toBe(true);
				const listed = await SessionManager.list(fx.cwd, fx.sessionDir, fx.storage);
				expect(listed.map(session => [session.path, session.firstMessage])).toEqual([[file, "root question"]]);
			},
			STEP_TIMEOUT_MS,
		);

		test(
			"list: a session another client creates later is listed without a restart",
			async () => {
				const fx = await openFixture(kind);
				const { manager, file } = await seed(fx);
				await manager.close();
				const other = await fx.otherClient();
				const later = SessionManager.create(fx.cwd, fx.sessionDir, other);
				addTurn(later, "from another process", "ok");
				await later.close();

				const listed = await SessionManager.list(fx.cwd, fx.sessionDir, fx.storage);
				expect(listed.map(session => session.path).sort()).toEqual([file, later.getSessionFile()!].sort());
				const all = await listAllSessions(fx.storage, getSessionsDir(fx.agentDir));
				expect(all.map(session => session.firstMessage).sort()).toEqual(["from another process", "root question"]);
			},
			STEP_TIMEOUT_MS,
		);

		test(
			"resume: the session is found by id prefix and reopens with its turns",
			async () => {
				const fx = await openFixture(kind);
				const { manager, file } = await seed(fx);
				const id = manager.getSessionId();
				await manager.close();

				const match = await resolveResumableSession(id.slice(0, 8), fx.cwd, fx.sessionDir, fx.storage);
				expect(match?.session.path).toBe(file);
				expect(await messageTexts(fx.storage, file)).toEqual(["root question", "root answer"]);
			},
			STEP_TIMEOUT_MS,
		);

		test(
			"resume by id: --resume, --fork and the subcommand resolver find a session by full id, id prefix and path, in the launch project and in another",
			async () => {
				const fx = await openFixture(kind);
				// `--project--` is another project's bucket: the launch directory's own bucket is elsewhere.
				const other = await seed(fx);
				const otherId = other.manager.getSessionId();
				await other.manager.close();
				const localDir = SessionManager.getDefaultSessionDir(fx.cwd, undefined, fx.storage);
				const local = SessionManager.create(fx.cwd, localDir, fx.storage);
				addTurn(local, "local question", "local answer");
				await local.close();
				const localFile = local.getSessionFile()!;
				const localId = local.getSessionId();
				expect(path.dirname(localFile)).not.toBe(path.dirname(other.file));

				const otherPrefix = uniquePrefix(otherId, localId);
				const localPrefix = uniquePrefix(localId, otherId);

				const resumed: string[] = [];
				for (const key of [otherId, otherPrefix, other.file, localId, localPrefix, localFile]) {
					resumed.push(await launchSession(["--resume", key], fx.cwd));
				}
				expect(resumed).toEqual([other.file, other.file, other.file, localFile, localFile, localFile]);

				const forkFile = await launchSession(["--fork", otherPrefix], fx.cwd);
				expect(forkFile).not.toBe(other.file);
				expect(await messageTexts(fx.storage, forkFile)).toEqual(["root question", "root answer"]);

				// `omp render` and `omp anonymize` resolve their session argument here.
				const resolved: string[] = [];
				for (const key of [otherId, otherPrefix, other.file]) {
					resolved.push(await resolveSessionFileArg(key, fx.cwd));
				}
				expect(resolved).toEqual([other.file, other.file, other.file]);
			},
			STEP_TIMEOUT_MS,
		);

		test(
			"rename: the new title is what listing and a reopen show",
			async () => {
				const fx = await openFixture(kind);
				const { manager, file } = await seed(fx);
				await manager.setSessionName("Renamed session", "user");
				await manager.close();

				const listed = await SessionManager.list(fx.cwd, fx.sessionDir, fx.storage);
				expect(listed.map(session => session.title)).toEqual(["Renamed session"]);
				const reopened = await SessionManager.open(file, fx.sessionDir, fx.storage);
				expect(reopened.getHeader()?.title).toBe("Renamed session");
				await reopened.close();
			},
			STEP_TIMEOUT_MS,
		);

		test(
			"fork: the fork carries the turns, the subagent tree, and the tool artifacts",
			async () => {
				const fx = await openFixture(kind);
				const { manager, file } = await seed(fx);
				await manager.close();

				const fork = await SessionManager.forkFrom(file, fx.cwd, fx.sessionDir, fx.storage, {
					suppressBreadcrumb: true,
				});
				const forkFile = fork.getSessionFile()!;
				await fork.close();

				expect(forkFile).not.toBe(file);
				expect(await messageTexts(fx.storage, forkFile)).toEqual(["root question", "root answer"]);
				expect(await childKeys(fx.storage, forkFile)).toEqual(CHILDREN);
				expect(await childKeys(fx.storage, file)).toEqual(CHILDREN);
				expect(await Bun.file(path.join(forkFile.slice(0, -6), "1.bash.log")).text()).toBe("tool output");
			},
			STEP_TIMEOUT_MS,
		);

		test(
			"branch: a branched session keeps the subagent tree and the tool artifacts",
			async () => {
				const fx = await openFixture(kind);
				const { manager, file } = await seed(fx);
				const branchFile = manager.createBranchedSession(manager.getLeafId()!, { copyArtifacts: true })!;
				await manager.flush();
				await manager.close();

				expect(branchFile).not.toBe(file);
				expect(await childKeys(fx.storage, branchFile)).toEqual(CHILDREN);
				expect(await Bun.file(path.join(branchFile.slice(0, -6), "1.bash.log")).text()).toBe("tool output");
			},
			STEP_TIMEOUT_MS,
		);

		test(
			"move: the transcript, its subagents, and its artifacts move together",
			async () => {
				const fx = await openFixture(kind);
				const { manager, file } = await seed(fx);
				const movedDir = path.join(getSessionsDir(fx.agentDir), "--moved--");

				await manager.moveTo(fx.tempDir.join("moved"), movedDir);
				const movedFile = manager.getSessionFile()!;
				await manager.close();

				expect(movedFile).toBe(path.join(movedDir, path.basename(file)));
				expect(await fx.storage.exists(file)).toBe(false);
				expect(await messageTexts(fx.storage, movedFile)).toEqual(["root question", "root answer"]);
				expect(await childKeys(fx.storage, movedFile)).toEqual(CHILDREN);
				expect(await childKeys(fx.storage, file)).toEqual([]);
				expect(await Bun.file(path.join(movedFile.slice(0, -6), "1.bash.log")).text()).toBe("tool output");
			},
			STEP_TIMEOUT_MS,
		);

		test(
			"export: the HTML export embeds the subagent transcripts",
			async () => {
				const fx = await openFixture(kind);
				const { manager } = await seed(fx);
				const outputPath = fx.tempDir.join("export.html");
				await exportSessionToHtml(manager, undefined, { outputPath });
				await manager.close();

				const html = await Bun.file(outputPath).text();
				const embedded = /<script id="session-data" type="application\/json">([^<]*)<\/script>/.exec(html)?.[1];
				const data = JSON.parse(Buffer.from(embedded ?? "", "base64").toString("utf8")) as {
					subSessions?: Record<string, unknown>;
				};
				expect(Object.keys(data.subSessions ?? {}).sort()).toEqual(CHILDREN);
			},
			STEP_TIMEOUT_MS,
		);

		test(
			"subagent transcript read: RPC reads and the roster restore the stored children",
			async () => {
				const fx = await openFixture(kind);
				const { manager, file, child, grandchild } = await seed(fx);
				await manager.close();

				const first = await readRpcSubagentTranscript(child, 0, fx.storage);
				expect(first.messages.map(message => ("content" in message ? message.content : undefined))).toEqual([
					"worker brief",
				]);
				expect(first.nextByte).toBe(Buffer.byteLength(transcript("worker", fx.cwd, "worker brief")));
				const again = await readRpcSubagentTranscript(child, first.nextByte, fx.storage);
				expect(again.messages).toEqual([]);

				const registry = new AgentRegistry();
				await registerPersistedSubagents(registry, file, { hydrateHistory: false, storage: fx.storage });
				expect(registry.get("Worker")?.sessionFile).toBe(child);
				expect(registry.get("Worker.Helper")?.sessionFile).toBe(grandchild);
			},
			STEP_TIMEOUT_MS,
		);

		test(
			"delete: the transcript, its subagents, and its artifacts go together",
			async () => {
				const fx = await openFixture(kind);
				const { manager, file, artifactsDir } = await seed(fx);
				await manager.close();

				await fx.storage.deleteSessionWithArtifacts(file);

				expect(await fx.storage.exists(file)).toBe(false);
				expect(await childKeys(fx.storage, file)).toEqual([]);
				expect(await Bun.file(path.join(artifactsDir, "1.bash.log")).exists()).toBe(false);
			},
			STEP_TIMEOUT_MS,
		);

		test(
			"gc preview and apply: blobs a subagent references and live pointers survive; orphans go",
			async () => {
				const fx = await openFixture(kind);
				const referenced = await agedBlob(fx.agentDir, "kept");
				const orphan = await agedBlob(fx.agentDir, "orphan");
				const { manager, file } = await seed(fx, { childText: `blob:sha256:${hashFor("kept")}` });
				await manager.close();
				const marker = path.join(getCustomSessionFilesDir(fx.agentDir), hashPath(file));
				await Bun.write(marker, file);
				const old = new Date(Date.now() - 3 * 86_400_000);
				await fs.utimes(marker, old, old);
				const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
				try {
					const preview = await runGcCommand({
						flags: {
							agentDir: fx.agentDir,
							blobs: true,
							stale: true,
							staleRetainNewest: 20,
							staleRetainDays: 30,
						},
					});
					expect(preview.blobs).toMatchObject({ wouldDelete: 1, deleted: 0 });
					expect(preview.stale).toMatchObject({ danglingMarkers: 0, wouldDelete: 0 });
					expect(await Bun.file(orphan).exists()).toBe(true);

					const applied = await runGcCommand({
						flags: {
							agentDir: fx.agentDir,
							blobs: true,
							stale: true,
							staleRetainNewest: 20,
							staleRetainDays: 30,
							apply: true,
						},
					});
					expect(applied.blobs).toMatchObject({ wouldDelete: 1, deleted: 1, errors: [] });
					expect(applied.stale).toMatchObject({ danglingMarkers: 0, deleted: 0 });
				} finally {
					stdout.mockRestore();
				}
				expect(await Bun.file(referenced).exists()).toBe(true);
				expect(await Bun.file(orphan).exists()).toBe(false);
				expect(await Bun.file(marker).exists()).toBe(true);
			},
			STEP_TIMEOUT_MS,
		);
	});
}

describe("session move onto a destination that cannot take every transcript", () => {
	test(
		"file storage: the move completes and the transcript it could not place stays at the source",
		async () => {
			const fx = await openFixture("file");
			const { manager, file, grandchild } = await seed(fx);
			const movedDir = path.join(getSessionsDir(fx.agentDir), "--moved--");
			// The destination already holds this session's directory, with a
			// plain file where the source keeps the `Worker/` subagent
			// directory. Merging strands `Worker`, and the storage pass that
			// follows cannot even ask whether `Worker/Worker.Helper.jsonl`
			// exists there: the lookup fails with ENOTDIR.
			const destArtifactsDir = path.join(movedDir, path.basename(file).slice(0, -".jsonl".length));
			await fs.mkdir(destArtifactsDir, { recursive: true });
			await Bun.write(path.join(destArtifactsDir, "Worker"), "not a directory");

			await manager.moveTo(fx.tempDir.join("moved"), movedDir);
			const movedFile = manager.getSessionFile()!;
			await manager.close();

			// The session moved: its file is at the destination and gone from
			// the source, so `--continue` and `history://` still find it.
			expect(movedFile).toBe(path.join(movedDir, path.basename(file)));
			expect(await fx.storage.exists(movedFile)).toBe(true);
			expect(await fx.storage.exists(file)).toBe(false);
			// The transcript that could not be placed stayed where it was
			// rather than being lost or left under the destination session.
			expect(await fx.storage.exists(grandchild)).toBe(true);
		},
		STEP_TIMEOUT_MS,
	);
});
