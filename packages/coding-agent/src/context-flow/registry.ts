import type { ContextFlowNode, ContextFlowSnapshot, OffloadSummary, WiringStatus } from "./types";
import { RESEARCH_STACK_WIRING } from "./wiring";

let nextId = 1;

function newId(): string {
	return `cf-${nextId++}`;
}

export class ContextFlowRegistry {
	#turn = 0;
	#nodes: ContextFlowNode[] = [];
	#offload: OffloadSummary = {
		externalBytes: 0,
		reintroducedTokens: 0,
		grantedTokens: 0,
		active: false,
	};
	#revision = 0;

	get revision(): number {
		return this.#revision;
	}

	beginTurn(label = "user prompt"): string {
		this.#turn += 1;
		return this.record({
			stage: "prompt",
			component: "omp.user",
			role: "ingress",
			visibility: "root",
			status: "ok",
			decision: label,
		});
	}

	record(partial: Omit<ContextFlowNode, "id" | "turn" | "startedAt"> & { id?: string; startedAt?: number }): string {
		const id = partial.id ?? newId();
		const node: ContextFlowNode = {
			id,
			turn: this.#turn,
			startedAt: partial.startedAt ?? Date.now(),
			...partial,
		};
		this.#nodes.push(node);
		if (this.#nodes.length > 200) this.#nodes.splice(0, this.#nodes.length - 200);
		this.#revision += 1;
		return id;
	}

	recordNotWired(component: string, parentId?: string): string {
		return this.record({
			parentId,
			stage: "semantic",
			component,
			role: "classifier",
			visibility: "local",
			wiringStatus: "present_not_wired",
			status: "not_wired",
			reason: "implementation exists; OMP hot path does not call this component",
		});
	}

	updateOffload(patch: Partial<OffloadSummary>): void {
		this.#offload = { ...this.#offload, ...patch, active: true };
		this.#revision += 1;
	}

	snapshot(): Pick<ContextFlowSnapshot, "turn" | "nodes" | "offload" | "wiring"> {
		return {
			turn: this.#turn,
			nodes: [...this.#nodes],
			offload: { ...this.#offload },
			wiring: RESEARCH_STACK_WIRING,
		};
	}
}

const REGISTRIES = new WeakMap<object, ContextFlowRegistry>();

export function getContextFlowRegistry(owner: object): ContextFlowRegistry {
	let reg = REGISTRIES.get(owner);
	if (!reg) {
		reg = new ContextFlowRegistry();
		REGISTRIES.set(owner, reg);
	}
	return reg;
}
