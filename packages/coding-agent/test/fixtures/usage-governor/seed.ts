import * as fs from "node:fs";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import type { FakeAccountSpec } from "./fake-provider";

/** Access tokens are fake and never expire; a refresh would be a defect (see govplan-extension). */
const FAKE_EXPIRY_MS = 24 * 60 * 60_000;

/**
 * Seed OAuth rows for the fake accounts into `<agentDir>/agent.db` through `AuthStorage`, so the
 * child reads them exactly as it would a real login. Opens and closes its own storage handle.
 */
export async function seedAuthDb(agentDir: string, accounts: readonly FakeAccountSpec[], nowMs = Date.now()) {
	fs.mkdirSync(agentDir, { recursive: true });
	const storage = await AuthStorage.create(path.join(agentDir, "agent.db"));
	try {
		for (const account of accounts) {
			await storage.credentials.upsert(account.provider, {
				type: "oauth",
				access: account.bearer,
				refresh: `fake-refresh-${account.label}`,
				expires: nowMs + FAKE_EXPIRY_MS,
				accountId: account.accountId,
				email: account.email,
			});
		}
	} finally {
		storage.close();
	}
}

/** Settings for one scenario. The file is JSON, which is valid YAML, as the sibling CLI test writes it. */
export interface ScenarioSettings {
	/** `usageGovernor.enabled`; the control scenario turns it off. */
	enabled: boolean;
	/** `usageGovernor.interactiveReserve`; omitted to exercise the default. */
	interactiveReserve?: "hold" | "spend";
}

/** Writes the scenario config: `usageGovernor.leadPct` is left unset so the default applies. */
export function writeScenarioConfig(agentDir: string, settings: ScenarioSettings): void {
	fs.mkdirSync(agentDir, { recursive: true });
	const usageGovernor: Record<string, unknown> = { enabled: settings.enabled };
	if (settings.interactiveReserve !== undefined) usageGovernor.interactiveReserve = settings.interactiveReserve;
	const config = {
		usageGovernor,
		modelRoles: { default: "govplan/m", task: "govplan-g/m" },
		retry: {
			usageReservePct: 10,
			fallbackChains: { default: ["govplan/m2"] },
		},
		compaction: { enabled: false },
	};
	fs.writeFileSync(path.join(agentDir, "config.yml"), JSON.stringify(config, null, 2));
}
