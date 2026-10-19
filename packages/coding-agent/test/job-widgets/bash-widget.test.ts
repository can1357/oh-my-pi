import { describe, expect, it } from "bun:test";
import { procmgr } from "@oh-my-pi/pi-utils";
import type { JobWidgetView } from "@oh-my-pi/pi-tui/tools/job-widget";
import { AsyncJobManager } from "../../src/async/job-manager";
import { snapshotJobs } from "../../src/async/job-control";
import { Settings } from "../../src/config/settings";
import { type JobWidgetAuthorRequest, JobWidgets } from "../../src/job-widgets";
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
			// The author saw the command, the call's intent, and the pipe's lines; `out` is still empty.
			expect(requests[0]?.brief).toEqual({
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
});
