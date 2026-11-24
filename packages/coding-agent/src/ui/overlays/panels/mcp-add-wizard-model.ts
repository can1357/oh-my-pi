/**
 * Adding an MCP server, step by step: name, transport, the command or URL,
 * a connection test that detects whether the server needs credentials
 * (OAuth sign-in with discovered or hand-entered endpoints, or an API key
 * in an env var or header), where to save it, and a review.
 *
 * Async steps (connection test, sign-in, health check) run while the
 * wizard shows them; stepping back makes a test that settles later stale.
 */
import * as path from "node:path";
import type { Accessor, TextEdit } from "@oh-my-pi/pi-tui";
import { signal } from "@oh-my-pi/pi-tui";
import { replaceTabs } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { getMCPConfigPath, getProjectDir } from "@oh-my-pi/pi-utils";
import type { TspText } from "@oh-my-pi/pi-wire";
import { shortenPath } from "../../../utils/render-utils";
import { listKeyId } from "../../../config/keybindings/matchers";
import { getKeybindings } from "../../../config/keybindings/keybindings";

type TransportType = "stdio" | "http" | "sse";
type AuthMethod = "none" | "oauth" | "manual";
type AuthLocation = "env" | "header";
export type MCPAddScope = "user" | "project";

/** Authentication fields the wizard produces. */
interface MCPAddWizardAuth {
	type: "oauth";
	credentialId: string;
	tokenUrl?: string;
	clientId?: string;
	clientSecret?: string;
	resource?: string;
}

interface MCPAddWizardConfigBase {
	timeout?: number;
	auth?: MCPAddWizardAuth;
}

interface MCPAddWizardStdioConfig extends MCPAddWizardConfigBase {
	type: "stdio";
	command: string;
	args?: string[];
	env?: Record<string, string>;
}

interface MCPAddWizardRemoteConfig extends MCPAddWizardConfigBase {
	type: "http" | "sse";
	url: string;
	headers?: Record<string, string>;
}

/** A server configuration, for the connection test and for saving. */
export type MCPAddWizardConfig = MCPAddWizardStdioConfig | MCPAddWizardRemoteConfig;

export interface MCPAddWizardOAuthEndpoints {
	authorizationUrl: string;
	tokenUrl: string;
	issuerUrl?: string;
	clientId?: string;
	registrationUrl?: string;
	scopes?: string;
	resource?: string;
}

export interface MCPAddWizardAuthDetection {
	requiresAuth: boolean;
	authType?: "oauth" | "apikey" | "unknown";
	oauth?: MCPAddWizardOAuthEndpoints;
	authServerUrl?: string;
	resourceMetadataUrl?: string;
	scopes?: string;
}

/** Host-owned validation and OAuth discovery. */
export interface MCPAddWizardDeps {
	validateServerName(name: string): string | undefined;
	analyzeAuthError(error: Error, serverUrl?: string): MCPAddWizardAuthDetection;
	discoverOAuthEndpoints(
		serverUrl: string,
		authServerUrl?: string,
		resourceMetadataUrl?: string,
		options?: { protectedScopes?: string },
	): Promise<MCPAddWizardOAuthEndpoints | null>;
	fetchResourceMetadataScopes(resourceMetadataUrl: string): Promise<string | undefined>;
}

/** What sign-in returns: the stored credential, and the client id when the provider registered one. */
export interface MCPAddWizardOAuthResult {
	credentialId: string;
	clientId?: string;
	resource?: string;
}

export interface MCPAddWizardOAuthOptions {
	serverUrl?: string;
	resource?: string;
	stripSameOriginResource?: boolean;
	registrationUrl?: string;
	issuerUrl?: string;
	/** Aborted when the user stops waiting. */
	abortSignal?: AbortSignal;
}

export interface MCPAddWizardCallbacks {
	onComplete(name: string, config: MCPAddWizardConfig, scope: MCPAddScope): void;
	onCancel(): void;
	onOAuth?(
		authUrl: string,
		tokenUrl: string,
		clientId: string,
		clientSecret: string,
		scopes: string,
		options?: MCPAddWizardOAuthOptions,
	): Promise<MCPAddWizardOAuthResult>;
	onTestConnection?(config: MCPAddWizardConfig): Promise<void>;
}

/** Timers the wizard waits on (tests make them immediate). */
export interface MCPAddWizardClock {
	/** Resolves after `ms`. */
	delay(ms: number): Promise<void>;
	/** Calls `tick` every `ms` until the returned stop runs. */
	every(ms: number, tick: () => void): () => void;
}

export interface MCPAddWizardOptions {
	readonly initialName?: string;
	readonly clock?: MCPAddWizardClock;
	/** Where each scope's config file is, as shown (default: relative in the project, else `~`-shortened). */
	readonly configPathLabel?: (scope: MCPAddScope) => string;
	/** Key id that steps back (default `escape`). */
	readonly cancelKey?: string;
}

export type WizardStepId =
	| "name"
	| "transport"
	| "command"
	| "args"
	| "url"
	| "auth-method"
	| "oauth-error"
	| "oauth-auth-url"
	| "oauth-token-url"
	| "oauth-client-id"
	| "oauth-client-secret"
	| "oauth-scopes"
	| "apikey"
	| "auth-location"
	| "env-var-name"
	| "header-name"
	| "scope"
	| "confirm";

