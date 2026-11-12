import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ReboundExtension } from "../../src/extensibility/extensions/loader";
import type { Extension } from "../../src/extensibility/extensions/types";
import {
	createExtensionsHotReloadSubsystem,
	describeExtensionsRefresh,
	ExtensionsReloader,
	type ExtensionsReloaderHost,
	extensionSignature,
} from "../../src/session/extensions-hot-reload";
import { HotReloadCoordinator } from "../../src/session/hot-reload";

describe("describeExtensionsRefresh", () => {
	it("is silent when nothing changed and nothing failed", () => {
		expect(describeExtensionsRefresh({ added: [], replaced: [], removed: [], errors: [] })).toBeUndefined();
	});

	it("counts additions, replacements and removals and names each changed extension", () => {
		expect(
			describeExtensionsRefresh({
				added: ["/x/a.ts"],
				replaced: ["/x/b.ts", "/x/c.ts"],
				removed: ["/x/d.ts"],
				errors: [],
			}),
		).toEqual({
			level: "info",
			message: "extensions reloaded: +1 ~2 -1\n  + a.ts\n  ~ b.ts\n  ~ c.ts\n  - d.ts",
		});
	});

	it("lists each failed extension and downgrades to a warning", () => {
		const notice = describeExtensionsRefresh({
			added: [],
			replaced: ["/x/b.ts"],
			removed: [],
			errors: [{ path: "/x/broken.ts", error: "SyntaxError: nope" }],
		});
		expect(notice?.level).toBe("warning");
		expect(notice?.message).toBe("extensions reloaded: +0 ~1 -0, 1 failed\n  ~ b.ts\n  broken.ts: SyntaxError: nope");
	});

	it("reports a failure even when no extension changed", () => {
		const notice = describeExtensionsRefresh({
			added: [],
			replaced: [],
			removed: [],
			errors: [{ path: "/x/broken.ts", error: "boom" }],
		});
		expect(notice?.message.split("\n")[0]).toBe("extensions unchanged: +0 ~0 -0, 1 failed");
	});
});

/** An `Extension` stand-in carrying only what the reloader reads. */
function fakeExtension(resolvedPath: string, tools: string[] = []): Extension {
	return {
		path: resolvedPath,
		resolvedPath,
		tools: new Map(tools.map(name => [name, {}])),
	} as unknown as Extension;
}

