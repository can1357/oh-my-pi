import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBrandDisplayName, getBrandLogo, getBrandTips } from "@oh-my-pi/pi-utils/branding";

const ENV_KEYS = ["RESEARCHHARNESS_BRAND_NAME", "RESEARCHHARNESS_BRAND_LOGO", "RESEARCHHARNESS_BRAND_TIPS"] as const;
const saved = new Map<string, string | undefined>();

afterEach(() => {
	for (const key of ENV_KEYS) {
		const value = saved.get(key);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	saved.clear();
});

function setEnv(key: (typeof ENV_KEYS)[number], value: string | undefined): void {
	if (!saved.has(key)) saved.set(key, process.env[key]);
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

function tmpFile(name: string, content: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "branding-"));
	const file = path.join(dir, name);
	fs.writeFileSync(file, content);
	return file;
}

describe("branding", () => {
	it("returns empty display name when env is unset (stock omp title)", () => {
		setEnv("RESEARCHHARNESS_BRAND_NAME", undefined);
		expect(getBrandDisplayName()).toBe("");
	});

	it("returns trimmed display name from env", () => {
		setEnv("RESEARCHHARNESS_BRAND_NAME", "  Research Harness  ");
		expect(getBrandDisplayName()).toBe("Research Harness");
	});

	it("treats whitespace-only display name as unset", () => {
		setEnv("RESEARCHHARNESS_BRAND_NAME", "   ");
		expect(getBrandDisplayName()).toBe("");
	});

	it("returns undefined logo when env unset", () => {
		setEnv("RESEARCHHARNESS_BRAND_LOGO", undefined);
		expect(getBrandLogo()).toBeUndefined();
	});

	it("reads logo rows and drops blank lines", () => {
		const file = tmpFile("logo.txt", " ██████████ \n\n   ██  ██   \n");
		setEnv("RESEARCHHARNESS_BRAND_LOGO", file);
		expect(getBrandLogo()).toEqual([" ██████████ ", "   ██  ██   "]);
	});

	it("degrades to undefined for an unreadable logo path", () => {
		setEnv("RESEARCHHARNESS_BRAND_LOGO", "/nonexistent/branding/logo.txt");
		expect(getBrandLogo()).toBeUndefined();
	});

	it("reads tips and drops blank lines", () => {
		const file = tmpFile("tips.txt", "tip one\n\ntip two\n");
		setEnv("RESEARCHHARNESS_BRAND_TIPS", file);
		expect(getBrandTips()).toEqual(["tip one", "tip two"]);
	});

	it("trims indentation off tips while leaving logo rows aligned", () => {
		setEnv("RESEARCHHARNESS_BRAND_TIPS", tmpFile("tips.txt", "   indented tip   \n"));
		setEnv("RESEARCHHARNESS_BRAND_LOGO", tmpFile("logo.txt", "   ██   \n"));
		expect(getBrandTips()).toEqual(["indented tip"]);
		expect(getBrandLogo()).toEqual(["   ██   "]);
	});

	it("degrades to undefined for an unreadable tips path", () => {
		setEnv("RESEARCHHARNESS_BRAND_TIPS", "/nonexistent/branding/tips.txt");
		expect(getBrandTips()).toBeUndefined();
	});
});
