import { parseZedCredentials, ZED_APP_VERSION, ZED_CLOUD_URL, ZED_HEADERS } from "@oh-my-pi/pi-catalog/wire/zed";
import type {
	CredentialRankingStrategy,
	UsageFetchContext,
	UsageFetchParams,
	UsageLimit,
	UsageProvider,
	UsageReport,
} from "../usage";

export async function fetchZedUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
	const rawKey = params.credential.apiKey ?? params.credential.accessToken ?? "";
	const parsed = parseZedCredentials(rawKey);
	const userId = parsed.userId || params.credential.accountId;
	const accessToken = parsed.accessToken;

	if (!userId || !accessToken) return null;

	try {
		const response = await ctx.fetch(`${ZED_CLOUD_URL}/client/users/me`, {
			method: "GET",
			headers: {
				Authorization: `${userId} ${accessToken}`,
				"Content-Type": "application/json",
				[ZED_HEADERS.VERSION]: ZED_APP_VERSION,
			},
			signal: params.signal,
		});

		if (!response.ok) return null;

		const limits: UsageLimit[] = [];

		return {
			provider: "zed-agent",
			fetchedAt: Date.now(),
			limits,
		};
	} catch {
		return null;
	}
}

export const zedUsageProvider: UsageProvider = {
	id: "zed-agent",
	fetchUsage: fetchZedUsage,
	supports: params => params.provider === "zed-agent",
};

export const zedRankingStrategy: CredentialRankingStrategy = {
	findWindowLimits(report) {
		return { primary: report.limits[0] };
	},
	windowDefaults: {
		primaryMs: 30 * 24 * 3600 * 1000,
		secondaryMs: 30 * 24 * 3600 * 1000,
	},
};
