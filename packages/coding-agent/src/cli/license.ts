import rootLicense from "../tools/browser/relay/extension-assets/LICENSE.txt" with { type: "text" };
import thirdPartyNotices from "../tools/browser/relay/extension-assets/THIRD-PARTY-NOTICES.txt" with { type: "text" };

export function formatLicenseOutput(): string {
	return `OMP License and Third-Party Notices\n\n${rootLicense.trimEnd()}\n\n${thirdPartyNotices.trimEnd()}\n`;
}
