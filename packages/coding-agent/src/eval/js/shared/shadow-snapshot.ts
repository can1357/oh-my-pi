/**
 * Which mutable global intrinsics still have their original identity.
 *
 * A retained cell can replace e.g. `String` with an arbitrary value; the shadow
 * projector models `String(...)`/`JSON.stringify(...)`/`Array.prototype.join`
 * calls as pure transforms only for names flagged intact here, so speculation
 * never performs I/O from a branch the real cell cannot reach.
 */
export type ShadowInitialGlobals = Readonly<{
	String: boolean;
	JSON: boolean;
	"JSON.stringify": boolean;
	"Array.prototype.join": boolean;
	/**
	 * Whether `Object.prototype.toString` still has its original identity.
	 * Implicit string coercion (templates, `+`) dispatches it for objects
	 * (including arrays containing objects); a retained replacement changes
	 * authoritative paths while leaving no snapshot trace. Absent only for
	 * hand-built snapshots, where the intrinsic is assumed intact.
	 */
	"Object.prototype.toString"?: boolean;
	/**
	 * Whether the prelude tool bridge dispatcher still has its installed
	 * identity. The proxy resolves `__omp_call_tool__` per call, so the flag
	 * must track this binding; it also joins the snapshot digest, invalidating
	 * plans if the installation ever changes under them. Absent only for
	 * hand-built snapshots, where the bridge is assumed intact.
	 */
	__omp_call_tool__?: boolean;
}>;

export type ShadowSnapshot = Readonly<{
	revision: number;
	values: Readonly<Record<string, unknown>>;
	initialGlobals: ShadowInitialGlobals;
}>;

/**
 * Pure digest for a JS shadow snapshot; kept out of `./runtime` so host-side
 * speculation/context-manager startup does not eagerly evaluate `node:vm` or
 * `node:util` inspect.
 */
export function shadowSnapshotDigest(snapshot: ShadowSnapshot): string {
	// Intrinsic-identity flags participate: an async `globalThis.String = null` that
	// lands after planning changes no value and bumps no revision, so a
	// values-only digest would still match at verify time while projections made
	// against the builtin no longer describe the cell. The template conversion
	// avoids the mutable `String` global this function itself must survive.
	return `${Bun.hash(JSON.stringify({ values: snapshot.values, initialGlobals: snapshot.initialGlobals }))}`;
}
