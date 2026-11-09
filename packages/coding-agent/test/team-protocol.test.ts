import { describe, expect, it } from "bun:test";
import { InternalUrlRouter } from "../src/internal-urls/router";
import { AgentRegistry } from "../src/registry/agent-registry";
import type { AgentSession } from "../src/session/agent-session";
import { teamRuntime } from "../src/task/team-runtime";
import { registerLocalSession } from "../src/thread/session-directory";
import type { ToolSession } from "../src/tools";

describe("team:// routing", () => {
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
