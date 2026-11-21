// Always null on disk. Binary and npm bundle builds replace this module in memory with a lazy `$bunfs`/asset file
// path (scripts/embed-relay-extension.ts); a source checkout reads `extension.generated.json` instead (extension-files.ts).

/** Path to the zstd-compressed omp extension embedded in this build; null when running from source. */
export const embeddedRelayExtensionZstPath: string | null = null;
