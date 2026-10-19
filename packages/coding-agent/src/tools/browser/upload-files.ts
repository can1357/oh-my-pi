import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { untilAborted, withTimeout } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { BunFile } from "bun";
import type { ElementHandle, Page, Realm } from "puppeteer-core";
import { throwIfAborted } from "../tool-errors";

declare module "puppeteer-core" {
	interface Frame {
		/** The frame's isolated world, where a page's replaced globals never reach (`@internal` upstream). */
		isolatedRealm(): Realm;
	}
}

/** What a browser's own pick reports for a file. */
export interface UploadFileInfo {
	name: string;
	/** Bare MIME type, empty when the extension names none. */
	type: string;
	lastModified: number;
}

/** A file to hand a page, its contents base64-encoded. */
export interface FilePayload extends UploadFileInfo {
	data: string;
}

/** A file to upload, opened for reading in slices. */
export interface UploadSource {
	path: string;
	file: BunFile;
	size: number;
	/** A folder, which only a browser reading its path can expand (for a `webkitdirectory` input). */
	directory: boolean;
	/**
	 * The file's identity and last change (inode, size, mtime, ctime). A rewrite that keeps size and mtime (a coarse
	 * clock, a build step restoring timestamps) still moves ctime, and a replace by rename changes the inode.
	 */
	revision: string;
	info: UploadFileInfo;
}

/**
 * How a browser gets uploaded files: `paths` of staged copies it reads itself, or `contents` omp reads and streams in,
 * for a browser that may not open omp's files (a relay without file-URL access, a Chrome on another machine).
 */
export type UploadRoute = "paths" | "contents";

/** The type Bun gives an extension it does not know; a browser's own pick reports such a file with no type. */
const UNKNOWN_TYPE = "application/octet-stream";

/** Extensions Chrome itself maps to `application/octet-stream` (`kSecondaryMappings` in `net/base/mime_util.cc`). */
const OCTET_STREAM_EXTENSIONS: Record<string, true> = { ".bin": true, ".exe": true, ".com": true };

/** How long the route check waits for the browser to read its token file back. */
const ROUTE_CHECK_READ_MS = 2_000;

/** Open a file for upload; rejects when it cannot be read. */
export async function openUploadSource(absolute: string): Promise<UploadSource> {
	const file = Bun.file(absolute);
	// A missing file reports size 0; stat rejects instead of uploading it empty.
	const stats = await file.stat();
	const bunType = file.type.split(";")[0];
	const unknown = bunType === UNKNOWN_TYPE && !OCTET_STREAM_EXTENSIONS[path.extname(absolute).toLowerCase()];
	return {
		path: absolute,
		file,
		size: stats.size,
		directory: stats.isDirectory(),
		revision: `${stats.ino}\0${stats.size}\0${stats.mtimeMs}\0${stats.ctimeMs}`,
		info: { name: path.basename(absolute), type: unknown ? "" : bunType, lastModified: file.lastModified },
	};
}

/** Open every file of one upload, in order. */
export async function openUploadSources(absolutePaths: string[], signal?: AbortSignal): Promise<UploadSource[]> {
	const sources: UploadSource[] = [];
	for (const absolute of absolutePaths) {
		throwIfAborted(signal);
		sources.push(await openUploadSource(absolute));
	}
	return sources;
}

/** Reject folders for a browser that only takes file contents: only a browser reading a path expands a folder. */
export function refuseFolders(sources: UploadSource[]): void {
	const folder = sources.find(source => source.directory);
	if (!folder) return;
	throw new ToolError(
		`${folder.path} is a folder, and this browser cannot read omp's files (a relay without file-URL access, or a browser on another machine), so it takes files only; upload the files inside it instead`,
	);
}

/** Read whole files into payloads for one call into the page. */
export async function readFilePayloads(absolutePaths: string[], signal?: AbortSignal): Promise<FilePayload[]> {
	const sources = await openUploadSources(absolutePaths, signal);
	refuseFolders(sources);
	const payloads: FilePayload[] = [];
	for (const { path: source, info } of sources) {
		throwIfAborted(signal);
		payloads.push({ ...info, data: (await fs.readFile(source)).toString("base64") });
	}
	return payloads;
}

/**
 * Set a file input's files to `paths` through `DOM.setFileInputFiles`; the browser reads them itself. Raw CDP rather than
 * `ElementHandle.uploadFile`, which an actionable handle routes back through the upload helpers.
 */