/** The phases the progress strip shows. */
export const PHASES = ["Name", "Transport", "Connection", "Auth", "Scope", "Review"] as const;
export const PHASE_AUTH = 3;

const STEP_PHASE: Readonly<Record<WizardStepId, number>> = {
	name: 0,
	transport: 1,
	command: 2,
	args: 2,
	url: 2,
	"auth-method": 3,
	"oauth-error": 3,
	"oauth-auth-url": 3,
	"oauth-token-url": 3,
	"oauth-client-id": 3,
	"oauth-client-secret": 3,
	"oauth-scopes": 3,
	apikey: 3,
	"auth-location": 3,
	"env-var-name": 3,
	"header-name": 3,
	scope: 4,
	confirm: 5,
};

const TRANSPORTS: readonly TransportType[] = ["stdio", "http", "sse"];
export const TRANSPORT_CHOICES: Readonly<Record<TransportType, { icon: string; label: string; description: string }>> =
	{
		stdio: { icon: "terminal", label: "Local command", description: "omp starts it on this machine" },
		http: { icon: "globe", label: "Remote server", description: "Streamable HTTP endpoint" },
		sse: { icon: "broadcast", label: "Server-sent events", description: "Older HTTP servers" },
	};
export const SCOPE_LABELS: Readonly<Record<MCPAddScope, string>> = { user: "Every project", project: "This project" };

/** A span of terminal-face text in a theme color (undefined: default). */
export type Tone = "accent" | "success" | "warning" | "error" | "muted";

/** One choice of a choice step. */
export interface WizardChoice {
	readonly label: string;
	readonly description?: string;
	/** Native detail when it differs from the description (a mono path). */
	readonly monoDetail?: boolean;
	readonly icon?: string;
	/** A short tag after the label (`stdio`). */
	readonly tag?: string;
}

/** A status line of an async step: busy (spinner) or a toned icon. */
export interface WizardStatus {
	readonly key: string;
	readonly state: "busy" | "ok" | "warn" | "error";
	/** Text, or [plain, mono, plain…] segments (odd ones mono). */
	readonly label: string | readonly string[];
}

/** What the terminal face shows of an async step: lines in a tone (`spinner` lines show the spinner frame first). */
export interface AsyncLine {
	readonly text: string;
	readonly tone?: Tone;
	readonly spinner?: boolean;
}

/** The mounted step, as both faces draw it. */
export type WizardStep =
	| {
			readonly kind: "input";
			readonly phase: number;
			readonly title: string;
			readonly lead: string;
			readonly placeholder?: string;
			readonly note?: string;
			/** What Escape does (undefined: an optional step that only skips). */
			readonly escape?: string;
			readonly optional: boolean;
			readonly secret: boolean;
			readonly error?: string;
	  }
	| {
			readonly kind: "choice";
			readonly phase: number;
			readonly title: string;
			readonly tone: Tone;
			readonly lead: string;
			/** Terminal lines above the choices (replace the lead there). */
			readonly intro?: readonly AsyncLine[];
			readonly failure?: { readonly message: string; readonly tip?: string; readonly cancelled: boolean };
			readonly choices: readonly WizardChoice[];
			readonly escape: string;
	  }
	| {
			readonly kind: "async";
			readonly phase: number;
			readonly title: string;
			readonly tone: Tone;
			readonly lead?: string;
			readonly lines: readonly AsyncLine[];
			readonly footer?: string;
			/** Native body: status rows (in a checks column when `checks`), then an error well. */
			readonly statuses: readonly WizardStatus[];
			readonly checks?: boolean;
			readonly error?: string;
			readonly back: string;
	  }
	| { readonly kind: "confirm"; readonly phase: number; readonly title: string };

interface WizardState {
	name: string;
	transport: TransportType | null;
	command: string;
	args: string;
	url: string;
	authMethod: AuthMethod;
	oauthAuthUrl: string;
	oauthTokenUrl: string;
	oauthRegistrationUrl: string;
	oauthIssuerUrl: string;
	oauthClientId: string;
	oauthClientSecret: string;
	oauthScopes: string;
	oauthResource: string;
	oauthResourceIsFallback: boolean;
	oauthCredentialId: string | null;
	apiKey: string;
	authLocation: AuthLocation | null;
	envVarName: string;
	headerName: string;
	scope: MCPAddScope | null;
}

/** Longest error/URL text the terminal face shows. */
const MAX_DISPLAY_WIDTH = 120;

/** Tabs expanded and cut to the display width. */
export function displayText(text: string): string {
	const expanded = replaceTabs(text);
	return Array.from(expanded).length > MAX_DISPLAY_WIDTH
		? `${Array.from(expanded)
				.slice(0, MAX_DISPLAY_WIDTH - 1)
				.join("")}…`
		: expanded;
}

function errorText(error: unknown): string {
	return replaceTabs(error instanceof Error ? error.message : String(error));
}

const REAL_CLOCK: MCPAddWizardClock = {
	delay: ms => Bun.sleep(ms),
	every(ms, tick) {
		const handle = setInterval(tick, ms);
		return () => clearInterval(handle);
	},
};

