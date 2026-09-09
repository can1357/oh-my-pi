import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveEquivalentPath } from "@oh-my-pi/pi-utils/dirs";

describe("issue #935 path equivalence", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("falls back to the lexical project path when realpath fails", () => {
		const inputPath = path.resolve("/sessions/link-project");
		const realpathSpy = vi.spyOn(fs, "realpathSync").mockImplementation((() => {
			const error = new Error("ENOENT: no such file or directory, realpath");
			(error as NodeJS.ErrnoException).code = "ENOENT";
			throw error;
		}) as unknown as typeof fs.realpathSync);

		expect(resolveEquivalentPath(inputPath)).toBe(inputPath);
		expect(realpathSpy).toHaveBeenCalledWith(inputPath);
	});
});
