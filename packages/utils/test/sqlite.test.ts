import { describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { checkpointWal } from "../src/sqlite";

function dbThrowing(code: string, message = code): Database {
	return {
		run() {
			throw Object.assign(new Error(message), { code });
		},
	} as Database;
}

describe("checkpointWal", () => {
	it("ignores already-closed database handles", () => {
		expect(() => checkpointWal(dbThrowing("SQLITE_MISUSE", "Database has closed"))).not.toThrow();
	});

	it("ignores SQLITE_IOERR_VNODE unlink races during shutdown", () => {
		expect(() => checkpointWal(dbThrowing("SQLITE_IOERR_VNODE"))).not.toThrow();
	});

	it("surfaces real SQLITE_IOERR write and fsync failures", () => {
		expect(() => checkpointWal(dbThrowing("SQLITE_IOERR_WRITE"))).toThrow(/SQLITE_IOERR_WRITE/);
		expect(() => checkpointWal(dbThrowing("SQLITE_IOERR_FSYNC"))).toThrow(/SQLITE_IOERR_FSYNC/);
		expect(() => checkpointWal(dbThrowing("SQLITE_IOERR"))).toThrow(/SQLITE_IOERR/);
	});
});
