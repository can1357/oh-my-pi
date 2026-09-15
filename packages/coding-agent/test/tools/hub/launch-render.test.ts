import { beforeAll, describe, expect, it } from "bun:test";
import { initTheme, theme } from "../../../src/modes/theme/theme";
import type { DaemonSnapshot, DaemonSpec } from "../../../src/launch/protocol";
import { launchRenderResult, type LaunchRenderArgs, type LaunchToolDetails } from "../../../src/tools/hub/launch";

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
});
