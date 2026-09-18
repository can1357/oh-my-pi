import { beforeAll, describe, expect, it } from "bun:test";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import type {
	CoordinationDetails,
	DaemonSnapshot,
	DaemonSpec,
	HubRenderArgs,
	JobSnapshot,
} from "@oh-my-pi/pi-tui/tools/hub";
import {
	hubToolRenderer,
	launchRenderResult,
	type LaunchRenderArgs,
	type LaunchToolDetails,
} from "@oh-my-pi/pi-tui/tools/hub";

const daemon: DaemonSnapshot = {
	name: "watcher",
	id: "daemon-id",
	state: "failed",
	createdAt: 1,
	startedAt: 2,
	exitedAt: 3,
	exitCode: 58,
	exitReason: "process exited with code 58 without a reported termination reason",
	restartCount: 0,
	outputBytes: 0,
	persist: false,
	detached: false,
};

const spec: DaemonSpec = {
	name: daemon.name,
	application: process.execPath,
	args: [],
	env: {},
	cwd: process.cwd(),
	pty: false,
	restart: "no",
	persist: false,
	detached: false,
};

function render(details: LaunchToolDetails, args: LaunchRenderArgs): string {
	return Bun.stripANSI(
		launchRenderResult(
			{ content: [{ type: "text", text: "" }], details },
			{ expanded: true, isPartial: false },
			theme,
			args,
		)
			.render(240)
			.join("\n"),
	);
}

function renderHubResult(details: CoordinationDetails, args: HubRenderArgs): string {
	return Bun.stripANSI(
		hubToolRenderer
			.renderResult(
				{ content: [{ type: "text", text: "" }], details },
				{ expanded: true, isPartial: false },
				theme,
				args,
			)
			.render(240)
			.join("\n"),
	);
}

function renderHubCall(args: HubRenderArgs): string {
	return Bun.stripANSI(
		hubToolRenderer
			.renderCall(args, { expanded: true, isPartial: true, spinnerFrame: 0 }, theme)
			.render(240)
			.join("\n"),
	);
}

describe("structured Hub launch diagnostics", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	it("shows the neutral reason on terminal start, wait, list, and describe rows", () => {
		const reason = "Reason: process exited with code 58 without a reported termination reason";
		expect(render({ op: "start", daemon }, { op: "start", name: daemon.name })).toContain(reason);
		expect(render({ op: "wait", daemon }, { op: "wait", name: daemon.name })).toContain(reason);
		expect(render({ op: "list", daemons: [daemon] }, { op: "ps" })).toContain(reason);
		expect(render({ op: "describe", daemon, spec }, { op: "describe", name: daemon.name })).toContain(reason);
	});

	it("renders job progress retunes as static job frames without dropping running rows", () => {
		const job: JobSnapshot = {
			id: "bg_1",
			type: "bash",
			status: "running",
			label: "sleep 30",
			durationMs: 1_234,
			progress: "ambient",
		};
		const args: HubRenderArgs = { op: "monitor", ids: ["bg_1", "bg_missing"], progress: "ambient" };
		const rendered = renderHubResult(
			{
				op: "monitor",
				jobs: [job],
				retuned: [
					{ id: "bg_1", status: "retuned", progress: "ambient" },
					{ id: "bg_missing", status: "not_found" },
				],
			},
			args,
		);

		expect(rendered).toContain("2 job progress updates");
		expect(rendered).toContain("bg_1 → ambient");
		expect(rendered).toContain("bg_missing not your job");
		expect(rendered).not.toContain("Launch monitor");

		const pending = renderHubCall({ op: "monitor", ids: ["bg_1"], progress: "ambient" });
		expect(pending).toContain("monitor bg_1");
		expect(pending).not.toContain("Launch monitor");
		expect(hubToolRenderer.activitySummary(args)).toEqual({ label: "Hub", detail: "monitor 2 jobs" });
		expect(hubToolRenderer.animatedPendingPreview?.(args)).toBe(false);
	});

	it("keeps process monitor calls in the launch renderer", () => {
		const args: HubRenderArgs = { op: "monitor", name: "watcher", progress: "wake" };
		const rendered = renderHubCall(args);

		expect(rendered).toContain("Launch monitor");
		expect(rendered).toContain("watcher");
		expect(hubToolRenderer.animatedPendingPreview?.(args)).toBe(true);
	});

	it("shows a progress-mode chip on ordinary job snapshots", () => {
		const rendered = renderHubResult(
			{
				op: "jobs",
				jobs: [
					{
						id: "bg_2",
						type: "bash",
						status: "running",
						label: "build assets",
						durationMs: 2_000,
						progress: "wake",
					},
				],
			},
			{ op: "jobs" },
		);

		expect(rendered).toContain("bg_2");
		expect(rendered).toContain("wake");
	});
});
