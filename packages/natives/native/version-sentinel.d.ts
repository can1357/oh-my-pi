/** Prefix of the post-link stamp slot linked into every addon. */
export const VERSION_STAMP_MAGIC: string;

/** Total stamp slot size in bytes: magic, version, NUL padding. */
export const VERSION_STAMP_SIZE: number;

/** Check whether addon bytes carry the stamp for exactly `version`. */
export function containsVersionStamp(bytes: Uint8Array, version: string): boolean;

/** Release a loaded addon reports (stamp, or legacy `__piNativesV*` export), or `null`. */
export function bindingsReleaseVersion(bindings: Record<string, unknown>): string | null;

/** True when the bindings identify their release at all (stamp reader or legacy sentinel). */
export function bindingsHaveReleaseIdentity(bindings: Record<string, unknown>): boolean;
