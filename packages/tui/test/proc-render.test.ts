import { beforeAll, describe, expect, it } from "bun:test";
import { homedir } from "node:os";
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
					{
						id: "ambient-job",
						type: "bash",
						status: "running",
						label: "lint",
						durationMs: 100,
						progress: "ambient",
					},
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

	it("preserves sanitized runtime diagnostics on service reads and progress writes", () => {
		const rawReason = `\x1b[31mspawn\r\n\t${homedir()}/missing ENOENT\x1b[0m`;
		const failed: DaemonSnapshot = { ...daemon, state: "exited", exitCode: 127, exitReason: rawReason };
		const read = renderProcRead(
			"web",
			{ content: [{ type: "text", text: "" }] },
			{ daemon: failed, log: "last output" },
			{ expanded: false } as RenderResultOptions,
			theme,
		);
		for (const output of [
			Bun.stripANSI(read.render(200).join("\n")),
			renderProgress({ action: "progress", daemon: failed, progress: "off", detached: true }),
		]) {
			expect(output).toContain("exit 127");
			expect(output).toContain("Reason: spawn ~/missing ENOENT");
			expect(output).not.toContain(homedir());
			expect(output).not.toMatch(/[\r\t]/);
		}
		expect(failed.exitReason).toBe(rawReason);
	});

	it("counts services rather than diagnostic rows when collapsing the process list", () => {
		const daemons = Array.from({ length: 11 }, (_, index) => ({
			...daemon,
			name: `svc-${index}`,
			id: `d-${index}`,
			state: "failed" as const,
			exitCode: 58,
			exitReason: `reason-${index}`,
		}));
		const output = Bun.stripANSI(
			renderProcRead("", { content: [] }, { daemons }, { expanded: false } as RenderResultOptions, theme)
				.render(200)
				.join("\n"),
		);
		expect(output).toContain("svc-7");
		expect(output).toContain("reason-7");
		expect(output).not.toContain("svc-8");
		expect(output).not.toContain("reason-8");
		expect(output).toContain("3 more processes");
	});

	it("bounds watcher details as complete service groups and expands all omitted watchers", () => {
		const daemons = Array.from({ length: 8 }, (_, index) => ({
			...daemon,
			name: `svc-${index}`,
			id: `d-${index}`,
		}));
		const monitors = daemons.flatMap(service =>
			Array.from({ length: 4 }, (_, index) => ({
				name: service.name,
				id: `${service.id}-monitor-${index}`,
				owner: `${service.name}-session-${index}`,
				delivery: "wake" as const,
				connected: true,
			})),
		);
		const mutableOptions = { expanded: false } as RenderResultOptions;
		const component = renderProcRead("", { content: [] }, { daemons, monitors }, mutableOptions, theme);
		const collapsed = component.render(200).map(line => Bun.stripANSI(line));
		expect(collapsed.length).toBeLessThanOrEqual(18);
		expect(collapsed.filter(line => line.includes("watched by"))).toHaveLength(9);
		expect(collapsed.join("\n")).toContain("svc-2");
		expect(collapsed.join("\n")).not.toContain("svc-3");
		expect(collapsed.join("\n")).toContain("5 more processes");
		expect(collapsed.join("\n")).toContain("1 more watcher");
		mutableOptions.expanded = true;
		const expanded = Bun.stripANSI(component.render(200).join("\n"));
		expect(expanded).toContain("svc-7-session-3");
		expect(expanded).not.toContain("more watcher");
		expect(expanded).not.toContain("more processes");
	});

	it("keeps the broker error visible in a collapsed process listing", () => {
		const output = Bun.stripANSI(
			renderProcRead(
				"",
				{ content: [{ type: "text", text: "broker unavailable" }], isError: true },
				{},
				{ expanded: false } as RenderResultOptions,
				theme,
			)
				.render(160)
				.join("\n"),
		);
		expect(output).toContain("broker unavailable");
	});

	it("uses replayed terminal rows instead of stale raw output", () => {
		const output = renderProcRead(
			"web",
			{ content: [{ type: "text", text: "old" }] },
			{ daemon, log: "old", terminalRows: ["           \x1b[1;38;5;2mready\x1b[0m"] },
			{ expanded: false } as RenderResultOptions,
			theme,
		)
			.render(200)
			.join("\n");
		expect(Bun.stripANSI(output)).toContain("           ready");
		expect(Bun.stripANSI(output)).not.toContain("old");
		expect(output).toContain("\x1b[1;38;5;2mready");
	});
});