export async function setFileInputPaths(input: ElementHandle, paths: string[]): Promise<void> {
	await input.frame.client.send("DOM.setFileInputFiles", { objectId: input.remoteObject().objectId, files: paths });
}

/** A detached file input's page side; this package type-checks without the DOM lib. */
interface PagePicker {
	type: string;
	multiple: boolean;
	readonly files: ArrayLike<{ text(): Promise<string> }> | null;
}

interface PickerGlobals {
	document: { createElement(tag: "input"): PagePicker };
}

/** Create a detached `<input type=file multiple>`. Runs in the page, in the isolated world. */
export function createFilePicker(): PagePicker {
	const { document } = globalThis as unknown as PickerGlobals;
	const input = document.createElement("input");
	input.type = "file";
	input.multiple = true;
	return input;
}

/** A picker's files, as an array. Runs in the page. */
export function pickedFiles(picker: PagePicker): unknown[] {
	return Array.from(picker.files ?? []);
}

/**
 * The text of a picker's first file, or "" when the browser could not read it (a path on another machine's file
 * system). Runs in the page.
 */
function readFirstPickedFile(picker: PagePicker): Promise<string> | string {
	const file = picker.files?.[0];
	return file ? file.text().catch(() => "") : "";
}

/**
 * Staging folders are `omp-uploads-<pid>-<id>` in the temp directory; the pid names the omp process that owns one. The
 * route check's own folder shares the prefix, so one a crash left behind is swept the same way.
 */
const STAGING_FOLDER = /^omp-uploads-(\d+)-/;

/**
 * How long a staging folder no open tab owns stays after its last upload: a page omp let go of may still be open in the
 * user's browser, and Chrome reads a picked file only when the page does.
 */
const STAGING_KEPT_MS = 24 * 60 * 60 * 1000;

/** The staging folder path for a new tab; it is created on the tab's first upload. */
export function newUploadStagingDir(): string {
	return path.join(os.tmpdir(), `omp-uploads-${process.pid}-${crypto.randomUUID().slice(0, 8)}`);
}

/** Remove a tab's staging folder, once the page that may read its copies is gone. */
export async function removeUploadStaging(directory: string): Promise<void> {
	await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "EPERM";
	}
}

/**
 * Remove staging folders a day after their last upload once no open tab of this process owns them and the omp
 * process that made them is this one or gone. Another running omp sweeps its own.
 */
export async function sweepUploadStaging(live: ReadonlySet<string>, now = Date.now()): Promise<void> {
	const root = os.tmpdir();
	for (const name of await fs.readdir(root).catch(() => [])) {
		const owner = STAGING_FOLDER.exec(name);
		const directory = path.join(root, name);
		if (!owner || live.has(directory)) continue;
		const pid = Number(owner[1]);
		if (pid !== process.pid && processAlive(pid)) continue;
		const stat = await fs.stat(directory).catch(() => null);
		if (stat && now - stat.mtimeMs >= STAGING_KEPT_MS) await removeUploadStaging(directory);
	}
}

/**
 * Copy a file, or a folder whole, following links so no copy points back at an original. A link to a folder already
 * being copied above it would repeat forever, so it is left out, as a folder that holds itself cannot be expanded.
 */
async function copyFollowingLinks(
	source: string,
	target: string,
	ancestors: ReadonlySet<string>,
	signal: AbortSignal | undefined,
): Promise<void> {
	throwIfAborted(signal);
	const stats = await fs.stat(source);
	if (!stats.isDirectory()) {
		// A clone where the filesystem supports one (APFS, btrfs, XFS), a plain copy elsewhere.
		await fs.copyFile(source, target, fs.constants.COPYFILE_FICLONE);
		await fs.utimes(target, stats.atime, stats.mtime);
		return;
	}
	const real = await fs.realpath(source);
	if (ancestors.has(real)) return;
	await fs.mkdir(target);
	const inside = new Set(ancestors).add(real);
	for (const entry of await fs.readdir(source)) {
		await copyFollowingLinks(path.join(source, entry), path.join(target, entry), inside, signal);
	}
	// Last, since adding its entries moved it.
	await fs.utimes(target, stats.atime, stats.mtime);
}

/**
 * One tab worker's uploads: the route a one-time check picked for its browser connection, and the tab's staging
 * folder, which outlives the worker (a recycle or a relay release starts a new one on the same page) and is removed by
 * the supervisor, since Chrome reads a picked file lazily.
 */
