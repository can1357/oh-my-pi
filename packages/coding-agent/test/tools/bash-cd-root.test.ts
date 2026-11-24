import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as daemonClients from "@oh-my-pi/pi-coding-agent/daemon/client";
import type { DaemonClient, DaemonOp } from "@oh-my-pi/pi-coding-agent/daemon/protocol";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import type { UnitSnapshot } from "@oh-my-pi/pi-coding-agent/daemon/daemon-types";

const MARKER = "omp-bash-cd-root-marker";
const FILESYSTEM_ROOT = path.resolve("/");

function sessionFor(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		skills: [],
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated({
			"async.enabled": false,
			"bash.autoBackground.enabled": false,
			"bash.direnv": "off",
			"bashInterceptor.enabled": false,
		}),
		getClientBridge: () => undefined,
	};
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find(entry => entry.type === "text")?.text ?? "";
}

function linesOf(text: string): string[] {
	return text
		.split("\n")
		.map(line => line.trim())
		.filter(line => line.length > 0);
}

describe("bash leading cd filesystem root", () => {
	let workspace = "";

	afterEach(async () => {
		if (workspace) await fs.rm(workspace, { recursive: true, force: true });
		workspace = "";
	});

	it.skipIf(process.platform === "win32")(
		"runs a leading cd / in the filesystem root from a non-root workspace",
		async () => {
			workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bash-cd-root-")));
			expect(workspace).not.toBe(FILESYSTEM_ROOT);
			await Bun.write(path.join(workspace, MARKER), "only-in-workspace\n");
			const tool = new BashTool(sessionFor(workspace));
			const rest = `pwd; if test -e ${MARKER}; then echo where:workspace; else echo where:root; fi`;
			const cases = [
				{ command: `cd /; ${rest}`, separator: ";" as const },
				{ command: `cd / && ${rest}`, separator: undefined },
				{ command: `cd ///; ${rest}`, separator: ";" as const },
			];

			for (const { command, separator } of cases) {
				const result = await tool.execute(`cd-root-${command}`, { command });
				const lines = linesOf(textOf(result));

				expect(result.isError).toBeUndefined();
				expect(path.resolve(result.details?.cwd ?? "")).toBe(FILESYSTEM_ROOT);
				const printedRoot = lines.find(line => /^\/+$/.test(line));
				expect(path.resolve(printedRoot ?? "")).toBe(FILESYSTEM_ROOT);
				expect(lines).toContain("where:root");
				expect(lines).not.toContain(workspace);
				expect(lines).not.toContain("where:workspace");
				expect(result.details?.cdSeparator).toBe(separator);
			}

			const aliased = await tool.execute("explicit-slash-cwd", { command: rest, cwd: "/" });
			const aliasedLines = linesOf(textOf(aliased));
			expect(aliased.isError).toBeUndefined();
			expect(aliased.details?.cwd).toBe(workspace);
			expect(aliasedLines).toContain(workspace);
			expect(aliasedLines).toContain("where:workspace");
			expect(aliasedLines).not.toContain("where:root");
		},
		30_000,
	);

	it.skipIf(process.platform === "win32")("starts a service from a leading cd / in the filesystem root", async () => {
		workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bash-cd-root-svc-")));
		const started: DaemonOp[] = [];
		const snapshot: UnitSnapshot = {
			id: "cdroot-1",
			kind: "proc",
			scope: { kind: "project", dir: workspace },
			key: "cdroot",
			label: "cdroot",
			generation: "cdroot-gen-1",
			state: "running",
			pids: [],
			createdAt: 1,
			startedAt: 1,
			restartCount: 0,
			outputBytes: 0,
			leases: 1,
			policy: { hold: "leases", idleMs: 0, onIdle: "stop", restart: "no", survive: "exec" },
			supervised: true,
		};
		const client = spyOn(daemonClients, "daemonClient").mockResolvedValue({
			onCompletion: () => () => {},
			onNotify: () => () => {},
			onReconnect: () => () => {},
			close: () => {},
			request: async (operation: DaemonOp) => {
				started.push(operation);
				if (operation.op === "open") return { unit: snapshot, lease: "lease-1", created: true };
				if (operation.op === "logs") return { text: "", terminalOutput: "", cursor: 0, unit: snapshot };
				throw new Error(`unexpected ${operation.op}`);
			},
		} as unknown as DaemonClient);
		try {
			const result = await new BashTool(sessionFor(workspace)).execute("cd-root-service", {
				command: "cd / && pwd",
				name: "cdroot",
			});
			const start = started.find(operation => operation.op === "open");
			if (start?.op !== "open" || !start.proc) throw new Error("service did not start");

			expect(result.isError).toBeUndefined();
			expect(path.resolve(start.proc.cwd)).toBe(FILESYSTEM_ROOT);
			expect(start.proc.args.at(-1)).toBe("pwd");
		} finally {
			client.mockRestore();
		}
	});
});
