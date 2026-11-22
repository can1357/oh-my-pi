/**
 * Another writer appends to a session a manager has open: a second omp process on the same session (`omp --resume`
 * in another terminal), each with its own connection, as SQL storage gives every process its own client.
 *
 * On every store that defers publishes (SQL, Redis), a publish the manager queued that the store refused because of
 * that append (the rewrite an entry starts after a record the loader skipped, or after a caller's rejected rewrite) is
 * recovered: the manager reads the session back, keeps the other writer's entries and publishes what the store lacks.
 * One recovery runs at a time, no full write starts while it is pending, and a failed read during it is reported
 * without moving the session.
 *
 * A rewrite a caller asks for (`rewriteEntries()`) was computed from a stale view: on the file store it is recovered;
 * on a store that defers publishes it rejects with `SessionWriteConflictError`, changes nothing and latches nothing,
 * and the session's next entry recovers as above.
 *
 * Every case writes a session of its own id: the file store's ownership lease is keyed by id, and every bun test
 * process with the same temp directory shares it.
 *
 * Every store: the file store and SQLite always, PostgreSQL and MySQL when `OMP_TEST_SQL_POSTGRES_URL` /
 * `OMP_TEST_SQL_MYSQL_URL` name a throwaway database, Redis when `OMP_TEST_REDIS_URL` names a throwaway Redis 7.
 */
import { RedisClient } from "bun";
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { RedisSessionStorage } from "@oh-my-pi/pi-coding-agent/session/redis-session-storage";
import { listSessions } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { type SessionStorage, SessionWriteConflictError } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { createAssistantMessage } from "../helpers/agent-session-setup";
import { type Backend, BACKENDS, useSqlSessionTestEnv } from "../helpers/sql-session-archive";

const headerFor = (id: string) =>
	`${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-11-21T00:00:00.000Z", cwd: "/w" })}\n`;
const userLine = (id: string, parentId: string | null, text: string) =>
	`${JSON.stringify({ type: "message", id, parentId, timestamp: "2026-11-21T00:00:01.000Z", message: { role: "user", content: text, timestamp: 1 } })}\n`;
const user = (text: string) => ({ role: "user" as const, content: text, timestamp: Date.now() });
/** A record the loader skips: the session's next entry rewrites the whole file, as after a crash-torn line. */
const SKIPPED = "not json\n";

const env = useSqlSessionTestEnv("@omp-foreign-append-");

type Store = Backend | "redis";
const STORES: Store[] = [...BACKENDS, ...(process.env.OMP_TEST_REDIS_URL ? (["redis"] as const) : [])];

/** Each test opens sessions through managers and closes its connections, which takes seconds on a loaded machine. */
const TIMEOUT = 60_000;

/** A store over the session data, a new connection on each call, as each omp process holds its own. */
function opener(store: Store): () => Promise<SessionStorage> {
	if (store !== "redis") return env.backendOpener(store);
	const prefix = `omp-test-foreign-append:${env.uniqueTag()}:`;
	const clients: RedisClient[] = [];
	env.cleanups.push(async () => {
		const client = new RedisClient(process.env.OMP_TEST_REDIS_URL!);
		for (const key of (await client.send("KEYS", [`${prefix}*`])) as string[]) await client.send("DEL", [key]);
		client.close();
		for (const open of clients.splice(0)) open.close();
	});
	return async () => {
		const client = new RedisClient(process.env.OMP_TEST_REDIS_URL!);
		clients.push(client);
		return RedisSessionStorage.create({ client, prefix });
	};
}

/** A call a test holds: `reached` resolves when the call arrives, which then waits for `open`. */
interface Gate {
	armed: boolean;
	reached: PromiseWithResolvers<void>;
	open: PromiseWithResolvers<void>;
}

/** The storage a manager under test writes through, and the calls a test can hold, fail or watch there. */
interface HeldStorage {
	proxy: SessionStorage;
	refresh: Gate;
	write: Gate;
	/** While armed, the next `readText` rejects once with `error`. */
	readFailure: { armed: boolean; fired: number; error: Error };
	/** Runs before every atomic write of a whole transcript. */
	beforeAtomicWrite: (() => Promise<void>) | undefined;
	/** Runs once, synchronously, right after the next whole-transcript atomic write resolves, before its caller resumes. */
	afterAtomicWrite: (() => void) | undefined;
	/** Whole-transcript writes the manager queued (`writeTextSync`, `writeLinesSync`). */
	syncWrites: number;
}