export class UploadStaging {
	readonly #directory: string;
	#created: Promise<unknown> | undefined;
	/** The route a check decided; unset until one does. */
	#route: UploadRoute | undefined;
	#checking: Promise<UploadRoute> | undefined;
	/** Staged copies of unchanged files, by source path and revision, so a repeated upload copies nothing. */
	readonly #copies = new Map<string, string>();

	constructor(directory: string) {
		this.#directory = directory;
	}

	/**
	 * The route for this connection: the browser gets a token file's path through `DOM.setFileInputFiles` on a detached
	 * input and must read it back. A read of the token means paths and `Not allowed` means contents, both kept for the
	 * connection. Anything else (a late or failed read, a navigation, a busy page) decides nothing: this upload gets
	 * contents, which any browser takes, and the next one checks again.
	 */
	route(page: Page, signal?: AbortSignal): Promise<UploadRoute> {
		if (this.#route) return Promise.resolve(this.#route);
		this.#checking ??= this.#checkRoute(page)
			.then(
				({ route, decided }) => {
					if (decided) this.#route = route;
					return route;
				},
				(): UploadRoute => "contents",
			)
			.finally(() => {
				this.#checking = undefined;
			});
		const checking = this.#checking;
		return untilAborted(signal, () => checking);
	}

	/**
	 * Copy files or folders into the staging directory, keeping names and mtimes, and return the copies' paths. Links
	 * are followed: a copy that pointed back at the original would send the browser to it again.
	 */
	async stage(sources: UploadSource[], signal?: AbortSignal): Promise<string[]> {
		const directory = await this.#ensureDirectory();
		const staged: string[] = [];
		let reusedAny = false;
		for (const source of sources) {
			throwIfAborted(signal);
			// A folder's own revision misses changes deeper in it, so only files are reused.
			const key = source.directory ? undefined : `${source.path}\0${source.revision}`;
			const reused = key === undefined ? undefined : this.#copies.get(key);
			if (reused) {
				reusedAny = true;
				staged.push(reused);
				continue;
			}
			const folder = await fs.mkdtemp(path.join(directory, "f-"));
			const copy = path.join(folder, source.info.name);
			// A folder, which Chrome expands for a `webkitdirectory` input, is copied whole.
			await copyFollowingLinks(source.path, copy, new Set(), signal);
			if (key !== undefined) this.#copies.set(key, copy);
			staged.push(copy);
		}
		// The sweep keeps a folder a day past its mtime; a reuse writes nothing, so it marks the folder used itself.
		if (reusedAny) {
			const now = new Date();
			await fs.utimes(directory, now, now);
		}
		return staged;
	}

	async #ensureDirectory(): Promise<string> {
		this.#created ??= fs.mkdir(this.#directory, { recursive: true });
		await this.#created;
		return this.#directory;
	}

	async #checkRoute(page: Page): Promise<{ route: UploadRoute; decided: boolean }> {
		const token = crypto.randomUUID();
		// Its own folder, so a tab that never stages a file leaves no staging folder behind.
		const checkDirectory = await fs.mkdtemp(path.join(os.tmpdir(), `omp-uploads-${process.pid}-check-`));
		try {
			const tokenPath = path.join(checkDirectory, "route-check");
			await Bun.write(tokenPath, token);
			const picker = await page.mainFrame().isolatedRealm().evaluateHandle(createFilePicker);
			try {
				const input = picker.asElement();
				if (!input) throw new Error("The upload route check could not create a file input");
				try {
					await setFileInputPaths(input, [tokenPath]);
				} catch (error) {
					// Chrome refuses every path to a client without file access (a relay extension by default).
					if (error instanceof Error && error.message.includes("Not allowed"))
						return { route: "contents", decided: true };
					throw error;
				}
				const text = await withTimeout(
					picker.evaluate(readFirstPickedFile),
					ROUTE_CHECK_READ_MS,
					"upload route check read timed out",
				);
				// Chrome took the path but read nothing or something else: it sees another machine's file system.
				return { route: text === token ? "paths" : "contents", decided: true };
			} finally {
				await picker.dispose().catch(() => undefined);
			}
		} finally {
			await fs.rm(checkDirectory, { recursive: true, force: true }).catch(() => undefined);
		}
	}
}
