import { describe, expect, it } from "bun:test";

async function runHost(source: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const child = Bun.spawn([process.execPath, "-e", source], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

describe("SDK import process ownership", () => {
	it.skipIf(process.platform === "win32")("lets the embedding host finish its SIGTERM shutdown", async () => {
		// Real signal delivery and an asynchronous stop must overlap the installed handler's exit.
		const result = await runHost(`
			process.on("SIGTERM", async () => {
				await Bun.sleep(100);
				process.stdout.write("host stopped cleanly\\n");
				process.exit(0);
			});
			// Dynamic import tests the host's process listener before the SDK dependency graph evaluates.
			await import("@oh-my-pi/pi-catalog");
			process.kill(process.pid, "SIGTERM");
		`);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("host stopped cleanly");
	});

	it("still runs registered cleanup when the embedding host exits", async () => {
		const result = await runHost(`
			const { postmortem } = await import("@oh-my-pi/pi-utils");
			postmortem.register("host-probe", () => process.stdout.write("cleanup ran\\n"));
			process.exit(0);
		`);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("cleanup ran");
	});
});
