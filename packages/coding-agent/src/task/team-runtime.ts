import { AgentRegistry, type AgentRef } from "../registry/agent-registry";
import { IrcBus } from "../irc/bus";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import { randomUUID } from "node:crypto";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import stopRequestTemplate from "../prompts/system/team-stop-request.md" with { type: "text" };
import type { TeamCommandMember } from "../thread/services/team-protocol";
import { TeamLedger, type TeamClaimResult, type TeamTask } from "./team-ledger";
import type { TeamDefinition } from "./teams";

/** Identity propagated to a team member's trusted tool session. */
export interface TeamIdentity {
	team: string;
	generation: number;
	memberId: string;
}

/** Result of a member's `write team://<team>/stop/<requestId>`. */
export interface TeamStopResponse {
	requestId: string;
	outcome: "acknowledged" | "declined";
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

interface StopIntent {
	handle: string;
	reservation: string;
	id: string;
	force: boolean;
	wholeTeam: boolean;
	timeoutMs: number;
	ref?: AgentRef;
	requestId: string;
	timer?: NodeJS.Timeout;
}

interface RuntimeTeam extends StartedTeam {
	name: string;
	lead: object;
	leadRef: AgentRef;
	ledger: TeamLedger;
	pendingRefs: Map<string, { reservation: unknown; generation: number }>;
	stops: Map<string, StopIntent>;
	releasing: Map<string, StopIntent>;
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
					for (const intent of state.stops.values()) {
						if (intent.id === event.ref.id && intent.ref && intent.ref.generation !== event.ref.generation)
							this.#clearStop(state, intent);
					}
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
			if (event.type === "removed" || (event.type === "status_changed" && event.ref.status === "aborted")) {
				for (const state of this.#generations.values()) {
					for (const intent of state.stops.values()) {
						if (intent.id === event.ref.id && intent.ref?.generation === event.ref.generation)
							this.#clearStop(state, intent);
					}
				}
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
			stops: new Map(),
			releasing: new Map(),
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
	listTeams(lead: object): string[] {
		const teams = this.#sessions.get(lead);
		if (!teams) return [];
		return [...teams.values()]
			.filter(state => this.isCurrentLead(lead, state.name, state.generation))
			.map(state => state.name);
	}
	/** Retain stop intent only while the same spawn reservation remains active. */
	memberUpdated(
		lead: object,
		name: string,
		generation: number,
		handle: string,
		before: TeamMembership | undefined,
		after: TeamMembership | undefined,
	): void {
		const state = this.#sessions.get(lead)?.get(name);
		if (!state || !this.isCurrentLead(lead, name, generation) || !before) return;
		const intent = state.stops.get(handle);
		if (!intent) return;
		if (
			after &&
			!intent.ref &&
			intent.id === before.id &&
			intent.reservation === Reflect.get(before, "reservation") &&
			intent.reservation === Reflect.get(after, "reservation") &&
			!after.ref &&
			after.failure === undefined
		) {
			intent.id = after.id;
		} else if (!after || !this.#matches(state, intent) || after.failure !== undefined) {
			this.#clearStop(state, intent);
		}
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

	#clearStop(state: RuntimeTeam, intent: StopIntent): void {
		if (intent.timer !== undefined) clearTimeout(intent.timer);
		if (state.stops.get(intent.handle) === intent) state.stops.delete(intent.handle);
	}

	#clearStops(state: RuntimeTeam): void {
		for (const intent of state.stops.values()) this.#clearStop(state, intent);
	}

	#notifyLead(state: RuntimeTeam, intent: StopIntent, body: string): void {
		if (!this.isCurrentLead(state.lead, state.name, state.generation)) return;
		void IrcBus.global()
			.send({ from: intent.id, to: state.leadId, body: `${body} (request ${intent.requestId})`, progress: true })
			.catch(error => logger.warn("Team stop notification failed", { error: String(error) }));
	}

