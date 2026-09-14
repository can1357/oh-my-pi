import { expect, it } from "bun:test";
import { acquireBrowser, releaseBrowser } from "../../src/tools/browser/registry";

it.each([false, true])(
	"retains Firefox endpoint ownership through pending cleanup=%s",
	async pendingCleanup => {
		const webSocketUrl = `ws://localhost:9222/lease-${crypto.randomUUID()}`;
		const kind = { kind: "firefox-relay" as const, webSocketUrl };
		const handle = await acquireBrowser(kind, { cwd: process.cwd() });
		const cleanup = Promise.withResolvers<void>();
		if (pendingCleanup && "webSocketUrl" in handle) handle.connectionCleanup = cleanup.promise;
		const probe = async (profile = `lease-probe-${crypto.randomUUID()}`) => {
			const child = Bun.spawn(
				[
					process.execPath,
					`${import.meta.dir}/../fixtures/firefox-endpoint-lease-probe.ts`,
					webSocketUrl.replace("localhost", "127.0.0.1"),
				],
				{
					env: { ...process.env, OMP_PROFILE: profile, PI_PROFILE: profile },
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const [exitCode, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect(stderr).toBe("");
			return { exitCode, stdout: stdout.trim() };
		};
		try {
			expect(await probe("separate-named-profile")).toEqual({ exitCode: 0, stdout: "contended" });
		} finally {
			await releaseBrowser(handle, { kill: false });
			if (pendingCleanup) {
				try {
					expect(await probe()).toEqual({ exitCode: 0, stdout: "contended" });
					await expect(acquireBrowser(kind, { cwd: process.cwd() })).rejects.toThrow("already owned");
				} finally {
					cleanup.resolve();
					await cleanup.promise;
				}
			}
		}
		expect(await probe()).toEqual({ exitCode: 0, stdout: "acquired" });
	},
	15_000,
);
