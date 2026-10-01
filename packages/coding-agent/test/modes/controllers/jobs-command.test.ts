import { beforeAll, describe, expect, it } from "bun:test";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AsyncJobSnapshotItem } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { Component } from "@oh-my-pi/pi-tui";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

const WIDTH = 60;

async function renderFullJobs(running: AsyncJobSnapshotItem[]): Promise<string[]> {
	let presented: Component[] = [];
	const ctx = {
		ui: { terminal: { columns: WIDTH } },
		session: {
			getAsyncJobSnapshot: () => ({
				running,
				recent: [],
				delivery: { queued: 0, delivering: false, pendingJobIds: [] },
			}),
		},
		presentCommandOutput: (output: Component | Component[]) => {
			presented = Array.isArray(output) ? output : [output];
		},
	} as unknown as InteractiveModeContext;
	await new CommandController(ctx).handleJobsCommand({ full: true });
	return presented.flatMap(component => component.render(WIDTH)).map(line => Bun.stripANSI(line).trimEnd());
}

describe("CommandController /jobs full", () => {
	beforeAll(async () => {
		await initTheme();
	});

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
		// Header rows sit at the text padding; command lines sit two columns deeper.
		expect(lines[first]).toMatch(/^ \S/);
		expect(commandLines.length).toBeGreaterThan(4);
		for (const line of commandLines) expect(line).toMatch(/^ {3}\S/);
		expect(commandLines.map(line => line.trim()).join(" ")).toContain("import sys EOF python /tmp/x.py --flag");
		expect(commandLines.at(-1)).toEndWith("END");
		expect(lines[second + 1]).toBe("   sleep 5");
	});
});
