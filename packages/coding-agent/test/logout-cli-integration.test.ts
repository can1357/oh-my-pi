import { expect, test } from "bun:test";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { TempDir } from "@oh-my-pi/pi-utils";

test("terminal logout reports failed real discovery after deletion without leaking upstream details", async () => {
	using tempDir = TempDir.createSync("@omp-logout-discovery-");
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response("fixture-sensitive-upstream-detail", { status: 500 }),
	});
	const dbPath = tempDir.join("agent.db");
	const storage = await AuthStorage.create(dbPath);
	try {
		await storage.credentials.set("logout-probe", { type: "api_key", key: "fixture-stored-key" });
	} finally {
		storage.close();
	}
	await Bun.write(
		tempDir.join("models.yml"),
		`providers:\n  logout-probe:\n    baseUrl: ${server.url}v1\n    apiKey: fixture-remaining-config-key\n    api: openai-completions\n    discovery:\n      type: openai-models-list\n`,
	);
	const childEnv: Record<string, string | undefined> = {
		...process.env,
		HOME: tempDir.path(),
		USERPROFILE: tempDir.path(),
		PI_CODING_AGENT_DIR: tempDir.path(),
		PI_CONFIG_FILES: "",
		OMP_AUTH_BROKER_URL: "",
		OMP_AUTH_BROKER_TOKEN: "",
		NO_COLOR: "1",
	};
	delete childEnv.OMP_PROFILE;
	delete childEnv.PI_PROFILE;
	const proc = Bun.spawn(
		[process.execPath, path.join(import.meta.dir, "..", "src", "cli.ts"), "logout", "logout-probe", "1"],
		{ cwd: tempDir.path(), env: childEnv, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
	);
	try {
		let output = "";
		let confirmed = false;
		const readOutput = async () => {
			const decoder = new TextDecoder();
			for await (const chunk of proc.stdout) {
				output += decoder.decode(chunk, { stream: true });
				if (!confirmed && output.includes("[y/N]")) {
					confirmed = true;
					proc.stdin.write("y\n");
				}
			}
			output += decoder.decode();
		};
		const [exitCode, errors] = await Promise.all([proc.exited, new Response(proc.stderr).text(), readOutput()]);
		expect(exitCode).toBe(1);
		expect(errors).toContain("Credential removed, but provider refresh failed");
		expect(output).toContain("Removed logout-probe account");
		for (const secret of [
			"fixture-sensitive-upstream-detail",
			"fixture-stored-key",
			"fixture-remaining-config-key",
		]) {
			expect(output + errors).not.toContain(secret);
		}
		const after = await AuthStorage.create(dbPath);
		try {
			await after.credentials.reload();
			expect(after.credentials.list("logout-probe")).toEqual([]);
			expect(await after.credentials.listDisabled("logout-probe")).toEqual([]);
		} finally {
			after.close();
		}
	} finally {
		proc.kill();
		await proc.exited;
		server.stop(true);
	}
}, 30_000);
