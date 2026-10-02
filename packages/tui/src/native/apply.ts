/**
 * Reference document applier: applies TSP frames to a node tree the way the
 * spec says the terminal does (§5.1). Ops are validated and applied one by
 * one; a rejected op is reported and skipped without affecting the rest of
 * the frame. `settle` is recorded as a hint and never restricts later ops.
 *
 * Used by tests, the debug server's `doc` op, and the TSP test harness.
 */
import { TSP_KINDS, TSP_TEXT_KINDS, type TspFrame, type TspKind, type TspNode, type TspOp } from "@oh-my-pi/pi-wire";

/** One rejected op. */
export interface TspApplyError {
	/** Frame sequence number. */
	s: number;
	/** Op index inside the frame. */
	op: number;
	msg: string;
}

interface DocNode {
	id: string;
	k: TspKind;
	p: Record<string, unknown>;
	c: DocNode[];
	parent: DocNode | null;
}

const KINDS: ReadonlySet<string> = new Set(TSP_KINDS);
const TEXT_KINDS: ReadonlySet<string> = new Set(TSP_TEXT_KINDS);

class OpError extends Error {}

function fail(msg: string): never {
	throw new OpError(msg);
}

/** A surface document: the root (id = surface id) plus an id index. */
export class TspDocument {
	readonly surface: string;
	#root: DocNode;
	#index = new Map<string, DocNode>();
	#settled = new Set<string>();
	#focus: string | null = null;
	#suspended = false;

	constructor(surface: string) {
		this.surface = surface;
		this.#root = { id: surface, k: "col", p: {}, c: [], parent: null };
		this.#index.set(surface, this.#root);
	}

	/** Currently focused node id. */
	get focus(): string | null {
		return this.#focus;
	}

	get suspended(): boolean {
		return this.#suspended;
	}

	/** Ids that received a `settle` hint and no later op. */
	get settled(): ReadonlySet<string> {
		return this.#settled;
	}

	/** Number of nodes, including the root. */
	get size(): number {
		return this.#index.size;
	}

	has(id: string): boolean {
		return this.#index.has(id);
	}

	/** `x keep:true`: drop the live-only regions (`dock`, `layer`) and focus; `main` stays. */
	close(): void {
		for (const region of ["dock", "layer"]) {
			const node = this.#index.get(region);
			if (!node || node.parent !== this.#root) continue;
			this.#root.c.splice(this.#root.c.indexOf(node), 1);
			this.#unregister(node);
		}
		this.#focus = null;
	}

	/** Apply a frame op by op; returns the rejected ops. */
	applyFrame(frame: TspFrame): TspApplyError[] {
		const errors: TspApplyError[] = [];
		for (let i = 0; i < frame.ops.length; i++) {
			try {
				this.#apply(frame.ops[i]!);
			} catch (error) {
				if (!(error instanceof OpError)) throw error;
				errors.push({ s: frame.s, op: i, msg: error.message });
			}
		}
		return errors;
	}

	/** Snapshot of the whole document (root included) as wire nodes. */
	snapshot(): TspNode {
		return this.#export(this.#root);
	}

	/** Snapshot of one subtree, or undefined for an unknown id. */
	get(id: string): TspNode | undefined {
		const found = this.#index.get(id);
		return found ? this.#export(found) : undefined;
	}

	#export(node: DocNode): TspNode {
		const out: { id: string; k: TspKind; p?: Record<string, unknown>; c?: TspNode[] } = { id: node.id, k: node.k };
		if (Object.keys(node.p).length > 0) out.p = { ...node.p };
		if (node.c.length > 0) out.c = node.c.map(child => this.#export(child));
		return out as TspNode;
	}

	#node(id: string): DocNode {
		return this.#index.get(id) ?? fail(`unknown id ${id}`);
	}

	#unsettle(node: DocNode): void {
		if (this.#settled.size === 0) return;
		for (let at: DocNode | null = node; at; at = at.parent) this.#settled.delete(at.id);
	}

