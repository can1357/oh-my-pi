/**
 * A memory bank is shared by every omp process in a project. With SQLite's default
 * `synchronous=FULL` every commit synced the WAL; file banks open with `synchronous=NORMAL`, which
 * syncs at checkpoints and keeps every commit across a process crash.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { closeQuietly, openDatabase } from "../src/db";

describe("openDatabase synchronous mode", () => {
	it("opens file banks with synchronous=NORMAL", () => {
		using dir = TempDir.createSync("@mnemopi-synchronous-");
		const db = openDatabase(path.join(dir.path(), "mnemopi.db"));
		try {
			// 1 = NORMAL; SQLite's default is 2 (FULL).
			expect(db.query("PRAGMA synchronous").get()).toEqual({ synchronous: 1 });
		} finally {
			closeQuietly(db);
		}
	});
});