/** One case's session, the manager writing it, and another omp process's appends to it. */
interface Session {
	id: string;
	connect: () => Promise<SessionStorage>;
	dir: string;
	file: string;
	manager: SessionManager;
	notices: unknown[];
	gates: HeldStorage;
	append(line: string): Promise<void>;
	stored(): Promise<string>;
}

/**
 * `storage` as the manager under test sees it: while armed, `refresh` and the atomic write each wait at a gate the
 * test opens, and the next `readText` fails once (by default as a dropped connection does); the sync whole-transcript
 * writes are counted. Every other member is the storage's own, bound to it.
 */
function held(storage: SessionStorage): HeldStorage {
	const handle: HeldStorage = {
		proxy: storage,
		refresh: { armed: false, reached: Promise.withResolvers(), open: Promise.withResolvers() },
		write: { armed: false, reached: Promise.withResolvers(), open: Promise.withResolvers() },
		readFailure: { armed: false, fired: 0, error: new Error("Connection closed") },
		beforeAtomicWrite: undefined,
		afterAtomicWrite: undefined,
		syncWrites: 0,
	};
	const wait = async (at: Gate) => {
		if (!at.armed) return;
		at.armed = false;
		at.reached.resolve();
		await at.open.promise;
	};
	handle.proxy = new Proxy(storage, {
		get(target, prop) {
			const value = Reflect.get(target, prop, target);
			if (typeof value !== "function") return value;
			if (prop === "refresh") {
				return async (...args: unknown[]) => {
					await wait(handle.refresh);
					return value.apply(target, args);
				};
			}
			if (prop === "writeTextAtomic" || prop === "writeLinesAtomic") {
				return async (...args: unknown[]) => {
					await handle.beforeAtomicWrite?.();
					await wait(handle.write);
					const result = await value.apply(target, args);
					const after = handle.afterAtomicWrite;
					handle.afterAtomicWrite = undefined;
					after?.();
					return result;
				};
			}
			if (prop === "writeTextSync" || prop === "writeLinesSync") {
				return (...args: unknown[]) => {
					handle.syncWrites++;
					return value.apply(target, args);
				};
			}
			if (prop === "readText") {
				return (...args: unknown[]) => {
					if (!handle.readFailure.armed) return value.apply(target, args);
					handle.readFailure.armed = false;
					handle.readFailure.fired++;
					return Promise.reject(handle.readFailure.error);
				};
			}
			return value.bind(target);
		},
	}) as SessionStorage;
	return handle;
}

const ids = (manager: SessionManager) => manager.getEntries().map(entry => entry.id);

/** The id and parent of each stored entry (a line with both); the title slot and the header have no parent. */
function storedLinks(content: string): Array<{ id: string; parentId: unknown }> {
	const links: Array<{ id: string; parentId: unknown }> = [];
	for (const line of content.split("\n")) {
		if (!line) continue;
		const value: unknown = JSON.parse(line);
		if (value && typeof value === "object" && "id" in value && typeof value.id === "string" && "parentId" in value) {
			links.push({ id: value.id, parentId: value.parentId });
		}
	}
	return links;
}

