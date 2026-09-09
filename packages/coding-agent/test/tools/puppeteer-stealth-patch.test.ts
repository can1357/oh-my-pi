import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { debugCatchError, debugError } from "puppeteer-core/lib/puppeteer/common/util.js";

const patchPath = resolve(import.meta.dir, "../../../../patches/puppeteer-core@25.3.0.patch");

describe("Puppeteer stealth patch", () => {
	it("uses the safe debug handler for all added rejection paths", async () => {
		const patch = await Bun.file(patchPath).text();
		const addedLines = patch.split("\n").filter(line => line.startsWith("+") && !line.startsWith("+++"));

		expect(addedLines.filter(line => line.includes(".catch(debugError)"))).toEqual([]);
		expect(addedLines.filter(line => /\bdebugError\(/.test(line))).toEqual([]);
		expect(addedLines.some(line => line.includes(".catch(debugCatchError)"))).toBe(true);
		expect(addedLines.some(line => line.includes("debugCatchError(error)"))).toBe(true);
	});

	it("keeps CDP failures non-throwing when Puppeteer debug logging is disabled", () => {
		expect(debugError).toBeUndefined();
		expect(() => debugCatchError(new Error("CDP world acquisition failed"))).not.toThrow();
	});
});
