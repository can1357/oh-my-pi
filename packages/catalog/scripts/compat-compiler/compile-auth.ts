/**
 * Compiles `rules/auth/*.kdl` into {@link CompiledAuth}: one `auth "<id>"`
 * node per provider describing display metadata, env-var fallbacks and the
 * declarative login / refresh flow interpreted by `@oh-my-pi/pi-ai`'s
 * registry engines. `auth/_order.kdl` pins `/login` display order.
 */
import type {
	CompiledApiKeyLogin,
	CompiledAuth,
	CompiledAuthProvider,
	CompiledAuthValidation,
	CompiledAuthValue,
	CompiledCallback,
	CompiledCredentialExpiry,
	CompiledCredentialField,
	CompiledCredentialMap,
	CompiledDeviceCodeLogin,
	CompiledLogin,
	CompiledOAuthCodeLogin,
	CompiledOAuthRequest,
	CompiledRefresh,
	CompiledUserinfo,
} from "../../src/compat/types";
import {
	CompatCompileError,
	type KdlNodeView,
	malformed,
	parseKdl,
	positionalStrings,
	propBool,
	propInt,
	propString,
	requiredProp,
	unexpected,
	validateProps,
} from "./kdl-reader";

const ORDER_FILE = "auth/_order.kdl";
const HOOK_NAME = /^[a-z0-9][a-z0-9-]*$/;
const CREDENTIAL_FIELDS = {
	email: "email",
	"account-id": "accountId",
	"org-id": "orgId",
	"org-name": "orgName",
	"project-id": "projectId",
	"api-endpoint": "apiEndpoint",
	"enterprise-url": "enterpriseUrl",
} as const;
const DEFAULT_SKEW_MS = 5 * 60 * 1000;

function children(node: KdlNodeView, properties: readonly string[]): KdlNodeView[] {
	validateProps(node, properties);
	if (!node.children) malformed(node);
	return node.children;
}

function leaf(node: KdlNodeView, properties: readonly string[]): void {
	validateProps(node, properties);
	if (node.children) malformed(node);
}

function singleString(node: KdlNodeView): string {
	const values = positionalStrings(node);
	if (values.length !== 1 || !values[0]) malformed(node);
	return values[0];
}

function singleBool(node: KdlNodeView): boolean {
	leaf(node, []);
	if (node.args.length !== 1 || typeof node.args[0] !== "boolean") malformed(node);
	return node.args[0];
}

