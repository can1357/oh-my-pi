/**
 * Whole-flow hooks: `login "custom" hook=…` and `refresh hook=…` for providers
 * whose flow is not expressible in the declarative grammar.
 */
import { loginGrokbotHook } from "../grokbot";
import type { Lazy, LoginHook, RefreshHook } from "./types";

export const CUSTOM_LOGIN_HOOKS: Record<string, Lazy<LoginHook>> = {
	"github-copilot": () => import("../oauth/github-copilot").then(module => module.loginGitHubCopilotHook),
	cursor: () => import("../oauth/cursor").then(module => module.loginCursorHook),
	// Top-level import keeps AGENTS.md's no-inline-import rule; Lazy still defers
	// invoking the hook until login runs.
	grokbot: () => Promise.resolve(loginGrokbotHook),
	perplexity: () => import("../oauth/perplexity").then(module => module.loginPerplexity),
};
export const CUSTOM_REFRESH_HOOKS: Record<string, Lazy<RefreshHook>> = {
	"github-copilot": () => import("../oauth/github-copilot").then(module => module.refreshGitHubCopilotHook),
	cursor: () => import("../oauth/cursor").then(module => module.refreshCursorHook),
};
