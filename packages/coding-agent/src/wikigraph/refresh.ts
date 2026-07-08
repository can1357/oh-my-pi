import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getWikigraphDb } from "./db";
import { indexMarkdownFile } from "./indexer";
import type { WikigraphRefreshResult } from "./types";

function expandHome(input: string): string {
	if (input === "~") return os.homedir();
	if (input.startsWith("~/") || input.startsWith("~\\")) return path.join(os.homedir(), input.slice(2));
	return input;
}

async function collectMarkdownFiles(root: string): Promise<string[]> {
	const files: string[] = [];
	async function walk(dir: string): Promise<void> {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		await Promise.all(
			entries.map(async entry => {
				const fullPath = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					if (entry.name === "node_modules" || entry.name === ".git") return;
					await walk(fullPath);
					return;
				}
				if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) files.push(fullPath);
			}),
		);
	}
	await walk(root);
	return files;
}

export async function refreshWikigraphIndex(roots: string[]): Promise<WikigraphRefreshResult> {
	const warnings: string[] = [];
	let added = 0;
	let updated = 0;
	let removed = 0;
	const db = await getWikigraphDb();
	const expandedRoots = roots.map(root => path.resolve(expandHome(root)));
	const rootFiles = await Promise.all(
		expandedRoots.map(async root => {
			try {
				const stat = await fs.stat(root);
				if (stat.isFile()) return { root: path.dirname(root), files: [root] };
				if (stat.isDirectory()) return { root, files: await collectMarkdownFiles(root) };
				return { root, files: [] };
			} catch (error) {
				warnings.push(`warning: cannot index ${root}: ${error instanceof Error ? error.message : String(error)}`);
				return { root, files: [] };
			}
		}),
	);
	for (const group of rootFiles) {
		const results = await Promise.all(
			group.files.map(async file => {
				try {
					return await indexMarkdownFile(db, file, group.root);
				} catch (error) {
					return {
						added: 0,
						updated: 0,
						removed: 0,
						warnings: [
							`warning: failed to index ${file}: ${error instanceof Error ? error.message : String(error)}`,
						],
					};
				}
			}),
		);
		for (const result of results) {
			added += result.added;
			updated += result.updated;
			removed += result.removed;
			warnings.push(...result.warnings);
		}
	}
	return { added, updated, removed, warnings: [...db.notes, ...warnings] };
}
