import { expect, test } from "bun:test";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

const cliEntry = path.join(import.meta.dir, "..", "src", "cli.ts");

test("omp dry-balance routes by account policies from a --config overlay", async () => {
	const agentDir = TempDir.createSync("@omp-dry-balance-config-");
	try {
		await Bun.write(
			path.join(agentDir.path(), "models.yml"),
			[
				"providers:",
				"  acme:",
				"    baseUrl: https://acme.example.test/v1",
				"    api: openai-completions",
				"    auth: oauth",
				"    models:",
				"      - id: balance-model",
				"",
			].join("\n"),
		);
		const authStorage = await AuthStorage.create(path.join(agentDir.path(), "agent.db"));
		const account = (name: string) => ({
			type: "oauth" as const,
			access: `access-${name}`,
			refresh: `refresh-${name}`,
			expires: Date.now() + 60 * 60_000,
			email: `${name}@example.com`,
		});
		await authStorage.credentials.set("acme", [account("a"), account("b")]);
		authStorage.close();
		const overlayPath = path.join(agentDir.path(), "policy-overlay.yml");
		await Bun.write(
			overlayPath,
			[
				"auth:",
				"  accountPolicies:",
				"    - provider: acme",
				"      account:",
				"        email: b@example.com",
				"      priority: 10",
				"",
			].join("\n"),
		);

		const child = Bun.spawn(
			[
				process.execPath,
				cliEntry,
				"dry-balance",
				"acme/balance-model",
				"--count",
				"20",
				"--json",
				"--config",
				overlayPath,
			],
			{
				cwd: agentDir.path(),
				env: { ...process.env, NO_COLOR: "1", PI_CODING_AGENT_DIR: agentDir.path() },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);

		expect(stderr).toBe("");
		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout).success.accounts).toEqual([{ account: "b@example.com", count: 20, percent: 100 }]);
	} finally {
		await agentDir.remove();
	}
});
