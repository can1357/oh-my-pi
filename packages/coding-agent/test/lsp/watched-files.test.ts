import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import * as chokidar from "chokidar";
import { type FileEvent, WATCHED_FILES_METHOD, WatchedFiles } from "../../src/lsp/watched-files";

const owners: WatchedFiles[] = [];
const directories: string[] = [];

afterEach(async () => {
	await Promise.all(owners.splice(0).map(owner => owner.close()));
	await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
	vi.restoreAllMocks();
});

async function workspace(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-watch-test-"));
	directories.push(directory);
	return directory;
}

function observer(root: string): {
	owner: WatchedFiles;
	events: FileEvent[];
	next: (uri: string, type: FileEvent["type"], action: () => Promise<unknown>) => Promise<void>;
} {
	const events: FileEvent[] = [];
	let received: ((changes: FileEvent[]) => void) | undefined;
	const owner = new WatchedFiles(root, async changes => {
		events.push(...changes);
		received?.(changes);
	});
	owners.push(owner);
	return {
		owner,
		events,
		async next(uri, type, action) {
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			// Real filesystem integration: this is a failure watchdog, not a settling sleep.
			const timer = setTimeout(() => reject(new Error(`Missing file event ${type}: ${uri}`)), 3_000);
			received = changes => {
				if (changes.some(change => change.uri === uri && change.type === type)) resolve();
			};
			try {
				await action();
				await promise;
			} finally {
				clearTimeout(timer);
				received = undefined;
			}
		},
	};
}

describe("registered filesystem watches", () => {
	it("prunes nested checkouts and dependencies before allocating watches, but watches generated Svelte types", async () => {
		const root = await workspace();
		for (const directory of [".worktrees/other/src", ".git/objects", "node_modules/example", ".svelte-kit/types"]) {
			await Bun.write(path.join(root, directory, "value.ts"), "before");
		}
		const watch = vi.spyOn(chokidar, "watch");
		const observed = observer(root);
		await observed.owner.register([
			{
				id: "svelte",
				method: WATCHED_FILES_METHOD,
				registerOptions: { watchers: [{ globPattern: "**/*.{ts,json,svelte}" }] },
			},
		]);
		// This guards the ENOSPC regression: filtering notifications alone is insufficient.
		const backend = watch.mock.results[0].value as chokidar.FSWatcher;
		const watchedDirectories = Object.keys(backend.getWatched());
		for (const directory of [".worktrees", ".git", "node_modules"]) {
			expect(watchedDirectories.some(target => target.startsWith(path.join(root, directory)))).toBe(false);
		}
		const generated = path.join(root, ".svelte-kit/types/value.ts");
		await observed.next(pathToFileURL(generated).href, 2, () => Bun.write(generated, "after"));
	});

	it("honors relative bases and kind masks across overlapping registration removal", async () => {
		const root = await workspace();
		const source = path.join(root, "src");
		await fs.mkdir(source);
		const observed = observer(root);
		const globPattern = { baseUri: { uri: pathToFileURL(source).href, name: "src" }, pattern: "*.ts" };
		await observed.owner.register([
			{ id: "created", method: WATCHED_FILES_METHOD, registerOptions: { watchers: [{ globPattern, kind: 1 }] } },
			{ id: "changed", method: WATCHED_FILES_METHOD, registerOptions: { watchers: [{ globPattern, kind: 2 }] } },
			{ id: "deleted", method: WATCHED_FILES_METHOD, registerOptions: { watchers: [{ globPattern, kind: 4 }] } },
		]);
		const target = path.join(source, "value.ts");
		const uri = pathToFileURL(target).href;
		await observed.next(uri, 1, () => Bun.write(target, "created"));
		await observed.next(uri, 2, () => Bun.write(target, "changed"));
		await observed.owner.unregister(["changed"]);
		await observed.next(uri, 3, () => fs.unlink(target));
		expect(observed.events).toEqual([
			{ uri, type: 1 },
			{ uri, type: 2 },
			{ uri, type: 3 },
		]);
		await observed.owner.unregister(["created", "deleted"]);
		await observed.owner.register([
			{
				id: "new",
				method: WATCHED_FILES_METHOD,
				registerOptions: { watchers: [{ globPattern: path.join(source, "*.ts") }] },
			},
		]);
		await observed.next(uri, 1, () => Bun.write(target, "registered again"));
	});

	it("cancels initialization and releases handles when the server closes during registration", async () => {
		const root = await workspace();
		await Bun.write(path.join(root, "src/value.ts"), "before");
		const watch = vi.spyOn(chokidar, "watch");
		const observed = observer(root);
		const registering = observed.owner.register([
			{
				id: "pending",
				method: WATCHED_FILES_METHOD,
				registerOptions: { watchers: [{ globPattern: "**/*.ts" }] },
			},
		]);
		const closing = observed.owner.close();
		await expect(registering).rejects.toThrow("closed");
		await closing;
		const backend = watch.mock.results[0].value as chokidar.FSWatcher;
		expect(backend.closed).toBe(true);
		expect(backend.getWatched()).toEqual({});
	});

	it("rejects an invalid batch without retaining partially registered watches", async () => {
		const root = await workspace();
		const watch = vi.spyOn(chokidar, "watch");
		const observed = observer(root);
		await expect(
			observed.owner.register([
				{ id: "valid", method: WATCHED_FILES_METHOD, registerOptions: { watchers: [{ globPattern: "**/*.ts" }] } },
				{
					id: "invalid",
					method: WATCHED_FILES_METHOD,
					registerOptions: { watchers: [{ globPattern: { baseUri: "https://example.com", pattern: "*.ts" } }] },
				},
			]),
		).rejects.toThrow();
		expect(watch).not.toHaveBeenCalled();
		await observed.owner.close();
		await expect(observed.owner.register([])).rejects.toThrow("closed");
	});
});
