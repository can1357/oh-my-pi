/**
 * Optional rebranding for host surfaces that ship generic ("omp").
 * The research-harness launcher sets RESEARCHHARNESS_BRAND_* so its TUI
 * presents as the research harness; unset env = fully stock behavior.
 * All reads are at call time and degrade to stock on any problem — branding
 * must never break startup.
 */
import * as fs from "node:fs";

export const BRAND_NAME_ENV = "RESEARCHHARNESS_BRAND_NAME";
export const BRAND_LOGO_ENV = "RESEARCHHARNESS_BRAND_LOGO";
export const BRAND_TIPS_ENV = "RESEARCHHARNESS_BRAND_TIPS";

/** Trimmed display name for branded surfaces, or "" to keep the stock app name. */
export function getBrandDisplayName(): string {
	const value = process.env[BRAND_NAME_ENV]?.trim();
	return value ? value : "";
}

/**
 * Brand logo rows, or undefined when unset/unreadable. Leading/trailing spaces
 * are preserved — the rows are a fixed-width block grid, so trimming them would
 * shear every column off its baseline. Blank rows are dropped.
 */
export function getBrandLogo(): readonly string[] | undefined {
	return readBrandLines(BRAND_LOGO_ENV);
}

/** Trimmed non-blank lines of the brand tips file, or undefined when unset/unreadable. */
export function getBrandTips(): readonly string[] | undefined {
	return readBrandLines(BRAND_TIPS_ENV)?.map(line => line.trim());
}

function readBrandLines(envKey: string): readonly string[] | undefined {
	const file = process.env[envKey]?.trim();
	if (!file) return undefined;
	try {
		return fs
			.readFileSync(file, "utf8")
			.split("\n")
			.map(line => line.replace(/\r$/, ""))
			.filter(line => line.trim().length > 0);
	} catch {
		return undefined;
	}
}