function defaultConfigPathLabel(scope: MCPAddScope): string {
	const cwd = getProjectDir();
	const file = getMCPConfigPath(scope, cwd);
	const relative = path.relative(cwd, file);
	return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : shortenPath(file);
}

export class MCPAddWizardModel {
	readonly rev = signal(0);
	step: WizardStepId = "name";
	view: WizardStep;
	state: WizardState = {
		name: "",
		transport: null,
		command: "",
		args: "",
		url: "",
		authMethod: "none",
		oauthAuthUrl: "",
		oauthTokenUrl: "",
		oauthRegistrationUrl: "",
		oauthIssuerUrl: "",
		oauthClientId: "",
		oauthClientSecret: "",
		oauthScopes: "",
		oauthResource: "",
		oauthResourceIsFallback: false,
		oauthCredentialId: null,
		apiKey: "",
		authLocation: null,
		envVarName: "API_KEY",
		headerName: "Authorization",
		scope: null,
	};
	/** The input step's field. */
	field = { text: "", cursor: 0 };
	selected = 0;
	/** Health-check spinner ticks (the terminal frame). */
	ticks = 0;
	readonly cancelKey: string;
	readonly configPathLabel: (scope: MCPAddScope) => string;
	#validationError: string | null = null;
	#failure: { cancelled: boolean; message: string; display: string; tip?: string } | null = null;
	/** Bumped when a test starts and on every step back: a test settling later is stale. */
	#attempt = 0;
	#oauthAbort: AbortController | null = null;
	readonly #clock: MCPAddWizardClock;
	#rev = 0;

	constructor(
		readonly deps: MCPAddWizardDeps,
		readonly callbacks: MCPAddWizardCallbacks,
		readonly terminal: { readonly theme: Accessor<Theme> },
		options: MCPAddWizardOptions = {},
	) {
		this.#clock = options.clock ?? REAL_CLOCK;
		this.cancelKey = options.cancelKey ?? "escape";
		this.configPathLabel = options.configPathLabel ?? defaultConfigPathLabel;
		const name = options.initialName?.trim();
		if (name) {
			this.state.name = name;
			this.step = "transport";
		}
		this.view = this.#mount();
	}

	touch(): void {
		this.rev.set(++this.#rev);
	}

	/** Whether Back exists on the mounted step (the name step cancels instead). */
	hasBack(): boolean {
		return this.step !== "name";
	}

	/** The phase strip: whether Auth was skipped (no credentials needed). */
	authSkipped(phase: number): boolean {
		return phase > PHASE_AUTH && this.state.authMethod === "none";
	}

	// ─── Steps ──────────────────────────────────────────────────────────────

	#show(): void {
		this.view = this.#mount();
		this.touch();
	}

