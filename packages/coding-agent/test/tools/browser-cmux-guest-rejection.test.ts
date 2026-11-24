import { expect, test } from "bun:test";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "../../../..");

/** A host process that runs `code` in a cmux tab and prints how the run failed. */
function probe(code: string): string {
	return `
import { spyOn } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CmuxSocketClient } from "@oh-my-pi/pi-coding-agent/tools/browser/cmux/socket-client";
import { acquireBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import { acquireTab, releaseTab, runInTab } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";

const cwd = process.cwd();
spyOn(CmuxSocketClient.prototype, "connect").mockResolvedValue(undefined);
spyOn(CmuxSocketClient.prototype, "close").mockImplementation(() => undefined);
spyOn(CmuxSocketClient.prototype, "request").mockImplementation(async method => {
	if (method === "browser.open_split") return { surface_id: "rejection-probe", url: "about:blank" };
	if (method === "browser.url.get") return { url: "about:blank" };
	if (method === "browser.snapshot") return { page: { html: "" } };
	if (method === "browser.eval") return { value: "" };
	return {};
});
const browser = await acquireBrowser({
	kind: "cmux",
	socketPath: "/tmp/unused-cmux-rejection-probe.sock",
	surface: "rejection-probe",
}, { cwd });
await acquireTab("rejection-probe", browser, { timeoutMs: 5_000 });
const session = { cwd, hasUI: false, settings: Settings.isolated({}), getSessionFile: () => null };

try {
	await runInTab("rejection-probe", {
		code: ${JSON.stringify(code)},
		timeoutMs: 10_000,
		session,
	});
	process.stdout.write("unexpected success\\n");
	process.exitCode = 2;
} catch (error) {
	process.stdout.write(\`caught:\${error instanceof Error ? error.message : String(error)}\\n\`);
} finally {
	await releaseTab("rejection-probe", { kill: false });
}
`;
}

async function runProbe(code: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn([process.execPath, "--eval", probe(code)], {
		cwd: repoRoot,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

test("cmux guest floating rejection fails the browser run without exiting the host", async () => {
	const { exitCode, stdout, stderr } = await runProbe(`
		const { promise, reject } = Promise.withResolvers();
		reject(new Error("boom"));
		await Bun.file("package.json").text();
		await promise.catch(() => undefined);
	`);

	expect(exitCode, stderr).toBe(0);
	expect(stdout).toBe("caught:Unhandled rejection (missing await?): boom\n");
	expect(stderr).not.toContain("[Unhandled Rejection]");
});

test("an unawaited page-global miss in cmux guest code gets the agent-visible run hint", async () => {
	const { exitCode, stdout, stderr } = await runProbe(`
		Promise.resolve().then(() => document.title);
		await Bun.file("package.json").text();
	`);

	expect(exitCode, stderr).toBe(0);
	expect(stdout).toContain("caught:Unhandled rejection (missing await?): document is not defined");
	expect(stdout).toContain("tab.run code runs in omp's Bun runtime, not in the page");
	expect(stdout).toContain("run page code with tab.evaluate(...)");
});