describe("ExtensionsReloader", () => {
	let root: string;
	let tick = 0;
	let loaded: Extension[];
	let discovered: string[];
	let loadErrors: Record<string, string>;
	let startErrors: Map<string, string>;
	let committed: string[];
	let removed: string[];
	let reconciled: string[][];
	let loadCalls: string[];
	let reloader: ExtensionsReloader;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extensions-reloader-"));
		loaded = [];
		discovered = [];
		loadErrors = {};
		startErrors = new Map();
		committed = [];
		removed = [];
		reconciled = [];
		loadCalls = [];
		const host: ExtensionsReloaderHost = {
			discoverPaths: async () => discovered,
			loadedExtensions: () => loaded,
			load: async entryPath => {
				loadCalls.push(entryPath);
				const error = loadErrors[entryPath];
				if (error) return { rebound: null, error };
				const rebound: ReboundExtension = {
					extension: fakeExtension(entryPath, [`tool-of-${path.basename(entryPath)}`]),
					commit: () => {
						committed.push(entryPath);
					},
				};
				return { rebound, error: null };
			},
			replace: async (previous, next, commit) => {
				const error = startErrors.get(next.resolvedPath);
				// A rejected swap leaves `previous` installed and never commits.
				if (error) return { ok: false, error };
				loaded = loaded.map(extension => (extension === previous ? next : extension));
				commit();
				return { ok: true };
			},
			add: async (next, commit) => {
				const error = startErrors.get(next.resolvedPath);
				if (error) return { ok: false, error };
				loaded = [...loaded, next];
				commit();
				return { ok: true };
			},
			remove: async extension => {
				loaded = loaded.filter(candidate => candidate !== extension);
				removed.push(extension.resolvedPath);
			},
			reconcileTools: async names => {
				reconciled.push([...names]);
			},
		};
		reloader = new ExtensionsReloader(host);
	});

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	async function writeSource(name: string): Promise<string> {
		const file = path.join(root, name);
		await Bun.write(file, `export default function () { /* ${++tick} */ }`);
		const bumped = new Date(Date.now() + tick * 1000);
		await fs.utimes(file, bumped, bumped);
		return file;
	}

	async function install(name: string): Promise<string> {
		const file = await writeSource(name);
		loaded.push(fakeExtension(file, [`tool-of-${name}`]));
		discovered.push(file);
		return file;
	}

	it("adds a newly discovered extension", async () => {
		const file = await writeSource("new.ts");
		discovered = [file];

		expect(await reloader.refresh()).toEqual({ added: [file], replaced: [], removed: [], errors: [] });
		expect(committed).toEqual([file]);
		expect(loaded.map(extension => extension.resolvedPath)).toEqual([file]);
	});

	it("replaces an extension whose source changed and leaves the others alone", async () => {
		const edited = await install("edited.ts");
		const calm = await install("calm.ts");
		await reloader.captureBaseline();
		await writeSource("edited.ts");

		const summary = await reloader.refresh({ changedOnly: true });

		expect(summary).toEqual({ added: [], replaced: [edited], removed: [], errors: [] });
		expect(loadCalls).toEqual([edited]);
		expect(loaded.map(extension => extension.resolvedPath).sort()).toEqual([calm, edited].sort());
	});

	it("re-imports everything on a plain refresh, changed or not", async () => {
		const a = await install("a.ts");
		const b = await install("b.ts");
		await reloader.captureBaseline();

		const summary = await reloader.refresh();

		expect([...summary.replaced].sort()).toEqual([a, b].sort());
		expect(loadCalls.sort()).toEqual([a, b].sort());
	});

	it("skips a malformed extension, reports it, and still reloads every other extension", async () => {
		const broken = await install("broken.ts");
		const healthy = await install("healthy.ts");
		await reloader.captureBaseline();
		const before = loaded.find(extension => extension.resolvedPath === broken);
		loadErrors[broken] = "SyntaxError: Unexpected token '{'";

		const summary = await reloader.refresh();

		expect(summary.errors).toEqual([{ path: broken, error: "SyntaxError: Unexpected token '{'" }]);
		expect(summary.replaced).toEqual([healthy]);
		// The old instance of the failing extension is the one still running.
		expect(loaded.find(extension => extension.resolvedPath === broken)).toBe(before);
		expect(committed).toEqual([healthy]);
	});

	it("keeps the old instance, reports the error, and commits nothing when the new one fails to start", async () => {
		const file = await install("flaky.ts");
		await reloader.captureBaseline();
		const before = loaded[0];
		startErrors.set(file, "start failed");

		const summary = await reloader.refresh();

		expect(summary).toEqual({
			added: [],
			replaced: [],
			removed: [],
			errors: [{ path: file, error: "start failed" }],
		});
		expect(loaded[0]).toBe(before);
		expect(committed).toEqual([]);
		// Tools of both instances are reconciled so the registry matches whichever one survived.
		expect(reconciled).toHaveLength(1);
	});

	it("does not add a new extension that fails to start", async () => {
		const file = await writeSource("doomed.ts");
		discovered = [file];
		startErrors.set(file, "start failed");

		const summary = await reloader.refresh();

		expect(summary.errors).toEqual([{ path: file, error: "start failed" }]);
		expect(summary.added).toEqual([]);
		expect(loaded).toEqual([]);
		expect(committed).toEqual([]);
	});

	it("retries a failed extension on a plain refresh but waits for an edit under changedOnly", async () => {
		const file = await install("retry.ts");
		await reloader.captureBaseline();
		await writeSource("retry.ts");
		loadErrors[file] = "broken";
		await reloader.refresh({ changedOnly: true });
		loadCalls.length = 0;

		await reloader.refresh({ changedOnly: true });
		expect(loadCalls).toEqual([]);

		delete loadErrors[file];
		const summary = await reloader.refresh();
		expect(summary.replaced).toEqual([file]);
	});

	it("unloads an extension whose file is gone", async () => {
		const file = await install("gone.ts");
		const keep = await install("keep.ts");
		await reloader.captureBaseline();
		await fs.rm(file);
		discovered = [keep];

		const summary = await reloader.refresh({ changedOnly: true });

		expect(summary.removed).toEqual([file]);
		expect(removed).toEqual([file]);
		expect(loaded.map(extension => extension.resolvedPath)).toEqual([keep]);
		expect(reconciled).toEqual([[`tool-of-gone.ts`]]);
	});

	it("keeps an extension that is no longer discovered but whose file still exists", async () => {
		const file = await install("disabled.ts");
		discovered = [];

		const summary = await reloader.refresh();

		expect(summary.removed).toEqual([]);
		expect(removed).toEqual([]);
		expect(loaded.map(extension => extension.resolvedPath)).toEqual([file]);
	});

	it("never rejects: a host that throws is reported against the extension", async () => {
		const file = await install("throws.ts");
		const throwing = new ExtensionsReloader({
			discoverPaths: async () => [file],
			loadedExtensions: () => loaded,
			load: async () => {
				throw new Error("host exploded");
			},
			replace: async () => ({ ok: true }),
			add: async () => ({ ok: true }),
			remove: async () => {},
			reconcileTools: async () => {},
		});

		const summary = await throwing.refresh();

		expect(summary.errors).toEqual([{ path: file, error: "host exploded" }]);
	});

	it("reports a discovery failure without touching the loaded extensions", async () => {
		const file = await install("steady.ts");
		const failing = new ExtensionsReloader({
			discoverPaths: async () => {
				throw new Error("cannot scan");
			},
			loadedExtensions: () => loaded,
			load: async () => ({ rebound: null, error: "unreachable" }),
			replace: async () => ({ ok: true }),
			add: async () => ({ ok: true }),
			remove: async extension => {
				removed.push(extension.resolvedPath);
			},
			reconcileTools: async () => {},
		});

		const summary = await failing.refresh();

		expect(summary.errors).toEqual([{ path: "(discovery)", error: "cannot scan" }]);
		expect(removed).toEqual([]);
		expect(loaded.map(extension => extension.resolvedPath)).toEqual([file]);
	});

	it("ignores inline factory extensions", async () => {
		loaded.push(fakeExtension("<inline-0>"));
		await reloader.captureBaseline();

		const summary = await reloader.refresh();

		expect(summary).toEqual({ added: [], replaced: [], removed: [], errors: [] });
		expect(reloader.entryPaths()).toEqual([]);
		expect(loaded).toHaveLength(1);
	});
});

