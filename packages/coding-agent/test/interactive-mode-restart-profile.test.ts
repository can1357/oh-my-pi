import { expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

it("native restart preserves the active profile and reopens its persisted session", async () => {
	using tempDir = TempDir.createSync("@omp-restart-profile-");
	const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/restart-profile.ts")], {
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
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
	const result = JSON.parse(stdout.trim());
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
