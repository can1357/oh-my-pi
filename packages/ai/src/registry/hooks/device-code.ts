/**
 * Hooks referenced by `login "device-code"` rules: fingerprint headers,
 * discovered endpoints and post-exchange identity steps.
 */
import type { AfterExchangeHook, HeadersHook, Lazy, ValueHook } from "./types";

export const DEVICE_CODE_HEADERS_HOOKS: Record<string, Lazy<HeadersHook>> = {
	"kimi-fingerprint": () => import("../oauth/kimi").then(module => module.getKimiCommonHeaders),
};
export const DEVICE_CODE_VALUE_HOOKS: Record<string, Lazy<ValueHook>> = {
	"xai-token-endpoint": () => import("../oauth/xai-oauth").then(module => module.getXAITokenEndpoint),
};
export const DEVICE_CODE_AFTER_EXCHANGE_HOOKS: Record<string, Lazy<AfterExchangeHook>> = {};
