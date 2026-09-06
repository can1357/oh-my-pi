import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { checkpointWal, isClosedDatabaseError, isSqliteBusyError } from "@oh-my-pi/pi-utils/sqlite";

describe("checkpointWal", () => {
	it("flushes an open database", () => {
		const db = new Database(":memory:");
		db.run("create table t(x)");
		expect(() => checkpointWal(db)).not.toThrow();
		db.close();
	});

	it("is a no-op on a closed handle", () => {
		// Every caller runs this from a `close()` path. `bun:sqlite` >= 1.4 throws
		// `Database has closed` where earlier versions tolerated it, and a throw
		// here left the caller's teardown half-done — in `AgentStorage.close()`
		// that orphaned the instance registry and broke every later close.
		const db = new Database(":memory:");
		db.close();
		expect(() => checkpointWal(db)).not.toThrow();
	});

	it("still surfaces a real failure", () => {
		const db = new Database(":memory:");
		// A statement error is not a closed handle and must not be swallowed.
		expect(() => db.run("PRAGMA nonsense_pragma_that_errors(")).toThrow();
		db.close();
	});
});

describe("isClosedDatabaseError", () => {
	it("recognizes bun's closed-handle guard, which carries no result code", () => {
		const db = new Database(":memory:");
		db.close();
		let caught: unknown;
		try {
			db.run("select 1");
		} catch (err) {
			caught = err;
		}
		expect(isClosedDatabaseError(caught)).toBe(true);
		// It has no SQLite result code, so the busy classifier must not claim it.
		expect(isSqliteBusyError(caught)).toBe(false);
	});

	it("rejects unrelated errors", () => {
		expect(isClosedDatabaseError(new Error("disk I/O error"))).toBe(false);
		expect(isClosedDatabaseError("Database has closed")).toBe(false);
	});
});