for (const store of STORES) {
	const defers = store !== "file";
	describe(`a ${store} session another writer appends to`, () => {
		/** A session of its own id holding `lines` after its header, opened by a manager through a held storage. */
		async function open(...lines: string[]): Promise<Session> {
			const id = Bun.randomUUIDv7();
			const connect = opener(store);
			const dir = env.tempDir.join(`sessions-${env.uniqueTag()}`);
			fs.mkdirSync(dir, { recursive: true });
			const file = path.join(dir, "s.jsonl");
			await (await connect()).writeText(file, headerFor(id) + lines.join(""));
			const gates = held(await connect());
			const manager = await SessionManager.open(file, dir, gates.proxy, { suppressBreadcrumb: true });
			const notices: unknown[] = [];
			manager.onPersistenceNotice(notice => notices.push(notice));
			return {
				id,
				connect,
				dir,
				file,
				manager,
				notices,
				gates,
				/** Another omp process: a connection of its own, which appends a whole line and is closed. */
				async append(line) {
					const other = await connect();
					const writer = other.openWriter(file);
					await writer.append(line);
					await writer.close();
					await other.drain();
				},
				/** The session as a reader on a connection of its own finds it. */
				async stored() {
					return (await connect()).readText(file);
				},
			};
		}

		/** The manager kept its file and its id, and moved nowhere. */
		function expectSameSession(s: Session) {
			expect({ file: s.manager.getSessionFile(), id: s.manager.getSessionId(), notices: s.notices }).toEqual({
				file: s.file,
				id: s.id,
				notices: [],
			});
		}

		/** The directory lists this one session, and it stores each of `entryIds` exactly once. */
		async function expectStoredOnce(s: Session, entryIds: readonly string[]): Promise<string> {
			const reader = await s.connect();
			expect((await listSessions(s.dir, reader)).map(info => [info.path, info.id])).toEqual([[s.file, s.id]]);
			const stored = await reader.readText(s.file);
			const count = (id: string) => stored.split(`"id":"${id}"`).length - 1;
			expect(Object.fromEntries(entryIds.map(id => [id, count(id)]))).toEqual(
				Object.fromEntries(entryIds.map(id => [id, 1])),
			);
			return stored;
		}

		it(
			defers
				? "rejects a caller's stale rewrite, changes and latches nothing, and saves later entries"
				: "keeps the other writer's entry through a caller's stale rewrite",
			async () => {
				const s = await open(userLine("m1", null, "a turn"));
				try {
					await s.append(userLine("f1", "m1", "another writer's turn"));
					const durable = await s.stored();
					const memory = ids(s.manager);
					const rejected = await s.manager.rewriteEntries().then(
						() => undefined,
						(err: unknown) => err,
					);
					if (defers) {
						expect(rejected).toBeInstanceOf(SessionWriteConflictError);
						expect(ids(s.manager)).toEqual(memory);
						expect(await s.stored()).toBe(durable);
						// Nothing latched: a flush resolves before any later entry.
						await s.manager.flush();
					} else {
						expect(rejected).toBeUndefined();
					}
					const later = s.manager.appendMessage(user("a later turn"));
					await s.manager.flush();
					expectSameSession(s);
					await expectStoredOnce(s, ["m1", "f1", later]);
				} finally {
					await s.manager.close().catch(() => undefined);
				}
			},
			TIMEOUT,
		);

		if (defers)
			it(
				"closes cleanly right after a caller's rejected rewrite",
				async () => {
					const s = await open(userLine("m1", null, "a turn"));
					await s.append(userLine("f1", "m1", "another writer's turn"));
					await expect(s.manager.rewriteEntries()).rejects.toBeInstanceOf(SessionWriteConflictError);
					await s.manager.close();
					expectSameSession(s);
					await expectStoredOnce(s, ["m1", "f1"]);
				},
				TIMEOUT,
			);

		it(
			"keeps the other writer's entry through the rewrite it queued at the next entry, and stores its own once",
			async () => {
				const s = await open(SKIPPED, userLine("m1", null, "a turn"));
				try {
					await s.append(userLine("f1", "m1", "another writer's turn"));
					const own = [
						s.manager.appendMessage(user("a second turn")),
						s.manager.appendMessage(createAssistantMessage("a reply")),
					];
					await s.manager.flush();
					expectSameSession(s);
					expect(ids(s.manager)).toContain("f1");
					await expectStoredOnce(s, ["m1", "f1", ...own]);
					own.push(s.manager.appendMessage(user("a later turn")));
					await s.manager.flush();
					await expectStoredOnce(s, ["m1", "f1", ...own]);
				} finally {
					await s.manager.close().catch(() => undefined);
				}
			},
			TIMEOUT,
		);

		if (defers)
			it(
				"recovers in place through more separate recoveries than the bound on recoveries in a row",
				async () => {
					const s = await open(userLine("m1", null, "a turn"));
					const stored = ["m1"];
					try {
						// Each cycle's recovery lands; only recoveries that do not land count toward moving off as contested.
						for (let cycle = 1; cycle <= 5; cycle++) {
							await s.append(userLine(`f${cycle}`, "m1", `another writer's turn ${cycle}`));
							stored.push(`f${cycle}`);
							await expect(s.manager.rewriteEntries()).rejects.toBeInstanceOf(SessionWriteConflictError);
							stored.push(s.manager.appendMessage(user(`own turn ${cycle}`)));
							await s.manager.flush();
							expectSameSession(s);
						}
						await expectStoredOnce(s, stored);
					} finally {
						await s.manager.close().catch(() => undefined);
					}
				},
				TIMEOUT,
			);

		if (defers)
			it(
				"goes on saving when a caller asks for a rewrite while a recovery waits",
				async () => {
					const s = await open(SKIPPED, userLine("m1", null, "a turn"));
					try {
						await s.append(userLine("f1", "m1", "another writer's turn"));
						s.gates.refresh.armed = true;
						const own = [s.manager.appendMessage(user("E1"))];
						await s.gates.refresh.reached.promise;
						// The rewrite waits for the recovery, which keeps the other writer's entry, so it meets no stale file.
						const rewrite = s.manager.rewriteEntries();
						own.push(s.manager.appendMessage(user("E2")));
						s.gates.refresh.open.resolve();
						await rewrite;
						own.push(s.manager.appendMessage(user("E3")));
						await s.manager.flush();
						expectSameSession(s);
						await expectStoredOnce(s, ["m1", "f1", ...own]);
					} finally {
						s.gates.refresh.open.resolve();
						await s.manager.close().catch(() => undefined);
					}
				},
				TIMEOUT,
			);

		if (defers)
			it(
				"keeps an entry recorded while a recovery waits for its read-back, starting no write for it",
				async () => {
					const s = await open(SKIPPED, userLine("m1", null, "a turn"));
					try {
						await s.append(userLine("f1", "m1", "another writer's turn"));
						s.gates.refresh.armed = true;
						const own = [s.manager.appendMessage(user("E1"))];
						await s.gates.refresh.reached.promise;
						const writes = s.gates.syncWrites;
						own.push(s.manager.appendMessage(user("E2")));
						// The recovery's publish carries E2; a write of its own would race the read-back.
						expect(s.gates.syncWrites).toBe(writes);
						s.gates.refresh.open.resolve();
						await s.manager.flush();
						expectSameSession(s);
						await expectStoredOnce(s, ["m1", "f1", ...own]);
					} finally {
						s.gates.refresh.open.resolve();
						await s.manager.close().catch(() => undefined);
					}
				},
				TIMEOUT,
			);

		if (defers)
			it(
				"reads again when the read-back meets this manager's own refused write",
				async () => {
					const s = await open(SKIPPED, userLine("m1", null, "a turn"));
					try {
						await s.append(userLine("f1", "m1", "another writer's turn"));
						// The read waits for this manager's queued writes to the file and reports a refused one's conflict.
						s.gates.readFailure.error = new SessionWriteConflictError(s.file, 1, 2);
						s.gates.readFailure.armed = true;
						const own = [s.manager.appendMessage(user("E1"))];
						await s.manager.flush();
						expect(s.gates.readFailure.fired).toBe(1);
						expectSameSession(s);
						await expectStoredOnce(s, ["m1", "f1", ...own]);
					} finally {
						await s.manager.close().catch(() => undefined);
					}
				},
				TIMEOUT,
			);

		if (defers)
			it(
				"appends what the store lacks when its journal is clean, which the other writer's appends cannot refuse",
				async () => {
					const s = await open(SKIPPED, userLine("m1", null, "a turn"));
					const stored = ["m1"];
					try {
						// A first whole publish leaves the store holding the journal as the manager writes it.
						stored.push(s.manager.appendMessage(user("E0")));
						await s.manager.flush();
						await s.append(userLine("f1", "m1", "another writer's turn"));
						stored.push("f1");
						await expect(s.manager.rewriteEntries()).rejects.toBeInstanceOf(SessionWriteConflictError);
						// From here the other writer appends before every whole publish: a recovery publishing the whole
						// transcript would meet a change each time and move the session to a sibling as contested.
						let foreign = 1;
						s.gates.beforeAtomicWrite = async () => {
							foreign++;
							await s.append(userLine(`f${foreign}`, "m1", `another writer's turn ${foreign}`));
							stored.push(`f${foreign}`);
						};
						stored.push(s.manager.appendMessage(user("E1")));
						await s.manager.flush();
						s.gates.beforeAtomicWrite = undefined;
						expectSameSession(s);
						await expectStoredOnce(s, stored);
					} finally {
						s.gates.beforeAtomicWrite = undefined;
						await s.manager.close().catch(() => undefined);
					}
				},
				TIMEOUT,
			);

		if (defers)
			it(
				"appends what the store lacks to a journal without a title slot, and a later title still lands",
				async () => {
					// The header alone on the first line, as an older omp or another tool writes a session.
					const s = await open(userLine("m1", null, "a turn"));
					const stored = ["m1"];
					try {
						expect((await s.stored()).startsWith('{"type":"session"')).toBe(true);
						await s.append(userLine("f1", "m1", "another writer's turn"));
						stored.push("f1");
						await expect(s.manager.rewriteEntries()).rejects.toBeInstanceOf(SessionWriteConflictError);
						// The other writer appends before every whole publish, as in the case above.
						let foreign = 1;
						s.gates.beforeAtomicWrite = async () => {
							foreign++;
							await s.append(userLine(`f${foreign}`, "m1", `another writer's turn ${foreign}`));
							stored.push(`f${foreign}`);
						};
						stored.push(s.manager.appendMessage(user("E1")));
						await s.manager.flush();
						s.gates.beforeAtomicWrite = undefined;
						expectSameSession(s);
						await expectStoredOnce(s, stored);
						// The journal still has no slot: the title rewrites it instead of updating a slot it lacks.
						await s.manager.setSessionName("a title", "user");
						await s.manager.flush();
						await s.manager.close();
						const reopened = await SessionManager.open(s.file, s.dir, await s.connect(), {
							suppressBreadcrumb: true,
						});
						try {
							expect([reopened.getSessionId(), reopened.getSessionName()]).toEqual([s.id, "a title"]);
							expect(ids(reopened)).toEqual(expect.arrayContaining(stored));
						} finally {
							await reopened.close();
						}
						await expectStoredOnce(s, stored);
					} finally {
						s.gates.beforeAtomicWrite = undefined;
						await s.manager.close().catch(() => undefined);
					}
				},
				TIMEOUT,
			);

		// k microtasks after the store resolved the recovery's write: before the recovery resumes, and after. One case
		// per depth, so each closes its connections before the next (a server's default connection limit holds).
		for (const k of defers ? [0, 1, 2, 3, 4, 5] : []) {
			it(
				`stores an entry recorded ${k} microtasks after a recovery's whole publish lands`,
				async () => {
					// A record the loader skips makes the recovery publish the whole transcript, not append.
					const s = await open(SKIPPED, userLine("m1", null, "a turn"));
					try {
						await s.append(userLine("f1", "m1", "another writer's turn"));
						let gap: string | undefined;
						const record = () => {
							gap = s.manager.appendMessage(user(`recorded ${k} microtasks after the publish`));
						};
						s.gates.afterAtomicWrite = () => {
							let chain = record;
							for (let i = 0; i < k; i++) {
								const next = chain;
								chain = () => queueMicrotask(next);
							}
							chain();
						};
						const own = [s.manager.appendMessage(user("E1"))];
						await s.manager.flush();
						own.push(s.manager.appendMessage(user("E2")));
						await s.manager.flush();
						await s.manager.close();
						expect(gap).toBeDefined();
						expectSameSession(s);
						const content = await expectStoredOnce(s, ["m1", "f1", ...own, gap ?? "never recorded"]);
						// Each stored entry's parent is stored: none hangs off an entry the store lacks.
						const links = storedLinks(content);
						const storedIds = new Set(links.map(link => link.id));
						expect(
							links
								.filter(link => typeof link.parentId === "string" && !storedIds.has(link.parentId))
								.map(link => link.id),
						).toEqual([]);
					} finally {
						s.gates.afterAtomicWrite = undefined;
						await s.manager.close().catch(() => undefined);
					}
				},
				TIMEOUT,
			);
		}

		if (defers)
			it(
				"publishes at close what a failed read left unsaved, keeping the other writer's later change",
				async () => {
					const s = await open(SKIPPED, userLine("m1", null, "a turn"));
					await s.append(userLine("f1", "m1", "another writer's turn"));
					s.gates.readFailure.armed = true;
					const own = s.manager.appendMessage(user("E1"));
					await expect(s.manager.flush()).rejects.toThrow("Connection closed");
					await s.append(userLine("f2", "f1", "another writer's later turn"));
					// As a session's dispose does: the seal, then the close, whose publish meets the other writer's change.
					s.manager.seal();
					await s.manager.close();
					expectSameSession(s);
					await expectStoredOnce(s, ["m1", "f1", "f2", own]);
				},
				TIMEOUT,
			);

		if (defers)
			it(
				"reports a read that fails during a recovery and keeps the file and the id",
				async () => {
					const s = await open(SKIPPED, userLine("m1", null, "a turn"));
					try {
						await s.append(userLine("f1", "m1", "another writer's turn"));
						s.gates.readFailure.armed = true;
						const own = [s.manager.appendMessage(user("E1"))];
						await expect(s.manager.flush()).rejects.toThrow("Connection closed");
						expect(s.gates.readFailure.fired).toBe(1);
						expectSameSession(s);
						// The next entry's write recovers.
						own.push(s.manager.appendMessage(user("E2")));
						await s.manager.flush();
						expectSameSession(s);
						await expectStoredOnce(s, ["m1", "f1", ...own]);
					} finally {
						await s.manager.close().catch(() => undefined);
					}
				},
				TIMEOUT,
			);

		if (defers)
			it(
				"closes only once a recovery that started during the close has published",
				async () => {
					const s = await open(SKIPPED, userLine("m1", null, "a turn"));
					let closed = false;
					try {
						await s.append(userLine("f1", "m1", "another writer's turn"));
						s.gates.refresh.armed = true;
						const own = s.manager.appendMessage(user("E1"));
						// The store refuses the queued rewrite while the close drains it; the close waits for the recovery.
						const closing = s.manager.close().then(() => {
							closed = true;
						});
						await s.gates.refresh.reached.promise;
						// Every step a close that did not wait would take is a microtask, done before this turn ends.
						const turn = Promise.withResolvers<void>();
						setImmediate(turn.resolve);
						await turn.promise;
						expect(closed).toBe(false);
						s.gates.refresh.open.resolve();
						await closing;
						expectSameSession(s);
						await expectStoredOnce(s, ["m1", "f1", own]);
					} finally {
						s.gates.refresh.open.resolve();
						await s.manager.close().catch(() => undefined);
					}
				},
				TIMEOUT,
			);

		if (defers)
			it(
				"keeps two managers writing one session in it, each entry once",
				async () => {
					const s = await open(userLine("m1", null, "a turn"));
					const other = await SessionManager.open(s.file, s.dir, await s.connect(), { suppressBreadcrumb: true });
					const otherNotices: unknown[] = [];
					other.onPersistenceNotice(notice => otherNotices.push(notice));
					const stored = ["m1"];
					try {
						for (let round = 1; round <= 5; round++) {
							for (const manager of [s.manager, other]) {
								stored.push(manager.appendMessage(user(`turn ${round}`)));
								await manager.flush();
							}
							for (const manager of [s.manager, other]) {
								await manager.rewriteEntries().catch((err: unknown) => {
									expect(err).toBeInstanceOf(SessionWriteConflictError);
								});
								stored.push(manager.appendMessage(user(`after a rewrite ${round}`)));
								await manager.flush();
							}
						}
						await other.close();
						await s.manager.close();
						expectSameSession(s);
						expect([other.getSessionFile(), other.getSessionId(), otherNotices]).toEqual([s.file, s.id, []]);
						await expectStoredOnce(s, stored);
					} finally {
						await other.close().catch(() => undefined);
						await s.manager.close().catch(() => undefined);
					}
				},
				TIMEOUT,
			);
	});
}
