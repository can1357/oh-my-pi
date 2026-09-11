import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import { renderCommandHelp } from "@oh-my-pi/pi-utils/cli";
import { runAgentsCommand } from "@oh-my-pi/pi-coding-agent/cli/agents-cli";
import { agentsHelp } from "@oh-my-pi/pi-coding-agent/cli/command-help";
import Agents from "@oh-my-pi/pi-coding-agent/commands/agents";
import { loadBundledAgents } from "@oh-my-pi/pi-coding-agent/task/agents";

afterEach(() => {
	vi.restoreAllMocks();
});

async function captureStdout(run: () => Promise<void>): Promise<string> {
	const chunks: string[] = [];
	const stdoutSpy = spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
		chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
		return true;
	});
	try {
		await run();
	} finally {
		stdoutSpy.mockRestore();
	}
	return Bun.stripANSI(chunks.join(""));
}

function sortedBundledAgents() {
	return [...loadBundledAgents()].sort((a, b) => a.name.localeCompare(b.name));
}

describe("omp agents list", () => {
	it("prints bundled agent names and descriptions", async () => {
		const bundled = sortedBundledAgents();
		const output = await captureStdout(() => runAgentsCommand({ action: "list", flags: {} }));

		expect(output).toContain(`Bundled agents: ${bundled.length}`);
		for (const agent of bundled) {
			expect(output).toContain(agent.name);
			expect(output).toContain(agent.description);
		}
		expect(output).not.toContain(bundled[0]?.systemPrompt ?? "___missing___");
	});

	it("prints a JSON catalog without system prompts", async () => {
		const bundled = sortedBundledAgents();
		const output = await captureStdout(() => runAgentsCommand({ action: "list", flags: { json: true } }));
		const payload = JSON.parse(output) as {
			agents: Array<{
				name: string;
				description: string;
				source: string;
				systemPrompt?: unknown;
			}>;
		};

		expect(payload.agents.map(agent => agent.name)).toEqual(bundled.map(agent => agent.name));
		for (const [index, row] of payload.agents.entries()) {
			expect(row.description).toBe(bundled[index]?.description);
			expect(row.source).toBe("bundled");
			expect(row.systemPrompt).toBeUndefined();
		}
	});

	it("advertises list in command help", () => {
		expect(agentsHelp.description).toBe("List or unpack bundled task agents");
		const chunks: string[] = [];
		const stdoutSpy = spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
			chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		});
		try {
			renderCommandHelp("omp", "agents", Agents);
		} finally {
			stdoutSpy.mockRestore();
		}
		const help = Bun.stripANSI(chunks.join(""));
		expect(help).toContain("List or unpack bundled task agents");
		expect(help).toContain("omp agents list");
	});
});
