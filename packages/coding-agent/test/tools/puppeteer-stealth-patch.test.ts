import { describe, expect, it } from "bun:test";
import {
	getSourcePuppeteerURLIfAvailable,
	withSourcePuppeteerURLIfNone,
} from "puppeteer-core/lib/puppeteer/common/util.js";

describe("Puppeteer stealth patch", () => {
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
