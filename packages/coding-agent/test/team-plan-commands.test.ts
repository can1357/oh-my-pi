import { beforeEach, describe, expect, it } from "bun:test";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import { Settings } from "../src/config/settings";
import { IrcBus, ircWaitAccepts } from "../src/irc/bus";
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
	const notices: IrcMessage[] = [];
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
			expect(output).toContain("/team approve <handle> [--rev N]");
			expect(output).toContain("/team reject <handle> [--rev N] <reason>");
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
		const approvals = notices.filter(message => message.body.includes("Plan approved"));
		expect(approvals).toHaveLength(1);
		expect(approvals[0]).toMatchObject({ from: "lead", to: "worker", progress: true, teamControl: true });
		expect(approvals[0]!.body).toContain("mutation tools are available");
		expect(ircWaitAccepts({ directOnly: true }, approvals[0]!)).toBe(true);
		expect(IrcBus.global().unansweredSends("lead", 0)).toEqual([]);
		expect(IrcBus.global().unansweredSends("worker", 0)).toEqual([]);
	});

	it("parses --rev placement and validates its value", async () => {
		const { command } = await fixture();
		// Bad values are usage errors before any runtime call. A `--rev` token in
		// handle position is a usage error too, not an unknown member handle.
		for (const args of [
			"approve worker --rev",
			"approve worker --rev 0",
			"approve worker --rev -1",
			"approve worker --rev x",
			"approve worker --rev 1.5",
			"approve worker --rev +2",
			"approve worker --rev 02",
			"approve worker --rev 1 2",
			"approve --rev 1 worker",
			"approve --rev",
			"approve --rev 1",
			"reject --rev 1 Fix the build",
			"reject worker --rev Add tests",
			"reject worker --rev 0 Add tests",
			"reject worker Add tests --rev",
		]) {
			const output = await command(args);
			expect(output).toContain("/team approve <handle> [--rev N]");
			expect(output).toContain("/team reject <handle> [--rev N] <reason>");
			expect(output).not.toContain("No live team member named");
		}
	});

	it("approves and rejects against the revision shown in notices", async () => {
		const { child, notices, identity, command } = await fixture();
		await teamRuntime.submitPlan(child, identity, "First plan");
		expect(notices.at(-1)!.body).toContain("rev 1");
		await teamRuntime.submitPlan(child, identity, "Second plan");
		expect(notices.at(-1)!.body).toContain("rev 2");
		// Stale revision: the command names the current revision and changes nothing.
		expect(await command("approve worker --rev 1")).toContain("Stale plan revision 1; current is 2");
		expect(await teamRuntime.planPending(child, identity)).toBe(true);
		expect(await command("reject worker --rev 1 Missing coverage")).toContain("Stale plan revision 1; current is 2");
		expect(await teamRuntime.planPending(child, identity)).toBe(true);
		// A matching revision approves; the notice names the revision.
		expect(await command("approve worker --rev 2")).toContain("approved");
		expect(notices.at(-1)!.body).toContain("rev 2");
		expect(await teamRuntime.planPending(child, identity)).toBe(false);
		// The reject path is symmetric: resubmit after the approval (rev 3),
		// then a stale revision refuses, the matching revision rejects, and the
		// resubmission after that reject shows rev 4 — submissions are the only
		// counter, so the fourth submission is rev 4 regardless of the reject.
		await teamRuntime.submitPlan(child, identity, "Third plan");
		expect(notices.at(-1)!.body).toContain("rev 3");
		expect(await command("reject worker --rev 2 Missing coverage")).toContain("Stale plan revision 2; current is 3");
		expect(await teamRuntime.planPending(child, identity)).toBe(true);
		expect(await command("reject worker --rev 3 Missing coverage")).toContain("rejected");
		expect(notices.at(-1)!.body).toContain("rev 3");
		expect(await teamRuntime.planPending(child, identity)).toBe(true);
		// The resubmission after that reject is the fourth submission: rev 4.
		await teamRuntime.submitPlan(child, identity, "Fourth plan");
		expect(notices.at(-1)!.body).toContain("rev 4");
		expect(await command("approve worker --rev 3")).toContain("Stale plan revision 3; current is 4");
		expect(await command("approve worker --rev 4")).toContain("approved");
		expect(await teamRuntime.planPending(child, identity)).toBe(false);
	});
});