function singleInt(node: KdlNodeView): number {
	leaf(node, []);
	const value = node.args[0];
	if (node.args.length !== 1 || typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		malformed(node);
	return value;
}

function hookName(node: KdlNodeView, name: string): string {
	const value = requiredProp(node, name);
	if (!HOOK_NAME.test(value)) malformed(node, `${node.name} ${name}`);
	return value;
}

/**
 * Reads a `CompiledAuthValue` node: `name "literal" env="VAR" encoding="base64"`
 * or `name hook="resolver"`; child `env "A" "B"` declares an ordered env list.
 */
function authValue(node: KdlNodeView, extraProps: readonly string[] = []): CompiledAuthValue {
	validateProps(node, ["env", "encoding", "hook", ...extraProps]);
	const result: CompiledAuthValue = {};
	const hook = propString(node, "hook");
	if (hook !== undefined) {
		if (!HOOK_NAME.test(hook) || node.args.length > 0) malformed(node);
		result.hook = hook;
	} else {
		result.value = singleString(node);
	}
	const encoding = propString(node, "encoding");
	if (encoding !== undefined) {
		if (encoding !== "base64" || result.hook) malformed(node);
		result.encoding = "base64";
	}
	const env: string[] = [];
	const envProp = propString(node, "env");
	if (envProp !== undefined) {
		if (!envProp) malformed(node);
		env.push(envProp);
	}
	for (const child of node.children ?? []) {
		if (child.name !== "env") unexpected(child, node.name);
		leaf(child, []);
		const vars = positionalStrings(child);
		if (vars.length === 0 || vars.some(v => !v)) malformed(child);
		env.push(...vars);
	}
	if (env.length > 0) result.env = env;
	return result;
}

function stringMap(node: KdlNodeView): Record<string, string> {
	const map: Record<string, string> = {};
	for (const child of children(node, [])) {
		leaf(child, []);
		if (child.name in map) malformed(child);
		const values = positionalStrings(child);
		if (values.length !== 1) malformed(child);
		map[child.name] = values[0];
	}
	return map;
}

/** `token url="…" body="form" standard=#false timeout-ms=N { params {…}; headers {…} }` */
function request(node: KdlNodeView, defaults?: Partial<CompiledOAuthRequest>): CompiledOAuthRequest {
	validateProps(node, ["url", "url-env", "url-hook", "body", "standard", "timeout-ms"]);
	if (node.args.length > 0) malformed(node);
	let url = defaults?.url;
	const urlProp = propString(node, "url");
	const urlHook = propString(node, "url-hook");
	const urlEnv = propString(node, "url-env");
	if (urlHook !== undefined) {
		if (urlProp !== undefined || !HOOK_NAME.test(urlHook)) malformed(node);
		url = { hook: urlHook };
	} else if (urlProp !== undefined) {
		if (!urlProp) malformed(node);
		url = { value: urlProp };
	}
	if (urlEnv !== undefined) {
		if (!url || !urlEnv) malformed(node);
		url = { ...url, env: [urlEnv] };
	}
	if (!url) malformed(node, `${node.name} url`);
	const body = propString(node, "body") ?? defaults?.body ?? "form";
	if (body !== "form" && body !== "json") malformed(node);
	const result: CompiledOAuthRequest = {
		url,
		body,
		standard: propBool(node, "standard") ?? true,
		params: {},
		headers: {},
	};
	const timeout = propInt(node, "timeout-ms");
	if (timeout !== undefined) result.timeoutMs = timeout;
	for (const child of node.children ?? []) {
		switch (child.name) {
			case "params":
				result.params = stringMap(child);
				break;
			case "headers":
				result.headers = stringMap(child);
				break;
			default:
				unexpected(child, node.name);
		}
	}
	return result;
}

function credentialField(node: KdlNodeView): CompiledCredentialField {
	validateProps(node, ["claim", "literal"]);
	if (node.children) malformed(node);
	const field: CompiledCredentialField = {};
	if (node.args.length > 0) field.path = singleString(node);
	const literal = propString(node, "literal");
	if (literal !== undefined) field.literal = literal;
	const claim = propString(node, "claim");
	if (claim !== undefined) {
		const claims = claim
			.split("|")
			.map(c => c.trim())
			.filter(Boolean);
		if (claims.length === 0) malformed(node);
		field.claim = claims;
	}
	if (field.path === undefined && field.literal === undefined && !field.claim) malformed(node);
	return field;
}

function expiry(node: KdlNodeView): CompiledCredentialExpiry {
	validateProps(node, ["path", "from", "skew-ms", "fallback-ms"]);
	if (node.children) malformed(node);
	const mode = singleString(node);
	const skewMs = propInt(node, "skew-ms") ?? DEFAULT_SKEW_MS;
	switch (mode) {
		case "seconds": {
			const result: CompiledCredentialExpiry = { mode, path: propString(node, "path") ?? "expires_in", skewMs };
			const from = propString(node, "from");
			if (from !== undefined) {
				if (!from) malformed(node);
				result.fromPath = from;
			}
			return result;
		}
		case "jwt": {
			const result: CompiledCredentialExpiry = { mode, skewMs };
			const fallback = propInt(node, "fallback-ms");
			if (fallback !== undefined) result.fallbackMs = fallback;
			return result;
		}
		case "never":
			if (node.props.length > 0) malformed(node);
			return { mode };
		default:
			return malformed(node);
	}
}

/** `credential { access "access_token"; refresh "refresh_token"; expires "seconds"; … }` */
function credentialMap(node: KdlNodeView | undefined, base?: CompiledCredentialMap): CompiledCredentialMap {
	const map: CompiledCredentialMap = base
		? structuredClone(base)
		: {
				access: { path: "access_token" },
				refresh: { path: "refresh_token" },
				expires: { mode: "seconds", path: "expires_in", skewMs: DEFAULT_SKEW_MS },
			};
	if (!node) return map;
	const seen = new Set<string>();
	for (const child of children(node, [])) {
		if (seen.has(child.name)) malformed(child);
		seen.add(child.name);
		switch (child.name) {
			case "access":
				map.access = credentialField(child);
				break;
			case "refresh":
				map.refresh = credentialField(child);
				break;
			case "expires":
				map.expires = expiry(child);
				break;
			default: {
				const key = CREDENTIAL_FIELDS[child.name as keyof typeof CREDENTIAL_FIELDS];
				if (!key) unexpected(child, "credential");
				map[key] = credentialField(child);
			}
		}
	}
	return map;
}

function userinfo(node: KdlNodeView): CompiledUserinfo {
	leaf(node, ["url", "email", "account-id"]);
	if (node.args.length > 0) malformed(node);
	const result: CompiledUserinfo = { url: requiredProp(node, "url") };
	const email = propString(node, "email");
	if (email !== undefined) result.email = email;
	const accountId = propString(node, "account-id");
	if (accountId !== undefined) result.accountId = accountId;
	if (!result.url || (!result.email && !result.accountId)) malformed(node);
	return result;
}

function scopes(node: KdlNodeView): { scopes: string[]; separator: string } {
	leaf(node, ["separator"]);
	const values = positionalStrings(node);
	if (values.some(v => !v)) malformed(node);
	const separator = propString(node, "separator") ?? " ";
	if (!separator) malformed(node);
	return { scopes: values, separator };
}

function validation(node: KdlNodeView): CompiledAuthValidation {
	const kind = singleString(node);
	const optional = propBool(node, "optional");
	const label = propString(node, "label");
	const common = { ...(label !== undefined ? { label } : {}), ...(optional ? { optional } : {}) };
	switch (kind) {
		case "chat-completions": {
			leaf(node, [
				"base-url",
				"model",
				"label",
				"tolerate-model-denied",
				"max-tokens-field",
				"max-tokens",
				"optional",
			]);
			const result: CompiledAuthValidation = {
				kind,
				...common,
				baseUrl: requiredProp(node, "base-url"),
				model: requiredProp(node, "model"),
			};
			const tolerate = propBool(node, "tolerate-model-denied");
			if (tolerate !== undefined) result.tolerateModelDenied = tolerate;
			const field = propString(node, "max-tokens-field");
			if (field !== undefined) {
				if (field !== "max_tokens" && field !== "max_completion_tokens") malformed(node);
				result.maxTokensField = field;
			}
			const maxTokens = propInt(node, "max-tokens");
			if (maxTokens !== undefined) result.maxTokens = maxTokens;
			return result;
		}
		case "anthropic-messages":
			leaf(node, ["base-url", "model", "label", "optional"]);
			return { kind, ...common, baseUrl: requiredProp(node, "base-url"), model: requiredProp(node, "model") };
		case "models-endpoint": {
			leaf(node, ["url", "base-url-env", "headers-hook", "label", "optional"]);
			const result: CompiledAuthValidation = { kind, ...common, url: requiredProp(node, "url") };
			const baseUrlEnv = propString(node, "base-url-env");
			if (baseUrlEnv !== undefined) result.baseUrlEnv = baseUrlEnv;
			if (propString(node, "headers-hook") !== undefined) result.headersHook = hookName(node, "headers-hook");
			return result;
		}
		default:
			return malformed(node);
	}
}

function apiKeyLogin(node: KdlNodeView): CompiledApiKeyLogin {
	const login: Partial<CompiledApiKeyLogin> = { kind: "api-key" };
	const seen = new Set<string>();
	for (const child of children(node, [])) {
		if (seen.has(child.name)) malformed(child);
		seen.add(child.name);
		switch (child.name) {
			case "auth-url":
				leaf(child, []);
				login.authUrl = singleString(child);
				break;
			case "instructions":
				leaf(child, []);
				login.instructions = singleString(child);
				break;
			case "prompt": {
				leaf(child, ["placeholder"]);
				login.prompt = singleString(child);
				const placeholder = propString(child, "placeholder");
				if (placeholder !== undefined) login.placeholder = placeholder;
				break;
			}
			case "empty-fallback":
				leaf(child, []);
				if (child.args.length !== 1 || typeof child.args[0] !== "string") malformed(child);
				login.emptyFallback = child.args[0];
				break;
			case "normalize":
				leaf(child, []);
				if (singleString(child) !== "strip-bearer") malformed(child);
				login.normalize = "strip-bearer";
				break;
			case "validate":
				login.validate = validation(child);
				break;
			default:
				unexpected(child, "login api-key");
		}
	}
	if (!login.prompt) malformed(node, "login api-key prompt");
	if ((login.authUrl === undefined) !== (login.instructions === undefined)) malformed(node, "login api-key auth-url");
	return login as CompiledApiKeyLogin;
}

function callback(node: KdlNodeView): CompiledCallback {
	validateProps(node, [
		"port",
		"path",
		"hostname",
		"redirect-uri",
		"redirect-uri-env",
		"port-fallback",
		"manual-only",
	]);
	if (node.args.length > 0 || node.children) malformed(node);
	const port = propInt(node, "port");
	if (port === undefined) malformed(node, "callback port");
	const result: CompiledCallback = {
		port,
		path: propString(node, "path") ?? "/callback",
		hostname: propString(node, "hostname") ?? "localhost",
		portFallback: propBool(node, "port-fallback") ?? true,
		manualOnly: propBool(node, "manual-only") ?? false,
	};
	const redirectUri = propString(node, "redirect-uri");
	const redirectUriEnv = propString(node, "redirect-uri-env");
	if (redirectUri !== undefined || redirectUriEnv !== undefined) {
		result.redirectUri = {};
		if (redirectUri !== undefined) {
			if (!redirectUri) malformed(node);
			result.redirectUri.value = redirectUri;
		}
		if (redirectUriEnv !== undefined) {
			if (!redirectUriEnv) malformed(node);
			result.redirectUri.env = [redirectUriEnv];
		}
	}
	return result;
}

function oauthCodeLogin(node: KdlNodeView): CompiledOAuthCodeLogin {
	const login: Partial<CompiledOAuthCodeLogin> = {
		kind: "oauth-code",
		scopes: [],
		scopeSeparator: " ",
		pkce: false,
		state: "hex",
		standardAuthorizeParams: true,
		authorizeParams: {},
	};
	const seen = new Set<string>();
	let credentialNode: KdlNodeView | undefined;
	for (const child of children(node, [])) {
		if (seen.has(child.name)) malformed(child);
		seen.add(child.name);
		switch (child.name) {
			case "client-id":
				login.clientId = authValue(child);
				break;
			case "client-secret":
				login.clientSecret = authValue(child);
				break;
			case "authorize-url":
				login.authorizeUrl = authValue(child);
				break;
			case "scopes": {
				const parsed = scopes(child);
				login.scopes = parsed.scopes;
				login.scopeSeparator = parsed.separator;
				break;
			}
			case "pkce":
				login.pkce = singleBool(child);
				break;
			case "state": {
				leaf(child, []);
				const mode = singleString(child);
				if (mode !== "hex" && mode !== "uuid" && mode !== "none") malformed(child);
				login.state = mode;
				break;
			}
			case "authorize-params":
				validateProps(child, ["standard"]);
				login.standardAuthorizeParams = propBool(child, "standard") ?? true;
				login.authorizeParams = stringMap({ ...child, props: [] });
				break;
			case "instructions":
				leaf(child, []);
				login.instructions = singleString(child);
				break;
			case "callback":
				login.callback = callback(child);
				break;
			case "token":
				login.token = request(child);
				break;
			case "credential":
				credentialNode = child;
				break;
			case "userinfo":
				login.userinfo = userinfo(child);
				break;
			case "after-exchange":
				leaf(child, ["hook"]);
				login.afterExchange = hookName(child, "hook");
				break;
			case "paste-key":
				leaf(child, ["prefix", "validate-url"]);
				login.pasteKey = {
					prefix: requiredProp(child, "prefix"),
					validateUrl: requiredProp(child, "validate-url"),
				};
				if (!login.pasteKey.prefix || !login.pasteKey.validateUrl) malformed(child);
				break;
			default:
				unexpected(child, "login oauth-code");
		}
	}
	if (!login.authorizeUrl) malformed(node, "login oauth-code authorize-url");
	if (!login.callback) malformed(node, "login oauth-code callback");
	if (!login.token) malformed(node, "login oauth-code token");
	login.credential = credentialMap(credentialNode);
	return login as CompiledOAuthCodeLogin;
}

function deviceCodeLogin(node: KdlNodeView): CompiledDeviceCodeLogin {
	const login: Partial<CompiledDeviceCodeLogin> = { kind: "device-code", scopes: [], scopeSeparator: " " };
	const seen = new Set<string>();
	let credentialNode: KdlNodeView | undefined;
	for (const child of children(node, [])) {
		if (seen.has(child.name)) malformed(child);
		seen.add(child.name);
		switch (child.name) {
			case "client-id":
				login.clientId = authValue(child);
				break;
			case "base-url":
				login.baseUrl = authValue(child);
				break;
			case "scopes": {
				const parsed = scopes(child);
				login.scopes = parsed.scopes;
				login.scopeSeparator = parsed.separator;
				break;
			}
			case "headers-hook":
				leaf(child, []);
				login.headersHook = singleString(child);
				if (!HOOK_NAME.test(login.headersHook)) malformed(child);
				break;
			case "device":
				login.device = request(child);
				break;
			case "token":
				login.token = request(child);
				break;
			case "response": {
				leaf(child, [
					"user-code",
					"device-code",
					"verification-uri",
					"verification-uri-complete",
					"interval",
					"expires-in",
				]);
				if (child.args.length > 0) malformed(child);
				const response: CompiledDeviceCodeLogin["response"] = {
					userCode: propString(child, "user-code") ?? "user_code",
					deviceCode: propString(child, "device-code") ?? "device_code",
					verificationUri: propString(child, "verification-uri") ?? "verification_uri",
				};
				const complete = propString(child, "verification-uri-complete");
				if (complete !== undefined) response.verificationUriComplete = complete;
				const interval = propString(child, "interval");
				if (interval !== undefined) response.interval = interval;
				const expiresIn = propString(child, "expires-in");
				if (expiresIn !== undefined) response.expiresIn = expiresIn;
				login.response = response;
				break;
			}
			case "instructions":
				leaf(child, []);
				login.instructions = singleString(child);
				break;
			case "credential":
				credentialNode = child;
				break;
			case "userinfo":
				login.userinfo = userinfo(child);
				break;
			case "after-exchange":
				leaf(child, ["hook"]);
				login.afterExchange = hookName(child, "hook");
				break;
			default:
				unexpected(child, "login device-code");
		}
	}
	if (!login.clientId) malformed(node, "login device-code client-id");
	if (!login.device || !login.token) malformed(node, "login device-code device/token");
	login.response ??= {
		userCode: "user_code",
		deviceCode: "device_code",
		verificationUri: "verification_uri",
		verificationUriComplete: "verification_uri_complete",
		interval: "interval",
		expiresIn: "expires_in",
	};
	login.instructions ??= "Enter code: {user_code}";
	login.credential = credentialMap(credentialNode);
	return login as CompiledDeviceCodeLogin;
}

function loginNode(node: KdlNodeView): CompiledLogin {
	const kind = node.args.length === 1 && typeof node.args[0] === "string" ? node.args[0] : undefined;
	switch (kind) {
		case "api-key":
			validateProps(node, []);
			return apiKeyLogin(node);
		case "oauth-code":
			validateProps(node, []);
			return oauthCodeLogin(node);
		case "device-code":
			validateProps(node, []);
			return deviceCodeLogin(node);
		case "custom":
			leaf(node, ["hook"]);
			return { kind: "custom", hook: hookName(node, "hook") };
		default:
			return malformed(node, "login");
	}
}

function refreshNode(node: KdlNodeView, login: CompiledLogin | undefined): CompiledRefresh {
	if (node.args.length === 1) {
		leaf(node, []);
		if (node.args[0] !== "none") malformed(node);
		return { kind: "none" };
	}
	if (node.args.length > 0) malformed(node);
	if (propString(node, "hook") !== undefined) {
		leaf(node, ["hook"]);
		return { kind: "hook", hook: hookName(node, "hook") };
	}
	const grant = login && (login.kind === "oauth-code" || login.kind === "device-code") ? login : undefined;
	const refresh: Partial<Extract<CompiledRefresh, { kind: "request" }>> = { kind: "request", require: [] };
	const seen = new Set<string>();
	let credentialNode: KdlNodeView | undefined;
	for (const child of children(node, [])) {
		if (seen.has(child.name)) malformed(child);
		seen.add(child.name);
		switch (child.name) {
			case "token":
				refresh.token = request(child, grant?.token);
				break;
			case "require":
				leaf(child, []);
				refresh.require = positionalStrings(child);
				if (refresh.require.length === 0 || refresh.require.some(v => !v)) malformed(child);
				break;
			case "credential":
				credentialNode = child;
				break;
			case "userinfo":
				refresh.userinfo = userinfo(child);
				break;
			case "after-refresh":
				leaf(child, ["hook"]);
				refresh.afterRefresh = hookName(child, "hook");
				break;
			case "headers-hook":
				leaf(child, []);
				refresh.headersHook = singleString(child);
				if (!HOOK_NAME.test(refresh.headersHook)) malformed(child);
				break;
			default:
				unexpected(child, "refresh");
		}
	}
	if (!refresh.token) {
		if (!grant) malformed(node, "refresh token");
		refresh.token = { ...grant.token, params: {}, headers: {}, standard: true };
	}
	// An explicit refresh `credential` block replaces the login map (refresh
	// responses commonly omit identity fields that must merge from storage).
	refresh.credential = credentialMap(credentialNode, credentialNode ? undefined : grant?.credential);
	if (!refresh.headersHook && grant?.kind === "device-code" && grant.headersHook) {
		refresh.headersHook = grant.headersHook;
	}
	return refresh as Extract<CompiledRefresh, { kind: "request" }>;
}

function provider(node: KdlNodeView): CompiledAuthProvider {
	validateProps(node, []);
	const id = singleString(node);
	const result: Partial<CompiledAuthProvider> = { id, apiKeyFormat: "bearer" };
	const seen = new Set<string>();
	let refreshChild: KdlNodeView | undefined;
	for (const child of children(node, [])) {
		if (seen.has(child.name)) malformed(child);
		seen.add(child.name);
		switch (child.name) {
			case "name":
				leaf(child, []);
				result.name = singleString(child);
				break;
			case "env":
				if (propString(child, "hook") !== undefined) {
					leaf(child, ["hook"]);
					if (child.args.length > 0) malformed(child);
					result.env = { hook: hookName(child, "hook") };
				} else {
					leaf(child, []);
					const vars = positionalStrings(child);
					if (vars.length === 0 || vars.some(v => !v)) malformed(child);
					result.env = { vars };
				}
				break;
			case "allows-missing-api-key":
				result.allowsMissingApiKey = singleBool(child);
				break;
			case "available":
				result.available = singleBool(child);
				break;
			case "show-in-login-list":
				result.showInLoginList = singleBool(child);
				break;
			case "store-as":
				leaf(child, []);
				result.storeAs = singleString(child);
				break;
			case "callback-port":
				result.callbackPort = singleInt(child);
				break;
			case "paste-code":
				result.pasteCode = singleBool(child);
				break;
			case "api-key-format": {
				leaf(child, []);
				const format = singleString(child);
				if (format !== "bearer" && format !== "structured") malformed(child);
				result.apiKeyFormat = format;
				break;
			}
			case "expiry":
				leaf(child, []);
				if (singleString(child) !== "jwt-or-never") malformed(child);
				result.expiry = "jwt-or-never";
				break;
			case "result":
				leaf(child, []);
				if (singleString(child) !== "api-key") malformed(child);
				result.result = "api-key";
				break;
			case "login":
				result.login = loginNode(child);
				break;
			case "refresh":
				refreshChild = child;
				break;
			default:
				unexpected(child, "auth");
		}
	}
	if (!result.name) malformed(node, "auth name");
	if (refreshChild) result.refresh = refreshNode(refreshChild, result.login);
	const login = result.login;
	if (login && (login.kind === "oauth-code" || login.kind === "device-code") && !result.refresh) {
		throw new CompatCompileError(node.file, node.line, `auth "${id}" declares an OAuth login but no \`refresh\``);
	}
	if (login?.kind === "oauth-code") {
		if (result.callbackPort === undefined) result.callbackPort = login.callback.port;
		result.pasteCode ??= true;
	}
	if (!login && result.refresh) {
		throw new CompatCompileError(node.file, node.line, `auth "${id}" declares \`refresh\` without \`login\``);
	}
	if (result.result && (!login || login.kind === "api-key" || (result.refresh && result.refresh.kind !== "none"))) {
		throw new CompatCompileError(
			node.file,
			node.line,
			`auth "${id}": \`result "api-key"\` needs an OAuth login without refresh`,
		);
	}
	return result as CompiledAuthProvider;
}

/** Compiles the auth sources (`auth/*.kdl`) into display-ordered providers. */
export function compileAuth(sources: { file: string; text: string }[]): CompiledAuth {
	const providers = new Map<string, CompiledAuthProvider>();
	let order: string[] | undefined;
	let orderFile: { file: string; line: number } | undefined;
	for (const source of sources) {
		for (const node of parseKdl(source.file, source.text)) {
			if (source.file === ORDER_FILE) {
				if (node.name !== "login-order" || order) malformed(node);
				leaf(node, []);
				order = positionalStrings(node);
				orderFile = { file: node.file, line: node.line };
				continue;
			}
			if (node.name !== "auth") unexpected(node, "document root");
			const compiled = provider(node);
			if (providers.has(compiled.id)) {
				throw new CompatCompileError(node.file, node.line, `duplicate auth provider "${compiled.id}"`);
			}
			providers.set(compiled.id, compiled);
		}
	}
	const ordered: CompiledAuthProvider[] = [];
	const placed = new Set<string>();
	for (const id of order ?? []) {
		const entry = providers.get(id);
		if (!entry || placed.has(id)) {
			throw new CompatCompileError(
				orderFile?.file ?? ORDER_FILE,
				orderFile?.line,
				`login-order names unknown or repeated provider "${id}"`,
			);
		}
		placed.add(id);
		ordered.push(entry);
	}
	for (const [id, entry] of [...providers].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
		if (placed.has(id)) continue;
		if (entry.login && entry.showInLoginList !== false) {
			throw new CompatCompileError(
				orderFile?.file ?? ORDER_FILE,
				orderFile?.line,
				`loginable provider "${id}" is missing from login-order`,
			);
		}
		ordered.push(entry);
	}
	return { providers: ordered };
}
