import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

/** `serve` must fail loud: non-zero exit plus a reason on stderr (issue #12442). */
async function runCli(args: string[], home: string): Promise<{ code: number; stderr: string }> {
	const proc = Bun.spawn(["bun", "packages/coding-agent/src/cli.ts", ...args], {
		cwd: path.join(import.meta.dir, "..", "..", ".."),
		env: { ...process.env, HOME: home, USERPROFILE: home },
		stdout: "ignore",
		stderr: "pipe",
	});
	const timeout = setTimeout(() => proc.kill(), 25_000);
	const stderr = await new Response(proc.stderr).text();
	const code = await proc.exited;
	clearTimeout(timeout);
	return { code, stderr };
}

function freshHome(): string {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "serve-fail-home-"));
	fs.mkdirSync(path.join(home, ".omp"), { recursive: true });
	return home;
}

afterEach(() => {
	delete process.env.OMP_AUTH_BROKER_URL;
});

describe("auth-broker serve startup failure", () => {
	test("unreadable token file exits non-zero with a reason on stderr", async () => {
		const home = freshHome();
		fs.mkdirSync(path.join(home, ".omp", "auth-broker.token"), { recursive: true });
		const { code, stderr } = await runCli(["auth-broker", "serve"], home);
		expect(code).toBe(1);
		expect(stderr).toContain("auth-broker serve failed to start");
	});

	test("occupied bind port exits non-zero with a reason on stderr", async () => {
		const home = freshHome();
		const blocker = net.createServer();
		await new Promise<void>(resolve => blocker.listen(0, "127.0.0.1", resolve));
		const port = (blocker.address() as net.AddressInfo).port;
		try {
			const { code, stderr } = await runCli(["auth-broker", "serve", "--bind", `127.0.0.1:${port}`], home);
			expect(code).toBe(1);
			expect(stderr).toContain("auth-broker serve failed to start");
		} finally {
			blocker.close();
		}
	});
});

describe("auth-gateway serve startup failure", () => {
	test("missing broker config exits non-zero with a reason on stderr", async () => {
		const home = freshHome();
		const { code, stderr } = await runCli(["auth-gateway", "serve"], home);
		expect(code).toBe(1);
		expect(stderr).toContain("auth-gateway serve failed to start");
	});
});
