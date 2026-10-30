import nativesNotices from "@oh-my-pi/pi-natives/THIRD-PARTY-NOTICES.txt" with { type: "text" };
import license from "../../LICENSE" with { type: "text" };
import cliNotices from "../../THIRD-PARTY-NOTICES.txt" with { type: "text" };

/**
 * `omp --license` output: the OMP license, then the notices of the two components the executable embeds — the CLI
 * and the native addon.
 */
export function formatLicenseOutput(): string {
	const sections = [license, cliNotices, nativesNotices].map(text => text.trimEnd());
	return `OMP License and Third-Party Notices\n\n${sections.join("\n\n")}\n`;
}
