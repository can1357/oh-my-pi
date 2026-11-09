import { describe, expect, it } from "bun:test";
import { InternalUrlRouter } from "../src/internal-urls/router";
import { AgentRegistry } from "../src/registry/agent-registry";
import { IrcBus } from "../src/irc/bus";
import type { AgentSession } from "../src/session/agent-session";
import { teamRuntime } from "../src/task/team-runtime";
import { registerLocalSession } from "../src/thread/session-directory";
import type { ToolSession } from "../src/tools";

describe("team:// routing", () => {
	it("submits a plan as the actual session author and rejects forged or malformed requests", async () => {
		const registry = AgentRegistry.global();
		const suffix = crypto.randomUUID();
		const plans: Array<{ from: string; body: string; progress?: boolean }> = [];
		const lead = {
			instanceKey: `plan-lead:${suffix}`,
			deliverIrcMessage: async (message: (typeof plans)[number]) => {
				plans.push(message);
				return "injected";
			},
		} as unknown as AgentSession;
		const child = { instanceKey: `plan-child:${suffix}` } as AgentSession;
		const outsider = { instanceKey: `plan-outsider:${suffix}` } as AgentSession;
		for (const session of [lead, child, outsider]) registerLocalSession(session);
		const leadRef = registry.register({ id: `lead-${suffix}`, displayName: "lead", kind: "main", session: lead });
		const ref = registry.register({ id: `child-${suffix}`, displayName: "child", kind: "sub", session: child });
		const started = await teamRuntime.start(lead, {
			name: `plan-${suffix}`,
			description: "",
			members: [],
			body: "",
			source: "project",
			filePath: "plan.md",
			planApproval: true,
		});
		started.members.set("worker", { id: ref.id, ref });
		const identity = { team: `plan-${suffix}`, generation: started.generation, memberId: ref.id };
		const tools = (session: AgentSession): ToolSession =>
			({
				cwd: ".",
				hasUI: false,
				getSessionFile: () => null,
				getSessionInstanceKey: () => session.instanceKey,
				teamIdentity: identity,
			}) as ToolSession;
		const router = new InternalUrlRouter();
		const url = `team://${identity.team}/plan`;
		try {
			await router.write(url, "Inspect and add tests", { session: tools(child) });
			expect(plans.at(-1)).toMatchObject({ from: ref.id, progress: true });
			expect(plans.at(-1)!.body).toContain("Inspect and add tests");
			expect(plans.at(-1)!.body).toContain("rev 1");
			expect(IrcBus.global().unansweredSends(ref.id, 0)).toEqual([]);
			await expect(router.write(url, "spoofed", { session: tools(outsider) })).rejects.toThrow();
			await expect(router.write(url, "   ", { session: tools(child) })).rejects.toThrow();
			for (const target of [`${url}/worker`, `${url}?author=lead`, `${url}#lead`]) {
				await expect(router.write(target, "spoofed", { session: tools(child) })).rejects.toThrow();
			}
			await expect(router.resolve(url, { session: tools(child) })).rejects.toThrow();
		} finally {
			await teamRuntime.stop(lead, identity.team);
			registry.unregister(leadRef.id, leadRef);
			registry.unregister(ref.id, ref);
		}
	});

	it("rejects malformed task paths and never locates the ledger", async () => {
		const router = new InternalUrlRouter();
		for (const url of ["team://audit", "team://audit/tasks/1", "team://audit/tasks/1/claim/extra"]) {
			await expect(router.resolve(url)).rejects.toThrow();
			await expect(router.write(url, "x")).rejects.toThrow();
		}
		const target = await router.target("team://audit/tasks");
		expect(target?.kind).toBe("resource");
	});

	it("rejects a caller without a trusted session", async () => {
		const router = new InternalUrlRouter();
		await expect(router.resolve("team://audit/tasks")).rejects.toThrow();
		await expect(router.write("team://audit/tasks/1/claim", "forged owner")).rejects.toThrow();
	});

	it("dispatches claims atomically and authorizes completion against the actual caller", async () => {
		const registry = AgentRegistry.global();
		const suffix = crypto.randomUUID();
		const makeSession = (name: string) => {
			const session = { instanceKey: `team-test:${name}:${suffix}` } as AgentSession;
			registerLocalSession(session);
			const id = `${name}-${suffix}`;
			const ref = registry.register({ id, displayName: id, kind: name === "lead" ? "main" : "sub", session });
			return { session, id, ref };
		};
		const lead = makeSession("lead");
		const first = makeSession("first");
		const second = makeSession("second");
		const outsider = makeSession("outsider");
		try {
			const team = await teamRuntime.start(lead.session, {
				name: "audit",
				description: "",
				members: [],
				body: "",
				source: "project",
				filePath: "audit.md",
			});
			team.members.set("first", { id: first.id, ref: first.ref });
			team.members.set("second", { id: second.id, ref: second.ref });
			const tools = (member: typeof first, generation = team.generation): ToolSession =>
				({
					cwd: ".",
					hasUI: false,
					getSessionFile: () => null,
					getSessionInstanceKey: () => member.session.instanceKey,
					teamIdentity: { team: "audit", generation, memberId: member.id },
				}) as ToolSession;
			const leadSession = tools(lead);
			const firstSession = tools(first);
			const secondSession = tools(second);
			const outsiderSession = tools(outsider);
			const router = new InternalUrlRouter();
			await expect(
				router.write("team://audit/stop/request-123", "ack", { session: firstSession }),
			).rejects.not.toThrow("Invalid team task URL");
			await expect(router.resolve("team://audit/stop/request-123", { session: firstSession })).rejects.toThrow();
			for (const url of [
				"team://audit/stop/",
				"team://audit/stop/id/extra",
				"team://audit/stop/id?x=1",
				"team://audit/stop/id#fragment",
			]) {
				await expect(router.write(url, "ack", { session: firstSession })).rejects.toThrow();
			}
			const rows = async (session = leadSession) =>
				JSON.parse((await router.resolve("team://audit/tasks", { session })).content);
			await router.write("team://audit/tasks", "Inspect", { session: leadSession });
			await expect(router.write("team://audit/tasks", "unauthorized", { session: firstSession })).rejects.toThrow();
			const claims = await Promise.allSettled([
				router.write("team://audit/tasks/1/claim", "forged", { session: firstSession }),
				router.write("team://audit/tasks/1/claim", "forged", { session: secondSession }),
			]);
			const winnerIndex = claims.findIndex(result => result.status === "fulfilled");
			expect(winnerIndex).toBeGreaterThanOrEqual(0);
			const winner = winnerIndex === 0 ? first : second;
			const ownerSession = winnerIndex === 0 ? firstSession : secondSession;
			const otherSession = winnerIndex === 0 ? secondSession : firstSession;
			const winningClaim = claims[winnerIndex];
			const losingClaim = claims[1 - winnerIndex];
			expect(winningClaim.status).toBe("fulfilled");
			if (winningClaim.status !== "fulfilled") throw new Error("Expected a winning claim");
			expect(winningClaim.value?.content).toEqual([
				{ type: "text", text: JSON.stringify({ kind: "claimed", owner: winner.id }) },
			]);
			expect(losingClaim.status).toBe("rejected");
			if (losingClaim.status !== "rejected") throw new Error("Expected a conflicting claim");
			expect(String(losingClaim.reason)).toContain(winner.id);
			const owned = [{ id: "1", title: "Inspect", owner: winner.id, status: "open", note: "" }];
			expect(await rows()).toEqual(owned);
			const repeat = await router.write("team://audit/tasks/1/claim", "", { session: ownerSession });
			expect(repeat?.content).toEqual([
				{ type: "text", text: JSON.stringify({ kind: "already-owned", owner: winner.id }) },
			]);
			expect(await rows()).toEqual(owned);
			await expect(router.write("team://audit/tasks/1/release", "", { session: otherSession })).rejects.toThrow();
			await expect(router.write("team://audit/tasks/1/done", "forged", { session: otherSession })).rejects.toThrow();
			expect(await rows()).toEqual(owned);
			await router.write("team://audit/tasks/1/done", "owner finished", { session: ownerSession });
			expect(await rows()).toEqual([
				{ id: "1", title: "Inspect", owner: winner.id, status: "done", note: "owner finished" },
			]);
			await expect(router.write("team://audit/tasks/1/claim", "", { session: otherSession })).rejects.toThrow();
			await router.write("team://audit/tasks/1/release", "", { session: ownerSession });
			const open = [{ id: "1", title: "Inspect", owner: null, status: "open", note: "" }];
			expect(await rows()).toEqual(open);
			await router.write("team://audit/tasks/1/claim", "", { session: ownerSession });
			await router.write("team://audit/tasks/1/done", "lead finished", { session: leadSession });
			expect(await rows()).toEqual([
				{ id: "1", title: "Inspect", owner: winner.id, status: "done", note: "lead finished" },
			]);
			await router.write("team://audit/tasks/1/release", "", { session: leadSession });
			expect(await rows()).toEqual(open);

			await expect(router.resolve("team://audit/tasks", { session: outsiderSession })).rejects.toThrow();
			for (const action of ["claim", "release", "done"]) {
				await expect(
					router.write(`team://audit/tasks/1/${action}`, "intrusion", { session: outsiderSession }),
				).rejects.toThrow();
				await expect(
					router.write(`team://audit/tasks/999/${action}`, "unknown", { session: leadSession }),
				).rejects.toThrow();
			}
			for (const url of [
				"team://audit/tasks/0/claim",
				"team://audit/tasks/01/claim",
				"team://audit/tasks/1/delete",
				"team://audit/tasks/1/claim/extra",
				"team://audit/tasks/1/claim?x=1",
				"team://audit/tasks/1/claim#fragment",
			]) {
				await expect(router.write(url, "malformed", { session: leadSession })).rejects.toThrow();
			}
			expect(await rows()).toEqual(open);

			await teamRuntime.stop(lead.session, "audit");
			const nextTeam = await teamRuntime.start(lead.session, {
				name: "audit",
				description: "",
				members: [],
				body: "",
				source: "project",
				filePath: "audit.md",
			});
			nextTeam.members.set("first", { id: first.id, ref: first.ref });
			const newLeadSession = tools(lead, nextTeam.generation);
			await router.write("team://audit/tasks", "New generation", { session: newLeadSession });
			await expect(router.resolve("team://audit/tasks", { session: firstSession })).rejects.toThrow();
			for (const action of ["claim", "release", "done"]) {
				await expect(
					router.write(`team://audit/tasks/1/${action}`, "stale", { session: firstSession }),
				).rejects.toThrow();
			}
			await expect(router.write("team://audit/tasks", "stale", { session: leadSession })).rejects.toThrow();
			expect(await rows(newLeadSession)).toEqual([
				{ id: "1", title: "New generation", owner: null, status: "open", note: "" },
			]);
		} finally {
			await teamRuntime.stop(lead.session, "audit");
			for (const member of [lead, first, second, outsider]) registry.unregister(member.id, member.ref);
		}
	});
});
