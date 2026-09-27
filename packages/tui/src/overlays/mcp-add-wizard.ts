/**
 * MCP Add Wizard Component
 *
 * Interactive multi-step wizard for adding MCP servers.
 */
import { Container, matchesKey, replaceTabs, Spacer, Text, truncateToWidth, wrapTextWithAnsi } from "../index";
import type { Component } from "../tui";
import { getMCPConfigPath, getProjectDir } from "@oh-my-pi/pi-utils";
import { shortenPath } from "../render/render-utils";
import { getSelectListTheme, theme } from "../theme/theme";
import { matchesAppInterrupt, matchesSelectDown, matchesSelectUp } from "../keybinding-matchers";
import { formatKeyHint } from "../app-keybindings";
import { editorKey, editorKeys, interruptKey } from "../chrome/keybinding-hints";
import { OverlayPanel } from "../chrome/overlay-box";
import { TextFormField, type FormFieldTheme } from "../components/form";
import { SelectList } from "../components/select-list";
import { WizardStep, type WizardStepKind } from "../components/wizard-step";

type TransportType = "stdio" | "http" | "sse";
type AuthMethod = "none" | "oauth" | "manual";
type AuthLocation = "env" | "header";
type Scope = "user" | "project";

/** Authentication fields produced by the wizard. */
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

/** Server configuration fields produced for testing and persistence. */
export type MCPAddWizardConfig = MCPAddWizardStdioConfig | MCPAddWizardRemoteConfig;

interface MCPAddWizardOAuthEndpoints {
	authorizationUrl: string;
	tokenUrl: string;
	issuerUrl?: string;
	issParameterSupported?: boolean;
	clientId?: string;
	registrationUrl?: string;
	scopes?: string;
	resource?: string;
}

interface MCPAddWizardAuthDetection {
	requiresAuth: boolean;
	authType?: "oauth" | "apikey" | "unknown";
	oauth?: MCPAddWizardOAuthEndpoints;
	authServerUrl?: string;
	resourceMetadataUrl?: string;
	scopes?: string;
}

/** Host-owned validation and OAuth discovery capabilities. */
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

type MCPWizardStep =
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

/**
 * Result of the wizard's OAuth callback. `credentialId` is mandatory;
 * `clientId` is populated when the OAuth provider performed dynamic client
 * registration (or when the caller pre-supplied it) so the wizard can fold it
 * into the final `mcp.json` entry. Refresh material (including any DCR client
 * secret) is embedded in the stored credential, never written to config files.
 */
export interface MCPAddWizardOAuthResult {
	credentialId: string;
	clientId?: string;
	resource?: string;
}

interface MCPAddWizardOAuthOptions {
	serverUrl?: string;
	resource?: string;
	stripSameOriginResource?: boolean;
	registrationUrl?: string;
	issuerUrl?: string;
	issParameterSupported?: boolean;
	/**
	 * External cancellation source. Aborting it tears down the in-flight OAuth
	 * flow and surfaces a neutral cancellation error. The wizard wires its own
	 * controller here so Esc cancels the OAuth wait instead of stepping back
	 * through the form (the wizard is focused, so the editor's Esc hook does
	 * not fire).
	 */
	abortSignal?: AbortSignal;
}

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
	oauthIssParameterSupported: boolean;
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
	scope: Scope | null;
}

/** Max display width for sanitized error/URL text in wizard TUI */
const MAX_DISPLAY_WIDTH = 120;

/** Sanitize a string for TUI display: replace tabs and truncate */
function sanitize(text: string): string {
	return truncateToWidth(replaceTabs(text), MAX_DISPLAY_WIDTH);
}

/** Footer for text steps; the field submits on `tui.input.submit` and cancels on `tui.select.cancel`. */
function inputHint(escapeAction: string): string {
	return `[${editorKey("tui.input.submit")} to continue, ${editorKey("tui.select.cancel")} to ${escapeAction}]`;
}

/** Footer for choice steps; the wizard routes navigation, Enter, and Escape itself. */
function choiceHint(escapeAction: string): string {
	return `[${editorKeys("tui.select.up", "tui.select.down")} to navigate, ${formatKeyHint("enter")} to select, ${interruptKey()} to ${escapeAction}]`;
}

const mcpFormTheme: FormFieldTheme = {
	label: text => text,
	description: text => theme.fg("muted", text),
	error: text => theme.fg("error", text),
	hint: text => theme.fg("muted", text),
};

interface WizardChoiceOption {
	readonly label: string;
	/** Shown dimmed beneath the row while the row is not highlighted. */
	readonly description?: string;
}

export class MCPAddWizard extends OverlayPanel {
	#deps: MCPAddWizardDeps;
	#currentStep: MCPWizardStep = "name";
	#state: WizardState = {
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
		oauthIssParameterSupported: false,
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

	#contentContainer: Container;
	#step: WizardStep | null = null;
	#stepKind: WizardStepKind = "input";
	#inputField: TextFormField | null = null;
	#selectedIndex = 0;
	#validationError: string | null = null;
	#oauthErrorLines: readonly string[] | null = null;
	#oauthErrorHeading: { text: string; tone: "error" | "muted" } | null = null;
	#onCompleteCallback: (name: string, config: MCPAddWizardConfig, scope: Scope) => void;
	#onCancelCallback: () => void;
	#onOAuthCallback:
		| ((
				authUrl: string,
				tokenUrl: string,
				clientId: string,
				clientSecret: string,
				scopes: string,
				options?: MCPAddWizardOAuthOptions,
		  ) => Promise<MCPAddWizardOAuthResult>)
		| null = null;
	#onTestConnectionCallback: ((config: MCPAddWizardConfig) => Promise<void>) | null = null;
	#onRenderCallback: (() => void) | null = null;
	/**
	 * Set while the OAuth callback is in flight; populated by
	 * {@link #launchOAuthFlow} and consumed by {@link handleInput} so Esc
	 * cancels the OAuth wait instead of stepping back through the form.
	 */
	#oauthAbort: AbortController | null = null;

