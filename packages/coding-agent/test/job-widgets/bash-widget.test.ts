import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { procmgr } from "@oh-my-pi/pi-utils";
import type { JobWidgetView } from "@oh-my-pi/pi-tui/tools/job-widget";
import { AsyncJobManager } from "../../src/async/job-manager";
import { snapshotJobs } from "../../src/async/job-control";
import { Settings } from "../../src/config/settings";
import { type JobWidgetAuthorRequest, JobWidgets } from "../../src/job-widgets";
import type { AsyncJobInspection } from "../../src/session/agent-session-types";
import { inspectAsyncJob } from "../../src/session/async-job-views";
import type { ToolSession } from "../../src/tools";
import { BashTool } from "../../src/tools/bash";

const SHELL = process.platform === "win32" ? procmgr.resolveWindowsShell() : "/bin/sh";

function toolSession(manager: AsyncJobManager): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		getAgentId: () => "Main",
		getSessionId: () => "Main",
		getSessionFile: () => null,
		getToolCallIntent: (toolCallId: string) =>
			toolCallId === "bench" ? "measure req/s under load, goal 60 req/s" : undefined,
		asyncJobManager: manager,
		settings: Settings.isolated({
			"async.enabled": true,
			"launch.enabled": false,
			"bash.autoBackground.enabled": false,
			"bashInterceptor.enabled": false,
			"worktree.clone": false,
			shellPath: SHELL,
		}),
	} as unknown as ToolSession;
}

describe("bash job widgets", () => {
	it("draws a live widget from a pipe while `tail` still holds the command's output back", async () => {
		const manager = new AsyncJobManager({});
		const requests: JobWidgetAuthorRequest[] = [];
		manager.widgets = new JobWidgets({
			authorAfterMs: 0,
			minIngestMs: 0,
			author: async request => {
				requests.push(request);
				return {
					title: "load test",
					rules: [{ from: "pipe:*", match: String.raw`^req \d+ rps=(?P<rps>\d+)` }],
					blocks: [{ kind: "spark", field: "rps", label: "req/s", unit: "req/s", better: "higher", target: 60 }],
					headline: { field: "rps", agg: "last", unit: "req/s", better: "higher" },
				};
			},
		});
		const session = toolSession(manager);
		try {
			await new BashTool(session).execute("bench", {
				command: "{ printf 'req 1 rps=40\\nreq 2 rps=48\\nreq 3 rps=56\\n'; sleep 30; } | tail -n 1",
				async: true,
				pty: false,
			});
			const [job] = manager.getAllJobs({ ownerId: "Main" });
			if (!job) throw new Error("no bash job started");

			// Real-time poll: the pipe fills from a real child's write, relayed by a native thread.
			let view: JobWidgetView | undefined;
			for (let waited = 0; view?.headline?.text !== "56 req/s" && waited < 10_000; waited += 20) {
				await Bun.sleep(20);
				view = snapshotJobs(session, [job])[0]?.widget;
			}
			expect(job.status).toBe("running");
			expect(view).toMatchObject({
				title: "load test",
				state: "live",
				headline: { text: "56 req/s", trend: { text: "▲ 40%", tone: "success" } },
				blocks: [{ kind: "spark", values: [40, 48, 56], marks: [{ value: 60 }], last: "56 req/s" }],
			});
			// Every pipe line is data the spark already shows, so there is no stage line to repeat it.
			expect(view?.stage).toBeUndefined();
			// The author saw the command, its timeout, the call's intent, and the pipe's lines; `out` is still empty.
			expect(requests[0]?.brief).toMatchObject({
				kind: "bash",
				command: "{ printf 'req 1 rps=40\\nreq 2 rps=48\\nreq 3 rps=56\\n'; sleep 30; } | tail -n 1",
				intent: "measure req/s under load, goal 60 req/s",
			});
			expect(requests[0]?.sources.map(source => source.id)).toEqual(["pipe:1"]);
			expect(requests[0]?.sources[0]?.label).toMatch(/printf.* → tail -n 1$/);
		} finally {
			await manager.dispose({ timeoutMs: 2_000 });
		}
	}, 20_000);

	// A command that redirects everything prints nothing of its own: without the file as a stream, a job
	// inspector shows "no output" for as long as it runs, and its widget has no line to read.
	it("offers the file a command redirects its output into as a stream, beside the running command's trace", async () => {
		const manager = new AsyncJobManager({});
		const session = toolSession(manager);
		// The shell's own spelling of the directory: the temp dir is a symlink on macOS.
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-redirect-")));
		try {
			await new BashTool(session).execute("bench", {
				command: `cd '${dir}' && { printf 'round 1/3\\nround 2/3\\n'; sleep 30; } > bench.log 2>&1`,
				async: true,
				pty: false,
			});
			const [job] = manager.getAllJobs({ ownerId: "Main" });
			if (!job) throw new Error("no bash job started");

			// Real-time poll: a real child writes the file, and the trace arrives on its own timer.
			let inspection: AsyncJobInspection | undefined;
			for (let waited = 0; waited < 10_000; waited += 20) {
				await Bun.sleep(20);
				inspection = inspectAsyncJob(manager, "Main", job.id);
				if (inspection?.streams?.[0]?.bytes && inspection.trace) break;
			}
			expect(job.status).toBe("running");
			expect(inspection?.output ?? "").toBe("");
			expect(inspection?.streams).toHaveLength(1);
			const stream = inspection?.streams?.[0];
			expect(stream).toMatchObject({
				id: "file:1",
				kind: "file",
				consumer: path.join(dir, "bench.log"),
				bytes: 20,
				open: true,
			});
			expect(stream?.tail()).toBe("round 1/3\nround 2/3\n");
			expect(job.widgetInputs?.sources().map(source => source.id)).toEqual(["out", "file:1"]);
			const states = inspection?.trace?.units.flatMap(unit => unit.nodes.map(node => node.state));
			expect(states).toContain("running");
		} finally {
			await manager.dispose({ timeoutMs: 2_000 });
			await fs.rm(dir, { recursive: true, force: true });
		}
	}, 20_000);
});
