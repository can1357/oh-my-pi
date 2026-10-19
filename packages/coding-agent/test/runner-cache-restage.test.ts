import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stageRunnerScript } from "../src/eval/runner-cache";

// stageRunnerScript memoizes the staged path per cache directory, but the warm
// path must re-validate with fs.existsSync so a tmpdir sweep (macOS periodic
// `clean_tmps`) or any external clear self-heals within a long-lived process
// instead of returning a path to a missing file (issue #8140).
describe("stageRunnerScript re-validation", () => {
	const dirs: string[] = [];

	function uniqueDir() {
		const name = `omp-runner-cache-test-${process.pid}-${dirs.length}-${Date.now()}`;
		dirs.push(name);
		return name;
	}

	// Mirrors stageRunnerScript's per-uid directory naming.
	function stagingDir(name: string) {
		const uid = process.getuid?.();
		return path.join(os.tmpdir(), uid === undefined ? name : `${name}-${uid}`);
	}

	afterEach(() => {
		// Covers the shared name, the per-uid dir, mkdtemp fallbacks, and decoys:
		// every name is unique per pid/test/time, so a prefix match is safe.
		const tmp = os.tmpdir();
		for (const entry of fs.readdirSync(tmp)) {
			if (dirs.some(name => entry.startsWith(name))) {
				fs.rmSync(path.join(tmp, entry), { recursive: true, force: true });
			}
		}
		dirs.length = 0;
	});

	it("re-stages the runner after the cached file is deleted mid-session", async () => {
		const dirName = uniqueDir();
		const script = "print('staged runner')\n";

		const first = await stageRunnerScript(dirName, "py", script);
		expect(fs.existsSync(first)).toBe(true);

		// Simulate a mid-session tmpdir sweep clearing the whole cache dir.
		fs.rmSync(stagingDir(dirName), { recursive: true, force: true });
		expect(fs.existsSync(first)).toBe(false);

		// Same process, memo still set: the warm path must fall through and
		// re-stage instead of handing back the now-missing path.
		const second = await stageRunnerScript(dirName, "py", script);
		expect(second).toBe(first);
		expect(fs.existsSync(second)).toBe(true);
		expect(await Bun.file(second).text()).toBe(script);
	});

	it("reuses the memoized path while the file still exists", async () => {
		const dirName = uniqueDir();
		const script = "puts 'hi'\n";

		const first = await stageRunnerScript(dirName, "rb", script);
		const second = await stageRunnerScript(dirName, "rb", script);

		expect(second).toBe(first);
		expect(first.endsWith(".rb")).toBe(true);
		expect(fs.existsSync(second)).toBe(true);
	});

	// The shared, un-suffixed tmpdir name may be owned by another account (e.g.
	// root created it 0755 first); staging must not write into it, or every other
	// user's Python eval fails with EACCES. A non-writable dir stands in for the
	// foreign owner; root bypasses mode bits and Windows has no getuid, so skip both.
	it.skipIf(process.getuid?.() === undefined || process.getuid?.() === 0)(
		"stages outside a shared dir the current user cannot write",
		async () => {
			const dirName = uniqueDir();
			const shared = path.join(os.tmpdir(), dirName);
			fs.mkdirSync(shared, { mode: 0o555 });

			const staged = await stageRunnerScript(dirName, "py", "print('ok')\n");

			expect(path.dirname(staged)).not.toBe(shared);
			expect(await Bun.file(staged).text()).toBe("print('ok')\n");
			expect(fs.statSync(path.dirname(staged)).mode & 0o777).toBe(0o700);
		},
	);

	// The per-uid name is predictable, so another account can pre-create it. A
	// symlink to a directory it controls, holding a runner under the
	// deterministic hashed name, must not be executed as ours.
	it.skipIf(process.getuid?.() === undefined)("refuses a runner planted behind a symlinked staging dir", async () => {
		const dirName = uniqueDir();
		const script = "print('ours')\n";
		const decoy = path.join(os.tmpdir(), `${dirName}-decoy`);
		const planted = path.join(decoy, `runner-${Bun.hash(script).toString(36)}.py`);
		fs.mkdirSync(decoy, { mode: 0o777 });
		fs.writeFileSync(planted, "print('planted')\n");
		fs.symlinkSync(decoy, stagingDir(dirName));

		const staged = await stageRunnerScript(dirName, "py", script);

		expect(fs.realpathSync(staged)).not.toBe(fs.realpathSync(planted));
		expect(await Bun.file(staged).text()).toBe(script);
		expect(fs.statSync(path.dirname(staged)).mode & 0o777).toBe(0o700);
	});

	// The warm memo path must re-check the dir too: after a tmp sweep another
	// account can recreate the per-uid name and plant the hashed runner there.
	it.skipIf(process.getuid?.() === undefined)("re-validates the staging dir before reusing the memo", async () => {
		const dirName = uniqueDir();
		const script = "print('ours')\n";
		const first = await stageRunnerScript(dirName, "py", script);

		fs.rmSync(stagingDir(dirName), { recursive: true, force: true });
		const decoy = path.join(os.tmpdir(), `${dirName}-decoy`);
		fs.mkdirSync(decoy, { mode: 0o777 });
		fs.writeFileSync(path.join(decoy, path.basename(first)), "print('planted')\n");
		fs.symlinkSync(decoy, stagingDir(dirName));
		expect(fs.existsSync(first)).toBe(true);

		const second = await stageRunnerScript(dirName, "py", script);

		expect(second).not.toBe(first);
		expect(await Bun.file(second).text()).toBe(script);
		expect(fs.statSync(path.dirname(second)).mode & 0o777).toBe(0o700);
	});

	// A non-directory squatting the per-uid name must not block staging.
	it.skipIf(process.getuid?.() === undefined)("stages when the per-uid name is a squatted file", async () => {
		const dirName = uniqueDir();
		fs.writeFileSync(stagingDir(dirName), "");

		const staged = await stageRunnerScript(dirName, "py", "print('ok')\n");

		expect(await Bun.file(staged).text()).toBe("print('ok')\n");
	});
});