	constructor(
		deps: MCPAddWizardDeps,
		onComplete: (name: string, config: MCPAddWizardConfig, scope: Scope) => void,
		onCancel: () => void,
		onOAuth?: (
			authUrl: string,
			tokenUrl: string,
			clientId: string,
			clientSecret: string,
			scopes: string,
			options?: MCPAddWizardOAuthOptions,
		) => Promise<MCPAddWizardOAuthResult>,
		onTestConnection?: (config: MCPAddWizardConfig) => Promise<void>,
		onRender?: () => void,
		initialName?: string,
	) {
		super("Add MCP Server");
		this.#deps = deps;
		this.#onCompleteCallback = onComplete;
		this.#onCancelCallback = onCancel;
		this.#onOAuthCallback = onOAuth ?? null;
		this.#onTestConnectionCallback = onTestConnection ?? null;
		this.#onRenderCallback = onRender ?? null;
		if (initialName && initialName.trim().length > 0) {
			this.#state.name = initialName.trim();
			this.#currentStep = "transport";
		}

		this.addChild(new Spacer(1));

		// Content container for step-specific content
		this.#contentContainer = new Container();
		this.addChild(this.#contentContainer);

		this.addChild(new Spacer(1));

		// Render first step
		this.#renderStep();
	}

	#requestRender(): void {
		this.#onRenderCallback?.();
	}

