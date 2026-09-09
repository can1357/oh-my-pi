import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnnotationStore } from "@oh-my-pi/pi-mnemopi/core/annotations";
import { BeamMemory } from "@oh-my-pi/pi-mnemopi/core/beam";

const cleanup: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "mnemopi-statement-lifetime-"));
	cleanup.push(dir);
	return dir;
}

afterEach(() => {
	while (cleanup.length > 0) {
		const dir = cleanup.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

describe("prepared statement lifetime", () => {
	// An unfinalized statement keeps the SQLite connection open, so close() is a
	// no-op and the file stays locked. close(true) is the direct assertion:
	// closeQuietly() swallows the same error, which is why the leak went unseen.
	it("leaves no statement holding the connection after the store paths run", () => {
		const dbPath = join(tempDir(), "mnemopi.db");
		const beam = new BeamMemory({ sessionId: "lifetime", dbPath });
		const id = beam.remember("statement lifetime check", { source: "test", importance: 0.5 });
		beam.get(id);
		beam.scratchpadWrite("pad entry");
		beam.scratchpadRead();
		beam.updateWorking(id, "statement lifetime check, edited");
		beam.getWorkingStats();
		beam.exportToDict();
		beam.forgetWorking(id);
		beam.scratchpadClear();

		expect(() => beam.db.close(true)).not.toThrow();
	});

	// close() swallows SQLite close failures, so verify the connection is actually
	// closed before testing the user-visible ability to delete its backing file.
	it("releases the database file so a closed bank can be deleted", () => {
		const dbPath = join(tempDir(), "mnemopi.db");
		const beam = new BeamMemory({ sessionId: "lifetime", dbPath });
		const id = beam.remember("deletable after close", { source: "test" });
		beam.get(id);
		beam.forgetWorking(id);
		beam.close();

		expect(() => beam.db.run("SELECT 1")).toThrow(/closed/i);
		expect(() => rmSync(dbPath)).not.toThrow();
		expect(existsSync(dbPath)).toBe(false);
	});

	it("leaves no statement holding the connection after an annotation import round-trip", () => {
		const source = new AnnotationStore(join(tempDir(), "source.db"));
		source.add("mem-1", "mentions", "Alice", "test");
		const exported = source.exportAll();
		expect(() => source.db.close(true)).not.toThrow();

		const target = new AnnotationStore(join(tempDir(), "target.db"));
		expect(target.importAll(exported).inserted).toBe(1);
		expect(target.queryByMemory("mem-1", "mentions").map(row => row.value)).toEqual(["Alice"]);
		expect(() => target.db.close(true)).not.toThrow();
	});
});
