import { hostMatchesUrl } from "@oh-my-pi/pi-catalog/hosts";

/** Provider metadata needed to resolve append-only context mode. */
export interface AppendOnlyContextModel {
	provider: string;
	baseUrl: string;
	/** Verbatim sparse compat config (explicit user intent), never the resolved record. */
	compatConfig?: object;
}

/**
 * Local model servers (Ollama, LM Studio, llama.cpp, vLLM, sglang, …) all
 * rely on llama.cpp-style prefix KV-cache reuse: identical leading tokens
 * skip re-prefill on the next request. Append-only mode is the only way to
 * guarantee byte-stable bytes across turns, since the live system prompt,
 * tool catalogue, and message log all flow through fresh allocations every
 * step (see `agent-loop.ts` `streamAssistantResponse` fallback path).
 */
const LOCAL_INFERENCE_PROVIDERS = new Set(["ollama", "ollama-cloud", "lm-studio", "llama.cpp"]);

/** True when `baseUrl` resolves to a loopback or RFC1918 host — covers
 * llama.cpp/vLLM/sglang servers registered under a user-defined provider id
 * via `models.yaml`. Built-in local provider ids (`ollama`, `lm-studio`,
 * `llama.cpp`) are already handled by `LOCAL_INFERENCE_PROVIDERS`.
 * Substring match on the parsed hostname only; ports, paths, and unparseable
 * URLs return false.
 */
function hasLocalLoopbackBaseUrl(baseUrl: string | undefined): boolean {
	if (!baseUrl) return false;
	let hostname: string;
	try {
		hostname = new URL(baseUrl).hostname.toLowerCase();
	} catch {
		return false;
	}
	if (
		hostname === "localhost" ||
		hostname === "127.0.0.1" ||
		hostname === "0.0.0.0" ||
		hostname === "::1" ||
		hostname === "[::1]"
	) {
		return true;
	}
	// RFC1918 private IPv4 ranges.
	if (hostname.startsWith("10.")) return true;
	if (hostname.startsWith("192.168.")) return true;
	if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(hostname)) return true;
	// Common ".local" mDNS hostnames used for home-LAN llama.cpp boxes.
	if (hostname.endsWith(".local")) return true;
	return false;
}

function shouldAutoEnableAppendOnlyContext(model: AppendOnlyContextModel | null | undefined): boolean {
	if (!model) return false;
	if (model.provider === "deepseek") return true;
	if (LOCAL_INFERENCE_PROVIDERS.has(model.provider)) return true;
	if (hostMatchesUrl(model.baseUrl, "xiaomi")) return true;
	if (hasLocalLoopbackBaseUrl(model.baseUrl)) return true;
	return !!model.compatConfig && "supportsStore" in model.compatConfig && model.compatConfig.supportsStore === true;
}

/** Resolves whether append-only context should be active for a model and setting. */
export function shouldEnableAppendOnlyContext(
	setting: "auto" | "on" | "off" | undefined,
	model: AppendOnlyContextModel | null | undefined,
): boolean {
	switch (setting ?? "auto") {
		case "on":
			return true;
		case "off":
			return false;
		default:
			return shouldAutoEnableAppendOnlyContext(model);
	}
}
