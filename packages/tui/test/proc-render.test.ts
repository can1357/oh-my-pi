import { beforeAll, describe, expect, it } from "bun:test";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import type { DaemonSnapshot } from "@oh-my-pi/pi-tui/tools/daemon";
import { renderProcRead, renderProcWrite, type ProcWriteDetails } from "@oh-my-pi/pi-tui/tools/proc-render";
import type { RenderResultOptions } from "@oh-my-pi/pi-tui/tools/renderer";
import type { CoordinationDetails } from "@oh-my-pi/pi-tui/tools/wait";

const options = { expanded: true } as RenderResultOptions;
const daemon: DaemonSnapshot = {
	name: "web",
	id: "web-1",
	state: "running",
	createdAt: 1,
	startedAt: 1,
	restartCount: 0,
	outputBytes: 0,
	persist: false,
	detached: false,
};

function renderProgress(details: ProcWriteDetails, isError = false, requested = "ambient"): string {
	const component = renderProcWrite(
		"build-job",
		"progress",
		requested,
		{ content: [{ type: "text", text: "" }], isError },
		details,
		options,
		theme,
	);
	return Bun.stripANSI(component.render(160).join("\n"));
}

describe("proc progress rendering", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("distinguishes applied and unchanged job retunes", () => {
		const output = renderProgress({
			op: "monitor",
			retuned: [
				{ id: "changed-job", status: "retuned", progress: "ambient" },
				{ id: "same-job", status: "unchanged", progress: "wake" },
			],
		});
		expect(output).toContain("changed-job → ambient");
		expect(output).toContain("same-job already wake");
	});

	it("explains each rejected retune instead of hiding outcomes behind a generic error", () => {
		const details: CoordinationDetails = {
			op: "monitor",
			retuned: [
				{ id: "foreign-job", status: "not_found" },
				{ id: "settled-job", status: "not_running", progress: "wake" },
				{ id: "silent-job", status: "unmonitored" },
				{ id: "watched-job", status: "suppressed", progress: "ambient" },
			],
		};
		const output = renderProgress(details, true);
		expect(output).toContain("foreign-job not your job");
		expect(output).toContain("settled-job already settled");
		expect(output).toContain("silent-job launched without progress");
		expect(output).toContain("watched-job withheld by a wait");
		expect(output).not.toContain("Process operation failed");
	});

	it("shows the service's resulting mode rather than the requested mode", () => {
		const wake = renderProgress({ action: "progress", daemon, progress: "wake" });
		const ambient = renderProgress({ action: "progress", daemon, progress: "ambient" }, false, "wake");
		expect(wake).toContain("monitor wake");
		expect(wake).not.toContain("monitor ambient");
		expect(ambient).toContain("monitor ambient");
		expect(ambient).not.toContain("monitor wake");
	});

	it("distinguishes detaching a service monitor from an already-unmonitored service", () => {
		const detached = renderProgress({ action: "progress", daemon, progress: "off", detached: true });
		const unchanged = renderProgress({ action: "progress", daemon, progress: "off", detached: false });
		expect(detached).toContain("monitor off");
		expect(detached).not.toContain("no active monitor");
		expect(unchanged).toContain("no active monitor");
		expect(unchanged).not.toContain("monitor off");
	});

	it("shows each job's current delivery mode in the proc listing", () => {
		const component = renderProcRead(
			"",
			{ content: [{ type: "text", text: "" }] },
			{
				jobs: [
					{ id: "wake-job", type: "bash", status: "running", label: "build", durationMs: 100, progress: "wake" },
					{ id: "ambient-job", type: "bash", status: "running", label: "lint", durationMs: 100, progress: "ambient" },
					{ id: "silent-job", type: "bash", status: "running", label: "check", durationMs: 100 },
				],
			},
			options,
			theme,
		);
		const lines = component.render(160).map(line => Bun.stripANSI(line));
		expect(lines.find(line => line.includes("wake-job"))).toMatch(/wake-job.*wake/);
		expect(lines.find(line => line.includes("ambient-job"))).toMatch(/ambient-job.*ambient/);
		const silent = lines.find(line => line.includes("silent-job"));
		expect(silent).toBeDefined();
		expect(silent).not.toMatch(/wake|ambient/);
	});
});
