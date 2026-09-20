import type {
	ContextFlowNode,
	ContextFlowNodeStatus,
	ContextFlowSnapshot,
	ContextFlowStage,
	ContextFlowVisibility,
	OffloadSummary,
	WiringStatus,
} from "./types";
import { RESEARCH_STACK_WIRING } from "./wiring";

let nextId = 1;

function newId(): string {
	return `cf-${nextId++}`;
}

export type StageBeginArgs = {
	key: string;
	stage: ContextFlowStage;
	component: string;
	role: string;
	visibility: ContextFlowVisibility;
	parentId?: string;
	wiringStatus?: WiringStatus;
	provider?: string;
	model?: string;
	inputTokens?: number;
	outputTokens?: number;
	inputBytes?: number;
	decision?: string;
	reason?: string;
	grantCount?: number;
};

export type StagePatch = Partial<
	Pick<
		ContextFlowNode,
		| "provider"
		| "model"
		| "inputTokens"
		| "outputTokens"
		| "cachedTokens"
		| "inputBytes"
		| "outputBytes"
		| "durationMs"
		| "decision"
		| "reason"
		| "evidenceHandles"
		| "grantCount"
		| "visibility"
	>
>;

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
	#listeners = new Set<() => void>();
	#notifyScheduled = false;
	#activeByKey = new Map<string, string>();
	#nodeIndex = new Map<string, number>();

	get revision(): number {
		return this.#revision;
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	#notify(): void {
		this.#revision += 1;
		if (this.#notifyScheduled || this.#listeners.size === 0) return;
		this.#notifyScheduled = true;
		queueMicrotask(() => {
			this.#notifyScheduled = false;
			for (const listener of this.#listeners) listener();
		});
	}

	#indexNodes(): void {
		this.#nodeIndex.clear();
		for (let i = 0; i < this.#nodes.length; i++) {
			this.#nodeIndex.set(this.#nodes[i]!.id, i);
		}
	}

	#updateNodeById(id: string, patch: Partial<ContextFlowNode>): void {
		const idx = this.#nodeIndex.get(id);
		if (idx === undefined) return;
		const prev = this.#nodes[idx]!;
		this.#nodes[idx] = { ...prev, ...patch };
		this.#notify();
	}

	beginTurn(label = "user prompt"): string {
		this.#turn += 1;
		return this.record({
			stage: "prompt",
			component: "omp.user",
			role: "ingress",
			visibility: "root",
			status: "complete",
			decision: label,
			durationMs: 0,
		});
	}

	record(
		partial: Omit<ContextFlowNode, "id" | "turn" | "startedAt"> & { id?: string; startedAt?: number },
	): string {
		const id = partial.id ?? newId();
		const node: ContextFlowNode = {
			id,
			turn: this.#turn,
			startedAt: partial.startedAt ?? Date.now(),
			...partial,
		};
		this.#nodes.push(node);
		if (this.#nodes.length > 200) this.#nodes.splice(0, this.#nodes.length - 200);
		this.#indexNodes();
		this.#notify();
		return id;
	}

	beginStage(args: StageBeginArgs): string {
		const startedAt = Date.now();
		const id = this.record({
			parentId: args.parentId,
			stage: args.stage,
			component: args.component,
			role: args.role,
			visibility: args.visibility,
			wiringStatus: args.wiringStatus,
			provider: args.provider,
			model: args.model,
			inputTokens: args.inputTokens,
			outputTokens: args.outputTokens,
			inputBytes: args.inputBytes,
			decision: args.decision,
			reason: args.reason,
			grantCount: args.grantCount,
			status: "running",
			startedAt,
		});
		this.#activeByKey.set(args.key, id);
		return id;
	}

	completeStage(key: string, patch?: StagePatch): void {
		const id = this.#activeByKey.get(key);
		if (!id) return;
		const node = this.#nodes[this.#nodeIndex.get(id)!];
		const durationMs = node ? Date.now() - node.startedAt : undefined;
		this.#updateNodeById(id, { ...patch, status: "complete", durationMs: patch?.durationMs ?? durationMs });
		this.#activeByKey.delete(key);
	}

	failStage(key: string, patch?: StagePatch): void {
		const id = this.#activeByKey.get(key);
		if (!id) return;
		const node = this.#nodes[this.#nodeIndex.get(id)!];
		const durationMs = node ? Date.now() - node.startedAt : undefined;
		this.#updateNodeById(id, { ...patch, status: "failed", durationMs: patch?.durationMs ?? durationMs });
		this.#activeByKey.delete(key);
	}

	skipStage(key: string, patch?: StagePatch): void {
		const id = this.#activeByKey.get(key);
		if (id) {
			this.#updateNodeById(id, { ...patch, status: "skipped", durationMs: 0 });
			this.#activeByKey.delete(key);
			return;
		}
		this.record({
			stage: "worker",
			component: key,
			role: "worker",
			visibility: "worker",
			status: "skipped",
			durationMs: 0,
			...patch,
		});
	}

	recordInstant(args: Omit<StageBeginArgs, "key"> & { status?: ContextFlowNodeStatus; durationMs?: number }): string {
		return this.record({
			parentId: args.parentId,
			stage: args.stage,
			component: args.component,
			role: args.role,
			visibility: args.visibility,
			wiringStatus: args.wiringStatus,
			provider: args.provider,
			model: args.model,
			inputTokens: args.inputTokens,
			outputTokens: args.outputTokens,
			inputBytes: args.inputBytes,
			outputBytes: args.outputBytes,
			decision: args.decision,
			reason: args.reason,
			grantCount: args.grantCount,
			status: args.status ?? "complete",
			durationMs: args.durationMs,
		});
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
		const clean = Object.fromEntries(
			Object.entries(patch).filter((entry): entry is [string, OffloadSummary[keyof OffloadSummary]] => entry[1] !== undefined),
		) as Partial<OffloadSummary>;
		this.#offload = { ...this.#offload, ...clean, active: patch.active ?? this.#offload.active ?? true };
		this.#notify();
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

export function subscribeContextFlow(owner: object, listener: () => void): () => void {
	return getContextFlowRegistry(owner).subscribe(listener);
}
