import { toNumber } from "@oh-my-pi/pi-catalog/utils";
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import { ProviderHttpError } from "../error";
import type {
	UsageFetchContext,
	UsageFetchParams,
	UsageLimit,
	UsageProvider,
	UsageReport,
	UsageStatus,
	UsageWindow,
} from "../usage";
import { parseIsoTimestamp } from "./shared";

const DEFAULT_BASE_URL = "https://api.venice.ai/api/v1";

function balanceLimit(args: {
	id: string;
	label: string;
	remaining: number | undefined;
	unit: "usd" | "credits";
	status: UsageStatus;
	window?: UsageWindow;
}): UsageLimit | null {
	if (args.remaining === undefined) return null;
	return {
		id: args.id,
		label: args.label,
		scope: { provider: "venice", ...(args.window ? { windowId: args.window.id } : {}) },
		amount: { remaining: args.remaining, unit: args.unit },
		status: args.status,
		...(args.window ? { window: args.window } : {}),
	};
}

async function fetchVeniceUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
	if (params.provider !== "venice") return null;
	const credential = params.credential;
	if (credential.type !== "api_key" || !credential.apiKey) return null;

	const baseUrl = (params.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
	const url = `${baseUrl}/api_keys/rate_limits`;
	let payload: unknown;
	try {
		const response = await ctx.fetch(url, {
			headers: { Authorization: `Bearer ${credential.apiKey}`, Accept: "application/json" },
			signal: params.signal,
		});
		if (response.status === 401 || response.status === 403) {
			throw new ProviderHttpError(`Venice rate limits endpoint returned ${response.status}`, response.status);
		}
		if (!response.ok) return null;
		payload = await response.json();
	} catch (error) {
		if (error instanceof ProviderHttpError) throw error;
		ctx.logger?.warn("Venice usage fetch error", { url, error: String(error) });
		return null;
	}
	if (!isRecord(payload) || !isRecord(payload.data) || !isRecord(payload.data.balances)) return null;
	const { accessPermitted, balances, apiTier, nextEpochBegins } = payload.data;
	if (typeof accessPermitted !== "boolean") return null;
	// The balances are alternative funding sources, not independent quotas.
	const status = accessPermitted ? "ok" : "exhausted";
	const epochResetsAt = parseIsoTimestamp(nextEpochBegins);
	const epochWindow: UsageWindow | undefined = epochResetsAt
		? { id: "epoch", label: "Epoch", resetsAt: epochResetsAt }
		: undefined;

	const bundled = toNumber(balances.BUNDLED_CREDITS);
	const limits = [
		balanceLimit({
			id: "venice:usd",
			label: "USD balance",
			remaining: toNumber(balances.USD),
			unit: "usd",
			status,
		}),
		balanceLimit({
			id: "venice:diem-credits:epoch",
			label: "DIEM balance",
			remaining: toNumber(balances.DIEM),
			unit: "credits",
			status,
			window: epochWindow,
		}),
		bundled !== undefined && bundled > 0
			? balanceLimit({
					id: "venice:bundled-credits",
					label: "Bundled credits",
					remaining: bundled,
					unit: "usd",
					status,
				})
			: null,
	].filter(limit => limit !== null);

	if (limits.length === 0) return null;

	const tierId = isRecord(apiTier) ? apiTier.id : undefined;
	const metadata: Record<string, unknown> = { endpoint: url };
	if (typeof tierId === "string" && tierId) metadata.apiTier = tierId;

	return {
		provider: params.provider,
		fetchedAt: Date.now(),
		limits,
		metadata,
		raw: payload,
	};
}

export const veniceUsageProvider: UsageProvider = {
	id: "venice",
	fetchUsage: fetchVeniceUsage,
	supports: params => params.provider === "venice" && params.credential.type === "api_key",
	validatesCredentials: true,
};
