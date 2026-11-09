import { AgentRegistry, type AgentRef } from "../registry/agent-registry";
import { IrcBus } from "../irc/bus";
import { logger } from "@oh-my-pi/pi-utils";
import { TeamLedger, type TeamClaimResult, type TeamTask } from "./team-ledger";
import type { TeamDefinition } from "./teams";

/** Identity propagated to a team member's trusted tool session. */
export interface TeamIdentity {
	team: string;
	generation: number;
	memberId: string;
}

export interface TeamMembership {
	id: string;
	ref?: AgentRef;
	failure?: string;
}

export interface StartedTeam {
	generation: number;
	leadId: string;
	members: Map<string, TeamMembership>;
}

interface RuntimeTeam extends StartedTeam {
	name: string;
	lead: object;
	leadRef: AgentRef;
	ledger: TeamLedger;
	pendingRefs: Map<string, { reservation: unknown; generation: number }>;
}

/** Main-owned membership and authority for all team generations. */
export class TeamRuntime {
	#sessions = new WeakMap<object, Map<string, RuntimeTeam>>();
	#generations = new Map<number, RuntimeTeam>();
	#nextGeneration = 0;
	#starts = new WeakMap<object, Map<string, Promise<StartedTeam>>>();
	#closedSessions = new WeakSet<object>();
	#observedSessions = new WeakSet<object>();
	#unsubscribe: (() => void) | undefined;

