/** @jsxImportSource @oh-my-pi/pi-tui */
import type { UiEvent } from "@oh-my-pi/pi-tui";
import { corpusEnvironment } from "@oh-my-pi/pi-tui/testing/corpus";
import { MCPAddWizard } from "../../../../src/ui/overlays/panels/mcp-add-wizard";
import {
	type MCPAddWizardDeps,
	MCPAddWizardModel,
	type MCPAddWizardOAuthResult,
} from "../../../../src/ui/overlays/panels/mcp-add-wizard-model";
import { type Driver, panelSuite } from "./harness";

const ENTER = "\r";
const ESC = "\x1b";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const BS = "\x7f";

const baseDeps: MCPAddWizardDeps = {
	validateServerName: name => (/^[\w.:-]+$/u.test(name) ? undefined : "Use letters, numbers, dash or underscore"),
	analyzeAuthError: () => ({ requiresAuth: false }),
	discoverOAuthEndpoints: async () => null,
	fetchResourceMetadataScopes: async () => undefined,
};
const oauthEndpoints = {
	authorizationUrl: "https://auth.example.com/oauth/authorize",
	tokenUrl: "https://auth.example.com/oauth/token",
	registrationUrl: "https://auth.example.com/register",
	scopes: "",
};
const oauthDeps: Partial<MCPAddWizardDeps> = {
	analyzeAuthError: () => ({
		requiresAuth: true,
		authType: "oauth",
		oauth: oauthEndpoints,
		resourceMetadataUrl: "https://mcp.example.com/.well-known/oauth-protected-resource",
	}),
	fetchResourceMetadataScopes: async () => "read write",
};

interface Setup {
	deps?: Partial<MCPAddWizardDeps>;
	oauth?: boolean;
	test?: boolean;
	name?: string;
}
const SETUPS: Record<string, Setup> = {
	"native-events-and-paste": { name: "  ünïcødé:服务  " },
	"connection-test-success-then-stale": { name: "gh", test: true },
	"connection-test-plain-failure": { name: "gh", test: true },
	"oauth-discovered-sign-in-health-ok": { name: "linear", test: true, oauth: true, deps: oauthDeps },
	"oauth-cancel-edit-settings-timeout-retry-health-fail": { name: "linear", test: true, oauth: true, deps: oauthDeps },
	"oauth-cancel-action-mid-wait": { name: "linear", test: true, oauth: true, deps: oauthDeps },
	"oauth-no-handler": { name: "linear", test: true, deps: oauthDeps },
	"oauth-incomplete-settings": {
		name: "linear",
		test: true,
		oauth: true,
		deps: {
			analyzeAuthError: () => ({
				requiresAuth: true,
				authType: "oauth",
				oauth: { ...oauthEndpoints, tokenUrl: "" },
			}),
		},
	},
	"manual-key-stdio-env-var": {
		name: "gh",
		test: true,
		deps: { analyzeAuthError: () => ({ requiresAuth: true, authType: "apikey" }) },
	},
	"manual-key-remote-header-and-env": {
		name: "remote",
		test: true,
		deps: {
			analyzeAuthError: () => ({ requiresAuth: true, authType: "unknown" }),
			discoverOAuthEndpoints: async () => {
				throw new Error("nope");
			},
		},
	},
};

const settle = async () => {
	for (let i = 0; i < 8; i++) await Bun.sleep(0);
};

