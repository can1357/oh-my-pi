import { describe, expect, it } from "bun:test";
import {
	debugCatchError,
	debugError,
	getSourcePuppeteerURLIfAvailable,
	withSourcePuppeteerURLIfNone,
} from "puppeteer-core/lib/puppeteer/common/util.js";

describe("Puppeteer stealth patch", () => {
	it("keeps CDP failures non-throwing when Puppeteer debug logging is disabled", () => {
		expect(debugError).toBeUndefined();
		expect(() => debugCatchError(new Error("CDP world acquisition failed"))).not.toThrow();
	});

	it("keeps source attribution usable when compiled binaries expose one stack frame", () => {
		const stackTraceLimit = Error.stackTraceLimit;
		Error.stackTraceLimit = 1;
		try {
			const tagged = withSourcePuppeteerURLIfNone("queryAll", () => 1);
			const sourceUrl = getSourcePuppeteerURLIfAvailable(tagged);

			expect(String(sourceUrl)).toStartWith("pptr:queryAll;");
			expect(sourceUrl?.siteString).not.toBe("");
		} finally {
			Error.stackTraceLimit = stackTraceLimit;
		}
	});
});
