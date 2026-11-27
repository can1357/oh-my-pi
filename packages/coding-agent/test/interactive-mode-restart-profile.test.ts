import { expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

async function runRestart(scenario: "profile" | "deleted-cwd"): Promise<string> {
	using tempDir = TempDir.createSync("@omp-restart-profile-");
	const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/restart-profile.ts"), scenario], {
		cwd: tempDir.path(),
		env: {
			...process.env,
			// os.homedir() reads USERPROFILE on Windows, HOME elsewhere.
			HOME: tempDir.path(),
			USERPROFILE: tempDir.path(),
			OMP_PROFILE: undefined,
			PI_PROFILE: undefined,
			PI_CODING_AGENT_DIR: undefined,
			PI_CODING_AGENT_SESSION_DIR: undefined,
			PI_CONFIG_DIR: ".omp",
			XDG_DATA_HOME: undefined,
			XDG_STATE_HOME: undefined,
			XDG_CACHE_HOME: undefined,
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		signal: AbortSignal.timeout(10_000),
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
	return stdout.trim();
}

it("native restart preserves the active profile and reopens its persisted session", async () => {
	const result = JSON.parse(await runRestart("profile"));
	expect(result.profile).toBe("restart-work");
	expect(result.entries).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				type: "message",
				message: expect.objectContaining({ role: "user", content: "profile restart marker" }),
			}),
		]),
	);
}, 30_000);

it.skipIf(process.platform === "win32")(
	"refuses restart from a removed working directory without closing the session",
	async () => {
		const result = JSON.parse(await runRestart("deleted-cwd"));
		expect(result.transcript).toContain("/move <dir>");
		expect(result.disposed).toBe(false);
	},
	30_000,
);