describe("extensionSignature", () => {
	let root: string;
	let tick = 0;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extension-signature-"));
	});

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	async function write(name: string, source: string): Promise<string> {
		const file = path.join(root, name);
		await Bun.write(file, source);
		const bumped = new Date(Date.now() + ++tick * 1000);
		await fs.utimes(file, bumped, bumped);
		return file;
	}

	it("changes when the entry file changes", async () => {
		const entry = await write("entry.ts", "export default () => {};");
		const before = await extensionSignature(entry);
		await write("entry.ts", "export default () => { /* edited */ };");
		expect(await extensionSignature(entry)).not.toBe(before);
	});

	it("changes when a local module the entry imports changes", async () => {
		await write("helper.ts", "export const value = 1;");
		const entry = await write("entry.ts", 'import { value } from "./helper";\nexport default () => value;');
		const before = await extensionSignature(entry);
		await write("helper.ts", "export const value = 2;");
		expect(await extensionSignature(entry)).not.toBe(before);
	});

	it("still fingerprints the entry when its source cannot be parsed", async () => {
		const entry = await write("entry.ts", "export default () => {};");
		const before = await extensionSignature(entry);
		await write("entry.ts", "export default () => {{{ not typescript");
		expect(await extensionSignature(entry)).not.toBe(before);
	});
});

describe("createExtensionsHotReloadSubsystem", () => {
	let root: string;
	let busy: boolean;
	let idleListeners: Array<() => void>;
	let reloads: number;
	let notices: string[];
	let watcher: HotReloadCoordinator;
	let tick = 0;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extensions-hot-reload-"));
		busy = false;
		idleListeners = [];
		reloads = 0;
		notices = [];
		watcher = new HotReloadCoordinator({
			subsystems: [
				createExtensionsHotReloadSubsystem({
					roots: () => [root],
					reload: async () => {
						reloads++;
					},
				}),
			],
			isBusy: () => busy,
			onIdle: listener => {
				idleListeners.push(listener);
				return () => {
					idleListeners = idleListeners.filter(l => l !== listener);
				};
			},
			notify: (_level, message) => {
				notices.push(message);
			},
			// The tests drive `poll()` themselves.
			pollIntervalMs: 3_600_000,
		});
	});

	afterEach(async () => {
		watcher.stop();
		await fs.rm(root, { recursive: true, force: true });
	});

	async function touch(name: string): Promise<void> {
		const file = path.join(root, name);
		await Bun.write(file, `${++tick}`);
		const bumped = new Date(Date.now() + tick * 1000);
		await fs.utimes(file, bumped, bumped);
	}

	it("reloads nothing while the sources are unchanged", async () => {
		await touch("a.ts");
		await watcher.start();
		await watcher.poll();
		expect([reloads, notices]).toEqual([0, []]);
	});

	it("reloads once per detected change", async () => {
		await watcher.start();
		await touch("new.ts");
		await watcher.poll();
		await watcher.poll();
		expect(reloads).toBe(1);

		await touch("new.ts");
		await watcher.poll();
		expect(reloads).toBe(2);
	});

	it("does not reload while a turn is in flight, says so once, and reloads when the turn ends", async () => {
		await watcher.start();
		busy = true;
		await touch("mid-turn.ts");
		await watcher.poll();
		await touch("mid-turn-2.ts");
		await watcher.poll();

		expect(reloads).toBe(0);
		expect(notices).toEqual(["extension files changed; reload deferred until the current turn ends"]);

		busy = false;
		for (const listener of idleListeners) listener();
		await watcher.poll();

		expect(reloads).toBe(1);
	});

	it("keeps polling after a reload throws and reports the failure", async () => {
		const failing = new HotReloadCoordinator({
			subsystems: [
				createExtensionsHotReloadSubsystem({
					roots: () => [root],
					reload: async () => {
						throw new Error("reload exploded");
					},
				}),
			],
			isBusy: () => false,
			onIdle: () => () => {},
			notify: (level, message) => {
				notices.push(`${level}: ${message}`);
			},
			pollIntervalMs: 3_600_000,
		});
		await failing.start();
		await touch("a.ts");
		await failing.poll();
		await touch("b.ts");
		await failing.poll();
		failing.stop();

		expect(notices).toEqual([
			"error: extensions hot reload failed: reload exploded",
			"error: extensions hot reload failed: reload exploded",
		]);
	});

	it("does nothing after stop", async () => {
		await watcher.start();
		watcher.stop();
		await touch("a.ts");
		await watcher.poll();
		expect(reloads).toBe(0);
		expect(idleListeners).toEqual([]);
	});
});