	#matches(state: RuntimeTeam, intent: StopIntent): boolean {
		const member = state.members.get(intent.handle);
		return (
			this.isCurrentLead(state.lead, state.name, state.generation) &&
			member?.id === intent.id &&
			Reflect.get(member, "reservation") === intent.reservation &&
			(!intent.ref || (member.ref?.id === intent.ref.id && member.ref.generation === intent.ref.generation))
		);
	}

	async #releaseStop(state: RuntimeTeam, intent: StopIntent): Promise<boolean> {
		if (!this.#matches(state, intent) || !intent.ref) return false;
		const current = AgentRegistry.global().get(intent.id);
		if (!current || current.generation !== intent.ref.generation || current.id !== intent.ref.id) return false;
		if (state.releasing.has(intent.handle) || current.status === "aborted") return false;
		state.releasing.set(intent.handle, intent);
		try {
			const released = await AgentLifecycleManager.global().release(intent.id, current, { tombstone: true });
			if (released && this.#matches(state, intent)) {
				const member = state.members.get(intent.handle);
				if (member?.ref?.generation === intent.ref.generation) state.members.delete(intent.handle);
				if (intent.wholeTeam && state.members.size === 0) await this.stop(state.lead, state.name);
			}
			return released;
		} finally {
			state.releasing.delete(intent.handle);
		}
	}

	async #dispatchStop(state: RuntimeTeam, intent: StopIntent, ref: AgentRef): Promise<string> {
		const current = AgentRegistry.global().get(intent.id);
		if (!this.#matches(state, intent) || !current || current.id !== ref.id || current.generation !== ref.generation) {
			this.#clearStop(state, intent);
			return "member changed";
		}
		intent.ref = current;
		if (intent.force) {
			this.#clearStop(state, intent);
			return (await this.#releaseStop(state, intent)) ? "released" : "release refused";
		}
		const requestId = intent.requestId;
		intent.timer = setTimeout(() => {
			if (state.stops.get(intent.handle) !== intent) return;
			this.#clearStop(state, intent);
			if (this.#matches(state, intent)) this.#notifyLead(state, intent, `Stop request for ${intent.id} timed out.`);
		}, intent.timeoutMs);
		intent.timer.unref?.();
		const body = prompt.render(stopRequestTemplate, { teamName: state.name, requestId }).trim();
		void IrcBus.global()
			.send({ from: state.leadId, to: intent.id, body, teamControl: true })
			.then(receipt => {
				if (receipt.outcome === "failed" && state.stops.get(intent.handle) === intent) {
					this.#clearStop(state, intent);
					this.#notifyLead(state, intent, `Stop request for ${intent.id} failed: ${receipt.error}`);
				}
			})
			.catch(error => {
				if (state.stops.get(intent.handle) !== intent) return;
				this.#clearStop(state, intent);
				this.#notifyLead(state, intent, `Stop request for ${intent.id} failed: ${String(error)}`);
			});
		return `requested (${requestId})`;
	}

	async requestStop(
		lead: object,
		name: string,
		generation: number,
		handle: string,
		expected: TeamCommandMember,
		force: boolean,
		timeoutMs: number,
		wholeTeam = false,
	): Promise<string> {
		const state = this.#sessions.get(lead)?.get(name);
		if (!state || !this.isCurrentLead(lead, name, generation)) return "team changed";
		const member = state.members.get(handle);
		if (
			!member ||
			member.id !== expected.id ||
			Reflect.get(member, "reservation") !== expected.reservation ||
			member.ref?.id !== expected.ref?.id ||
			member.ref?.generation !== expected.ref?.generation ||
			member.failure !== expected.failure
		)
			return "member changed";
		if (member.failure !== undefined) return `failed before registering: ${member.failure}`;
		const current = member.ref && AgentRegistry.global().get(member.id);
		const releasing = state.releasing.get(handle);
		if (releasing) {
			releasing.wholeTeam ||= wholeTeam;
			return "stop already pending";
		}
		if (current?.generation === member.ref?.generation && current?.status === "aborted")
			return "stop already pending";
		const existing = state.stops.get(handle);
		if (existing) {
			existing.wholeTeam ||= wholeTeam;
			if (!force || existing.force) return "stop already pending";
			this.#clearStop(state, existing);
		}
		const intent: StopIntent = {
			handle,
			reservation: expected.reservation,
			id: expected.id,
			force,
			wholeTeam: wholeTeam || existing?.wholeTeam === true,
			timeoutMs: Number.isFinite(timeoutMs) ? Math.max(1000, timeoutMs) : 1000,
			requestId: randomUUID(),
		};
		state.stops.set(handle, intent);
		return member.ref ? this.#dispatchStop(state, intent, member.ref) : "stop pending registration";
	}

	async resolvePendingStop(
		lead: object,
		name: string,
		generation: number,
		handle: string,
		expected: TeamCommandMember,
		ref?: AgentRef,
		failure?: string,
	): Promise<boolean> {
		const state = this.#sessions.get(lead)?.get(name);
		if (!state || !this.isCurrentLead(lead, name, generation)) return false;
		const member = state.members.get(handle);
		if (!member || member.id !== expected.id || Reflect.get(member, "reservation") !== expected.reservation)
			return false;
		if (ref) {
			const current = AgentRegistry.global().get(member.id);
			const pending = state.pendingRefs.get(member.id);
			if (
				!current ||
				ref.id !== member.id ||
				ref.generation !== current.generation ||
				(member.ref && member.ref.generation !== ref.generation) ||
				(pending?.reservation === expected.reservation && pending.generation !== ref.generation)
			)
				return false;
			member.ref = current;
		} else if (failure !== undefined) {
			if (member.ref) return false;
			member.failure = failure;
		} else return false;
		const intent = state.stops.get(handle);
		if (intent && this.#matches(state, intent)) {
			if (failure !== undefined) {
				this.#clearStop(state, intent);
				this.#notifyLead(state, intent, `Stop request for ${member.id} failed during registration: ${failure}`);
			} else if (ref && !intent.ref) {
				const result = await this.#dispatchStop(state, intent, ref);
				if (result === "release refused" || result === "member changed")
					this.#notifyLead(state, intent, `Stop request for ${member.id} failed: ${result}`);
			}
		}
		return true;
	}

	async respondStop(
		session: object,
		identity: TeamIdentity,
		requestId: string,
		body: string,
	): Promise<TeamStopResponse> {
		const { state, lead } = this.#authorize(session, identity);
		if (lead) throw new Error("Only the targeted member can respond");
		const intent = [...state.stops.values()].find(entry => entry.requestId === requestId);
		if (!intent || intent.id !== identity.memberId || !this.#matches(state, intent) || !intent.ref)
			throw new Error("Unknown or stale stop request");
		const current = AgentRegistry.global().get(intent.id);
		if (!current || current.session !== session || current.generation !== intent.ref.generation)
			throw new Error("Unknown or stale stop request");
		const response = body.trim();
		if (response !== "ack" && !/^decline:\s*\S/.test(response)) throw new Error("Expected ack or decline: <reason>");
		this.#clearStop(state, intent);
		if (response === "ack") {
			if (!(await this.#releaseStop(state, intent))) throw new Error("Stop release refused");
			return { requestId, outcome: "acknowledged" };
		}
		this.#notifyLead(
			state,
			intent,
			`${intent.id} declined stop: ${response.slice(response.indexOf(":") + 1).trim()}`,
		);
		return { requestId, outcome: "declined" };
	}

	/** Clear test state without recycling generation numbers. */
	resetForTests(): void {
		this.#unsubscribe?.();
		for (const state of this.#generations.values()) this.#clearStops(state);
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
		this.#clearStops(state);
		teams?.delete(name);
		this.#generations.delete(state.generation);
		this.#unobserveIfEmpty();
		await state.ledger.barrier();
	}

	/** Invalidate lead-owned teams when their session closes. */
	sessionClosed(session: object): void {
		this.#closedSessions.add(session);
		const teams = this.#sessions.get(session);
		if (teams)
			for (const state of teams.values()) {
				this.#clearStops(state);
				this.#generations.delete(state.generation);
			}
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