	#input(
		options: Omit<Extract<WizardStep, { kind: "input" }>, "kind" | "phase" | "secret"> & {
			initial: string;
			secret?: boolean;
		},
	): WizardStep {
		this.field = { text: options.initial, cursor: options.initial.length };
		const { initial: _initial, ...rest } = options;
		return { kind: "input", phase: STEP_PHASE[this.step], ...rest, secret: options.secret === true };
	}

	#choice(
		options: Omit<Extract<WizardStep, { kind: "choice" }>, "kind" | "phase" | "tone"> & { tone?: Tone },
	): WizardStep {
		return { kind: "choice", phase: STEP_PHASE[this.step], tone: options.tone ?? "accent", ...options } as WizardStep;
	}

	#mount(): WizardStep {
		const s = this.state;
		const error = this.#validationError ?? undefined;
		switch (this.step) {
			case "name":
				return this.#input({
					title: "Name the server",
					lead: "A unique name: it labels the server in /mcp and prefixes its tools.",
					initial: s.name,
					placeholder: "github",
					note: "Letters, numbers, dash, underscore, dot and colon",
					escape: "cancel",
					optional: false,
					error,
				});
			case "transport":
				return this.#choice({
					title: "How does omp reach it?",
					lead: `Pick how ${s.name} talks to omp.`,
					choices: TRANSPORTS.map(transport => ({ ...TRANSPORT_CHOICES[transport], tag: transport })),
					escape: "go back",
				});
			case "command":
				return this.#input({
					title: "Command",
					lead: "The program omp starts for this server.",
					initial: s.command,
					placeholder: "npx",
					escape: "go back",
					optional: false,
				});
			case "args":
				return this.#input({
					title: "Arguments",
					lead: `Passed to ${s.command}, separated by spaces. omp tries the connection next.`,
					initial: s.args,
					placeholder: "-y @modelcontextprotocol/server-github",
					optional: true,
				});
			case "url":
				return this.#input({
					title: "Server URL",
					lead: `Where ${s.name} listens. omp tries the connection next.`,
					initial: s.url,
					placeholder: "https://mcp.example.com/mcp",
					note: "Starts with http:// or https://",
					escape: "go back",
					optional: false,
					error,
				});
			case "auth-method":
				return this.#choice({
					title: "How does it authenticate?",
					lead: `${s.name} needs credentials before omp can use it.`,
					choices: [
						{ icon: "log-in", label: "Sign in with OAuth", description: "Opens your browser" },
						{ icon: "key", label: "API key or token", description: "Paste it, or run a command that prints it" },
					],
					escape: "go back",
				});
			case "oauth-error": {
				const failure = this.#failure;
				const cancelled = failure?.cancelled ?? false;
				const intro: AsyncLine[] = [];
				if (failure) {
					intro.push({ text: failure.display }, { text: "" });
					if (failure.tip) intro.push({ text: `Tip: ${failure.tip}`, tone: "muted" }, { text: "" });
				}
				intro.push({ text: "Choose next action:" });
				return this.#choice({
					title: cancelled ? "Sign-in cancelled" : "Sign-in failed",
					tone: cancelled ? "muted" : "error",
					lead: cancelled
						? "The browser sign-in stopped before it finished."
						: "The provider didn't finish signing you in.",
					intro,
					failure: failure ? { message: failure.message, tip: failure.tip, cancelled } : undefined,
					choices: [
						{ icon: "repeat", label: "Try again", description: "Opens the browser again" },
						{ icon: "sliders", label: "Edit OAuth settings", description: "Endpoints, client and scopes" },
					],
					escape: "go back",
				});
			}
			case "oauth-auth-url":
				return this.#input({
					title: "Authorization URL",
					lead: "The provider's OAuth authorize endpoint.",
					initial: s.oauthAuthUrl,
					placeholder: "https://auth.example.com/oauth/authorize",
					escape: "go back",
					optional: false,
				});
			case "oauth-token-url":
				return this.#input({
					title: "Token URL",
					lead: "The endpoint that exchanges the authorization code for a token.",
					initial: s.oauthTokenUrl,
					placeholder: "https://auth.example.com/oauth/token",
					escape: "go back",
					optional: false,
				});
			case "oauth-client-id":
				return this.#input({
					title: "Client ID",
					lead: "The ID of the OAuth app registered with the provider.",
					initial: s.oauthClientId,
					escape: "go back",
					optional: false,
				});
			case "oauth-client-secret":
				return this.#input({
					title: "Client secret",
					lead: "Leave it empty for PKCE-only flows.",
					initial: s.oauthClientSecret,
					escape: "go back",
					optional: true,
					secret: true,
				});
			case "oauth-scopes":
				return this.#input({
					title: "Scopes",
					lead: "What omp may access, separated by spaces. Sign-in starts next.",
					initial: s.oauthScopes,
					placeholder: "read write",
					escape: "go back",
					optional: true,
				});
			case "apikey":
				return this.#input({
					title: "API key",
					lead: "Paste the key or token. Start with ! to run a command that prints it, e.g. a password manager.",
					initial: s.apiKey,
					placeholder: "!op read op://dev/github/token",
					escape: "go back",
					optional: false,
				});
			case "auth-location":
				return this.#choice({
					title: "Where does the key go?",
					lead: "How the server expects to receive it.",
					choices: [
						{ icon: "terminal", label: "Environment variable", description: "Set when the server starts" },
						{ icon: "globe", label: "HTTP header", description: "Sent with every request" },
					],
					escape: "go back",
				});
			case "env-var-name":
				return this.#input({
					title: "Environment variable",
					lead: "The variable the server reads its key from.",
					initial: s.envVarName,
					placeholder: "API_KEY",
					escape: "go back",
					optional: false,
				});
			case "header-name":
				return this.#input({
					title: "Header name",
					lead: "The HTTP header that carries the key.",
					initial: s.headerName,
					placeholder: "Authorization",
					escape: "go back",
					optional: false,
				});
			case "scope":
				return this.#choice({
					title: "Where should it live?",
					lead: "Saved for you everywhere, or only in this project's config.",
					choices: (["user", "project"] as const).map(scope => ({
						icon: scope === "user" ? "home" : "folder",
						label: SCOPE_LABELS[scope],
						description: this.configPathLabel(scope),
						monoDetail: true,
					})),
					escape: "go back",
				});
			case "confirm":
				return { kind: "confirm", phase: STEP_PHASE.confirm, title: "Review" };
		}
	}

	/** The review's rows: label and value. */
	summary(): { key: string; value: string; native: TspText }[] {
		const s = this.state;
		const transport = s.transport ?? "stdio";
		const scope = s.scope ?? "user";
		const scopePath = this.configPathLabel(scope);
		const rows: { key: string; value: string; native: TspText }[] = [
			{ key: "Name", value: s.name, native: [{ s: "strong", t: s.name }] },
			{
				key: "Transport",
				value: transport,
				native: [{ t: `${TRANSPORT_CHOICES[transport].label}  ` }, { s: "mono muted", t: transport }],
			},
		];
		if (transport === "stdio") {
			rows.push({ key: "Command", value: s.command, native: [{ s: "mono", t: s.command }] });
			if (s.args) rows.push({ key: "Arguments", value: s.args, native: [{ s: "mono", t: s.args }] });
		} else {
			rows.push({ key: "URL", value: displayText(s.url), native: [{ s: "mono", t: replaceTabs(s.url) }] });
		}
		if (s.authMethod === "oauth")
			rows.push({ key: "Auth", value: "OAuth (authenticated)", native: "OAuth, signed in" });
		else if (s.authMethod === "manual") {
			const [where, name] = s.authLocation === "env" ? ["env", s.envVarName] : ["header", s.headerName];
			rows.push({
				key: "Auth",
				value: `API key via ${where} (${name})`,
				native: [{ t: where === "env" ? "API key in " : "API key in header " }, { s: "mono", t: name }],
			});
		} else rows.push({ key: "Auth", value: "None", native: [{ s: "muted", t: "None" }] });
		rows.push({
			key: "Saved in",
			value: `${SCOPE_LABELS[scope]} (${scopePath})`,
			native: [{ t: `${SCOPE_LABELS[scope]}  ` }, { s: "mono muted", t: scopePath }],
		});
		return rows;
	}

	#async(step: Omit<Extract<WizardStep, { kind: "async" }>, "kind" | "back"> & { back?: string }): void {
		this.view = { kind: "async", ...step, back: step.back ?? "Back" };
		this.touch();
	}

	// ─── Input ──────────────────────────────────────────────────────────────

	/** A key; false when it belongs to the input step's field. */
	key(id: string): boolean {
		const handled = this.#key(id);
		this.touch();
		return handled;
	}

	#key(id: string): boolean {
		// While sign-in is awaited, Escape and Ctrl+C stop the wait (not the form).
		if (this.#oauthAbort && (id === "ctrl+c" || id === "escape")) {
			this.#oauthAbort.abort("MCP OAuth flow cancelled by user");
			return true;
		}
		if (id === "ctrl+c") {
			this.callbacks.onCancel();
			return true;
		}
		if (this.view.kind === "input") {
			if (getKeybindings().matchesId(id, "tui.input.submit")) this.#submitField();
			else if (id === this.cancelKey) this.#cancelInput();
			else return id === "tab";
			return true;
		}
		const nav = listKeyId(id);
		if (this.view.kind === "async" && nav !== "escape") return true;
		if (nav === "escape") {
			if (this.step === "name") this.callbacks.onCancel();
			else this.#goBack();
		} else if (nav === "enter") this.#choose();
		else if (nav === "up") this.#moveSelection(-1);
		else if (nav === "down") this.#moveSelection(1);
		return true;
	}

	/** An edit of the input step's field. */
	editField(edit: TextEdit): void {
		if (this.view.kind !== "input") return;
		const secret = this.view.secret;
		const chars = secret ? Array.from(this.field.text) : null;
		if (chars) {
			if (edit.len !== chars.length) return;
			chars.splice(edit.from, edit.to - edit.from, ...Array.from(edit.text));
			this.field = { text: chars.join(""), cursor: edit.cursor };
		} else {
			if (edit.len !== this.field.text.length) return;
			this.field = {
				text: `${this.field.text.slice(0, edit.from)}${edit.text}${this.field.text.slice(edit.to)}`,
				cursor: edit.cursor,
			};
		}
		this.touch();
	}

	/** Pasted text goes into the input step's field (tabs expanded, lines joined). */
	paste(text: string): void {
		if (this.view.kind !== "input") return;
		const clean = replaceTabs(text.replace(/\r?\n/g, ""));
		const { text: value, cursor } = this.field;
		const at = this.view.secret ? Array.from(value).slice(0, cursor).join("").length : cursor;
		this.field = {
			text: `${value.slice(0, at)}${clean}${value.slice(at)}`,
			cursor: cursor + (this.view.secret ? Array.from(clean).length : clean.length),
		};
		this.touch();
	}

	/** A footer button: Cancel, Back or Next. */
	action(act: string): void {
		switch (act) {
			case "cancel":
				this.#oauthAbort?.abort("MCP OAuth flow cancelled by user");
				this.callbacks.onCancel();
				return;
			case "back":
				if (this.#oauthAbort) this.#oauthAbort.abort("MCP OAuth flow cancelled by user");
				else if (this.view.kind === "input") this.#cancelInput();
				else if (this.step === "name") this.callbacks.onCancel();
				else this.#goBack();
				break;
			case "next":
				if (this.view.kind === "input") this.#submitField();
				else if (this.view.kind !== "async") this.#choose();
				break;
			default:
				return;
		}
		this.touch();
	}

	/** A click on a choice: Enter on it. */
	pick(list: string, item: string): void {
		if (list !== `choices-${this.step}`) return;
		if (this.view.kind === "input" || this.view.kind === "async" || this.#oauthAbort) return;
		const index = Number(item);
		if (!Number.isInteger(index) || index < 0 || index > this.#maxIndex()) return;
		this.selected = index;
		this.#choose();
		this.touch();
	}

	#cancelInput(): void {
		if (this.step === "name") this.callbacks.onCancel();
		else this.#goBack();
	}

	#submitField(): void {
		if (this.view.kind !== "input") return;
		const value = this.field.text.trim();
		// A required field rejects an empty value in place.
		if (!value && !this.view.optional) return;
		const s = this.state;
		switch (this.step) {
			case "name": {
				s.name = value;
				const error = this.deps.validateServerName(value);
				if (error) {
					this.#validationError = error;
					this.#show();
					return;
				}
				this.#validationError = null;
				this.step = "transport";
				this.selected = 0;
				break;
			}
			case "command":
				s.command = value;
				this.step = "args";
				break;
			case "args":
				s.args = value;
				void this.#testConnection();
				return;
			case "url": {
				s.url = value;
				let parsed: URL | null = null;
				try {
					parsed = new URL(value);
				} catch {
					this.#validationError = "Invalid URL format (must start with http:// or https://)";
				}
				if (parsed && parsed.protocol !== "http:" && parsed.protocol !== "https:")
					this.#validationError = "URL must use http:// or https:// scheme";
				if (!parsed || this.#validationError) {
					this.#show();
					return;
				}
				void this.#testConnection();
				return;
			}
			case "oauth-auth-url":
				s.oauthAuthUrl = value;
				this.step = "oauth-token-url";
				break;
			case "oauth-token-url":
				s.oauthTokenUrl = value;
				this.step = "oauth-client-id";
				break;
			case "oauth-client-id":
				s.oauthClientId = value;
				this.step = "oauth-client-secret";
				break;
			case "oauth-client-secret":
				s.oauthClientSecret = value;
				this.step = "oauth-scopes";
				break;
			case "oauth-scopes":
				s.oauthScopes = value;
				void this.#signIn();
				return;
			case "apikey":
				s.apiKey = value;
				if (s.transport === "stdio") this.step = "env-var-name";
				else {
					this.step = "auth-location";
					this.selected = 0;
				}
				break;
			case "env-var-name":
				s.envVarName = value;
				s.authLocation = "env";
				this.step = "scope";
				this.selected = 0;
				break;
			case "header-name":
				s.headerName = value;
				s.authLocation = "header";
				this.step = "scope";
				this.selected = 0;
				break;
		}
		this.#show();
	}

	#choose(): void {
		const s = this.state;
		switch (this.step) {
			case "transport":
				s.transport = TRANSPORTS[this.selected] ?? "stdio";
				this.step = s.transport === "stdio" ? "command" : "url";
				break;
			case "auth-method":
				s.authMethod = this.selected === 0 ? "oauth" : "manual";
				this.step = s.authMethod === "oauth" ? "oauth-auth-url" : "apikey";
				break;
			case "oauth-error":
				if (this.selected === 0) {
					void this.#signIn();
					return;
				}
				this.step = "oauth-auth-url";
				break;
			case "auth-location":
				s.authLocation = this.selected === 0 ? "env" : "header";
				this.step = s.authLocation === "env" ? "env-var-name" : "header-name";
				break;
			case "scope":
				s.scope = this.selected === 0 ? "user" : "project";
				this.step = "confirm";
				this.selected = 0;
				break;
			case "confirm":
				if (s.scope) this.callbacks.onComplete(s.name, this.#config(true, false), s.scope);
				return;
		}
		this.#show();
	}

	#maxIndex(): number {
		switch (this.step) {
			case "transport":
				return 2;
			case "auth-method":
			case "oauth-error":
			case "auth-location":
			case "scope":
				return 1;
			default:
				return 0;
		}
	}

	#moveSelection(delta: number): void {
		const count = this.#maxIndex() + 1;
		this.selected = (this.selected + delta + count) % count;
		this.#show();
	}

	#goBack(): void {
		this.#attempt++;
		this.#validationError = null;
		const s = this.state;
		const connection = s.transport === "stdio" ? "args" : "url";
		switch (this.step) {
			case "transport":
				this.step = "name";
				break;
			case "command":
			case "url":
				this.step = "transport";
				this.selected = s.transport === "stdio" ? 0 : s.transport === "http" ? 1 : 2;
				break;
			case "args":
				this.step = "command";
				break;
			case "auth-method":
			case "oauth-auth-url":
			case "apikey":
				this.step = connection;
				break;
			case "auth-location":
				this.step = "apikey";
				break;
			case "env-var-name":
			case "header-name":
				if (s.transport === "stdio") this.step = "apikey";
				else {
					this.step = "auth-location";
					this.selected = s.authLocation === "env" ? 0 : 1;
				}
				break;
			case "oauth-token-url":
				this.step = "oauth-auth-url";
				break;
			case "oauth-client-id":
				this.step = "oauth-token-url";
				break;
			case "oauth-client-secret":
				this.step = "oauth-client-id";
				break;
			case "oauth-scopes":
				this.step = "oauth-client-secret";
				break;
			case "scope":
				this.step =
					s.authMethod === "oauth" ? "oauth-scopes" : s.authLocation === "env" ? "env-var-name" : "header-name";
				break;
			case "oauth-error":
				this.step = "oauth-auth-url";
				break;
			case "confirm":
				this.step = "scope";
				this.selected = s.scope === "user" ? 0 : 1;
				break;
		}
		this.#show();
	}

	// ─── Async steps ────────────────────────────────────────────────────────

	#toScope(): void {
		this.step = "scope";
		this.selected = 0;
		this.#show();
	}

	/** Connect once (no credentials) to learn whether the server needs any. */
	async #testConnection(): Promise<void> {
		const test = this.callbacks.onTestConnection;
		const config = this.#config(false, true);
		if (!test) {
			this.#toScope();
			return;
		}
		const attempt = ++this.#attempt;
		const target = config.type === "stdio" ? [config.command, ...(config.args ?? [])].join(" ") : config.url;
		this.#async({
			phase: 2,
			title: "Trying the connection",
			tone: "accent",
			lead: "omp connects once to see whether the server needs credentials.",
			lines: [{ text: `Connecting to ${displayText(target)}…`, tone: "muted" }],
			statuses: [{ key: "status", state: "busy", label: ["Connecting to ", replaceTabs(target)] }],
		});
		const continueToScope = async (ms: number) => {
			await this.#clock.delay(ms);
			if (attempt !== this.#attempt) return;
			this.state.authMethod = "none";
			this.#toScope();
		};
		try {
			await test(config);
			if (attempt !== this.#attempt) return;
			this.#async({
				phase: 2,
				title: "Connected",
				tone: "success",
				lead: "Next, choose where to save it.",
				lines: [{ text: "✓ No authentication required", tone: "success" }],
				statuses: [{ key: "status", state: "ok", label: "No sign-in needed" }],
			});
			await continueToScope(1000);
		} catch (error) {
			if (attempt !== this.#attempt) return;
			const detected = this.deps.analyzeAuthError(error as Error, this.state.url);
			if (!detected.requiresAuth) {
				this.#async({
					phase: 2,
					title: "Couldn't connect",
					tone: "warning",
					lead: "omp saves the server anyway; fix it later with /mcp.",
					lines: [
						{ text: displayText(error instanceof Error ? error.message : String(error)) },
						{ text: "" },
						{ text: "Adding server anyway...", tone: "muted" },
					],
					statuses: [{ key: "status", state: "busy", label: "Adding the server anyway…" }],
					error: errorText(error),
				});
				await continueToScope(2000);
				return;
			}
			const s = this.state;
			let oauth = detected.authType === "oauth" ? (detected.oauth ?? null) : null;
			if (!oauth && s.transport !== "stdio" && s.url) {
				try {
					oauth = await this.deps.discoverOAuthEndpoints(
						s.url,
						detected.authServerUrl,
						detected.resourceMetadataUrl,
						{
							protectedScopes: detected.scopes,
						},
					);
				} catch {
					// Discovery failed: fall back to an API key.
				}
			}
			if (oauth && !oauth.scopes && detected.resourceMetadataUrl) {
				const scopes = await this.deps.fetchResourceMetadataScopes(detected.resourceMetadataUrl);
				if (scopes) oauth = { ...oauth, scopes };
			}
			if (attempt !== this.#attempt) return;
			if (oauth) {
				s.oauthAuthUrl = oauth.authorizationUrl;
				s.oauthTokenUrl = oauth.tokenUrl;
				s.oauthRegistrationUrl = oauth.registrationUrl || "";
				s.oauthIssuerUrl = oauth.issuerUrl || "";
				s.oauthClientId = oauth.clientId || "";
				s.oauthScopes = oauth.scopes || "";
				s.oauthResource = oauth.resource || (s.transport === "stdio" ? "" : s.url);
				s.oauthResourceIsFallback = !oauth.resource && s.transport !== "stdio";
				s.authMethod = "oauth";
				void this.#signIn();
				return;
			}
			this.step = "apikey";
			this.#show();
		}
	}

	/** The browser sign-in, then a health check with the new credentials. */
	async #signIn(): Promise<void> {
		const signIn = this.callbacks.onOAuth;
		const s = this.state;
		if (!signIn) {
			this.#async({
				phase: PHASE_AUTH,
				title: "Sign-in isn't available",
				tone: "error",
				lines: [{ text: "OAuth login cannot start without a host OAuth handler." }],
				statuses: [
					{ key: "status", state: "error", label: "OAuth login cannot start without a host OAuth handler." },
				],
			});
			return;
		}
		if (!s.oauthAuthUrl || !s.oauthTokenUrl) {
			this.#async({
				phase: PHASE_AUTH,
				title: "OAuth settings incomplete",
				tone: "error",
				lines: [{ text: "Authorization and Token URLs are required." }],
				footer: "go back",
				statuses: [{ key: "status", state: "error", label: "Authorization and token URLs are required." }],
			});
			return;
		}
		const host = URL.parse(s.oauthAuthUrl)?.host;
		this.#async({
			phase: PHASE_AUTH,
			title: "Sign in to continue",
			tone: "accent",
			lead: "Approve access in your browser. If it didn't open, copy the link from the chat.",
			lines: [
				{ text: "Launching OAuth flow..." },
				{ text: "Browser will open automatically.", tone: "muted" },
				{ text: "" },
				{ text: "If browser doesn't open, copy the URL from chat.", tone: "warning" },
			],
			footer: "cancel",
			statuses: [
				{
					key: "status",
					state: "busy",
					label: host ? ["Waiting for ", host, "…"] : "Waiting for the browser…",
				},
			],
			back: "Stop waiting",
		});
		const abort = new AbortController();
		this.#oauthAbort = abort;
		try {
			const fallback = s.oauthResourceIsFallback || (!s.oauthResource && s.transport !== "stdio");
			s.oauthResourceIsFallback = fallback;
			const resource = s.oauthResource || (s.transport === "stdio" ? "" : s.url);
			const result = await signIn(
				s.oauthAuthUrl,
				s.oauthTokenUrl,
				s.oauthClientId,
				s.oauthClientSecret,
				s.oauthScopes,
				{
					serverUrl: s.url || undefined,
					registrationUrl: s.oauthRegistrationUrl || undefined,
					issuerUrl: s.oauthIssuerUrl || undefined,
					resource: resource || undefined,
					stripSameOriginResource: fallback,
					abortSignal: abort.signal,
				},
			);
			this.#oauthAbort = null;
			s.oauthCredentialId = result.credentialId;
			if (result.clientId) s.oauthClientId = result.clientId;
			s.oauthResource = result.resource ?? resource;
			await this.#healthCheck();
		} catch (error) {
			this.#oauthAbort = null;
			const cancelled = error instanceof Error && error.name === "MCPOAuthCancelledError";
			const display = displayText(error instanceof Error ? error.message : String(error));
			let tip: string | undefined;
			if (cancelled) tip = "Try again reopens the browser.";
			else if (display.includes("timeout") || display.includes("timed out"))
				tip = "Complete authorization faster next time.";
			else if (display.includes("Invalid OAuth URLs")) tip = "Check that the OAuth URLs are correct.";
			else if (display.includes("ECONNREFUSED")) tip = "Verify the OAuth server is accessible.";
			this.#failure = { cancelled, message: errorText(error), display, tip };
			this.selected = 0;
			this.step = "oauth-error";
			this.#show();
		}
	}

	async #healthCheck(): Promise<void> {
		const signedIn: WizardStatus = { key: "signed-in", state: "ok", label: "Signed in" };
		const checking = {
			phase: PHASE_AUTH,
			title: "Checking the server",
			tone: "success" as const,
			lead: "omp tries the new credentials before saving.",
			checks: true,
		};
		this.ticks = 0;
		this.#async({
			...checking,
			lines: [
				{ text: "Running connection health check...", tone: "muted" },
				{ text: "Checking server connection...", tone: "muted", spinner: true },
			],
			statuses: [signedIn, { key: "health", state: "busy", label: "Waiting for the server to answer…" }],
		});
		const stop = this.#clock.every(80, () => {
			this.ticks++;
			this.touch();
		});
		let failure: unknown;
		let failed = false;
		const test = this.callbacks.onTestConnection;
		if (test) {
			try {
				const { promise: timeout, reject } = Promise.withResolvers<never>();
				const timer = setTimeout(() => reject(new Error("Health check timed out after 10 seconds")), 10_000);
				try {
					await Promise.race([test(this.#config(true, true)), timeout]);
				} finally {
					clearTimeout(timer);
				}
			} catch (error) {
				failed = true;
				failure = error;
			}
		}
		stop();
		this.#async(
			failed
				? {
						...checking,
						lines: [
							{ text: "Running connection health check...", tone: "muted" },
							{ text: "⚠ Health check failed (will still save config)", tone: "warning" },
							{ text: "" },
							{ text: displayText(failure instanceof Error ? failure.message : String(failure)), tone: "muted" },
						],
						statuses: [
							signedIn,
							{ key: "health", state: "warn", label: "The server didn't answer; omp saves it anyway" },
						],
						error: errorText(failure),
					}
				: {
						...checking,
						lines: [
							{ text: "Running connection health check...", tone: "muted" },
							{ text: "✓ Health check passed", tone: "success" },
						],
						statuses: [signedIn, { key: "health", state: "ok", label: "The server answers" }],
					},
		);
		await this.#clock.delay(failed ? 2000 : 1000);
		this.#toScope();
	}

	/** The server config: with the credentials when `auth`, with the 5s test timeout when `testing`. */
	#config(auth: boolean, testing: boolean): MCPAddWizardConfig {
		const s = this.state;
		const oauth: MCPAddWizardAuth | undefined =
			auth && s.authMethod === "oauth" && s.oauthCredentialId
				? {
						type: "oauth",
						credentialId: s.oauthCredentialId,
						tokenUrl: s.oauthTokenUrl || undefined,
						resource: s.oauthResource || undefined,
						clientId: s.oauthClientId || undefined,
						clientSecret: s.oauthClientSecret || undefined,
					}
				: undefined;
		const key = auth && s.authMethod === "manual" && s.apiKey ? s.apiKey : undefined;
		const transport = s.transport ?? "stdio";
		if (transport === "stdio") {
			const config: MCPAddWizardStdioConfig = { type: "stdio", command: s.command };
			if (testing) config.timeout = 5000;
			if (s.args) config.args = s.args.split(/\s+/).filter(Boolean);
			if (oauth) config.auth = oauth;
			if (key) config.env = { [s.envVarName || "API_KEY"]: key };
			return config;
		}
		const config: MCPAddWizardRemoteConfig = { type: transport, url: s.url };
		if (testing) config.timeout = 5000;
		if (oauth) config.auth = oauth;
		// HTTP servers take the key in a header either way.
		if (key) config.headers = { [s.headerName || "Authorization"]: key };
		return config;
	}
}
