import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { hasFileAsPathComponent, loadSessionFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { TempDir } from "@oh-my-pi/pi-utils";

// Windows reports ENOENT (not ENOTDIR) when a path component is a regular
// file; loadSessionFile must keep the ENOTDIR rejection POSIX produces so a
// malformed session path is not masked as a missing session.
describe("loadSessionFile path errors", () => {
	it("detects a file component by inspecting the leaf and climbing", async () => {
		await using dir = await TempDir.create("omp-session-enotdir-");
		const file = path.join(dir.path(), "plain-file.txt");
		await Bun.write(file, "not a directory");
		// A component below the file, and the file named as a directory
		// (trailing separator), both resolve to a non-directory leaf.
		expect(await hasFileAsPathComponent(path.join(file, "sub", "session.jsonl"))).toBe(true);
		expect(await hasFileAsPathComponent(`${file}${path.sep}`)).toBe(true);
		expect(await hasFileAsPathComponent(path.join(dir.path(), "missing", "session.jsonl"))).toBe(false);
	});

	it("rejects a session path with a regular-file component", async () => {
		await using dir = await TempDir.create("omp-session-enotdir-");
		const file = path.join(dir.path(), "plain-file.txt");
		await Bun.write(file, "not a directory");
		const sessionPath = path.join(file, "sub", "session.jsonl");
		await expect(loadSessionFile(sessionPath)).rejects.toMatchObject({ code: "ENOTDIR" });
		await expect(loadSessionFile(sessionPath, undefined, { throwIfMissing: true })).rejects.toMatchObject({
			code: "ENOTDIR",
		});
	});
});
