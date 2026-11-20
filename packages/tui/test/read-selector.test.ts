import { describe, expect, it } from "bun:test";
import { missingReadPathError } from "@oh-my-pi/pi-coding-agent/tools/read";
import { splitPathAndSel } from "@oh-my-pi/pi-tui/tools/read";

// A bare trailing number is a line:column coordinate (`file.ts:62:105`), not a
// read selector. The splitter used to peel it, so a missing file was statted as
// `file.ts:62` and reported under that path, dropping the column the caller passed.
describe("bare trailing number", () => {
	it("does not peel a bare trailing number, and the not-found error quotes the raw path and names the grammar", () => {
		const raw = "session-storage-env.ts:62:105";

		expect(splitPathAndSel(raw)).toEqual({ path: raw });

		const message = missingReadPathError(raw, raw);
		expect(message).toContain(`'${raw}'`);
		expect(message).not.toContain("session-storage-env.ts:62'");
		expect(message).toContain("50-80");
		expect(message).toContain("50+150");
	});

	it("still peels a real range, a count, a tail, and a comma list", () => {
		expect(splitPathAndSel("session-storage-env.ts:62-105")).toEqual({
			path: "session-storage-env.ts",
			sel: "62-105",
		});
		expect(splitPathAndSel("session-storage-env.ts:50+150")).toEqual({
			path: "session-storage-env.ts",
			sel: "50+150",
		});
		expect(splitPathAndSel("session-storage-env.ts:-60")).toEqual({
			path: "session-storage-env.ts",
			sel: "-60",
		});
		expect(splitPathAndSel("session-storage-env.ts:5-16,960-973")).toEqual({
			path: "session-storage-env.ts",
			sel: "5-16,960-973",
		});
	});

	it("still peels a single line, and a colon a comma list folds into a range", () => {
		expect(splitPathAndSel("notes:62")).toEqual({ path: "notes", sel: "62" });
		expect(splitPathAndSel("a.ts:20:40,85:100")).toEqual({ path: "a.ts", sel: "20-40,85-100" });
	});

	it("names the peeled path when a selector was peeled off a file that is missing", () => {
		const message = missingReadPathError("notes:62-105", "notes");
		expect(message).toContain("'notes:62-105'");
		expect(message).toContain("'notes'");
		expect(message).toContain("50-80");
	});
});
