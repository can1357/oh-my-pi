import { afterEach, describe, expect, it } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { FileChangeType, type FileEvent } from "@oh-my-pi/pi-coding-agent/lsp/types";
import { fileToUri } from "@oh-my-pi/pi-coding-agent/lsp/utils";
import { WatchedFilesForwarder } from "@oh-my-pi/pi-coding-agent/lsp/watched-files";
import { TempDir } from "@oh-my-pi/pi-utils";

/** Real filesystem events need a wall-clock bound; every wait ends as soon as the event arrives. */
const EVENT_TIMEOUT_MS = 5_000;
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

	function setup(): { root: string; sent: FileEvent[]; forwarder: WatchedFilesForwarder } {
		const tempDir = TempDir.createSync("@omp-lsp-watched-files-");
		const root = tempDir.path();
		const sent: FileEvent[] = [];
		const forwarder = new WatchedFilesForwarder({ roots: () => [root], send: changes => void sent.push(...changes) });
		cleanups.push(() => {
			forwarder.close();
			tempDir.removeSync();
		});
		return { root, sent, forwarder };
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

	it("reports only changes whose path and type the registered watcher asked for", async () => {
		const { root, sent, forwarder } = setup();
		// Creates and deletes of TypeScript files only: kind 5 = Create | Delete.
		await forwarder.register("ts", {
			watchers: [{ globPattern: `${root.replaceAll("\\", "/")}/**/*.ts`, kind: 5 }],
		});
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

		const reports = new Map<string, number>();
		for (const change of sent) reports.set(change.uri, (reports.get(change.uri) ?? 0) + 1);
		expect([...reports].filter(([, count]) => count > 1)).toEqual([]);
	});

	it("does not report a directory as changed when only its entries changed", async () => {
		const { root, sent, forwarder } = setup();
		const dir = path.join(root, "src");
		await fs.mkdir(dir);
		await forwarder.register("all", { watchers: [{ globPattern: { baseUri: fileToUri(root), pattern: "**/*" } }] });

		const file = path.join(dir, "a.ts");
		await Bun.write(file, "export {};\n");
		await waitForEvent(sent, { uri: fileToUri(file), type: FileChangeType.Created });
		await Bun.write(file, "export const changed = 1;\n");
		await waitForEvent(sent, { uri: fileToUri(file), type: FileChangeType.Changed });
		await Bun.sleep(QUIET_MS);

		expect(sent.filter(change => change.uri === fileToUri(dir))).toEqual([]);
	});

	it("reports every file of a burst written while the event loop is busy", async () => {
		const { root, sent, forwarder } = setup();
		await forwarder.register("ts", { watchers: [{ globPattern: { baseUri: fileToUri(root), pattern: "**/*.ts" } }] });
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
	}, 15_000);

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

		// Moving a directory raises one event for the directory, none for the files it holds.
		const moved = path.join(watched, "src", "pkg");
		await fs.rename(path.join(outside, "pkg"), moved);
		for (const file of files) {
			await waitForEvent(sent, { uri: fileToUri(path.join(moved, file)), type: FileChangeType.Created });
		}
		await Bun.sleep(QUIET_MS);
		const reports = new Map<string, number>();
		for (const change of sent) reports.set(change.uri, (reports.get(change.uri) ?? 0) + 1);
		expect([...reports].filter(([, count]) => count > 1)).toEqual([]);

		// Only Windows says a vanished entry was a directory; elsewhere it is gone before it can be asked.
		if (process.platform !== "win32") return;
		await fs.rename(moved, path.join(outside, "back"));
		await waitForEvent(sent, { uri: fileToUri(moved), type: FileChangeType.Deleted });
	});

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
			watchers: [
				{ globPattern: { baseUri: fileToUri(root), pattern: "**/*.ts" } },
				{ globPattern: { baseUri: fileToUri(types), pattern: "**/*.d.ts" } },
			],
		});

		const skipped = path.join(root, "node_modules", "pkg", "index.ts");
		const wanted = path.join(types, "foo", "index.d.ts");
		fsSync.writeFileSync(skipped, "export {};\n");
		fsSync.writeFileSync(wanted, "export {};\n");
		await waitForEvent(sent, { uri: fileToUri(wanted), type: FileChangeType.Created });
		await Bun.sleep(QUIET_MS);
		expect(sent.filter(change => change.uri === fileToUri(skipped))).toEqual([]);
	});

	it("does not report a file created and removed within one batch as existing", async () => {
		const { root, sent, forwarder } = setup();
		await forwarder.register("ts", { watchers: [{ globPattern: { baseUri: fileToUri(root), pattern: "**/*.ts" } }] });
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
