import type { SymbolSet } from "@oh-my-pi/pi-tui/theme/contract";

/** What the tree reads off a job. */
export interface JobTreeJob {
	readonly id: string;
	readonly status: "running" | "completed" | "failed" | "cancelled";
	readonly startTime: number;
	/** Registry id of the agent that owns the job; absent or the root id: a top-level job. */
	readonly ownerId?: string;
	/** Registry id of the subagent a task job runs: the job heads that agent's subtree. */
	readonly agentId?: string;
}

/** A subagent in the tree, by registry id: an owner of listed jobs, or an ancestor linking one to the root. */
export interface JobTreeAgent {
	readonly id: string;
	readonly parentId?: string;
}

/** Where a row sits: its depth and the rails drawn left of it. */
export interface JobTreePlace {
	/** 0 for the top level. */
	readonly depth: number;
	/** Per enclosing level below the top, whether that level's rail continues past this row. */
	readonly rails: readonly boolean[];
	/** Whether this row is the last of its siblings. */
	readonly last: boolean;
	/** Whether rows nest under this one. */
	readonly parent: boolean;
}

/** One tree row: a job (a task job also heads its subagent), or a header for a subagent with no listed task job. */
export type JobTreeRow<J extends JobTreeJob> =
	| (JobTreePlace & { readonly kind: "job"; readonly job: J; readonly agent?: JobTreeAgent })
	| (JobTreePlace & { readonly kind: "agent"; readonly agent: JobTreeAgent });

interface TreeNode<J> {
	job?: J;
	agent?: JobTreeAgent;
	readonly children: TreeNode<J>[];
	/** Rows nested under this node. */
	size: number;
	running: boolean;
	startTime: number;
}

/**
 * `jobs` as tree rows in display order. `rootId` is the viewing agent: its
 * jobs, ownerless jobs and jobs of owners outside `agents` sit at the top
 * level, as do agents whose parent is the root or unknown.
 */
export function buildJobTree<J extends JobTreeJob>(
	jobs: readonly J[],
	agents: readonly JobTreeAgent[],
	rootId: string | undefined,
): JobTreeRow<J>[] {
	const top: TreeNode<J>[] = [];
	const agentNodes = new Map<string, TreeNode<J>>();
	for (const agent of agents) {
		if (agent.id === rootId) continue;
		agentNodes.set(agent.id, { agent, children: [], size: 0, running: false, startTime: Infinity });
	}
	// A task job heads its subagent; with several, the running then newest one.
	for (const job of jobs) {
		const node = job.agentId === undefined ? undefined : agentNodes.get(job.agentId);
		if (!node) continue;
		const held = node.job;
		if (!held || (held.status !== "running" && (job.status === "running" || job.startTime > held.startTime))) {
			node.job = job;
		}
	}
	for (const node of agentNodes.values()) {
		(parentNode(agentNodes, node.agent!)?.children ?? top).push(node);
	}
	for (const job of jobs) {
		if (job.agentId !== undefined && agentNodes.get(job.agentId)?.job === job) continue;
		const owner = job.ownerId === undefined || job.ownerId === rootId ? undefined : agentNodes.get(job.ownerId);
		(owner?.children ?? top).push({ job, children: [], size: 0, running: false, startTime: Infinity });
	}
	settle(top);
	return flatten(top);
}

/** `agent`'s parent node, or undefined for the top level: the root, an unknown agent, or a link that would close a cycle. */
function parentNode<J>(agentNodes: ReadonlyMap<string, TreeNode<J>>, agent: JobTreeAgent): TreeNode<J> | undefined {
	const parent = agent.parentId === undefined ? undefined : agentNodes.get(agent.parentId);
	if (!parent) return undefined;
	const seen = new Set<string>();
	for (let cursor = agent.parentId; cursor !== undefined && !seen.has(cursor);) {
		if (cursor === agent.id) return undefined;
		seen.add(cursor);
		cursor = agentNodes.get(cursor)?.agent?.parentId;
	}
	return parent;
}

/** Size, liveness and start time of each subtree, then siblings branchiest first; drops subagents with nothing listed. */
function settle<J extends JobTreeJob>(top: TreeNode<J>[]): void {
	// Post-order without recursion: lineage depth is not ours to bound.
	const order: TreeNode<J>[] = [];
	const stack = [...top];
	while (stack.length > 0) {
		const node = stack.pop()!;
		order.push(node);
		stack.push(...node.children);
	}
	const prune = (nodes: TreeNode<J>[]): void => {
		const kept = nodes.filter(node => node.job !== undefined || node.children.length > 0);
		nodes.splice(0, nodes.length, ...kept);
		nodes.sort(compareNodes);
	};
	for (let i = order.length - 1; i >= 0; i--) {
		const node = order[i];
		prune(node.children);
		node.size = 0;
		node.running = node.job?.status === "running";
		node.startTime = node.job?.startTime ?? Infinity;
		for (const child of node.children) {
			node.size += 1 + child.size;
			node.running ||= child.running;
			node.startTime = Math.min(node.startTime, child.startTime);
		}
	}
	prune(top);
}

/** Branchiest first: the larger subtree, then running before settled, then the older. */
function compareNodes<J>(a: TreeNode<J>, b: TreeNode<J>): number {
	return b.size - a.size || Number(!a.running) - Number(!b.running) || a.startTime - b.startTime;
}

/** Depth-first rows of `top`, iteratively so lineage depth stays unbounded. */
function flatten<J extends JobTreeJob>(top: readonly TreeNode<J>[]): JobTreeRow<J>[] {
	const out: JobTreeRow<J>[] = [];
	const stack: { node: TreeNode<J>; depth: number; rails: readonly boolean[]; last: boolean }[] = [];
	const push = (level: readonly TreeNode<J>[], depth: number, rails: readonly boolean[]): void => {
		for (let i = level.length - 1; i >= 0; i--) {
			stack.push({ node: level[i], depth, rails, last: i === level.length - 1 });
		}
	};
	push(top, 0, []);
	while (stack.length > 0) {
		const { node, depth, rails, last } = stack.pop()!;
		const place = { depth, rails, last, parent: node.children.length > 0 };
		if (node.job) out.push({ ...place, kind: "job", job: node.job, agent: node.agent });
		else if (node.agent) out.push({ ...place, kind: "agent", agent: node.agent });
		// The top level draws no rail, so its children's rails start empty.
		push(node.children, depth + 1, depth === 0 ? [] : [...rails, !last]);
	}
	return out;
}

/** Rails left of a row: a vertical glyph where the enclosing level continues past it, else blank. */
function railPrefix(rails: readonly boolean[], symbols: SymbolSet): string {
	return rails.map(continues => (continues ? `${symbols.symbol("tree.vertical")}  ` : "   ")).join("");
}

/** The guide drawn before a row's first line: rails plus its branch glyph; empty at the top level. */
export function jobTreeGuide(row: JobTreePlace, symbols: SymbolSet): string {
	if (row.depth === 0) return "";
	return `${railPrefix(row.rails, symbols)}${symbols.symbol(row.last ? "tree.last" : "tree.branch")} `;
}

/** The indent of a row's continuation lines: rails, plus a rail into its children when it has any. */
export function jobTreeIndent(row: JobTreePlace, symbols: SymbolSet): string {
	const rails = row.depth === 0 ? "" : railPrefix([...row.rails, !row.last], symbols);
	return `${rails}${row.parent ? `${symbols.symbol("tree.vertical")} ` : "  "}`;
}
