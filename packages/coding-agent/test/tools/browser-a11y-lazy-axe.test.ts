import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { buildA11yPageScript } from "../../src/tools/browser/a11y/audit";

interface AxeLoadProbeResult {
	retainedAxeBundleStrings: number;
}

const probePath = path.resolve(import.meta.dir, "..", "fixtures", "a11y-axe-load-probe.ts");

describe("accessibility audit axe-core loading", () => {
	test("importing the audit module does not pull the axe-core bundle into memory", async () => {
		const proc = Bun.spawn([process.execPath, probePath], { stderr: "pipe", stdout: "pipe" });
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);

		expect(exitCode, stderr).toBe(0);
		expect(JSON.parse(stdout) as AxeLoadProbeResult).toEqual({ retainedAxeBundleStrings: 0 });
	}, 30_000);

	test("the bundle is loaded once a page script is built", async () => {
		const script = await buildA11yPageScript();
		expect(script).toContain("/*! axe v");
		expect(script.length).toBeGreaterThan(500_000);
	}, 30_000);
});
