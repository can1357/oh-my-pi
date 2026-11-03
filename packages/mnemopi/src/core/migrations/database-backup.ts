import type { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";

import { closeQuietly, type DatabasePath, openDatabase } from "../../db";

type SerializableDatabase = Database & { serialize(): Uint8Array };

/**
 * Write a point-in-time backup of a bank file as its serialized SQLite byte
 * image. The source is opened read-only with no pragmas so a backup rehearsal
 * cannot mutate the bank. The e6 and e7 migrations share this single
 * implementation so a backup fix reaches every migration.
 */
export function backupDatabase(source: DatabasePath, destination: string): void {
	let db: Database | null = null;
	try {
		db = openDatabase(source, { create: false, readwrite: false, pragmas: false });
		writeFileSync(destination, (db as SerializableDatabase).serialize());
	} finally {
		closeQuietly(db);
	}
}