	#observeRegistry(): void {
		if (this.#unsubscribe) return;
		const registry = AgentRegistry.global();
		this.#unsubscribe = registry.onChange(event => {
			if (event.type === "registered") {
				for (const state of this.#generations.values()) {
					const member = [...state.members.values()].find(entry => entry.id === event.ref.id);
					if (member && !member.ref && member.failure === undefined) {
						const reservation = Reflect.get(member, "reservation");
						const previous = state.pendingRefs.get(member.id);
						if (!previous || previous.reservation !== reservation) {
							state.pendingRefs.set(member.id, { reservation, generation: event.ref.generation });
						}
					}
				}
				return;
			}
			if (event.type !== "status_changed" || event.previousStatus !== "running" || event.ref.status !== "idle")
				return;
			const current = registry.get(event.ref.id);
			if (!current || current.generation !== event.ref.generation) return;
			for (const state of this.#generations.values()) {
				const member = [...state.members.values()].find(entry => entry.id === event.ref.id);
				const pending = member && state.pendingRefs.get(member.id);
				const generation =
					member?.ref?.generation ??
					(pending?.reservation === (member && Reflect.get(member, "reservation"))
						? pending?.generation
						: undefined);
				if (!member || member.failure !== undefined || generation !== event.ref.generation) continue;
				const lead = registry.get(state.leadId);
				if (!lead || lead.generation !== state.leadRef.generation || lead.session !== state.lead) continue;
				void IrcBus.global()
					.send({
						from: event.ref.id,
						to: state.leadId,
						body: `${event.ref.id} is idle.\n${event.summary ?? ""}\nagent://${event.ref.id}`,
						progress: true,
					})
					.then(receipt => {
						if (receipt.outcome === "failed")
							logger.warn("Team idle notification failed", { error: receipt.error });
					})
					.catch(error => logger.warn("Team idle notification failed", { error: String(error) }));
			}
		});
	}

	#unobserveIfEmpty(): void {
		if (this.#generations.size !== 0) return;
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
	}

	async start(lead: object, team: TeamDefinition): Promise<StartedTeam> {
		const existing = this.#sessions.get(lead)?.get(team.name);
		if (existing) {
			if (!this.isCurrentLead(lead, team.name, existing.generation))
				throw new Error("Team lead is no longer registered");
			return existing;
		}
		let starts = this.#starts.get(lead);
		if (!starts) this.#starts.set(lead, (starts = new Map()));
		const pending = starts.get(team.name);
		if (pending) return pending;
		const start = this.#start(lead, team);
		starts.set(team.name, start);
		try {
			return await start;
		} finally {
			starts.delete(team.name);
		}
	}

	async #start(lead: object, team: TeamDefinition): Promise<StartedTeam> {
		const leadRef = AgentRegistry.global()
			.list()
			.find(ref => ref.session === lead);
		if (!leadRef) throw new Error("Team lead session is not registered");
		if (!this.#observedSessions.has(lead)) {
			this.#observedSessions.add(lead);
			const addDisposer: unknown = Reflect.get(lead, "addDisposer");
			if (typeof addDisposer === "function") addDisposer.call(lead, () => this.sessionClosed(lead));
		}
		if (this.#closedSessions.has(lead) || Reflect.get(lead, "isDisposed") === true)
			throw new Error("Team lead session is closed");
		const ledger = new TeamLedger(team.workspace);
		await ledger.initialize(team.tasks);
		if (
			this.#closedSessions.has(lead) ||
			Reflect.get(lead, "isDisposed") === true ||
			AgentRegistry.global().get(leadRef.id) !== leadRef ||
			leadRef.session !== lead
		) {
			throw new Error("Team lead session is no longer registered");
		}
		const state: RuntimeTeam = {
			name: team.name,
			lead,
			leadRef,
			leadId: leadRef.id,
			ledger,
			generation: ++this.#nextGeneration,
			members: new Map(),
			pendingRefs: new Map(),
		};
		let teams = this.#sessions.get(lead);
		if (!teams) this.#sessions.set(lead, (teams = new Map()));
		teams.set(team.name, state);
		this.#generations.set(state.generation, state);
		this.#observeRegistry();
		return state;
	}

	members(lead: object, name: string): Map<string, TeamMembership> | undefined {
		return this.#sessions.get(lead)?.get(name)?.members;
	}

	isCurrentLead(lead: object, name: string, generation: number): boolean {
		const state = this.#sessions.get(lead)?.get(name);
		return (
			state !== undefined &&
			state.generation === generation &&
			AgentRegistry.global().get(state.leadId) === state.leadRef &&
			state.leadRef.session === lead
		);
	}

	/** Identity for a lead's locally initiated team URI operations. */
	identity(lead: object, name: string): TeamIdentity | undefined {
		const state = this.#sessions.get(lead)?.get(name);
		return state ? { team: name, generation: state.generation, memberId: state.leadId } : undefined;
	}

	/** Clear test state without recycling generation numbers. */
	resetForTests(): void {
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		this.#sessions = new WeakMap();
		this.#generations.clear();
		this.#starts = new WeakMap();
		this.#closedSessions = new WeakSet();
		this.#observedSessions = new WeakSet();
	}

	async stop(lead: object, name: string): Promise<void> {
		const teams = this.#sessions.get(lead);
		const state = teams?.get(name);
		if (!state) return;
		teams?.delete(name);
		this.#generations.delete(state.generation);
		this.#unobserveIfEmpty();
		await state.ledger.barrier();
	}

	/** Invalidate lead-owned teams when their session closes. */
	sessionClosed(session: object): void {
		this.#closedSessions.add(session);
		const teams = this.#sessions.get(session);
		if (teams) for (const state of teams.values()) this.#generations.delete(state.generation);
		this.#sessions.delete(session);
		this.#unobserveIfEmpty();
	}

	#authorize(session: object, identity: TeamIdentity): { state: RuntimeTeam; lead: boolean } {
		const state = this.#generations.get(identity.generation);
		if (!state || state.name !== identity.team) throw new Error("Unknown or stale team generation");
		const registry = AgentRegistry.global();
		const leadRef = registry.get(state.leadId);
		if (
			!leadRef ||
			leadRef.id !== state.leadRef.id ||
			leadRef.generation !== state.leadRef.generation ||
			leadRef.session !== state.lead
		) {
			throw new Error("Team lead is no longer registered");
		}
		if (identity.memberId === state.leadId && session === state.lead) return { state, lead: true };
		const entry = [...state.members.values()].find(member => member.id === identity.memberId);
		if (!entry || entry.failure !== undefined) throw new Error("Caller is not a team member");
		const ref = registry.get(entry.id);
		if (
			!ref ||
			ref.session !== session ||
			(entry.ref !== undefined && (entry.ref.id !== ref.id || entry.ref.generation !== ref.generation))
		) {
			throw new Error("Team member session is not registered");
		}
		entry.ref ??= ref;
		return { state, lead: false };
	}

	async readTasks(session: object, identity: TeamIdentity): Promise<TeamTask[]> {
		return this.#authorize(session, identity).state.ledger.read(() => {
			this.#authorize(session, identity);
		});
	}
	async addTask(session: object, identity: TeamIdentity, title: string): Promise<TeamTask> {
		const { state, lead } = this.#authorize(session, identity);
		return state.ledger.add(title, lead, () => {
			this.#authorize(session, identity);
		});
	}
	async claim(session: object, identity: TeamIdentity, id: string): Promise<TeamClaimResult> {
		return this.#authorize(session, identity).state.ledger.claim(id, identity.memberId, () => {
			this.#authorize(session, identity);
		});
	}
	async releaseTask(session: object, identity: TeamIdentity, id: string): Promise<TeamTask> {
		const { state, lead } = this.#authorize(session, identity);
		return state.ledger.release(id, identity.memberId, lead, () => {
			this.#authorize(session, identity);
		});
	}
	async completeTask(session: object, identity: TeamIdentity, id: string, note: string): Promise<TeamTask> {
		const { state, lead } = this.#authorize(session, identity);
		return state.ledger.done(id, identity.memberId, lead, note, () => {
			this.#authorize(session, identity);
		});
	}
}

export const teamRuntime = new TeamRuntime();
