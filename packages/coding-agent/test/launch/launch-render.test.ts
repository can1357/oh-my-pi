import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import type { DaemonSnapshot } from "@oh-my-pi/pi-tui/tools/daemon";
import { renderProcRead, renderProcWrite } from "@oh-my-pi/pi-tui/tools/proc-render";
import { Settings } from "../../src/config/settings";
import { parseInternalUrl } from "../../src/internal-urls/parse";
import { ProcProtocolHandler } from "../../src/internal-urls/proc-protocol";
import type { DaemonBrokerClient } from "../../src/launch/client";
import * as daemonClient from "../../src/launch/client";
import type { DaemonOperation, DaemonRpcResult } from "../../src/launch/protocol";
import { serviceStatus } from "../../src/launch/services";
import type { ToolSession } from "../../src/tools";

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

const options = { expanded: true, isPartial: false };

afterEach(() => vi.restoreAllMocks());

describe("service exit diagnostics", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	it("shows the reason once in proc service reads, lists, and stop results", () => {
		const result = { content: [{ type: "text" as const, text: serviceStatus(daemon) }] };
		const surfaces = [
			renderProcRead(daemon.name, result, { daemon }, options, theme),
			renderProcRead("", result, { daemons: [daemon] }, options, theme),
			renderProcWrite(daemon.name, "kill", undefined, result, { action: "stop", daemon }, options, theme),
		];
		for (const surface of surfaces) {
			const text = Bun.stripANSI(surface.render(240).join("\n"));
			expect(text).toContain(`Reason: ${daemon.exitReason}`);
			expect(text.split(daemon.exitReason!).length - 1).toBe(1);
		}
	});

	it("preserves long model-facing diagnostics while hiding home paths and control sequences", async () => {
		const diagnostic = `runtime failure at ~/watch-pr.log: ${"detail ".repeat(80).trim()}`;
		const failed = {
			...daemon,
			exitReason: `\u001b[31mruntime failure at ${os.homedir()}/watch-pr.log:\n${"detail ".repeat(80)}\u001b[0m`,
		};
		const client = {
			request: async (operation: DaemonOperation): Promise<DaemonRpcResult> => {
				if (operation.op === "list") return { op: "list", daemons: [failed] };
				if (operation.op === "logs") {
					return {
						op: "logs",
						name: failed.name,
						text: "last output",
						cursor: 1,
						timedOut: false,
						state: failed.state,
					};
				}
				throw new Error(`Unexpected operation: ${operation.op}`);
			},
		} as DaemonBrokerClient;
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(client);
		const session = {
			cwd: process.cwd(),
			settings: Settings.isolated({ "launch.enabled": true }),
		} as ToolSession;
		const protocol = new ProcProtocolHandler();
		for (const url of ["proc://", `proc://${failed.name}`]) {
			const resource = await protocol.resolve(parseInternalUrl(url), { session });
			const text = String(resource.content);
			expect(text).toContain(`Reason: ${diagnostic}`);
			expect(text.split(diagnostic).length - 1).toBe(1);
			expect(text).not.toContain(os.homedir());
			expect(text).not.toContain("\u001b");
		}
	});
});
