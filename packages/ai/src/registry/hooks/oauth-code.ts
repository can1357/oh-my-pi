/**
 * Hooks referenced by `login "oauth-code"` rules: post-exchange identity /
 * provisioning steps and runtime-resolved values.
 */
import type { AfterExchangeHook, Lazy, LoginHook, ValueHook } from "./types";

// Each loader imports its provider module on first use, so a sign-in loads only that provider's hook.
export const OAUTH_CODE_AFTER_EXCHANGE_HOOKS: Record<string, Lazy<AfterExchangeHook>> = {
	"anthropic-identity": () => import("../oauth/anthropic").then(m => m.anthropicIdentityHook),
	"devin-identity": () => import("../oauth/devin").then(m => m.devinIdentityHook),
	"gitlab-duo-clear-cache": () => import("../oauth/gitlab-duo").then(m => m.gitLabDuoClearCacheHook),
	"openai-codex-profile": () => import("../oauth/openai-codex").then(m => m.openAICodexProfileHook),
	"zai-mint-key": () => import("../oauth/zai").then(m => m.zaiMintKeyHook),
	"google-antigravity-project": () => import("../oauth/google-antigravity").then(m => m.googleAntigravityProjectHook),
};
export const OAUTH_CODE_VALUE_HOOKS: Record<string, Lazy<ValueHook>> = {};
export const OAUTH_CODE_LOGIN_HOOKS: Record<string, Lazy<LoginHook>> = {
	"openai-codex-device": () => import("../oauth/openai-codex").then(m => m.loginOpenAICodexDevice),
};
