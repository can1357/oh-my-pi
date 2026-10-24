import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WelcomeComponent } from "@oh-my-pi/pi-tui/prompt/welcome";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

const ENV_KEYS = ["RESEARCHHARNESS_BRAND_NAME", "RESEARCHHARNESS_BRAND_LOGO", "RESEARCHHARNESS_BRAND_TIPS"] as const;
const saved = new Map<string, string | undefined>();

beforeAll(async () => {
	await initTheme(false);
});

afterEach(() => {
	vi.restoreAllMocks();
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
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "welcome-brand-"));
	const file = path.join(dir, name);
	fs.writeFileSync(file, content);
	return file;
}

/** Plain-text rows of the terminal banner at `columns`. */
function rows(component: WelcomeComponent, columns = 100): string[] {
	return component.render(columns).map(row => Bun.stripANSI(row));
}

describe("WelcomeComponent branding", () => {
	it("keeps the stock omp wordmark when brand env is unset", () => {
		setEnv("RESEARCHHARNESS_BRAND_NAME", undefined);
		const text = rows(new WelcomeComponent("1.2.3")).join("\n");
		expect(text).toContain("▄▀▀▄");
		expect(text).not.toContain("Research Harness");
	});

	it("sets the brand name in place of the wordmark with the version under it", () => {
		setEnv("RESEARCHHARNESS_BRAND_NAME", "Research Harness");
		const component = new WelcomeComponent("1.2.3");
		const banner = rows(component);
		const name = banner.find(row => row.includes("Research Harness"));
		const version = banner.find(row => row.includes("v1.2.3"));
		expect(banner.join("\n")).not.toContain("▄▀▀▄");
		expect(version?.indexOf("v1.2.3")).toBe(name?.indexOf("Research Harness"));

		expect(component.describe({} as never).c?.[0]).toMatchObject({
			c: [{ k: "image" }, { c: [{ p: { spans: [{ t: "Research Harness" }] } }, {}] }],
		});
	});

	it("keeps the name and version beside a brand logo shorter than the lockup", () => {
		setEnv("RESEARCHHARNESS_BRAND_NAME", "Research Harness");
		setEnv("RESEARCHHARNESS_BRAND_LOGO", tmpFile("logo.txt", "▓▓▓▓▓▓\n"));
		const text = rows(new WelcomeComponent("1.2.3")).join("\n");
		expect(text).toContain("▓▓▓▓▓▓");
		expect(text).not.toContain("████████████");
		expect(text).toContain("Research Harness");
		expect(text).toContain("v1.2.3");
	});

	it("picks tips from the brand tips file when set", () => {
		setEnv("RESEARCHHARNESS_BRAND_TIPS", tmpFile("tips.txt", "only-brand-tip\n"));
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		expect(new WelcomeComponent("1.2.3").tip).toBe("only-brand-tip");
	});

	it("falls back to stock tips when the brand tips file is missing", () => {
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		setEnv("RESEARCHHARNESS_BRAND_TIPS", undefined);
		const stock = new WelcomeComponent("1.2.3").tip;
		setEnv("RESEARCHHARNESS_BRAND_TIPS", "/nonexistent/branding/tips.txt");
		expect(new WelcomeComponent("1.2.3").tip).toBe(stock);
	});
});
