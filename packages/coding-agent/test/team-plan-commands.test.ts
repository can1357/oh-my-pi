import { beforeEach, describe, expect, it } from "bun:test";
import { Settings } from "../src/config/settings";
import { IrcBus } from "../src/irc/bus";
import { AgentRegistry } from "../src/registry/agent-registry";
import type { AgentSession } from "../src/session/agent-session";
import { BUILTIN_TEAMS_SLASH_COMMANDS } from "../src/slash-commands/builtin-teams";
import { teamRuntime } from "../src/task/team-runtime";
import { registerLocalSession } from "../src/thread/session-directory";

beforeEach(() => {
	teamRuntime.resetForTests();
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
});

async function fixture() {
	const notices: Array<{ body: string; progress?: boolean }> = [];
	const receive = async (message: (typeof notices)[number]) => {
		notices.push(message);
		return "injected";
	};
	const lead = { instanceKey: crypto.randomUUID(), deliverIrcMessage: receive } as unknown as AgentSession;
	const child = { instanceKey: crypto.randomUUID(), deliverIrcMessage: receive } as unknown as AgentSession;
	for (const session of [lead, child]) registerLocalSession(session);
	const registry = AgentRegistry.global();
	registry.register({ id: "lead", displayName: "lead", kind: "main", session: lead });
	const ref = registry.register({ id: "worker", displayName: "worker", kind: "sub", session: child });
	const team = await teamRuntime.start(lead, {
		name: "audit",
		description: "",
		members: [],
		body: "",
		source: "project",
		filePath: "audit.md",
		planApproval: true,
	});
	team.members.set("worker", { id: "worker", ref });
	const identity = { team: "audit", generation: team.generation, memberId: "worker" };
	const command = async (args: string, enabled = true, session = lead) => {
		const outputs: string[] = [];
		const handle = BUILTIN_TEAMS_SLASH_COMMANDS[0]!.handle as unknown as (
			command: { args: string },
			runtime: unknown,
		) => Promise<void>;
		await handle(
			{ args },
			{
				session,
				settings: Settings.isolated({ "team.enabled": enabled }),
				sessionManager: { getCwd: () => process.cwd() },
				output: (text: string) => outputs.push(text),
			},
		);
		return outputs.join("\n");
	};
	return { lead, child, notices, identity, command };
}

describe("team plan commands", () => {
	it("advertises approval subcommands and validates their usage", async () => {
		const { command } = await fixture();
		const names = BUILTIN_TEAMS_SLASH_COMMANDS[0]!.subcommands!.map(command => command.name);
		expect(names).toContain("approve");
		expect(names).toContain("reject");
		for (const args of ["approve", "approve worker extra", "reject worker"]) {
			const output = await command(args);
			expect(output).toContain("/team approve <handle>");
			expect(output).toContain("/team reject <handle> <reason>");
		}
	});

	it("enforces team.enabled for approve and reject without changing the gate", async () => {
		const { child, identity, command } = await fixture();
		for (const args of ["approve worker", "reject worker revise"]) {
			expect(await command(args, false)).toContain("team.enabled: true");
		}
		expect(await teamRuntime.planPending(child, identity)).toBe(true);
	});

	it("requires a submitted plan, rejects with a reason and approves only resubmitted plans", async () => {
		const { child, notices, identity, command } = await fixture();
		expect(await command("approve worker")).toContain("write team://audit/plan");
		await teamRuntime.submitPlan(child, identity, "First plan");
		expect(await command("approve worker", true, child)).toContain(
			'No live team member named "worker" owned by this lead',
		);
		expect(await teamRuntime.planPending(child, identity)).toBe(true);
		expect(await command("reject worker Add regression coverage")).toContain("rejected");
		expect(notices.at(-1)).toMatchObject({ progress: true });
		expect(notices.at(-1)!.body).toContain("Add regression coverage");
		expect(await command("approve worker")).toContain("write team://audit/plan");
		await teamRuntime.submitPlan(child, identity, "Revised plan with tests");
		expect(await command("approve worker")).toContain("approved");
		expect(await teamRuntime.planPending(child, identity)).toBe(false);
	});
});