	/** Mount a step as the wizard body. Overlay chrome is unbounded, so no height budget applies. */
	#show(step: WizardStep): void {
		step.setMaxHeight(undefined);
		this.#step = step;
		this.#contentContainer.clear();
		this.#contentContainer.addChild(step);
	}

	#inputStep(options: {
		heading: string;
		prompt: string;
		initial: string;
		hint: string;
		details?: readonly string[];
		optional: boolean;
		error?: string | null;
	}): void {
		this.#stepKind = "input";
		const field = new TextFormField({
			theme: mcpFormTheme,
			label: options.prompt,
			details: options.details?.map(detail => new Text(theme.fg("muted", detail), 0, 0)),
			summary: options.error
				? [new Text(theme.fg("error", `✗ ${sanitize(options.error)}`), 0, 0), new Spacer(1)]
				: undefined,
			hint: options.hint,
			initialValue: options.initial,
			empty: options.optional ? "submit" : "reject",
			emptyError: " ",
			onSubmit: () => this.#saveInputAndProceed(),
			onCancel: () => this.#cancelInputStep(),
		});
		this.#inputField = field;
		this.#show(
			new WizardStep({
				kind: "input",
				heading: new Text(theme.fg("accent", options.heading), 0, 0),
				content: field,
			}),
		);
	}

	#choiceStep(options: {
		heading: string;
		headingTone?: "accent" | "error" | "muted";
		intro?: Component;
		choices: readonly WizardChoiceOption[];
		hint: string;
		kind?: WizardStepKind;
	}): void {
		const tone = options.headingTone ?? "accent";
		const items = options.choices.map((choice, index) => ({
			value: String(index),
			label: choice.label,
			description: choice.description,
		}));
		const list = new SelectList(items, MAX_DISPLAY_WIDTH * Math.max(1, items.length), getSelectListTheme(), {
			search: "never",
			renderItem: ({ item, selected, width }) => {
				const prefix = selected ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
				const label = selected ? theme.fg("accent", item.label) : item.label;
				const lines = wrapTextWithAnsi(prefix + label, width);
				if (item.description && !selected) {
					lines.push(...wrapTextWithAnsi(`    ${theme.fg("dim", item.description)}`, width));
				}
				return lines;
			},
		});
		list.setSelectedIndex(this.#selectedIndex);
		this.#stepKind = options.kind ?? "choice";
		this.#show(
			new WizardStep({
				kind: this.#stepKind,
				heading: new Text(theme.fg(tone, options.heading), 0, 0),
				intro: options.intro,
				content: list,
				footer: new Text(theme.fg("muted", options.hint), 0, 0),
			}),
		);
	}

	#asyncStep(
		heading: string,
		headingTone: "accent" | "success" | "warning" | "error" | "muted",
		body: Component,
		footer?: Component,
	): void {
		this.#stepKind = "async";
		this.#inputField = null;
		this.#show(
			new WizardStep({
				kind: "async",
				heading: new Text(theme.fg(headingTone, heading), 0, 0),
				content: body,
				footer,
			}),
		);
	}

	#cancelInputStep(): void {
		if (this.#currentStep === "name") {
			this.#onCancelCallback();
			return;
		}
		this.#goBack();
	}

	#renderStep(): void {
		this.#contentContainer.clear();
		this.#step = null;
		this.#inputField = null; // Reset input field

		switch (this.#currentStep) {
			case "name":
				this.#renderNameStep();
				break;
			case "transport":
				this.#renderTransportStep();
				break;
			case "command":
				this.#renderCommandStep();
				break;
			case "args":
				this.#renderArgsStep();
				break;
			case "url":
				this.#renderUrlStep();
				break;
			case "auth-method":
				this.#renderAuthMethodStep();
				break;
			case "oauth-error":
				this.#renderOAuthErrorStep();
				break;
			case "oauth-auth-url":
				this.#renderOAuthAuthUrlStep();
				break;
			case "oauth-token-url":
				this.#renderOAuthTokenUrlStep();
				break;
			case "oauth-client-id":
				this.#renderOAuthClientIdStep();
				break;
			case "oauth-client-secret":
				this.#renderOAuthClientSecretStep();
				break;
			case "oauth-scopes":
				this.#renderOAuthScopesStep();
				break;
			case "apikey":
				this.#renderApiKeyStep();
				break;
			case "auth-location":
				this.#renderAuthLocationStep();
				break;
			case "env-var-name":
				this.#renderEnvVarNameStep();
				break;
			case "header-name":
				this.#renderHeaderNameStep();
				break;
			case "scope":
				this.#renderScopeStep();
				break;
			case "confirm":
				this.#renderConfirmStep();
				break;
		}
	}

	#renderNameStep(): void {
		this.#inputStep({
			heading: "Step 1: Server Name",
			prompt: "Enter a unique name for this server:",
			initial: this.#state.name,
			hint: `[Only letters, numbers, dash, underscore, dot, colon]\n${inputHint("cancel")}`,
			optional: false,
			error: this.#validationError,
		});
	}

	#renderTransportStep(): void {
		this.#choiceStep({
			heading: "Step 2: Transport Type",
			intro: new Text("Select the transport type:", 0, 0),
			choices: [
				{ label: "stdio (Local process)" },
				{ label: "http (HTTP server)" },
				{ label: "sse (Server-Sent Events)" },
			],
			hint: choiceHint("cancel"),
		});
	}

	#renderCommandStep(): void {
		this.#inputStep({
			heading: "Step 3: Command",
			prompt: "Enter the command to run:",
			initial: this.#state.command,
			hint: inputHint("go back"),
			optional: false,
		});
	}

	#renderArgsStep(): void {
		this.#inputStep({
			heading: "Step 4: Arguments (Optional)",
			prompt: "Enter command arguments (space-separated):",
			initial: this.#state.args,
			hint: `[Press ${editorKey("tui.input.submit")} to skip or continue]`,
			optional: true,
		});
	}

	#renderUrlStep(): void {
		this.#inputStep({
			heading: "Step 3: Server URL",
			prompt: "Enter the server URL:",
			initial: this.#state.url,
			hint: `[Must start with http:// or https://]\n${inputHint("go back")}`,
			optional: false,
			error: this.#validationError,
		});
	}

	#renderAuthLocationStep(): void {
		this.#choiceStep({
			heading: "Step: How to provide the key?",
			choices: [{ label: "Environment variable" }, { label: "HTTP header" }],
			hint: choiceHint("go back"),
		});
	}

	#renderEnvVarNameStep(): void {
		this.#inputStep({
			heading: "Step: Environment Variable Name",
			prompt: "Enter the environment variable name:",
			initial: this.#state.envVarName,
			hint: inputHint("go back"),
			optional: false,
		});
	}

	#renderHeaderNameStep(): void {
		this.#inputStep({
			heading: "Step: HTTP Header Name",
			prompt: "Enter the HTTP header name:",
			initial: this.#state.headerName,
			hint: inputHint("go back"),
			optional: false,
		});
	}

	#renderScopeStep(): void {
		const cwd = getProjectDir();
		const userPathLabel = shortenPath(getMCPConfigPath("user", cwd));
		const projectPathLabel = shortenPath(getMCPConfigPath("project", cwd));
		this.#choiceStep({
			heading: "Step: Configuration Scope",
			choices: [{ label: `User level (${userPathLabel})` }, { label: `Project level (${projectPathLabel})` }],
			hint: choiceHint("go back"),
		});
	}

	#renderConfirmStep(): void {
		const summary = new Container();
		summary.addChild(new Text(`Name: ${theme.fg("accent", this.#state.name)}`, 0, 0));
		summary.addChild(new Text(`Type: ${this.#state.transport}`, 0, 0));

		if (this.#state.transport === "stdio") {
			summary.addChild(new Text(`Command: ${this.#state.command}`, 0, 0));
			if (this.#state.args) {
				summary.addChild(new Text(`Args: ${this.#state.args}`, 0, 0));
			}
		} else {
			summary.addChild(new Text(`URL: ${sanitize(this.#state.url)}`, 0, 0));
		}

		// Auth info
		if (this.#state.authMethod === "none") {
			summary.addChild(new Text("Auth: None", 0, 0));
		} else if (this.#state.authMethod === "oauth") {
			summary.addChild(new Text("Auth: OAuth (authenticated)", 0, 0));
		} else if (this.#state.authMethod === "manual") {
			if (this.#state.authLocation === "env") {
				summary.addChild(new Text(`Auth: API key via env (${this.#state.envVarName})`, 0, 0));
			} else {
				summary.addChild(new Text(`Auth: API key via header (${this.#state.headerName})`, 0, 0));
			}
		}

		const scopeLabel = this.#state.scope === "user" ? "User level" : "Project level";
		summary.addChild(new Text(`Scope: ${scopeLabel}`, 0, 0));
		summary.addChild(new Spacer(1));
		summary.addChild(new Text("Save this configuration?", 0, 0));

		this.#choiceStep({
			heading: "Review Configuration",
			intro: summary,
			choices: [{ label: "Yes" }, { label: "No" }],
			hint: choiceHint("go back"),
			kind: "confirm",
		});
	}

	handleInput(keyData: string): void {
		// While an OAuth callback is being awaited, Esc/Ctrl+C aborts the flow
		// rather than stepping back through the form: the wizard advertises
		// "(Press Esc to cancel)" during the wait, and stepping back would
		// leave the OAuth login orphaned.
		if (this.#oauthAbort && (keyData === "\x03" || matchesAppInterrupt(keyData))) {
			this.#oauthAbort.abort("MCP OAuth flow cancelled by user");
			return;
		}

		// Handle Ctrl+C to cancel wizard immediately
		if (keyData === "\x03") {
			// Ctrl+C pressed - cancel wizard
			this.#onCancelCallback();
			return;
		}

		// Input steps own Enter/Escape through the field (submit/back or cancel).
		if (this.#inputField) {
			this.#step?.handleInput(keyData);
			return;
		}

		// Async steps ignore selection/submit keys. Escape still follows the
		// controller's existing back path when no in-flight OAuth abort owns it.
		if (this.#stepKind === "async" && !matchesAppInterrupt(keyData)) return;

		// Handle Escape (always handled by wizard)
		if (matchesAppInterrupt(keyData)) {
			if (this.#currentStep === "name") {
				// Cancel wizard
				this.#onCancelCallback();
				return;
			}
			// Go back to previous step
			this.#goBack();
			return;
		}

		// Selector steps - handle Enter
		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			this.#selectCurrentOption();
			return;
		}

		// Handle up/down arrows for selectors
		if (matchesSelectUp(keyData)) {
			this.#moveSelection(-1);
			return;
		}
		if (matchesSelectDown(keyData)) {
			this.#moveSelection(1);
			return;
		}
	}

	#saveInputAndProceed(): void {
		if (!this.#inputField) return;

		const value = this.#inputField.getValue().trim();

		switch (this.#currentStep) {
			case "name": {
				// Validate server name
				const nameError = this.#deps.validateServerName(value);
				if (nameError) {
					this.#validationError = nameError;
					this.#renderStep();
					return;
				}
				this.#validationError = null;
				this.#state.name = value;
				this.#currentStep = "transport";
				this.#selectedIndex = 0;
				break;
			}
			case "command":
				if (!value) {
					// Command is required
					return;
				}
				this.#state.command = value;
				this.#currentStep = "args";
				break;
			case "args":
				this.#state.args = value; // Optional
				void this.#testConnectionAndDetectAuth();
				return;
			case "url": {
				// Validate URL
				if (!value) {
					this.#validationError = "URL is required";
					this.#renderStep();
					return;
				}
				let parsedUrl: URL;
				try {
					parsedUrl = new URL(value);
				} catch {
					this.#validationError = "Invalid URL format (must start with http:// or https://)";
					this.#renderStep();
					return;
				}
				if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
					this.#validationError = "URL must use http:// or https:// scheme";
					this.#renderStep();
					return;
				}
				this.#validationError = null;
				this.#state.url = value;
				void this.#testConnectionAndDetectAuth();
				return;
			}
			case "oauth-auth-url":
				if (!value) return;
				this.#state.oauthAuthUrl = value;
				this.#currentStep = "oauth-token-url";
				break;
			case "oauth-token-url":
				if (!value) return;
				this.#state.oauthTokenUrl = value;
				this.#currentStep = "oauth-client-id";
				break;
			case "oauth-client-id":
				if (!value) return;
				this.#state.oauthClientId = value;
				this.#currentStep = "oauth-client-secret";
				break;
			case "oauth-client-secret":
				this.#state.oauthClientSecret = value; // Optional
				this.#currentStep = "oauth-scopes";
				break;
			case "oauth-scopes":
				this.#state.oauthScopes = value; // Optional
				// Launch OAuth flow
				void this.#launchOAuthFlow();
				return;
			case "apikey":
				if (!value) {
					// API key is required
					return;
				}
				this.#state.apiKey = value;
				// Determine auth location based on transport
				if (this.#state.transport === "stdio") {
					this.#currentStep = "env-var-name";
				} else {
					this.#currentStep = "auth-location";
					this.#selectedIndex = 0;
				}
				break;
			case "env-var-name":
				if (!value) {
					return;
				}
				this.#state.envVarName = value;
				this.#state.authLocation = "env";
				this.#currentStep = "scope";
				this.#selectedIndex = 0;
				break;
			case "header-name":
				if (!value) {
					return;
				}
				this.#state.headerName = value;
				this.#state.authLocation = "header";
				this.#currentStep = "scope";
				this.#selectedIndex = 0;
				break;
		}

		this.#inputField = null;
		this.#renderStep();
	}

	#selectCurrentOption(): void {
		switch (this.#currentStep) {
			case "transport": {
				const transports: TransportType[] = ["stdio", "http", "sse"];
				this.#state.transport = transports[this.#selectedIndex];
				this.#currentStep = this.#state.transport === "stdio" ? "command" : "url";
				break;
			}
			case "auth-method": {
				const authMethods: Array<"oauth" | "manual"> = ["oauth", "manual"];
				this.#state.authMethod = authMethods[this.#selectedIndex];
				if (this.#state.authMethod === "oauth") {
					this.#clearDiscoveredIssuer();
					this.#currentStep = "oauth-auth-url";
				} else {
					// manual
					this.#currentStep = "apikey";
				}
				break;
			}
			case "oauth-error":
				if (this.#selectedIndex === 0) {
					void this.#launchOAuthFlow();
				} else {
					// Editing the endpoints invalidates metadata discovered for
					// the previous ones.
					this.#clearDiscoveredIssuer();
					this.#currentStep = "oauth-auth-url";
				}
				return;
			case "auth-location": {
				const authLocations: Array<"env" | "header"> = ["env", "header"];
				this.#state.authLocation = authLocations[this.#selectedIndex];
				if (this.#state.authLocation === "env") {
					this.#currentStep = "env-var-name";
				} else {
					this.#currentStep = "header-name";
				}
				break;
			}
			case "scope": {
				const scopes: Scope[] = ["user", "project"];
				this.#state.scope = scopes[this.#selectedIndex];
				this.#currentStep = "confirm";
				this.#selectedIndex = 0;
				break;
			}
			case "confirm": {
				if (this.#selectedIndex === 0) {
					this.#complete();
					return;
				}
				this.#currentStep = "scope";
				this.#selectedIndex = this.#state.scope === "user" ? 0 : 1;
				break;
			}
		}

		this.#renderStep();
	}

	#moveSelection(delta: number): void {
		const maxIndex = this.#getMaxIndexForCurrentStep();
		this.#selectedIndex = (this.#selectedIndex + delta + maxIndex + 1) % (maxIndex + 1);
		this.#renderStep();
		this.#requestRender();
	}

	#getMaxIndexForCurrentStep(): number {
		switch (this.#currentStep) {
			case "transport":
				return 2; // 3 options
			case "auth-method":
				return 1; // 2 options
			case "oauth-error":
				return 1; // 2 options
			case "auth-location":
				return 1; // 2 options
			case "scope":
				return 1; // 2 options
			case "confirm":
				return 1; // 2 options
			default:
				return 0;
		}
	}

	/**
	 * Drop issuer metadata discovered for the previous endpoints.
	 *
	 * Called on every entry to the authorization-URL step: once the user can
	 * change the endpoints, the previously discovered `issuerUrl` and
	 * `issParameterSupported` no longer describe the server being configured,
	 * so forwarding them would reject valid callbacks (or accept tampered
	 * ones) once the OAuth flow starts.
	 */
	#clearDiscoveredIssuer(): void {
		this.#state.oauthIssuerUrl = "";
		this.#state.oauthIssParameterSupported = false;
	}

	#goBack(): void {
		// Navigate to previous step
		switch (this.#currentStep) {
			case "transport":
				this.#currentStep = "name";
				break;
			case "command":
			case "url":
				this.#currentStep = "transport";
				this.#selectedIndex = this.#state.transport === "stdio" ? 0 : this.#state.transport === "http" ? 1 : 2;
				break;
			case "args":
				this.#currentStep = "command";
				break;
			case "auth-method":
				// Go back to url or args depending on transport
				if (this.#state.transport === "stdio") {
					this.#currentStep = "args";
				} else {
					this.#currentStep = "url";
				}
				break;
			case "oauth-auth-url":
			case "apikey":
				// Go back to transport-specific connection step
				if (this.#state.transport === "stdio") {
					this.#currentStep = "args";
				} else {
					this.#currentStep = "url";
				}
				break;
			case "auth-location":
				// Go back to API key input
				this.#currentStep = "apikey";
				break;
			case "env-var-name":
			case "header-name":
				// Go back to auth location selection (for HTTP) or directly to apikey (for stdio)
				if (this.#state.transport === "stdio") {
					this.#currentStep = "apikey";
				} else {
					this.#currentStep = "auth-location";
					this.#selectedIndex = this.#state.authLocation === "env" ? 0 : 1;
				}
				break;
			case "oauth-token-url":
			case "oauth-client-id":
			case "oauth-client-secret":
			case "oauth-scopes":
				// Go back through OAuth flow
				if (this.#currentStep === "oauth-token-url") {
					this.#clearDiscoveredIssuer();
					this.#currentStep = "oauth-auth-url";
				} else if (this.#currentStep === "oauth-client-id") {
					this.#currentStep = "oauth-token-url";
				} else if (this.#currentStep === "oauth-client-secret") {
					this.#currentStep = "oauth-client-id";
				} else if (this.#currentStep === "oauth-scopes") {
					this.#currentStep = "oauth-client-secret";
				}
				break;
			case "scope":
				// Go back to last authentication step
				if (this.#state.authMethod === "oauth") {
					this.#currentStep = "oauth-scopes";
				} else {
					// manual - go back to env var name or header name
					if (this.#state.authLocation === "env") {
						this.#currentStep = "env-var-name";
					} else {
						this.#currentStep = "header-name";
					}
				}
				break;
			case "oauth-error":
				// Editing the endpoints (the only reason to go back here)
				// invalidates metadata discovered for the previous ones.
				this.#clearDiscoveredIssuer();
				this.#currentStep = "oauth-auth-url";
				break;
			case "confirm":
				this.#currentStep = "scope";
				this.#selectedIndex = this.#state.scope === "user" ? 0 : 1;
				break;
		}

		this.#renderStep();
	}

	#renderAuthMethodStep(): void {
		this.#choiceStep({
			heading: "Step: Authentication Method",
			choices: [
				{ label: "OAuth flow (web-based)", description: "(opens browser)" },
				{ label: "Manual API key/token", description: "(paste or use shell command)" },
			],
			hint: choiceHint("go back"),
		});
	}

	#renderOAuthAuthUrlStep(): void {
		this.#inputStep({
			heading: "OAuth: Authorization URL",
			prompt: "Enter the OAuth authorization endpoint:",
			initial: this.#state.oauthAuthUrl,
			details: ["e.g., https://auth.example.com/oauth/authorize"],
			hint: inputHint("go back"),
			optional: false,
		});
	}

	#renderOAuthTokenUrlStep(): void {
		this.#inputStep({
			heading: "OAuth: Token URL",
			prompt: "Enter the OAuth token endpoint:",
			initial: this.#state.oauthTokenUrl,
			details: ["e.g., https://auth.example.com/oauth/token"],
			hint: inputHint("go back"),
			optional: false,
		});
	}

	#renderOAuthClientIdStep(): void {
		this.#inputStep({
			heading: "OAuth: Client ID",
			prompt: "Enter your OAuth client ID:",
			initial: this.#state.oauthClientId,
			hint: inputHint("go back"),
			optional: false,
		});
	}

	#renderOAuthClientSecretStep(): void {
		this.#inputStep({
			heading: "OAuth: Client Secret (Optional)",
			prompt: "Enter your OAuth client secret:",
			initial: this.#state.oauthClientSecret,
			details: ["(Leave empty for PKCE-only flows)"],
			hint: inputHint("go back"),
			optional: true,
		});
	}

	#renderOAuthScopesStep(): void {
		this.#inputStep({
			heading: "OAuth: Scopes (Optional)",
			prompt: "Enter OAuth scopes (space-separated):",
			initial: this.#state.oauthScopes,
			details: ["e.g., read write"],
			hint: inputHint("go back"),
			optional: true,
		});
	}

	#renderOAuthErrorStep(): void {
		const intro = new Container();
		const errorLines = this.#oauthErrorLines ?? [];
		for (let index = 0; index < errorLines.length; index++) {
			intro.addChild(new Text(errorLines[index] ?? "", 0, 0));
			intro.addChild(new Spacer(1));
		}
		intro.addChild(new Text("Choose next action:", 0, 0));
		this.#choiceStep({
			heading: this.#oauthErrorHeading?.text ?? "OAuth authentication failed",
			headingTone: this.#oauthErrorHeading?.tone ?? "error",
			intro,
			choices: [{ label: "Retry OAuth authentication" }, { label: "Edit OAuth settings" }],
			hint: choiceHint("go back"),
		});
	}

	#renderApiKeyStep(): void {
		this.#inputStep({
			heading: "API Key Required",
			prompt: "Enter your API key or token:",
			initial: this.#state.apiKey,
			details: ["(Supports !command for password manager)"],
			hint: inputHint("go back"),
			optional: false,
		});
	}

	/**
	 * Test connection and automatically detect if auth is needed.
	 */
	async #testConnectionAndDetectAuth(): Promise<void> {
		const testConfig = this.#buildServerConfig();

		if (!this.#onTestConnectionCallback) {
			// Skip test, go to scope
			this.#currentStep = "scope";
			this.#selectedIndex = 0;
			this.#renderStep();
			return;
		}

		try {
			// Try to connect - timeout is handled by the transport layer (5 seconds)
			await this.#onTestConnectionCallback(testConfig);

			// Success! No auth required
			const successBody = new Container();
			successBody.addChild(new Text("No authentication required", 0, 0));
			this.#asyncStep("✓ Connection successful!", "success", successBody);

			setTimeout(() => {
				this.#state.authMethod = "none";
				this.#currentStep = "scope";
				this.#selectedIndex = 0;
				this.#renderStep();
			}, 1000);
		} catch (error) {
			// Connection failed - check if it's an auth error
			const authResult = this.#deps.analyzeAuthError(error as Error, this.#state.url);

			if (authResult.requiresAuth) {
				// Prefer OAuth first: use error metadata, then well-known discovery fallback.
				let oauth = authResult.authType === "oauth" ? (authResult.oauth ?? null) : null;
				if (!oauth && this.#state.transport !== "stdio" && this.#state.url) {
					try {
						oauth = await this.#deps.discoverOAuthEndpoints(
							this.#state.url,
							authResult.authServerUrl,
							authResult.resourceMetadataUrl,
							{ protectedScopes: authResult.scopes },
						);
					} catch {
						// Ignore discovery failures and fallback to manual auth.
					}
				}
				if (oauth && !oauth.scopes && authResult.resourceMetadataUrl) {
					// JSON-error-body path skips `discoverOAuthEndpoints` when the body
					// already carries endpoints, so scopes advertised only in the
					// protected-resource metadata document never reach the grant.
					const scopes = await this.#deps.fetchResourceMetadataScopes(authResult.resourceMetadataUrl);
					if (scopes) oauth = { ...oauth, scopes };
				}

				if (oauth) {
					this.#state.oauthAuthUrl = oauth.authorizationUrl;
					this.#state.oauthTokenUrl = oauth.tokenUrl;
					this.#state.oauthRegistrationUrl = oauth.registrationUrl || "";
					this.#state.oauthIssuerUrl = oauth.issuerUrl || "";
					this.#state.oauthIssParameterSupported = oauth.issParameterSupported === true;
					this.#state.oauthClientId = oauth.clientId || "";
					this.#state.oauthScopes = oauth.scopes || "";
					this.#state.oauthResource = oauth.resource || (this.#state.transport === "stdio" ? "" : this.#state.url);
					this.#state.oauthResourceIsFallback = !oauth.resource && this.#state.transport !== "stdio";
					this.#state.authMethod = "oauth";

					const oauthBody = new Container();
					oauthBody.addChild(new Text("Launching browser for authorization...", 0, 0));
					this.#asyncStep("✓ OAuth detected", "success", oauthBody);

					void this.#launchOAuthFlow();
					return;
				}

				// OAuth metadata unavailable: fallback to manual API key.
				this.#currentStep = "apikey";
				this.#renderStep();
			} else {
				// Not an auth error - just a connection failure
				const errorMsg = sanitize(error instanceof Error ? error.message : String(error));
				const failureBody = new Container();
				failureBody.addChild(new Text(errorMsg, 0, 0));
				failureBody.addChild(new Spacer(1));
				failureBody.addChild(new Text(theme.fg("muted", "Adding server anyway..."), 0, 0));
				this.#asyncStep("✗ Connection failed", "error", failureBody);

				setTimeout(() => {
					this.#state.authMethod = "none";
					this.#currentStep = "scope";
					this.#selectedIndex = 0;
					this.#renderStep();
				}, 2000);
			}
		}
	}

	/**
	 * Build a server config from current wizard state for connection testing (no auth).
	 */
	#buildServerConfig(): MCPAddWizardConfig {
		return this.#buildServerConfigWithAuth(false);
	}

	#buildServerConfigWithAuth(includeAuth: boolean): MCPAddWizardConfig {
		const transport = this.#state.transport ?? "stdio";

		if (transport === "stdio") {
			const config: MCPAddWizardStdioConfig = {
				type: "stdio",
				command: this.#state.command,
				timeout: 5000,
			};

			if (this.#state.args) {
				config.args = this.#state.args.split(/\s+/).filter(Boolean);
			}

			if (includeAuth && this.#state.authMethod === "oauth" && this.#state.oauthCredentialId) {
				config.auth = {
					type: "oauth",
					credentialId: this.#state.oauthCredentialId,
					tokenUrl: this.#state.oauthTokenUrl || undefined,
					resource: this.#state.oauthResource || undefined,
					clientId: this.#state.oauthClientId || undefined,
					clientSecret: this.#state.oauthClientSecret || undefined,
				};
			}

			if (includeAuth && this.#state.authMethod === "manual" && this.#state.apiKey) {
				config.env = {
					...config.env,
					[this.#state.envVarName || "API_KEY"]: this.#state.apiKey,
				};
			}

			return config;
		}

		// http or sse
		const config: MCPAddWizardRemoteConfig = {
			type: transport,
			url: this.#state.url,
			timeout: 5000,
		};

		if (includeAuth && this.#state.authMethod === "oauth" && this.#state.oauthCredentialId) {
			config.auth = {
				type: "oauth",
				credentialId: this.#state.oauthCredentialId,
				tokenUrl: this.#state.oauthTokenUrl || undefined,
				resource: this.#state.oauthResource || undefined,
				clientId: this.#state.oauthClientId || undefined,
				clientSecret: this.#state.oauthClientSecret || undefined,
			};
		}

		if (includeAuth && this.#state.authMethod === "manual" && this.#state.apiKey) {
			if (this.#state.authLocation === "env") {
				// For HTTP with env location, store in headers using the env var name as-is
				config.headers = {
					...config.headers,
					[this.#state.headerName || "Authorization"]: this.#state.apiKey,
				};
			} else {
				const headerName = this.#state.headerName || "Authorization";
				config.headers = {
					...config.headers,
					[headerName]: this.#state.apiKey,
				};
			}
		}

		return config;
	}

	async #launchOAuthFlow(): Promise<void> {
		if (!this.#onOAuthCallback) {
			const unavailableBody = new Container();
			unavailableBody.addChild(new Text("OAuth login cannot start without a host OAuth handler.", 0, 0));
			this.#asyncStep("OAuth flow not available", "error", unavailableBody);
			this.#requestRender();
			return;
		}

		// Validate OAuth configuration
		if (!this.#state.oauthAuthUrl || !this.#state.oauthTokenUrl) {
			const incompleteBody = new Container();
			incompleteBody.addChild(new Text("Authorization and Token URLs are required.", 0, 0));
			this.#asyncStep(
				"OAuth configuration incomplete",
				"error",
				incompleteBody,
				new Text(theme.fg("muted", `[Press ${interruptKey()} to go back]`), 0, 0),
			);
			this.#requestRender();
			return;
		}

		// Show "Authenticating..." message
		const authBody = new Container();
		authBody.addChild(new Text("Launching OAuth flow...", 0, 0));
		authBody.addChild(new Text(theme.fg("muted", "Browser will open automatically."), 0, 0));
		authBody.addChild(new Spacer(1));
		authBody.addChild(new Text(theme.fg("warning", "If browser doesn't open, copy the URL from chat."), 0, 0));
		this.#asyncStep(
			"OAuth Authentication",
			"accent",
			authBody,
			new Text(theme.fg("muted", `(Press ${interruptKey()} to cancel)`), 0, 0),
		);
		this.#requestRender();

		this.#oauthAbort = new AbortController();
		try {
			// Call OAuth handler
			const oauthResourceIsFallback =
				this.#state.oauthResourceIsFallback || (!this.#state.oauthResource && this.#state.transport !== "stdio");
			this.#state.oauthResourceIsFallback = oauthResourceIsFallback;
			const oauthResource = this.#state.oauthResource || (this.#state.transport === "stdio" ? "" : this.#state.url);
			const oauthResult = await this.#onOAuthCallback(
				this.#state.oauthAuthUrl,
				this.#state.oauthTokenUrl,
				this.#state.oauthClientId,
				this.#state.oauthClientSecret,
				this.#state.oauthScopes,
				{
					serverUrl: this.#state.url || undefined,
					registrationUrl: this.#state.oauthRegistrationUrl || undefined,
					issuerUrl: this.#state.oauthIssuerUrl || undefined,
					issParameterSupported: this.#state.oauthIssParameterSupported || undefined,
					resource: oauthResource || undefined,
					stripSameOriginResource: oauthResourceIsFallback,
					abortSignal: this.#oauthAbort.signal,
				},
			);

			// Store credential ID + any dynamically-registered client id. DCR client
			// secrets stay embedded in the stored credential, never in mcp.json.
			this.#state.oauthCredentialId = oauthResult.credentialId;
			if (oauthResult.clientId) this.#state.oauthClientId = oauthResult.clientId;
			this.#state.oauthResource = oauthResult.resource ?? oauthResource;

			// Show success message
			const healthBody = new Container();
			healthBody.addChild(new Text(theme.fg("muted", "Running connection health check..."), 0, 0));
			const spinnerFrames = theme.spinnerFrames;
			const initialFrame = spinnerFrames[0] ?? "|";
			const healthText = new Text(theme.fg("muted", `${initialFrame} Checking server connection...`), 0, 0);
			healthBody.addChild(healthText);
			this.#asyncStep("✓ Authentication successful!", "success", healthBody);

			let spinnerIndex = 0;
			const spinner = setInterval(() => {
				healthText.setText(
					theme.fg("muted", `${spinnerFrames[spinnerIndex % spinnerFrames.length]} Checking server connection...`),
				);
				spinnerIndex++;
				this.#requestRender();
			}, 80);

			let healthPassed = true;
			let healthError = "";
			if (this.#onTestConnectionCallback) {
				try {
					const { promise: timeoutPromise, reject: timeoutReject } = Promise.withResolvers<never>();
					const timer = setTimeout(
						() => timeoutReject(new Error("Health check timed out after 10 seconds")),
						10_000,
					);
					try {
						await Promise.race([
							this.#onTestConnectionCallback(this.#buildServerConfigWithAuth(true)),
							timeoutPromise,
						]);
					} finally {
						clearTimeout(timer);
					}
				} catch (error) {
					healthPassed = false;
					healthError = sanitize(error instanceof Error ? error.message : String(error));
				}
			}

			clearInterval(spinner);
			if (healthPassed) {
				healthText.setText(theme.fg("success", "✓ Health check passed"));
			} else {
				healthText.setText(theme.fg("warning", "⚠ Health check failed (will still save config)"));
				healthBody.addChild(new Spacer(1));
				healthBody.addChild(new Text(theme.fg("muted", healthError), 0, 0));
			}
			this.#requestRender();

			// Move to scope selection after short delay
			setTimeout(
				() => {
					this.#currentStep = "scope";
					this.#selectedIndex = 0;
					this.#renderStep();
					this.#requestRender();
				},
				healthPassed ? 1000 : 2000,
			);
		} catch (error) {
			// User cancellation has its own neutral heading + tip; everything else
			// keeps the "OAuth authentication failed" framing so the existing tips
			// stay meaningful. Name-matching avoids importing controller types.
			const cancelled = error instanceof Error && error.name === "MCPOAuthCancelledError";
			const errorMsg = sanitize(error instanceof Error ? error.message : String(error));
			const tipLines: string[] = [errorMsg];
			if (cancelled) {
				tipLines.push(theme.fg("muted", "Tip: Choose Retry to launch the browser again."));
			} else if (errorMsg.includes("timeout") || errorMsg.includes("timed out")) {
				tipLines.push(theme.fg("muted", "Tip: Complete authorization faster next time"));
			} else if (errorMsg.includes("Invalid OAuth URLs")) {
				tipLines.push(theme.fg("muted", "Tip: Check that the OAuth URLs are correct"));
			} else if (errorMsg.includes("ECONNREFUSED")) {
				tipLines.push(theme.fg("muted", "Tip: Verify the OAuth server is accessible"));
			}

			// Set up as a selector step
			this.#selectedIndex = 0;
			this.#currentStep = "oauth-error";
			this.#oauthErrorHeading = cancelled
				? { text: "○ OAuth cancelled", tone: "muted" }
				: { text: "✗ OAuth authentication failed", tone: "error" };
			this.#oauthErrorLines = tipLines;
			this.#renderStep();
			this.#requestRender();
		} finally {
			this.#oauthAbort = null;
		}
	}

	#complete(): void {
		if (!this.#state.scope) return;

		// Build the config
		const config: MCPAddWizardConfig = this.#buildConfig();

		// Call completion callback
		this.#onCompleteCallback(this.#state.name, config, this.#state.scope);
	}

	#buildConfig(): MCPAddWizardConfig {
		if (this.#state.transport === "stdio") {
			const config: MCPAddWizardStdioConfig = {
				type: "stdio",
				command: this.#state.command,
			};

			if (this.#state.args) {
				config.args = this.#state.args.split(/\s+/).filter(Boolean);
			}

			// Add OAuth auth if configured
			if (this.#state.authMethod === "oauth" && this.#state.oauthCredentialId) {
				config.auth = {
					type: "oauth",
					credentialId: this.#state.oauthCredentialId,
					tokenUrl: this.#state.oauthTokenUrl || undefined,
					resource: this.#state.oauthResource || undefined,
					clientId: this.#state.oauthClientId || undefined,
					clientSecret: this.#state.oauthClientSecret || undefined,
				};
			}

			// Add API key to env if manual auth — use user-chosen env var name
			if (this.#state.authMethod === "manual" && this.#state.apiKey) {
				const envKey = this.#state.envVarName || "API_KEY";
				config.env = {
					[envKey]: this.#state.apiKey,
				};
			}

			return config;
		}

		// HTTP or SSE — use concrete type
		const config: MCPAddWizardRemoteConfig = {
			type: this.#state.transport!,
			url: this.#state.url,
		};

		// Add OAuth auth if configured
		if (this.#state.authMethod === "oauth" && this.#state.oauthCredentialId) {
			config.auth = {
				type: "oauth",
				credentialId: this.#state.oauthCredentialId,
				tokenUrl: this.#state.oauthTokenUrl || undefined,
				resource: this.#state.oauthResource || undefined,
				clientId: this.#state.oauthClientId || undefined,
				clientSecret: this.#state.oauthClientSecret || undefined,
			};
		}

		// Add API key using user-chosen header name and auth location
		if (this.#state.authMethod === "manual" && this.#state.apiKey) {
			if (this.#state.authLocation === "env") {
				// Env-based auth for HTTP: store the key in env on the config
				// HTTP/SSE configs don't have an env field, so use headers as carrier
				const headerName = this.#state.headerName || "Authorization";
				config.headers = {
					[headerName]: this.#state.apiKey,
				};
			} else {
				// Header-based auth: use the user's chosen header name
				const headerName = this.#state.headerName || "Authorization";
				config.headers = {
					[headerName]: this.#state.apiKey,
				};
			}
		}

		return config;
	}
}
