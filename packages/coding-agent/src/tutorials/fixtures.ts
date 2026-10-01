/**
 * Lesson fixture trees (`<id>/fixture/`, `<id>/commits/<name>/`).
 *
 * Mirrors the stats dashboard embed: `fixtures.generated.txt` is an empty
 * checked-in placeholder that `gen:tutorials` fills with a base64 gzip tar of
 * every lesson tree for compiled binaries and the npm bundle (reset afterwards).
 * Source checkouts, where the placeholder is empty, read the trees from disk
 * next to this module.
 */
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import embeddedFixtures from "./fixtures.generated.txt" with { type: "text" };

export interface LessonFile {
	/** Path relative to the tree root, `/`-separated. */
	path: string;
	bytes: Uint8Array;
}

let embeddedFiles: Promise<Map<string, Blob>> | null | undefined;

function loadEmbeddedFiles(): Promise<Map<string, Blob>> | null {
	if (embeddedFiles !== undefined) return embeddedFiles;
	const normalized = embeddedFixtures.replaceAll(/\s+/g, "");
	embeddedFiles = normalized ? new Bun.Archive(Buffer.from(normalized, "base64")).files() : null;
	return embeddedFiles;
}

async function readDiskTree(root: string): Promise<LessonFile[]> {
	let entries: Dirent[];
	try {
		entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
	return Promise.all(
		entries
			.filter(entry => entry.isFile())
			.map(async entry => {
				const absolute = path.join(entry.parentPath, entry.name);
				return {
					path: path.relative(root, absolute).split(path.sep).join("/"),
					bytes: await fs.readFile(absolute),
				};
			}),
	);
}

/** Read one lesson tree (`fixture` or `commits/<name>`), sorted by path. Throws when the tree is empty or missing. */
export async function readLessonTree(lessonId: string, tree: string): Promise<LessonFile[]> {
	const embedded = loadEmbeddedFiles();
	let files: LessonFile[];
	if (embedded) {
		const prefix = `${lessonId}/${tree}/`;
		files = await Promise.all(
			[...(await embedded).entries()]
				.filter(([name]) => name.startsWith(prefix))
				.map(async ([name, blob]) => ({ path: name.slice(prefix.length), bytes: await blob.bytes() })),
		);
	} else {
		files = await readDiskTree(path.join(import.meta.dir, lessonId, tree));
	}
	if (files.length === 0) throw new Error(`Tutorial lesson "${lessonId}" has no files in ${tree}/`);
	return files.sort((a, b) => a.path.localeCompare(b.path));
}
