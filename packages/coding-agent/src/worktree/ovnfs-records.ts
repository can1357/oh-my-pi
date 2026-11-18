import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getWorktreeDir, isEnoent, isRecord } from "@oh-my-pi/pi-utils";
import type { OvnfsCheckout } from "./backend";

/** Reserved metadata directory in the managed worktree base. */
export const OVNFS_RECORD_DIR = ".ovnfs";

/** The source-to-checkout relationship outlives the checkout for session resumption. */
export interface OvnfsRecord extends OvnfsCheckout {
	root: string;
	source: string;
	removed?: boolean;
}

function recordPath(record: OvnfsRecord): string {
	const key = Bun.hash(JSON.stringify([record.command, record.checkout, record.created])).toString(16);
	return path.join(getWorktreeDir(OVNFS_RECORD_DIR), `${key}.json`);
}

/** Publish a checkout record or its removal without exposing a partially written record. */
export async function writeOvnfsRecord(record: OvnfsRecord): Promise<void> {
	const target = recordPath(record);
	const temp = `${target}.${crypto.randomUUID()}.tmp`;
	try {
		await Bun.write(temp, JSON.stringify(record));
		await fs.rename(temp, target);
	} finally {
		await fs.rm(temp, { force: true });
	}
}

/** Read checkout provenance, including entries whose mount or source has disappeared. */
export async function readOvnfsRecords(): Promise<OvnfsRecord[]> {
	const recordsDir = getWorktreeDir(OVNFS_RECORD_DIR);
	let names: string[];
	try {
		names = await fs.readdir(recordsDir);
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}
	const records = await Promise.all(
		names
			.filter(name => name.endsWith(".json"))
			.map(async name => {
				const value: unknown = await Bun.file(path.join(recordsDir, name)).json();
				if (
					!isRecord(value) ||
					typeof value.command !== "string" ||
					typeof value.checkout !== "string" ||
					typeof value.created !== "string" ||
					typeof value.root !== "string" ||
					typeof value.source !== "string" ||
					!path.isAbsolute(value.root) ||
					!path.isAbsolute(value.source)
				)
					throw new Error(`Invalid ovnfs worktree record: ${name}`);
				const { command, checkout, created, root, source } = value;
				return { command, checkout, created, root, source, removed: value.removed === true };
			}),
	);
	return records;
}
