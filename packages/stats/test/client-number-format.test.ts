import { afterEach, describe, expect, it, vi } from "bun:test";
import { formatCompact, formatCost, formatErrorRate, formatInteger } from "../src/client/data/formatters";

// Simulate a browser whose default locale is tr-TR, where compact "B" means
// "bin" (thousand) and "," is the decimal separator. Formatters that fall back
// to the default locale would render `546 B` and `$38.003,33` here.
const nativeToLocaleString = Number.prototype.toLocaleString;

afterEach(() => {
	vi.restoreAllMocks();
});

describe("dashboard number formatting", () => {
	it("ignores the browser locale so figures match the English UI", () => {
		vi.spyOn(Number.prototype, "toLocaleString").mockImplementation(function (
			this: number,
			locales?: Intl.LocalesArgument,
			options?: Intl.NumberFormatOptions,
		) {
			return nativeToLocaleString.call(this, locales ?? "tr-TR", options);
		});

		expect(formatInteger(435_087)).toBe("435,087");
		expect(formatCompact(546_000)).toBe("546K");
		expect(formatCompact(1_400_000_000)).toBe("1.4B");
		expect(formatCost(38_003.33)).toBe("$38,003.33");
		expect(formatCost(0.0192, 4)).toBe("$0.0192");
	});
});

describe("error-rate formatting", () => {
	it("keeps rare failures visible without changing ordinary rates or zero", () => {
		expect(formatErrorRate(4 / 10_052)).toBe("0.04%");
		expect(formatErrorRate(1 / 10_000_000)).toBe("<0.01%");
		expect(formatErrorRate(1 / 100)).toBe("1.0%");
		expect(formatErrorRate(0)).toBe("0.0%");
	});
});
