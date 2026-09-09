import { describe, expect, it } from "bun:test";
import * as path from "node:path";

describe("Cursor transport errors", () => {
	it("surfaces a TLS handshake reset as a stream error", async () => {
		const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/cursor-tls-reset.ts")], {
			cwd: path.resolve(import.meta.dir, "../../.."),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);

		expect(exitCode).toBe(0);
		expect(stderr).toBe("");
		expect(JSON.parse(stdout)).toEqual({
			eventTypes: ["start", "error"],
			stopReason: "error",
		});
	}, 60_000);
});
