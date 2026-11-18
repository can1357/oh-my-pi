import type { DisasmBackendId } from "./backend";
import type { DisasmDatabase } from "./client";
import type { RetainedReference } from "./protocol";

/** Session-owned disassembler references; symbol keys do not enter tool schemas or serialized context. */
export const DSM_REFERENCES = Symbol("dsm.references");

interface OwnedReference {
	backend: DisasmBackendId;
	db: DisasmDatabase;
	reference: RetainedReference;
}

/** Lifetime state shared by one agent's JavaScript/Python dsm facades, never by its children. */
export interface DsmReferenceOwner {
	references: Map<string, OwnedReference>;
	pending: Set<Promise<unknown>>;
	generation: number;
	disposed: boolean;
	cleanup: Promise<void>;
	unregister: (() => void)[];
}
