import { Settings } from "../../src/config/settings";
import { loadLegacyPiModule } from "../../src/extensibility/plugins/legacy-pi-compat";

const entryPath = process.argv[2];
if (!entryPath) throw new Error("usage: legacy-pi-require-cache-clear-probe <entry>");

await Settings.init({ inMemory: true });
const extension = (await loadLegacyPiModule(entryPath)) as { cleared: boolean };
// A host module imported after the extension loaded, like the lazily imported interactive mode.
const { isSettingsInitialized } = await import("../../src/config/settings");
process.stdout.write(
	`${JSON.stringify({ cleared: extension.cleared, settingsInitialized: isSettingsInitialized() })}\n`,
);
