import { afterEach, beforeEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "../src/async";
import { Settings } from "../src/config/settings";
import type { ToolSession } from "../src/tools";
import { BashTool } from "../src/tools/bash";
import { WriteTool } from "../src/tools/write";

let cwd: string;
let manager: AsyncJobManager;
let tool: BashTool;
let write: WriteTool;

beforeEach(async () => {
	cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-job-lifecycle-"));
	manager = new AsyncJobManager({});
	const session: ToolSession = {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionId: () => cwd,
		getSessionSpawns: () => "*",
		asyncJobManager: manager,
		settings: Settings.isolated({}),
	};
	tool = new BashTool(session);
	write = new WriteTool(session);
});

afterEach(async () => {
	await manager.dispose();
	await fs.rm(cwd, { recursive: true, force: true });
});

it.skipIf(process.platform === "win32")(
	"allows a cancelled bash job to run its TERM cleanup",
	async () => {
		const script = path.join(cwd, "cleanup.sh");
		await Bun.write(
			script,
			"trap 'sleep 0.2; printf cleaned >> cleaned; exit 0' TERM\nprintf 'ready\\n'\nwhile :; do :; done\n",
		);
		const ready = Promise.withResolvers<void>();
		const result = await tool.execute(
			"term-cleanup",
			{ command: `sh ${JSON.stringify(script)}`, async: true, timeout: 0 },
			undefined,
			update => {
				if (update.content?.some(block => block.type === "text" && block.text.includes("ready"))) ready.resolve();
			},
		);
		await ready.promise;
		const id = result.details?.async?.jobId;
		if (!id) throw new Error("expected background job");
		const watchAbort = new AbortController();
		const watcher = fs.watch(cwd, { signal: watchAbort.signal });
		const cleaned = (async () => {
			for await (const event of watcher) {
				if (event.filename === "cleaned") return true;
			}
			return false;
		})();
		// A real subprocess handles TERM; fake timers cannot bound its OS-level cleanup.
		const deadline = Promise.withResolvers<false>();
		const watchdog = setTimeout(() => deadline.resolve(false), 3_000);
		try {
			const cancelled = await write.execute("cancel-cleanup", { path: `proc://${id}/kill` });
			expect(cancelled.details?.proc).toMatchObject({ cancelled: [{ id, status: "cancelled" }] });
			await manager.waitForAll();
			expect(await Promise.race([cleaned, deadline.promise])).toBe(true);
			expect(await Bun.file(path.join(cwd, "cleaned")).text()).toBe("cleaned");
		} finally {
			clearTimeout(watchdog);
			watchAbort.abort();
			await cleaned.catch(() => {});
		}
	},
	10_000,
);

it.skipIf(process.platform === "win32")("gives a background job the session identity", async () => {
	const sessionFile = path.join(cwd, "sessions", "bg.jsonl");
	const job = new BashTool({
		cwd,
		hasUI: false,
		getSessionFile: () => sessionFile,
		getSessionId: () => "session-bg",
		getSessionSpawns: () => "*",
		asyncJobManager: manager,
		settings: Settings.isolated({}),
	});
	const result = await job.execute("bg-env", {
		command: `printf '%s|%s|%s' "$PI_SESSION_ID" "$PI_SESSION_FILE" "$PI_TOOL_CALL_ID" > env.txt`,
		async: true,
	});
	if (!result.details?.async?.jobId) throw new Error("expected background job");
	await manager.waitForAll();
	const [id, file, callId] = (await Bun.file(path.join(cwd, "env.txt")).text()).split("|");
	expect(id).toBe("session-bg");
	expect(file).toBe(sessionFile);
	expect(callId).toBe("bg-env");
});

it.skipIf(process.platform === "win32")(
	"holds the cancelled job's slot until its shell is gone, so the queued successor never overlaps it",
	async () => {
		// A cancelled command answers at once while its shell is still being killed.
		// The successor must not start beside it: at a cap of one, the process the
		// first job started has to be gone by the time the second job's body runs.
		const capped = new AsyncJobManager({ maxRunningJobs: 1 });
		const session: ToolSession = {
			cwd,
			hasUI: false,
			getSessionFile: () => null,
			getSessionId: () => cwd,
			getSessionSpawns: () => "*",
			asyncJobManager: capped,
			settings: Settings.isolated({}),
		};
		const script = path.join(cwd, "slow-exit.sh");
		await Bun.write(
			script,
			"trap 'sleep 0.5; exit 0' TERM\nprintf '%s' $$ > holder.pid\nwhile :; do sleep 0.05; done\n",
		);
		const holderTool = new BashTool(session);
		const started = await holderTool.execute("winddown-holder", {
			command: `sh ${JSON.stringify(script)}`,
			async: true,
			timeout: 0,
		});
		const holderJob = started.details?.async?.jobId;
		if (!holderJob) throw new Error("expected background job");
		const pidFile = path.join(cwd, "holder.pid");
		const deadline = Date.now() + 10_000;
		while (!(await Bun.file(pidFile).exists())) {
			if (Date.now() > deadline) throw new Error("holder never started");
			await Bun.sleep(10);
		}
		const holderPid = Number(await Bun.file(pidFile).text());
		const alive = (): boolean => {
			try {
				process.kill(holderPid, 0);
				return true;
			} catch {
				return false;
			}
		};

		// Queued behind the holder; its body records whether that process still exists.
		let sawHolderAlive: boolean | undefined;
		const successor = capped.register("bash", "successor", async () => {
			sawHolderAlive = alive();
			return "done";
		});
		expect(capped.getJob(successor)?.waitingForSlot).toBe(true);

		try {
			expect(capped.cancel(holderJob)).toBe(true);
			await capped.getJob(successor)!.promise;
			expect(sawHolderAlive).toBe(false);
		} finally {
			if (alive()) process.kill(holderPid, "SIGKILL");
			await capped.dispose({ timeoutMs: 2000 });
		}
	},
	30_000,
);
