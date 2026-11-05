import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";

const HISTORY_STORAGE = path.join(import.meta.dir, "..", "src", "session", "history-storage.ts");

// Even without the test preload's own agent dir, a test that names none must not write prompts into
// the user's ~/.omp/agent/history.db.
test("a test run without an agent dir of its own leaves the user's prompt history untouched", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-history-test-runtime-"));
	try {
		const home = path.join(root, "home");
		const agentDir = path.join(home, ".omp", "agent");
		await fs.mkdir(agentDir, { recursive: true });
		// A `*.test.ts` entry in a directory with no bunfig.toml: a real `bun test` run, without the
		// preload, that opens the default store the way interactive mode does.
		const probe = path.join(root, "history.test.ts");
		await Bun.write(
			probe,
			[
				'import { expect, test } from "bun:test";',
				`import { HistoryStorage } from ${JSON.stringify(url.pathToFileURL(HISTORY_STORAGE).href)};`,
				'test("submit a prompt", async () => {',
				"	const history = HistoryStorage.open();",
				'	await history.add("hermetic history probe", "/tmp");',
				'	expect(history.getRecent(5).map(entry => entry.prompt)).toContain("hermetic history probe");',
				"	HistoryStorage.close();",
				"});",
			].join("\n"),
		);
		const env: Record<string, string | undefined> = { ...process.env, HOME: home, USERPROFILE: home };
		delete env.PI_CODING_AGENT_DIR;
		const child = Bun.spawn([process.execPath, "test", probe], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
		const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
		expect(exitCode, stderr).toBe(0);
		expect(await fs.readdir(agentDir)).toEqual([]);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}, 60_000);
