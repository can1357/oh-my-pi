/** Return the native-addon export expected for a package version. */
export function versionSentinelFor(packageVersion: string): string;

/** Check whether addon bytes contain the exact expected version sentinel. */
export function containsVersionSentinel(bytes: Buffer, expected: string): boolean;
