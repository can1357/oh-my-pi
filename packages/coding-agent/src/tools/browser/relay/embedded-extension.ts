// Always null on disk. Binary and npm bundle builds replace this module in memory with the generated extension
// (scripts/embed-relay-extension.ts); a source checkout reads `extension.generated.json` instead (extension-files.ts).
import type { RelayExtensionBundle } from "./extension-files";

/** The omp extension compiled into this build; null when running from source. */
export const embeddedRelayExtension: RelayExtensionBundle | null = null;