	#apply(op: TspOp): void {
		switch (op[0]) {
			case "add": {
				const [, id, parentId, before, wire] = op;
				if (wire.id !== id) fail(`add id ${id} does not match node id ${wire.id}`);
				const parent = this.#node(parentId);
				const index = this.#insertIndex(parent, before);
				const built = this.#build(wire, parent, new Set());
				parent.c.splice(index, 0, built);
				this.#register(built);
				this.#unsettle(parent);
				return;
			}
			case "set": {
				const [, id, props] = op;
				const node = this.#node(id);
				if (typeof props !== "object" || props === null || Array.isArray(props))
					fail("set props must be an object");
				for (const key in props) {
					const value = props[key];
					if (value === null) delete node.p[key];
					else if (value !== undefined) node.p[key] = value;
				}
				this.#unsettle(node);
				return;
			}
			case "text": {
				const [, id, mode, text] = op;
				const node = this.#textNode(id);
				if (typeof text !== "string") fail("text must be a string");
				if (mode === "append") node.p.text = this.#text(node) + text;
				else if (mode === "replace") node.p.text = text;
				else fail(`unknown text mode ${String(mode)}`);
				this.#unsettle(node);
				return;
			}
			case "splice": {
				const [, id, at, del, text] = op;
				const node = this.#textNode(id);
				const current = this.#text(node);
				if (!Number.isInteger(at) || !Number.isInteger(del) || at < 0 || del < 0 || at + del > current.length)
					fail(`splice range ${at}+${del} outside text of length ${current.length}`);
				node.p.text = current.slice(0, at) + text + current.slice(at + del);
				this.#unsettle(node);
				return;
			}
			case "move": {
				const [, id, parentId, before] = op;
				const node = this.#node(id);
				if (node === this.#root) fail("cannot move the root");
				const parent = this.#node(parentId);
				for (let at: DocNode | null = parent; at; at = at.parent) {
					if (at === node) fail(`cannot move ${id} into its own subtree`);
				}
				if (before === id) fail("move before itself");
				const oldParent = node.parent!;
				// Validate `before` before detaching so a rejected move leaves the tree intact.
				if (before !== null && this.#index.get(before)?.parent !== parent)
					fail(`${before} is not a child of ${parentId}`);
				oldParent.c.splice(oldParent.c.indexOf(node), 1);
				parent.c.splice(this.#insertIndex(parent, before), 0, node);
				node.parent = parent;
				this.#unsettle(oldParent);
				this.#unsettle(node);
				return;
			}
			case "del": {
				const [, id] = op;
				const node = this.#node(id);
				if (node === this.#root) fail("cannot delete the root");
				const parent = node.parent!;
				parent.c.splice(parent.c.indexOf(node), 1);
				this.#unregister(node);
				this.#unsettle(parent);
				return;
			}
			case "settle": {
				const [, id] = op;
				this.#node(id);
				this.#settled.add(id);
				return;
			}
			case "focus": {
				const [, id] = op;
				if (id !== null) this.#node(id);
				this.#focus = id;
				return;
			}
			case "reveal":
			case "scroll": {
				const [, id] = op;
				this.#node(id);
				return;
			}
			case "suspend":
				this.#suspended = true;
				return;
			case "resume":
				this.#suspended = false;
				return;
			default:
				fail(`unknown op ${String((op as readonly unknown[])[0])}`);
		}
	}

	#textNode(id: string): DocNode {
		const node = this.#node(id);
		if (!TEXT_KINDS.has(node.k)) fail(`${id} (${node.k}) has no primary text`);
		return node;
	}

	#text(node: DocNode): string {
		return typeof node.p.text === "string" ? node.p.text : "";
	}

	#insertIndex(parent: DocNode, before: string | null): number {
		if (before === null) return parent.c.length;
		const sibling = this.#index.get(before);
		if (!sibling || sibling.parent !== parent) fail(`${before} is not a child of ${parent.id}`);
		return parent.c.indexOf(sibling);
	}

	#build(wire: TspNode, parent: DocNode, seen: Set<string>): DocNode {
		if (typeof wire.id !== "string" || wire.id.length === 0) fail("node without id");
		if (!KINDS.has(wire.k)) fail(`unknown kind ${String(wire.k)}`);
		if (this.#index.has(wire.id) || seen.has(wire.id)) fail(`duplicate id ${wire.id}`);
		seen.add(wire.id);
		const node: DocNode = { id: wire.id, k: wire.k, p: {}, c: [], parent };
		if (wire.p) {
			for (const key in wire.p) {
				const value = (wire.p as Record<string, unknown>)[key];
				if (value !== undefined && value !== null) node.p[key] = value;
			}
		}
		if (wire.c) for (const child of wire.c) node.c.push(this.#build(child, node, seen));
		return node;
	}

	#register(node: DocNode): void {
		this.#index.set(node.id, node);
		for (const child of node.c) this.#register(child);
	}

	#unregister(node: DocNode): void {
		this.#index.delete(node.id);
		this.#settled.delete(node.id);
		if (this.#focus === node.id) this.#focus = null;
		for (const child of node.c) this.#unregister(child);
	}
}
