/**
 * A canonical JSON tree. This lives in the presentation leaf because both
 * presentation payloads and hook-owned arguments cross untyped boundaries.
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
