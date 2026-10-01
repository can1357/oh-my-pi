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

	afterEach(() => {
		for (const name of dirs) {
			fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true });
		}
		dirs.length = 0;
	});

	it("re-stages the runner after the cached file is deleted mid-session", async () => {
		const dirName = uniqueDir();
		const script = "print('staged runner')\n";

		const first = await stageRunnerScript(dirName, "py", script);
		expect(fs.existsSync(first)).toBe(true);

		// Simulate a mid-session tmpdir sweep clearing the whole cache dir.
		fs.rmSync(path.join(os.tmpdir(), dirName), { recursive: true, force: true });
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
});
