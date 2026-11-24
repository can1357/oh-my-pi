import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";

/** Offline quota reports for testing the real Usage sheet with more rows than fit in a short pane. */
export default function ternUsage(pi: ExtensionAPI): void {
	for (const provider of ["fixture-north", "fixture-south", "fixture-east", "fixture-west"]) {
		pi.registerProvider(provider, {
			apiKey: "unused",
			usage: {
				id: provider,
				async fetchUsage() {
					return {
						provider,
						fetchedAt: Date.now(),
						limits: ["Hourly", "Daily", "Weekly"].map((label, i) => ({
							id: label.toLowerCase(),
							label,
							scope: { provider },
							window: { id: label, label },
							amount: { used: i + 1, limit: 4, usedFraction: (i + 1) / 4, unit: "requests" },
						})),
					};
				},
			},
		});
	}
}
