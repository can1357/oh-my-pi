import { expect, test } from "bun:test";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "../../../..");

const probe = `
import { CmuxTab, runCmuxCode } from "@oh-my-pi/pi-coding-agent/tools/browser/cmux/cmux-tab";
import { CmuxSocketClient } from "@oh-my-pi/pi-coding-agent/tools/browser/cmux/socket-client";

const cwd = process.cwd();
const tab = new CmuxTab({
	client: new CmuxSocketClient({ socketPath: "/tmp/unused-cmux-rejection-probe.sock" }),
	surfaceId: "rejection-probe",
});
const session = { cwd, hasUI: false, getSessionFile: () => null };

try {
	await runCmuxCode(tab, {
		code: \`
			const { promise, reject } = Promise.withResolvers();
			reject(new Error("boom"));
			await Bun.file("package.json").text();
			await promise.catch(() => undefined);
		\`,
		timeoutMs: 10_000,
		session,
		snapshot: { cwd },
	});
	process.stdout.write("unexpected success\\n");
	process.exitCode = 2;
} catch (error) {
	process.stdout.write(\`caught:\${error instanceof Error ? error.message : String(error)}\\n\`);
}
`;

test("cmux guest floating rejection fails the browser run without exiting the host", async () => {
	const proc = Bun.spawn([process.execPath, "--eval", probe], {
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

	expect(exitCode, stderr).toBe(0);
	expect(stdout).toBe("caught:Unhandled rejection (missing await?): boom\n");
	expect(stderr).not.toContain("[Unhandled Rejection]");
});
