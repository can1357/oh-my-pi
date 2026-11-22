import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { FileChangeType, type FileEvent } from "@oh-my-pi/pi-coding-agent/lsp/types";
import { fileToUri } from "@oh-my-pi/pi-coding-agent/lsp/utils";
import { InotifyBudget, WatchedFilesForwarder } from "@oh-my-pi/pi-coding-agent/lsp/watched-files";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Real filesystem events need a wall-clock bound; every wait ends as soon as the event arrives. Generous
 * because a loaded machine's event daemon (macOS fseventsd) can lag seconds behind the writes.
 */
const EVENT_TIMEOUT_MS = 15_000;
/**
 * How long a change must stay unreported to count as filtered, well past the forwarder's batch
 * window. The events come from the OS watcher, so fake timers cannot stand in for this wait.
 */
const QUIET_MS = 600;

describe("WatchedFilesForwarder", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) cleanup();
	});

	function setup(budget?: InotifyBudget): { root: string; sent: FileEvent[]; forwarder: WatchedFilesForwarder } {
		const tempDir = TempDir.createSync("@omp-lsp-watched-files-");
		const root = tempDir.path();
		const sent: FileEvent[] = [];
		const forwarder = new WatchedFilesForwarder({
			roots: () => [root],
			send: changes => void sent.push(...changes),
			inotifyBudget: budget,
		});
		cleanups.push(() => {
			forwarder.close();
			tempDir.removeSync();
		});
		return { root, sent, forwarder };
	}

	function inotifyWatches(): number {
		return fsSync
			.readdirSync("/proc/self/fdinfo")
			.map(fd => {
				try {
					return fsSync.readFileSync(`/proc/self/fdinfo/${fd}`, "utf8");
				} catch {
					return "";
				}
			})
			.reduce((count, info) => count + info.split("\n").filter(line => line.startsWith("inotify wd")).length, 0);
	}

	async function waitForEvent(sent: FileEvent[], event: FileEvent): Promise<void> {
		const deadline = Date.now() + EVENT_TIMEOUT_MS;
		while (!sent.some(change => change.uri === event.uri && change.type === event.type)) {
			if (Date.now() > deadline) {
				throw new Error(`no ${JSON.stringify(event)} among ${JSON.stringify(sent)}`);
			}
			await Bun.sleep(20);
		}
	}

	/**
	 * Waits until the OS watcher is live: macOS starts its FSEvents stream after `fs.watch` returns, so a
	 * change made right after `register` can be lost. Rewrites `sentinel`, which a registered glob must
	 * match, until it is reported, then forgets the reports; late repeats of the sentinel may still follow.
	 */
	async function untilWatching(sent: FileEvent[], sentinel: string): Promise<void> {
		const deadline = Date.now() + EVENT_TIMEOUT_MS;
		const uri = fileToUri(sentinel);
		for (let write = 0; !sent.some(change => change.uri === uri); write++) {
			if (Date.now() > deadline) throw new Error(`the watcher never reported ${sentinel}`);
			fsSync.writeFileSync(sentinel, `// ${write}\n`);
			await Bun.sleep(100);
		}
		sent.length = 0;
	}

	/** URIs of `files` reported more than once. */
	function repeated(sent: FileEvent[], files: string[]): string[] {
		const reports = new Map(files.map(file => [fileToUri(file), 0]));
		for (const change of sent) {
			const count = reports.get(change.uri);
			if (count !== undefined) reports.set(change.uri, count + 1);
		}
		return [...reports].filter(([, count]) => count > 1).map(([uri]) => uri);
	}

	it("reports only changes whose path and type the registered watcher asked for", async () => {
		const { root, sent, forwarder } = setup();
		// Creates and deletes of TypeScript files only: kind 5 = Create | Delete.
		await forwarder.register("ts", {
			watchers: [{ globPattern: `${root.replaceAll("\\", "/")}/**/*.ts`, kind: 5 }],
		});
		await untilWatching(sent, path.join(root, "ready.ts"));
		const file = path.join(root, "src", "a.ts");
		await fs.mkdir(path.dirname(file));

		await Bun.write(file, "export {};\n");
		await Bun.write(path.join(root, "src", "notes.txt"), "ignored\n");
		await waitForEvent(sent, { uri: fileToUri(file), type: FileChangeType.Created });

		sent.length = 0;
		await Bun.write(file, "export const changed = 1;\n");
		await Bun.sleep(QUIET_MS);
		await fs.rm(file);
		await waitForEvent(sent, { uri: fileToUri(file), type: FileChangeType.Deleted });

		expect(sent.some(change => change.type === FileChangeType.Changed)).toBe(false);
		expect(sent.some(change => change.uri.endsWith("notes.txt"))).toBe(false);
	});

	it("reports files written right after a base directory is created", async () => {
		const { root, sent, forwarder } = setup();
		const later = path.join(root, "later", "deep");
		// A shallow glob at the root opens the same flat root watch the missing base waits through, so its
		// sentinel proves that watch live before the base is registered.
		await forwarder.register("ready", {
			watchers: [{ globPattern: { baseUri: fileToUri(root), pattern: "ready.ts" } }],
		});
		await untilWatching(sent, path.join(root, "ready.ts"));
		await forwarder.register("later", {
			watchers: [{ globPattern: { baseUri: fileToUri(later), pattern: "**/*" } }],
		});

		// Written before the watch can move from the nearest existing ancestor to the base.
		const file = path.join(later, "x.ts");
		fsSync.mkdirSync(later, { recursive: true });
		fsSync.writeFileSync(file, "export {};\n");
		await waitForEvent(sent, { uri: fileToUri(file), type: FileChangeType.Created });
	});

	it("reports each file once when a missing base appears below a recursively watched directory", async () => {
		const { root, sent, forwarder } = setup();
		const types = path.join(root, "node_modules", "@types");
		await forwarder.register("ts", {
			watchers: [
				{ globPattern: { baseUri: fileToUri(root), pattern: "**/*.ts" } },
				{ globPattern: { baseUri: fileToUri(types), pattern: "**/*.ts" } },
			],
		});
		await untilWatching(sent, path.join(root, "ready.ts"));

		const files: string[] = [];
		for (let d = 0; d < 5; d++) {
			const dir = path.join(types, `pkg${d}`);
			fsSync.mkdirSync(dir, { recursive: true });
			for (let f = 0; f < 20; f++) {
				const file = path.join(dir, `f${f}.d.ts`);
				fsSync.writeFileSync(file, "export {};\n");
				files.push(file);
			}
		}
		for (const file of files) await waitForEvent(sent, { uri: fileToUri(file), type: FileChangeType.Created });
		// The duplicate came from a rescan after the base appeared; give it time to land.
		await Bun.sleep(QUIET_MS);

		expect(repeated(sent, files)).toEqual([]);
	});

	it("does not report a directory as changed when only its entries changed", async () => {
		const { root, sent, forwarder } = setup();
		const dir = path.join(root, "src");
		await fs.mkdir(dir);
		await forwarder.register("all", { watchers: [{ globPattern: { baseUri: fileToUri(root), pattern: "**/*" } }] });
		await untilWatching(sent, path.join(root, "ready.ts"));

		const file = path.join(dir, "a.ts");
		await Bun.write(file, "export {};\n");
		await waitForEvent(sent, { uri: fileToUri(file), type: FileChangeType.Created });
		await Bun.write(file, "export const changed = 1;\n");
		await waitForEvent(sent, { uri: fileToUri(file), type: FileChangeType.Changed });
		await Bun.sleep(QUIET_MS);

		// FSEvents may replay the directory's creation, made just before the watch started; nothing else may name it.
		const reported = sent.filter(change => change.uri === fileToUri(dir) && change.type !== FileChangeType.Created);
		expect(reported).toEqual([]);
	});

	it("reports every file of a burst written while the event loop is busy", async () => {
		const { root, sent, forwarder } = setup();
		await forwarder.register("ts", { watchers: [{ globPattern: { baseUri: fileToUri(root), pattern: "**/*.ts" } }] });
		await untilWatching(sent, path.join(root, "ready.ts"));
		// Written synchronously, as a package install would from another process: the
		// watcher must keep reading while JS is busy (libuv's Windows watcher drops most of these).
		const files: string[] = [];
		for (let d = 0; d < 20; d++) {
			const dir = path.join(root, "generated", `pkg${d}`);
			fsSync.mkdirSync(dir, { recursive: true });
			for (let f = 0; f < 100; f++) {
				const file = path.join(dir, `f${f}.ts`);
				fsSync.writeFileSync(file, "export {};\n");
				files.push(file);
			}
		}
		const expected = new Set(files.map(file => fileToUri(file)));
		const deadline = Date.now() + EVENT_TIMEOUT_MS;
		const created = () => new Set(sent.filter(change => change.type === FileChangeType.Created).map(c => c.uri));
		while (created().size < expected.size && Date.now() < deadline) await Bun.sleep(50);
		expect([...expected].filter(uri => !created().has(uri))).toEqual([]);
	}, 30_000);

	it("reports the files of a directory moved into the watched tree, and the directory when moved out", async () => {
		const { root, sent, forwarder } = setup();
		const watched = path.join(root, "watched");
		const outside = path.join(root, "outside");
		await fs.mkdir(path.join(watched, "src"), { recursive: true });
		await fs.mkdir(path.join(outside, "pkg", "nested"), { recursive: true });
		const files = ["a.ts", path.join("nested", "b.ts")];
		for (const file of files) fsSync.writeFileSync(path.join(outside, "pkg", file), "export {};\n");
		await forwarder.register("ts", {
			watchers: [{ globPattern: { baseUri: fileToUri(watched), pattern: "**/*.ts" } }],
		});
		await untilWatching(sent, path.join(watched, "ready.ts"));

		// Moving a directory raises one event for the directory, none for the files it holds.
		const moved = path.join(watched, "src", "pkg");
		await fs.rename(path.join(outside, "pkg"), moved);
		for (const file of files) {
			await waitForEvent(sent, { uri: fileToUri(path.join(moved, file)), type: FileChangeType.Created });
		}
		await Bun.sleep(QUIET_MS);
		expect(
			repeated(
				sent,
				files.map(file => path.join(moved, file)),
			),
		).toEqual([]);

		// Only Windows says a vanished entry was a directory; elsewhere it is gone before it can be asked.
		if (process.platform !== "win32") return;
		await fs.rename(moved, path.join(outside, "back"));
		await waitForEvent(sent, { uri: fileToUri(moved), type: FileChangeType.Deleted });
	});

	// Only Windows says a vanished entry was a directory.
	it.skipIf(process.platform !== "win32")(
		"reports a directory's files created again after it was moved out and back",
		async () => {
			const { root, sent, forwarder } = setup();
			const watched = path.join(root, "watched");
			const outside = path.join(root, "outside");
			await fs.mkdir(watched, { recursive: true });
			await fs.mkdir(path.join(outside, "pkg", "nested"), { recursive: true });
			fsSync.writeFileSync(path.join(outside, "pkg", "nested", "b.ts"), "export {};\n");
			await forwarder.register("ts", {
				watchers: [{ globPattern: { baseUri: fileToUri(watched), pattern: "**/*.ts" } }],
			});
			await untilWatching(sent, path.join(watched, "ready.ts"));

			const moved = path.join(watched, "pkg");
			const created = { uri: fileToUri(path.join(moved, "nested", "b.ts")), type: FileChangeType.Created };
			await fs.rename(path.join(outside, "pkg"), moved);
			await waitForEvent(sent, created);
			await fs.rename(moved, path.join(outside, "pkg"));
			await waitForEvent(sent, { uri: fileToUri(moved), type: FileChangeType.Deleted });
			sent.length = 0;

			// The vanished directory took its files' earlier creations with it: this one is new.
			await fs.rename(path.join(outside, "pkg"), moved);
			await waitForEvent(sent, created);
		},
	);

	// Only Windows pairs a directory's old and new names.
	it.skipIf(process.platform !== "win32")(
		"reports each file's old path deleted when a directory is renamed",
		async () => {
			const { root, sent, forwarder } = setup();
			const before = path.join(root, "before");
			await fs.mkdir(before);
			fsSync.writeFileSync(path.join(before, "a.ts"), "export {};\n");
			await forwarder.register("ts", {
				watchers: [{ globPattern: { baseUri: fileToUri(root), pattern: "**/*.ts" } }],
			});

			const after = path.join(root, "after");
			await fs.rename(before, after);
			await waitForEvent(sent, { uri: fileToUri(path.join(before, "a.ts")), type: FileChangeType.Deleted });
			await waitForEvent(sent, { uri: fileToUri(path.join(after, "a.ts")), type: FileChangeType.Created });
		},
	);

	it("skips package contents below a base unless a watcher registered a base inside them", async () => {
		const { root, sent, forwarder } = setup();
		const types = path.join(root, "node_modules", "@types");
		await fs.mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
		await fs.mkdir(path.join(types, "foo"), { recursive: true });
		await forwarder.register("ts", {
			watchers: [{ globPattern: { baseUri: fileToUri(root), pattern: "**/*.ts" } }],
		});
		await forwarder.register("types", {
			watchers: [{ globPattern: { baseUri: fileToUri(types), pattern: "**/*.d.ts" } }],
		});
		await untilWatching(sent, path.join(root, "ready.ts"));

		const skipped = path.join(root, "node_modules", "pkg", "index.ts");
		const wanted = path.join(types, "foo", "index.d.ts");
		fsSync.writeFileSync(skipped, "export {};\n");
		fsSync.writeFileSync(wanted, "export {};\n");
		await waitForEvent(sent, { uri: fileToUri(wanted), type: FileChangeType.Created });
		await Bun.sleep(QUIET_MS);
		expect(sent.filter(change => change.uri === fileToUri(skipped))).toEqual([]);
	});

	// A recursive `fs.watch` on Linux adds an inotify watch per directory; package trees must not use up the user's limit.
	it.skipIf(process.platform !== "linux")("puts no inotify watches on package contents or object stores", async () => {
		const { root, sent, forwarder } = setup();
		const packages = 300;
		for (let i = 0; i < packages; i++)
			await fs.mkdir(path.join(root, "node_modules", `pkg${i}`, "lib"), { recursive: true });
		for (let i = 0; i < 16; i++)
			await fs.mkdir(path.join(root, ".git", "objects", i.toString(16)), { recursive: true });
		await fs.mkdir(path.join(root, "src"));
		const before = inotifyWatches();
		await forwarder.register("ts", { watchers: [{ globPattern: { baseUri: fileToUri(root), pattern: "**/*.ts" } }] });
		// root, src, node_modules and .git: package and object store directories stay unwatched.
		expect(inotifyWatches() - before).toBeLessThanOrEqual(4);

		const source = path.join(root, "src", "index.ts");
		fsSync.writeFileSync(source, "export {};\n");
		await waitForEvent(sent, { uri: fileToUri(source), type: FileChangeType.Created });
	});

	it.skipIf(process.platform !== "linux")(
		"releases nested package watches when their registration is removed",
		async () => {
			const { root, forwarder } = setup();
			const types = path.join(root, "node_modules", "@types");
			await fs.mkdir(path.join(types, "foo"), { recursive: true });
			await forwarder.register("ts", {
				watchers: [{ globPattern: { baseUri: fileToUri(root), pattern: "**/*.ts" } }],
			});
			const before = inotifyWatches();
			await forwarder.register("types", {
				watchers: [{ globPattern: { baseUri: fileToUri(types), pattern: "**/*.d.ts" } }],
			});
			expect(inotifyWatches()).toBeGreaterThan(before);
			await forwarder.unregister("types");
			expect(inotifyWatches()).toBe(before);
		},
	);

	// The inotify watch limit is per user: a process that used it up would break unrelated programs (#20117).
	it.skipIf(process.platform !== "linux")(
		"watches no more directories than its inotify budget, shallowest first",
		async () => {
			const { root, sent, forwarder } = setup(new InotifyBudget(3));
			const shallow = path.join(root, "src");
			const deep = path.join(root, ".lake", "build", "ir", "Mathlib");
			await fs.mkdir(shallow);
			await fs.mkdir(deep, { recursive: true });
			const before = inotifyWatches();
			await forwarder.register("ts", {
				watchers: [{ globPattern: { baseUri: fileToUri(root), pattern: "**/*.ts" } }],
			});
			// root, src and .lake.
			expect(inotifyWatches() - before).toBe(3);

			const unwatched = path.join(deep, "a.ts");
			const source = path.join(shallow, "index.ts");
			fsSync.writeFileSync(unwatched, "export {};\n");
			fsSync.writeFileSync(source, "export {};\n");
			await waitForEvent(sent, { uri: fileToUri(source), type: FileChangeType.Created });
			await Bun.sleep(QUIET_MS);
			expect(sent.filter(change => change.uri === fileToUri(unwatched))).toEqual([]);
		},
	);

	it.skipIf(process.platform !== "linux")(
		"gives watches back and stops adding them when the kernel refuses one",
		async () => {
			const { root, sent, forwarder } = setup(new InotifyBudget(1000));
			for (let i = 0; i < 10; i++) await fs.mkdir(path.join(root, `d${i}`));
			const refused = path.join(root, "d0", "refused");
			await fs.mkdir(refused);
			const watch = fsSync.watch;
			const spy = spyOn(fsSync, "watch").mockImplementation((...args: unknown[]) => {
				if (args[0] === refused) {
					throw Object.assign(new Error(`ENOSPC: no space left on device, watch '${refused}'`), {
						code: "ENOSPC",
					});
				}
				return Reflect.apply(watch, fsSync, args);
			});
			cleanups.push(() => spy.mockRestore());
			const before = inotifyWatches();
			await forwarder.register("ts", {
				watchers: [{ globPattern: { baseUri: fileToUri(root), pattern: "**/*.ts" } }],
			});
			// 11 held (root and d0-d9) when refused: half of them stay, root among them.
			expect(inotifyWatches() - before).toBe(5);

			// A directory created later stays unwatched, so the process does not climb back to the limit.
			await fs.mkdir(path.join(root, "later"));
			const file = path.join(root, "index.ts");
			fsSync.writeFileSync(file, "export {};\n");
			await waitForEvent(sent, { uri: fileToUri(file), type: FileChangeType.Created });
			await Bun.sleep(QUIET_MS);
			expect(inotifyWatches() - before).toBe(5);
		},
	);

	it("does not report a file created and removed within one batch as existing", async () => {
		const { root, sent, forwarder } = setup();
		await forwarder.register("ts", { watchers: [{ globPattern: { baseUri: fileToUri(root), pattern: "**/*.ts" } }] });
		await untilWatching(sent, path.join(root, "ready.ts"));
		const transient = path.join(root, "transient.ts");
		const kept = path.join(root, "kept.ts");
		fsSync.writeFileSync(transient, "export {};\n");
		fsSync.rmSync(transient);
		fsSync.writeFileSync(kept, "export {};\n");
		await waitForEvent(sent, { uri: fileToUri(kept), type: FileChangeType.Created });
		await Bun.sleep(QUIET_MS);

		// `fs.watch` cannot tell a create-then-delete from a delete, so a Deleted may follow; nothing may claim it exists.
		expect(
			sent.filter(change => change.uri === fileToUri(transient) && change.type !== FileChangeType.Deleted),
		).toEqual([]);
	});

	it("resolves relative glob patterns against the workspace roots and stops after unregister", async () => {
		const { root, sent, forwarder } = setup();
		await forwarder.register("rel", { watchers: [{ globPattern: "**/*.py" }] });
		await untilWatching(sent, path.join(root, "ready.py"));
		const first = path.join(root, "one.py");
		await Bun.write(first, "x = 1\n");
		await waitForEvent(sent, { uri: fileToUri(first), type: FileChangeType.Created });

		await forwarder.unregister("rel");
		sent.length = 0;
		await Bun.write(path.join(root, "two.py"), "y = 2\n");
		await Bun.sleep(QUIET_MS);
		expect(sent).toEqual([]);
	});

	it("does not echo a write the client reported itself, but reports a later change to the same file", async () => {
		const { root, sent, forwarder } = setup();
		await forwarder.register("ts", { watchers: [{ globPattern: { baseUri: fileToUri(root), pattern: "**/*.ts" } }] });
		await untilWatching(sent, path.join(root, "ready.ts"));
		const own = path.join(root, "own.ts");
		const marker = path.join(root, "marker.ts");
		fsSync.writeFileSync(own, "export {};\n");
		forwarder.announced({ changes: [{ uri: fileToUri(own), type: FileChangeType.Created }] });
		fsSync.writeFileSync(marker, "export {};\n");
		await waitForEvent(sent, { uri: fileToUri(marker), type: FileChangeType.Created });
		await Bun.sleep(QUIET_MS);
		expect(sent.filter(change => change.uri === fileToUri(own))).toEqual([]);

		// Another program edits it afterwards: that change is new to the server.
		fsSync.writeFileSync(own, "export const edited = 1;\n");
		await waitForEvent(sent, { uri: fileToUri(own), type: FileChangeType.Changed });
	});
});
