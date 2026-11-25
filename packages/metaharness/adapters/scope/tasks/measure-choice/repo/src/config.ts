import { fnv1a } from "./hash/fnv1a";
import { murmur3 } from "./hash/murmur3";

export type HashName = "fnv1a" | "murmur3";

export const HASHES: Record<HashName, (key: string) => number> = { fnv1a, murmur3 };

/** The hash `KeyTable` buckets with. */
export const DEFAULT_HASH: HashName = "murmur3";
