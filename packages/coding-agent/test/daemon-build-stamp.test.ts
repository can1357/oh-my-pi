import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { VERSION } from "@oh-my-pi/pi-utils";

/**
 * Contract: the build stamp is stable per process, versioned, and derives its
 * epoch from the ENTRY context — a .ts entry outside the workspace layout
 * (SDK embedding, ad-hoc scripts) must fall back to the entry file's own
 * mtime instead of globbing a random grandparent directory for sources.
 */
describe("daemonBuildStamp", () => {
	test("non-workspace .ts entries stamp from the entry mtime, not a stray glob", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-stamp-fallback-"));
		// Deliberately NOT under a "packages/<pkg>/src" layout.
		const entry = path.join(root, "probe.ts");
		const script = `
import { daemonBuildStamp } from ${JSON.stringify(path.join(import.meta.dir, "..", "src", "daemon", "build-stamp.ts"))};
console.log(await daemonBuildStamp());
`;
		fs.writeFileSync(entry, script);
		const entryEpoch = Math.trunc(fs.statSync(entry).mtimeMs);
		try {
			const result = Bun.spawnSync(["bun", entry], {
				env: { ...process.env, OMP_DAEMON_BUILD_STAMP: "" },
			});
			const stamp = result.stdout.toString().trim().split("\n").at(-1);
			expect(result.exitCode).toBe(0);
			expect(stamp).toBe(`${VERSION}+${entryEpoch.toString(36)}`);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 20_000);

	test("explicit override pins the pairing identity", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-stamp-override-"));
		const entry = path.join(root, "probe.ts");
		const script = `
import { daemonBuildStamp } from ${JSON.stringify(path.join(import.meta.dir, "..", "src", "daemon", "build-stamp.ts"))};
console.log(await daemonBuildStamp());
`;
		fs.writeFileSync(entry, script);
		try {
			const result = Bun.spawnSync(["bun", entry], {
				env: { ...process.env, OMP_DAEMON_BUILD_STAMP: "pinned-identity" },
			});
			expect(result.exitCode).toBe(0);
			expect(result.stdout.toString().trim().split("\n").at(-1)).toBe("pinned-identity");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 20_000);
});
