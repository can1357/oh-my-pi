/**
 * Hook registry consulted by the login engines. Each domain file owns the
 * hooks its rule kind references; this module only merges them.
 */
import { API_KEY_HEADERS_HOOKS, API_KEY_LOGIN_HOOKS } from "./api-key";
import { CUSTOM_LOGIN_HOOKS, CUSTOM_REFRESH_HOOKS } from "./custom";
import { DEVICE_CODE_AFTER_EXCHANGE_HOOKS, DEVICE_CODE_HEADERS_HOOKS, DEVICE_CODE_VALUE_HOOKS } from "./device-code";
import { ENV_HOOKS } from "./env";
import { OAUTH_CODE_AFTER_EXCHANGE_HOOKS, OAUTH_CODE_LOGIN_HOOKS, OAUTH_CODE_VALUE_HOOKS } from "./oauth-code";
import type { HookTables } from "./types";

export const HOOKS: HookTables = {
	env: ENV_HOOKS,
	headers: { ...API_KEY_HEADERS_HOOKS, ...DEVICE_CODE_HEADERS_HOOKS },
	value: { ...OAUTH_CODE_VALUE_HOOKS, ...DEVICE_CODE_VALUE_HOOKS },
	login: { ...API_KEY_LOGIN_HOOKS, ...OAUTH_CODE_LOGIN_HOOKS, ...CUSTOM_LOGIN_HOOKS },
	refresh: CUSTOM_REFRESH_HOOKS,
	afterExchange: { ...OAUTH_CODE_AFTER_EXCHANGE_HOOKS, ...DEVICE_CODE_AFTER_EXCHANGE_HOOKS },
};

export type * from "./types";
