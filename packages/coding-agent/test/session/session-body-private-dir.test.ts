/**
 * Where a full rewrite on indexed storage keeps its body until the store has
 * it, by what the temporary directory holds and whether the account id can
 * be read.
 */
import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { IndexedSessionStorage } from "@oh-my-pi/pi-coding-agent/session/indexed-session-storage";
import { logger, TempDir } from "@oh-my-pi/pi-utils";
import { withoutAccountId } from "../helpers/account-id";
import { StreamingMemoryBackend } from "../helpers/memory-session-backend";

const SPOOL_WARNING = "Session rewrites stream straight to the store: their spool file cannot be used";
/** What the running test acquired, each released after it, newest first, even when one before it throws. */
let cleanup = new DisposableStack();

interface PrivateDirs {
	/** The directory's mode bits. */
	mode: number;
	/** The account id the directory is named for; this account's by default. */
	uid?: number;
	/** Make it a link to a directory of this account's with `mode`, made elsewhere. */
	linked?: boolean;
}

/** A directory standing for `os.tmpdir()` that holds a spool directory or none. */
function setUp(privateDirs: PrivateDirs | undefined): string {
	// Removed after `tmp`, whose links name directories in it: the newest is released first.
	const linkTargets = cleanup.adopt(TempDir.createSync("@omp-private-dir-link-targets-"), removeDir);
	const tmp = cleanup.adopt(TempDir.createSync("@omp-private-dir-tmp-"), removeDir);
	if (privateDirs) {
		const { mode, uid = process.getuid?.(), linked = false } = privateDirs;
		const name = `omp-spool-${uid}`;
		const dir = (linked ? linkTargets : tmp).join(name);
		fs.mkdirSync(dir);
		fs.chmodSync(dir, mode);
		if (linked) fs.symlinkSync(dir, tmp.join(name));
	}
	return tmp.path();
}

/** What the probe records when the spool refuses its directory, named for account `uid`. */
function refusedDirs(uid: number | undefined) {
	return {
		rewritesStored: [true, true],
		streamed: 2,
		opened: [],
		warnings: [SPOOL_WARNING],
		underTmp: [`omp-spool-${uid}`],
	};
}

async function probe(scenario: string, tmp: string) {
	if (scenario === "no-account-id") withoutAccountId();
	if (scenario === "other-account") {
		const uid = process.getuid?.();
		if (uid === undefined) throw new Error("other-account needs an account id");
		spyOn(process, "getuid").mockReturnValue(uid + 1);
	}
	spyOn(os, "tmpdir").mockReturnValue(tmp);
	const warnings: string[] = [];
	spyOn(logger, "warn").mockImplementation(message => {
		warnings.push(message);
	});
	// An atomic rewrite opens its spool with `fs.open`; a synchronous one with `fs.openSync`. Only the files
	// opened in a directory under `tmp` count, not the directory, which the spool opens to check it.
	const opened: string[] = [];
	const noteOpen = (target: fs.PathLike): void => {
		const name = path.relative(tmp, String(target));
		if (String(target).startsWith(`${tmp}${path.sep}`) && path.dirname(name) !== ".") opened.push(name);
	};
	const openSync = fs.openSync;
	spyOn(fs, "openSync").mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
		noteOpen(target);
		return Reflect.apply(openSync, fs, [target, ...rest]);
	}) as typeof fs.openSync);
	const open = fs.open;
	spyOn(fs, "open").mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
		noteOpen(target);
		return Reflect.apply(open, fs, [target, ...rest]);
	}) as typeof fs.open);

	const lines = ['{"type":"session","id":"one"}\n', `${JSON.stringify({ type: "custom", data: "x".repeat(4096) })}\n`];
	const backend = new StreamingMemoryBackend();
	const storage = new IndexedSessionStorage(backend);
	await storage.initialize();
	// One rewrite through each opener: the atomic one opens asynchronously, the synchronous one does not.
	await storage.writeLinesAtomic("/sessions/one.jsonl", lines, { expectedSize: null });
	storage.writeLinesSync("/sessions/two.jsonl", lines, { expectedSize: null });
	await storage.drain();
	const rewritesStored = [...backend.sessions.values()].map(text => text === lines.join(""));
	// Only the backend's streamed write counts here: a rewrite handed over as one string does not.
	const streamed = backend.streamedBytes.length;
	return { rewritesStored, streamed, opened, warnings, underTmp: (await fs.promises.readdir(tmp)).sort() };
}

/**
 * Remove `dir`, also when an entry of it cannot be made the owner's again
 * first, as a 0300 spool directory must be before it can be listed.
 */
function removeDir(dir: TempDir): void {
	using removal = new DisposableStack();
	removal.defer(() => dir.removeSync());
	for (const name of fs.readdirSync(dir.path())) fs.chmodSync(path.join(dir.path(), name), 0o700);
}

afterEach(() => {
	const acquired = cleanup;
	cleanup = new DisposableStack();
	// First, so the spies on `fs` are gone before the directories are removed.
	acquired.defer(() => vi.restoreAllMocks());
	acquired.dispose();
});

describe("rewrite bodies by the temporary directory", () => {
	// Each case here names its directory for the account id and checks it against that id.
	describe.skipIf(process.getuid === undefined)("where the account id can be read", () => {
		it("uses a file in a directory this account owns with mode 0700", async () => {
			const tmp = setUp({ mode: 0o700 });
			const result = await probe("private", tmp);
			const uid = process.getuid?.();
			expect({
				...result,
				opened: result.opened.map(name => path.dirname(name)),
			}).toEqual({
				rewritesStored: [true, true],
				streamed: 2,
				opened: [`omp-spool-${uid}`, `omp-spool-${uid}`],
				warnings: [],
				underTmp: [`omp-spool-${uid}`],
			});
			// Every file was unlinked as soon as it was open.
			for (const name of result.underTmp) expect(await fs.promises.readdir(path.join(tmp, name))).toEqual([]);
		}, 30_000);

		it("streams the rewrites, warning once, in an owner-only 0300 directory", async () => {
			const tmp = setUp({ mode: 0o300 });
			expect(await probe("owner-only-0300", tmp)).toEqual(refusedDirs(process.getuid?.()));
		}, 30_000);

		it("streams the rewrites, warning once, where the directory is a link to a 0700 directory of this account's", async () => {
			const tmp = setUp({ mode: 0o700, linked: true });
			expect(await probe("linked", tmp)).toEqual(refusedDirs(process.getuid?.()));
		}, 30_000);

		it("streams the rewrites, warning once, in a 0700 directory another account owns", async () => {
			const other = (process.getuid?.() ?? 0) + 1;
			const tmp = setUp({ mode: 0o700, uid: other });
			expect(await probe("other-account", tmp)).toEqual(refusedDirs(other));
		}, 30_000);
	});

	it("keeps the bodies compressed in memory, makes no file and logs nothing where the account id cannot be read", async () => {
		const tmp = setUp(undefined);
		const result = await probe("no-account-id", tmp);
		expect(result).toEqual({
			rewritesStored: [true, true],
			streamed: 2,
			opened: [],
			warnings: [],
			underTmp: [],
		});
	}, 30_000);
});
