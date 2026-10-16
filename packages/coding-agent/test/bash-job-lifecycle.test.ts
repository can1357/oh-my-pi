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
