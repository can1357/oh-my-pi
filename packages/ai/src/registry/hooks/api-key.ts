/**
 * Hooks referenced by API-key style rules: `headers-hook` resolvers for
 * `validate "models-endpoint"` probes needing computed headers, and
 * `login "custom"` flows that paste keys but need region/endpoint prompts.
 */
import type { HeadersHook, Lazy, LoginHook } from "./types";

export const API_KEY_HEADERS_HOOKS: Record<string, Lazy<HeadersHook>> = {
	"coreweave-project": () => import("../oauth/coreweave").then(m => m.requireCoreWeaveProjectHeaders),
	"cline-pass-client": () => import("@oh-my-pi/pi-catalog/wire/cline-pass").then(m => m.clinePassClientHeaders),
};

export const API_KEY_LOGIN_HOOKS: Record<string, Lazy<LoginHook>> = {
	"alibaba-coding-plan": () => import("../oauth/alibaba-coding-plan").then(m => m.loginAlibabaCodingPlan),
	"alibaba-token-plan": () => import("../oauth/alibaba-token-plan").then(m => m.loginAlibabaTokenPlan),
	"cloudflare-ai-gateway": () => import("../oauth/cloudflare-ai-gateway").then(m => m.loginCloudflareAiGateway),
	kilo: () => import("../oauth/kilo").then(m => m.loginKilo),
	xiaomi: () => import("../oauth/xiaomi").then(m => m.loginXiaomi),
};
