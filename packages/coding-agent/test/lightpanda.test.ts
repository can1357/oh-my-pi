import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { findLightpandaExecutable, launchLightpandaBrowser, resolveBrowserEngine } from "../src/tools/browser/lightpanda";

describe("lightpanda browser engine", () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		delete process.env.OMP_BROWSER_ENGINE;
		delete process.env.LIGHTPANDA_PATH;
	});

	afterEach(() => {
		process.env = { ...originalEnv };
		vi.restoreAllMocks();
	});

	it("resolves default browser engine as chromium", () => {
		expect(resolveBrowserEngine()).toBe("chromium");
		expect(resolveBrowserEngine("chromium")).toBe("chromium");
	});

	it("resolves engine as lightpanda when requested or set via OMP_BROWSER_ENGINE", () => {
		expect(resolveBrowserEngine("lightpanda")).toBe("lightpanda");

		process.env.OMP_BROWSER_ENGINE = "lightpanda";
		expect(resolveBrowserEngine()).toBe("lightpanda");
	});

	it("respects LIGHTPANDA_PATH environment variable if set", async () => {
		process.env.LIGHTPANDA_PATH = "/custom/path/to/lightpanda";
		const execPath = await findLightpandaExecutable();
		expect(execPath).toBe("/custom/path/to/lightpanda");
	});

	it("fails with error if lightpanda executable is missing or invalid", async () => {
		process.env.LIGHTPANDA_PATH = "/path/that/does/not/exist/lightpanda";
		await expect(launchLightpandaBrowser()).rejects.toThrow();
	});
});
