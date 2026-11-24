import { describe, expect, it } from "bun:test";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AsyncJobSnapshotItem } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { JSXNode } from "@oh-my-pi/pi-tui";
import { printRows } from "../../../src/ui/print-rows";

const WIDTH = 60;

/** `/jobs full` in text mode, as the report box above the editor shows it: its content rows, borders stripped. */
async function renderFullJobs(running: AsyncJobSnapshotItem[]): Promise<string[]> {
	let report: (() => JSXNode) | undefined;
	const ctx = {
		shell: {
			native: () => false,
			size: () => ({ columns: WIDTH, rows: 200 }),
			dock: { slot: () => ({ set: (factory: () => JSXNode) => (report = factory), clear: () => {} }) },
		},
		keybindings: { keysFor: () => ["escape"] },
		commandReportRows: () => 200,
		viewSession: {
			getAsyncJobTree: () => ({ running, recent: [], agents: [] }),
			requestJobCaptions: () => {},
		},
	} as unknown as InteractiveModeContext;
	await new CommandController(ctx).handleJobsCommand({ full: true });
	if (!report) throw new Error("Expected the report above the editor");
	return printRows(report, WIDTH)
		.map(line => Bun.stripANSI(line))
		.filter(line => line.startsWith("│"))
		.map(line => line.slice(2, -2).trimEnd());
}

describe("CommandController /jobs full", () => {
	it("keeps every line of a multi-line or wrapped command indented under its job row", async () => {
		const longLine = `python /tmp/x.py ${"--flag ".repeat(12)}END`;
		const command = `cat <<'EOF' > /tmp/x.py\nimport sys\nEOF\n${longLine}`;
		const startTime = Date.now();
		const lines = await renderFullJobs([
			{ id: "bash-1", type: "bash", status: "running", label: "cat <<'EOF'...", command, startTime },
			{ id: "bash-2", type: "bash", status: "running", label: "sleep 5", startTime },
		]);

		const first = lines.findIndex(line => line.includes("bash-1"));
		const second = lines.findIndex(line => line.includes("bash-2"));
		const commandLines = lines.slice(first + 1, second);
		// Job rows start the report body; command lines sit two columns deeper.
		expect(lines[first]).toMatch(/^\S/);
		expect(commandLines.length).toBeGreaterThan(4);
		for (const line of commandLines) expect(line).toMatch(/^ {2}\S/);
		expect(commandLines.map(line => line.trim()).join(" ")).toContain("import sys EOF python /tmp/x.py --flag");
		expect(commandLines.at(-1)).toEndWith("END");
		expect(lines[second + 1]).toBe("  sleep 5");
	});
});
