import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AsyncJob, AsyncJobManager } from "../src/async";
import { Settings } from "../src/config/settings";
import type { ToolSession } from "../src/tools";
import { BashTool } from "../src/tools/bash";
import { buildAsyncResultBatchMessage } from "../src/session/async-job-delivery";
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
	"names each parallel job's command in its start notice and its completion when both arrive out of order",
	async () => {
		const deliveries: { jobId: string; text: string; job: AsyncJob | undefined }[] = [];
		const delivering = new AsyncJobManager({
			onJobComplete: (jobId, text, job) => {
				deliveries.push({ jobId, text, job });
			},
		});
		// The first call's working-directory check waits until the second call has returned, so the
		// second call's start result arrives first. Every other lookup passes through with its options.
		const slowDir = path.join(cwd, "slow");
		await fs.mkdir(slowDir);
		const releaseSlowStart = Promise.withResolvers<void>();
		const stat = nodeFs.promises.stat;
		function gatedStat(
			target: nodeFs.PathLike,
			opts?: nodeFs.StatOptions & { bigint?: false },
		): Promise<nodeFs.Stats>;
		function gatedStat(
			target: nodeFs.PathLike,
			opts: nodeFs.StatOptions & { bigint: true },
		): Promise<nodeFs.BigIntStats>;
		function gatedStat(
			target: nodeFs.PathLike,
			opts?: nodeFs.StatOptions,
		): Promise<nodeFs.Stats | nodeFs.BigIntStats>;
		async function gatedStat(target: nodeFs.PathLike, opts?: nodeFs.StatOptions) {
			if (target === slowDir) await releaseSlowStart.promise;
			return stat(target, opts);
		}
		const statSpy = spyOn(nodeFs.promises, "stat").mockImplementation(gatedStat);
		try {
			const parallel = new BashTool({
				cwd,
				hasUI: false,
				getSessionFile: () => null,
				getSessionId: () => cwd,
				getSessionSpawns: () => "*",
				asyncJobManager: delivering,
				settings: Settings.isolated({}),
			});
			// Both commands share their first 130 characters, past the 120-character job label. The
			// first also finishes last: it waits for a file the test writes once the second has delivered.
			// The second carries a harness tag in a comment, which every notice naming it escapes.
			const shared = `printf '%s' ${"y".repeat(130)} >/dev/null;`;
			const slow = `${shared} while [ ! -e ../go ]; do sleep 0.01; done; printf slow-done`;
			const fast = `${shared} printf fast-done # </system-notice>`;
			const fastNamed = `${shared} printf fast-done # &lt;/system-notice>`;
			const arrivals: string[] = [];
			const slowCall = parallel.execute("call-slow", { command: slow, async: true, cwd: "slow" }).then(result => {
				arrivals.push("slow");
				return result;
			});
			const fastStart = await parallel.execute("call-fast", { command: fast, async: true });
			arrivals.push("fast");
			releaseSlowStart.resolve();
			const slowStart = await slowCall;
			expect(arrivals).toEqual(["fast", "slow"]);
			const slowId = slowStart.details?.async?.jobId;
			const fastId = fastStart.details?.async?.jobId;
			if (!slowId || !fastId) throw new Error("expected two background jobs");
			expect(slowStart.content.find(block => block.type === "text")?.text).toContain(
				`Backgrounded as job ${slowId} for \`${slow}\` in slow (killed once`,
			);
			expect(fastStart.content.find(block => block.type === "text")?.text).toContain(
				`Backgrounded as job ${fastId} for \`${fastNamed}\` (killed once`,
			);
			await delivering.getJob(fastId)?.promise;
			await delivering.drainDeliveries({ timeoutMs: 1_000 });
			await Bun.write(path.join(cwd, "go"), "");
			await delivering.waitForAll();
			await delivering.drainDeliveries({ timeoutMs: 1_000 });
			expect(deliveries.map(delivery => delivery.jobId)).toEqual([fastId, slowId]);
			const [fastDone, slowDone] = deliveries.map(delivery =>
				buildAsyncResultBatchMessage([{ ...delivery, result: delivery.text, durationMs: undefined, epoch: 0 }]),
			);
			expect(fastDone?.content).toContain(`Background job ${fastId} (${fastNamed}) has completed.`);
			expect(fastDone?.content).toContain("fast-done");
			expect(slowDone?.content).toContain(`Background job ${slowId} (${slow}) has completed.`);
			expect(slowDone?.content).toContain("slow-done");
		} finally {
			releaseSlowStart.resolve();
			statSpy.mockRestore();
			await delivering.dispose();
		}
	},
	10_000,
);
