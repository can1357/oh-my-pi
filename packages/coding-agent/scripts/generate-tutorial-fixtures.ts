#!/usr/bin/env bun
/**
 * Embed tutorial lesson trees for compiled binaries and the npm bundle.
 *
 * `--generate` packs every `src/tutorials/<id>/{fixture,commits}/**` file into a
 * base64 gzip tar at `src/tutorials/fixtures.generated.txt`; `--reset` restores
 * the empty checked-in placeholder, which makes the runtime read the trees from
 * disk instead (see src/tutorials/fixtures.ts).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";

const tutorialsDir = path.resolve(import.meta.dir, "../src/tutorials");
const generatedFile = path.join(tutorialsDir, "fixtures.generated.txt");
const EMBEDDED_TREES = ["fixture", "commits"];

/** Collect `<id>/<tree>/<path>` → bytes for every lesson tree under `src/tutorials`. */
export async function collectTutorialTrees(): Promise<Record<string, Uint8Array>> {
	const entries: Record<string, Uint8Array> = {};
	for (const lesson of await fs.readdir(tutorialsDir, { withFileTypes: true })) {
		if (!lesson.isDirectory()) continue;
		for (const tree of EMBEDDED_TREES) {
			const root = path.join(tutorialsDir, lesson.name, tree);
			let files: string[];
			try {
				files = await fs.readdir(root, { recursive: true });
			} catch (error) {
				if (isEnoent(error)) continue;
				throw error;
			}
			for (const file of files.sort()) {
				const absolute = path.join(root, file);
				if (!(await fs.stat(absolute)).isFile()) continue;
				entries[[lesson.name, tree, ...file.split(path.sep)].join("/")] = await Bun.file(absolute).bytes();
			}
		}
	}
	return entries;
}

async function main(): Promise<void> {
	if (process.argv.includes("--reset")) {
		await Bun.write(generatedFile, "");
		console.log(`Reset ${generatedFile}`);
		return;
	}
	if (!process.argv.includes("--generate")) {
		console.log(`Skipping ${generatedFile}; pass --generate to embed the lesson trees`);
		return;
	}
	const archive = await new Bun.Archive(await collectTutorialTrees(), { compress: "gzip", level: 9 }).bytes();
	await Bun.write(generatedFile, Buffer.from(archive).toString("base64"));
	console.log(`Generated ${generatedFile}`);
}

if (import.meta.main) await main();