panelSuite({
	dir: "overlays/mcp-add-wizard",
	mount(caseName, corpusCase) {
		const setup = SETUPS[caseName] ?? {};
		const env = corpusEnvironment(corpusCase.theme);
		const tests: PromiseWithResolvers<void>[] = [];
		const oauths: PromiseWithResolvers<MCPAddWizardOAuthResult>[] = [];
		const ticks: { tick: () => void; stopped: boolean }[] = [];
		const noop = () => {};
		const model = new MCPAddWizardModel(
			{ ...baseDeps, ...setup.deps },
			{
				onComplete: noop,
				onCancel: noop,
				onTestConnection: setup.test
					? () => {
							const d = Promise.withResolvers<void>();
							d.promise.catch(noop);
							tests.push(d);
							return d.promise;
						}
					: undefined,
				onOAuth: setup.oauth
					? (_a, _t, _c, _s, _sc, options) => {
							const d = Promise.withResolvers<MCPAddWizardOAuthResult>();
							d.promise.catch(noop);
							options?.abortSignal?.addEventListener("abort", () => {
								const error = new Error("OAuth flow cancelled by user");
								error.name = "MCPOAuthCancelledError";
								d.reject(error);
							});
							oauths.push(d);
							return d.promise;
						}
					: undefined,
			},
			{ theme: env.theme },
			{
				initialName: setup.name,
				clock: {
					delay: async () => {},
					every(_ms, tick) {
						const entry = { tick, stopped: false };
						ticks.push(entry);
						return () => {
							entry.stopped = true;
						};
					},
				},
				configPathLabel: scope => (scope === "user" ? "~/.omp/agent/mcp.json" : ".omp/mcp.json"),
			},
		);
		const run = (act: (d: Driver) => void) => async (d: Driver) => {
			act(d);
			await settle();
		};
		const keys = (...seq: string[]) =>
			run(d => {
				for (const k of seq) for (const ch of k.startsWith("\x1b") || k === ENTER ? [k] : [...k]) d.press(ch);
			});
		const act = (name: string) => (d: Driver) =>
			void d.emit({ type: "action", key: `sheet/actions/${name}`, act: name, mods: [] });
		const select = (list: string, item: string, type: "select" | "activate" = "select") =>
			run(d => void d.emit({ type, key: `sheet/${list}`, item } as UiEvent));
		const test = () => tests.at(-1)!;
		const oauth = () => oauths.at(-1)!;
		const later = (fn: () => void) => run(fn);
		const toRemoteUrl = {
			http: keys(DOWN, ENTER),
			url: keys("https://mcp.example.com/mcp", ENTER),
		};
		const steps: Record<string, (d: Driver) => Promise<void>> = {
			...toRemoteUrl,
			// keys
			"type bad name": keys("bad name"),
			"submit bad name": keys(ENTER),
			"fix name": keys(...Array<string>(8).fill(BS), "srv"),
			"submit name": keys(ENTER),
			down: keys(DOWN),
			"down wraps": keys(DOWN),
			"up wraps": keys(UP),
			"enter http": keys(DOWN, DOWN, ENTER),
			"empty url": keys(ENTER),
			"ftp url": keys("ftp://x", ENTER),
			"not a url": keys(...Array<string>(7).fill(BS), "not a url", ENTER),
			"esc back to transport": keys(ESC),
			stdio: keys(UP, ENTER),
			"empty command rejected": keys(ENTER),
			command: keys("npx", ENTER),
			args: keys("-y\t@modelcontextprotocol/server-github", ENTER),
			"scope down": keys(DOWN),
			"scope enter": keys(ENTER),
			"review down no-op": keys(DOWN),
			"review esc": keys(ESC),
			"scope esc → args": keys(ESC),
			"args esc → command": keys(ESC),
			"command esc → transport": keys(ESC),
			"transport esc → name": keys(ESC),
			"forward again": keys(ENTER, ENTER, "npx", ENTER, ENTER, ENTER),
			save: keys(ENTER),
			"ctrl+c": keys("\x03"),
			"name esc cancels": keys(ESC, ESC, ESC, ESC, ESC),
			// native events and paste
			"select sse": select("choices-transport", "2"),
			"paste url": run(d => d.paste("https://mcp.example.com/a\tb")),
			"back action": run(act("back")),
			"stale list ignored": select("choices-url", "0"),
			"out of range ignored": select("choices-transport", "7"),
			"non-integer ignored": select("choices-transport", "x"),
			"activate http": select("choices-transport", "1", "activate"),
			"next empty url": run(act("next")),
			"paste and next": run(d => {
				d.paste("https://mcp.example.com/mcp");
				act("next")(d);
			}),
			"scope select project": select("choices-scope", "1"),
			back: run(act("back")),
			next: run(act("next")),
			"next saves": run(act("next")),
			cancel: run(act("cancel")),
			"back on name": run(act("back")),
			"type and next": run(d => {
				d.press("x");
				act("next")(d);
			}),
			"unknown action": run(act("bogus")),
			// connection test
			"args → testing": keys("-y server", ENTER),
			"keys ignored while testing": keys(DOWN, ENTER),
			"select ignored while testing": select("choices-args", "0"),
			"next ignored while testing": run(act("next")),
			"connected → scope": later(() => test().resolve()),
			review: keys(ENTER),
			"back to scope": keys(ESC),
			"back to args": keys(ESC),
			retest: keys(ENTER),
			"step back while testing": keys(ESC),
			"stale success ignored": later(() => test().resolve()),
			fail: later(() => test().reject(new Error(`connect ECONNREFUSED\t127.0.0.1:443 ${"x".repeat(200)}`))),
			// oauth
			"401 → oauth wait": later(() =>
				test().reject(new Error(caseName.includes("mid-wait") ? "401" : "401 Unauthorized")),
			),
			"keys ignored while waiting": keys(DOWN),
			"signed in → health": later(() => oauth().resolve({ credentialId: "cred-1", clientId: "dcr-client" })),
			tick: later(() => {
				for (const entry of ticks) if (!entry.stopped) entry.tick();
			}),
			"health ok → scope": later(() => test().resolve()),
			"esc cancels wait": keys(ESC),
			"edit settings": keys(ENTER),
			"auth url": keys(ENTER),
			"token url back": keys(ESC),
			"auth url again": keys(ENTER),
			"token url": keys(ENTER),
			"client id empty rejected": keys(ENTER),
			"client id": keys("cid", ENTER),
			"client secret (masked)": keys("s3cret", ENTER),
			"scopes → wait": keys(ENTER),
			timeout: later(() => oauth().reject(new Error("Login timed out"))),
			"try again": keys(ENTER),
			"native back stops waiting": run(act("back")),
			"try again via click": select("choices-oauth-error", "0"),
			"invalid urls": later(() => oauth().reject(new Error("Invalid OAuth URLs"))),
			retry: keys(ENTER),
			refused: later(() => oauth().reject(new Error("connect ECONNREFUSED"))),
			other: later(() => oauth().reject("weird")),
			"signed in": later(() => oauth().resolve({ credentialId: "cred-2", resource: "https://mcp.example.com" })),
			"health fails": later(() => test().reject(new Error("health\tboom"))),
			"scope esc → scopes": keys(ESC),
			"scopes esc → secret": keys(ESC),
			"esc chain": keys(ESC, ESC, ESC),
			"oauth-auth-url esc → url": keys(ESC),
			"oauth-error esc → auth url": keys(ESC),
			"401 → unavailable": later(() => test().reject(new Error("401"))),
			esc: keys(ESC),
			"401 → incomplete": later(() => test().reject(new Error("401"))),
			// manual keys
			"401 → api key": later(() => test().reject(new Error("401"))),
			"empty key rejected": keys(ENTER),
			key: keys(caseName.includes("stdio") ? "!op read op://dev/x" : "sk-123", ENTER),
			"env var": keys(BS, BS, BS, "TOKEN", ENTER),
			header: keys(DOWN, ENTER),
			"header name": keys(ENTER),
			"back to scope, header name, location": keys(ESC, ESC, ESC),
			env: keys(UP, ENTER),
			"env var name back → location": keys(ESC),
			"location back → apikey": keys(ESC),
			"apikey back → url": keys(ESC),
			"401": later(() => test().reject(new Error("401"))),
			"through env": keys(ENTER, ENTER, ENTER, ENTER, ENTER),
			"env esc → apikey": keys(ESC),
			"apikey esc → args": keys(ESC),
			forward: keys(ENTER),
			"401 again": later(() => test().reject(new Error("401"))),
			through: keys(ENTER, ENTER, ENTER, ENTER),
		};
		// Labels that differ per case.
		if (caseName === "manual-key-stdio-env-var") {
			steps.stdio = keys(ENTER, "npx", ENTER);
			steps.args = keys(ENTER);
			steps.back = keys(ESC, ESC);
		}
		if (caseName === "connection-test-success-then-stale") steps.stdio = keys(ENTER);
		if (caseName === "manual-key-remote-header-and-env") steps.url = keys(ENTER);
		if (caseName === "oauth-cancel-action-mid-wait") steps.cancel = run(act("cancel"));
		if (caseName.startsWith("oauth-cancel-edit")) steps.down = keys(DOWN);
		if (caseName === "keys-name-validation-transport-url-validation-stdio-review") steps.back = run(act("back"));
		let urlSeen = 0;
		if (caseName === "manual-key-remote-header-and-env") {
			const first = toRemoteUrl.url;
			steps.url = async d => (urlSeen++ === 0 ? first(d) : keys(ENTER)(d));
		}
		return { view: () => <MCPAddWizard model={model} />, steps };
	},
});
