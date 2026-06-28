/**
 * A UUID-shaped string: five hex groups in the canonical 8-4-4-4-12 layout.
 *
 * NOT a spec-compliant RFC 4122 UUID — the version/variant nibbles are left as
 * raw hash output — but the shape passes everywhere a UUID string is expected.
 */
export type DeterministicUuid = `${string}-${string}-${string}-${string}-${string}`;

/**
 * Format the leading 128 bits of `seed`'s SHA-256 digest as a v4-shape UUID
 * (8-4-4-4-12 hex groups).
 *
 * Deterministic: identical seeds always map to the same id, so callers get
 * stable ids across requests / conversation turns (reusing message-blob ids,
 * keying prompt caches) without persisting a seed→id mapping.
 */
export function deterministicUuid(seed: string): DeterministicUuid {
	const hex = new Bun.CryptoHasher("sha256").update(seed).digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
