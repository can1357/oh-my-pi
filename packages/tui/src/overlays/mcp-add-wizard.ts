/**
 * MCP Add Wizard Component
 *
 * Interactive multi-step wizard for adding MCP servers.
 */
import { Container, matchesKey, replaceTabs, Spacer, Text, truncateToWidth, wrapTextWithAnsi } from "../index";
import type { Component } from "../tui";
import * as path from "node:path";
import { getMCPConfigPath, getProjectDir } from "@oh-my-pi/pi-utils";
import { shortenPath } from "../render/render-utils";
import { getSelectListTheme, theme } from "../theme/theme";
import type { TspText } from "@oh-my-pi/pi-wire";
import { matchesAppInterrupt, matchesSelectDown, matchesSelectUp } from "../keybinding-matchers";
import { formatKeyHint } from "../app-keybindings";
import { boundKeys, editorKey, editorKeys, interruptKey } from "../chrome/keybinding-hints";
import type { KeyName } from "../key-hint-format";
import { getKeybindings } from "../keybindings";
import { OverlayPanel } from "../chrome/overlay-box";
import { TextFormField, type FormFieldTheme } from "../components/form";
import { SelectList } from "../components/select-list";
import { WizardStep, type WizardStepKind } from "../components/wizard-step";
import { col, compact, node, row, span, text } from "../native/describe";
import { type DescribeContext, leafKey, type NativeChild, type NativeNode, type NativeUiEvent } from "../native/node";
import { actionBar, actionButton } from "../native/overlay";
import { plainText } from "../native/spans";
import { isNativeRendering } from "../native/state";

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

/** An error message for a native text node: whole (the terminal wraps it), tabs expanded, no escapes. */
function nativeErrorText(error: unknown): string {
	return plainText(error instanceof Error ? error.message : String(error));
}

/** Footer for text steps; the field submits on `tui.input.submit` and cancels on `tui.select.cancel`. */
function inputHint(escapeAction: string): string {
	return `[${editorKey("tui.input.submit")} to continue, ${editorKey("tui.select.cancel")} to ${escapeAction}]`;
}

/** Footer for choice steps; the wizard routes navigation, Enter, and Escape itself. */
function choiceHint(escapeAction: string): string {
	return `[${editorKeys("tui.select.up", "tui.select.down")} to navigate, ${formatKeyHint("enter")} to select, ${interruptKey()} to ${escapeAction}]`;
}

/** The wizard's phases, the native progress strip's segments in order. */
const PHASES = ["Name", "Transport", "Connection", "Auth", "Scope", "Review"] as const;
const PHASE_NAME = 0;
const PHASE_TRANSPORT = 1;
const PHASE_CONNECTION = 2;
const PHASE_AUTH = 3;
const PHASE_SCOPE = 4;
const PHASE_REVIEW = 5;

/** The phase each step belongs to. */
const STEP_PHASE: Readonly<Record<MCPWizardStep, number>> = {
	name: PHASE_NAME,
	transport: PHASE_TRANSPORT,
	command: PHASE_CONNECTION,
	args: PHASE_CONNECTION,
	url: PHASE_CONNECTION,
	"auth-method": PHASE_AUTH,
	"oauth-error": PHASE_AUTH,
	"oauth-auth-url": PHASE_AUTH,
	"oauth-token-url": PHASE_AUTH,
	"oauth-client-id": PHASE_AUTH,
	"oauth-client-secret": PHASE_AUTH,
	"oauth-scopes": PHASE_AUTH,
	apikey: PHASE_AUTH,
	"auth-location": PHASE_AUTH,
	"env-var-name": PHASE_AUTH,
	"header-name": PHASE_AUTH,
	scope: PHASE_SCOPE,
	confirm: PHASE_REVIEW,
};

/** Transport choices in list order. */
const TRANSPORTS: readonly TransportType[] = ["stdio", "http", "sse"];

/** How each transport reads as a choice and in the review. */
const TRANSPORT_CHOICES: Readonly<Record<TransportType, { icon: string; label: string; description: string }>> = {
	stdio: { icon: "terminal", label: "Local command", description: "omp starts it on this machine" },
	http: { icon: "globe", label: "Remote server", description: "Streamable HTTP endpoint" },
	sse: { icon: "broadcast", label: "Server-sent events", description: "Older HTTP servers" },
};

const SCOPE_LABELS: Readonly<Record<Scope, string>> = { user: "Every project", project: "This project" };

/** The ANSI heading: the step's title and where it sits among the phases. */
function ansiHeading(title: string, tone: "accent" | "success" | "warning" | "error" | "muted", phase: number): Text {
	return new Text(`${theme.fg(tone, title)}${theme.fg("dim", `  ${phase + 1}/${PHASES.length}`)}`, 0, 0);
}

/** A status line of a native async step: a spinner while busy, else a toned icon. */
function statusRow(state: "busy" | "ok" | "warn" | "error" | "off", label: TspText, key = "status"): NativeNode {
	if (state === "busy") {
		return node(
			"row",
			{ role: "omp.mcpAdd.status", gap: "sm", align: "center" },
			[node("spinner", { style: "orbit", tone: "accent" }), text(label, { wrap: "word" })],
			key,
		);
	}
	const [icon, tone] = (
		{
			ok: ["check", "success"],
			warn: ["warn", "warning"],
			error: ["x-circle", "error"],
			off: ["slash-circle", "muted"],
		} as const
	)[state];
	return node(
		"row",
		{ role: "omp.mcpAdd.status", tone, gap: "sm", align: "center" },
		[node("icon", { name: icon, tone }), text(label, { wrap: "word" })],
		key,
	);
}

/** A tool's own error message, whole, in a quiet mono well. */
function errorBlock(message: string, key = "error"): NativeNode {
	return { ...text(message, { role: "omp.mcpAdd.error", wrap: "word" }), key };
}

/** Footer buttons of a native step: what Esc runs (`undefined`: Esc cancels) and what Enter runs (`undefined`: nothing). */
interface NativeStepActions {
	readonly back?: string;
	/** The key Escape is bound to on this step (Back's, or Cancel's when there is no Back). */
	readonly backKey?: KeyName;
	readonly next?: string;
	/** The key `next` mirrors (Enter in a choice, the field's submit key in an input step). */
	readonly nextKey?: KeyName;
}

/** What the native description shows for the mounted step (the ANSI view mounts a {@link WizardStep}). */
interface NativeWizardStep {
	readonly phase: number;
	readonly title: string;
	readonly lead?: string;
	/** An optional field: the title carries an `Optional` tag. */
	readonly optional?: boolean;
	/** Nodes, and a text step's `Input`, under the title and over the choices. */
	readonly body: readonly NativeChild[];
	readonly choices?: readonly WizardChoiceOption[];
	readonly actions: NativeStepActions;
}

const mcpFormTheme: FormFieldTheme = {
	label: text => text,
	description: text => theme.fg("muted", text),
	error: text => theme.fg("error", text),
	hint: text => theme.fg("muted", text),
};

interface WizardChoiceOption {
	readonly label: string;
	/** Shown dimmed beneath the row while the row is not highlighted (ANSI), after the label (native). */
	readonly description?: string;
	/** Native row's detail when it differs from `description` (a mono path). */
	readonly detail?: TspText;
	/** Native row icon. */
	readonly icon?: string;
	/** A short machine tag at the row's end (`stdio`); the ANSI label carries it in parentheses. */
	readonly tag?: string;
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
	/** Why the last OAuth attempt ended: the error (whole for native, fitted for ANSI) and a tip. */
	#oauthFailure: { cancelled: boolean; message: string; ansiMessage: string; tip?: string } | null = null;
	/**
	 * Bumped when a connection test starts and whenever the user steps back, so
	 * a test that settles after the user left its step doesn't move the wizard.
	 */
	#attempt = 0;
	#nativeStep: NativeWizardStep = { phase: PHASE_NAME, title: "", body: [], actions: {} };
	/** Memoized native description; dropped whenever a step mounts or its body changes. */
	#native: NativeNode | undefined;
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
		super("Add MCP Server", "omp.overlay.mcpAdd");
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
	#show(step: WizardStep, native: NativeWizardStep): void {
		step.setMaxHeight(undefined);
		this.#step = step;
		this.#contentContainer.clear();
		this.#contentContainer.addChild(step);
		this.#nativeStep = native;
		this.#native = undefined;
	}

	/** Replace the mounted step's native body (async steps update in place). */
	#setNativeBody(body: readonly NativeChild[]): void {
		this.#nativeStep = { ...this.#nativeStep, body };
		this.#native = undefined;
	}

	/**
	 * A text step. `lead` says what the field wants (the ANSI field's label),
	 * `placeholder` is an example value (the ANSI view lists it as a detail),
	 * `note` a constraint under the field, `escape` what Escape does
	 * (`undefined`: an optional step whose only hint is skipping).
	 */
	#inputStep(options: {
		title: string;
		lead: string;
		initial: string;
		placeholder?: string;
		note?: string;
		escape?: string;
		optional: boolean;
		secret?: boolean;
		error?: string | null;
	}): void {
		this.#stepKind = "input";
		const phase = STEP_PHASE[this.#currentStep];
		const keyHint =
			options.escape === undefined
				? `[Press ${editorKey("tui.input.submit")} to skip or continue]`
				: inputHint(options.escape);
		const field = new TextFormField({
			theme: mcpFormTheme,
			label: options.lead,
			details: options.placeholder ? [new Text(theme.fg("muted", `e.g. ${options.placeholder}`), 0, 0)] : undefined,
			summary: options.error
				? [new Text(theme.fg("error", `✗ ${sanitize(options.error)}`), 0, 0), new Spacer(1)]
				: undefined,
			hint: options.note ? `[${options.note}]\n${keyHint}` : keyHint,
			initialValue: options.initial,
			secret: options.secret,
			empty: options.optional ? "submit" : "reject",
			emptyError: " ",
			onSubmit: () => this.#saveInputAndProceed(),
			onCancel: () => this.#cancelInputStep(),
		});
		field.input.placeholder = options.placeholder;
		this.#inputField = field;
		const caption = options.error
			? text([span(plainText(options.error), "error")], { role: "omp.mcpAdd.note", wrap: "word" })
			: options.note
				? text(options.note, { role: "omp.mcpAdd.note", wrap: "word" })
				: undefined;
		const cancelKey = getKeybindings().getKeys("tui.select.cancel")[0] ?? "escape";
		this.#show(
			new WizardStep({ kind: "input", heading: ansiHeading(options.title, "accent", phase), content: field }),
			{
				phase,
				title: options.title,
				lead: options.lead,
				optional: options.optional,
				body: [
					node(
						"col",
						{ role: "omp.mcpAdd.field", gap: "xs", ...(options.error ? { tone: "error" as const } : {}) },
						compact([field.input, caption]),
						"field",
					),
				],
				actions: {
					back: this.#currentStep === "name" ? undefined : "Back",
					backKey: cancelKey,
					next: "Continue",
					nextKey: getKeybindings().getKeys("tui.input.submit")[0] ?? "enter",
				},
			},
		);
	}

	/** `escape` names what Escape does; `intro` replaces the ANSI lead; `body` sits between the lead and the choices. */
	#choiceStep(options: {
		title: string;
		lead?: string;
		headingTone?: "accent" | "error" | "muted";
		intro?: Component;
		body?: readonly NativeChild[];
		choices: readonly WizardChoiceOption[];
		escape: string;
	}): void {
		const tone = options.headingTone ?? "accent";
		const phase = STEP_PHASE[this.#currentStep];
		const items = options.choices.map((choice, index) => ({
			value: String(index),
			label: choice.tag ? `${choice.label} (${choice.tag})` : choice.label,
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
		this.#stepKind = "choice";
		this.#show(
			new WizardStep({
				kind: "choice",
				heading: ansiHeading(options.title, tone, phase),
				intro: options.intro ?? (options.lead ? new Text(options.lead, 0, 0) : undefined),
				content: list,
				footer: new Text(theme.fg("muted", choiceHint(options.escape)), 0, 0),
			}),
			{
				phase,
				title: options.title,
				lead: options.lead,
				body: options.body ?? [],
				choices: options.choices,
				actions: {
					back: this.#currentStep === "name" ? undefined : "Back",
					backKey: boundKeys("app.interrupt", ["escape"])[0] ?? "escape",
					next: "Continue",
					nextKey: "enter",
				},
			},
		);
	}

	/**
	 * A step the wizard is working through (connection test, OAuth): `ansi` and
	 * `native` describe its body; `back` labels what Escape does there.
	 */
	#asyncStep(options: {
		phase: number;
		title: string;
		tone: "accent" | "success" | "warning" | "error" | "muted";
		lead?: string;
		ansi: Component;
		native: readonly NativeChild[];
		footer?: Component;
		back?: string;
	}): void {
		this.#stepKind = "async";
		this.#inputField = null;
		this.#show(
			new WizardStep({
				kind: "async",
				heading: ansiHeading(options.title, options.tone, options.phase),
				content: options.ansi,
				footer: options.footer,
			}),
			{
				phase: options.phase,
				title: options.title,
				lead: options.lead,
				body: options.native,
				actions: { back: options.back ?? "Back", backKey: boundKeys("app.interrupt", ["escape"])[0] ?? "escape" },
			},
		);
	}

	/**
	 * The sheet: the phase strip, the step's title and lead, its body (field,
	 * status, summary), its choices, and a footer whose buttons run what
	 * Escape, Enter and Ctrl+C run.
	 */
	override describe(_cx: DescribeContext): NativeNode {
		if (this.#native) return this.#native;
		const step = this.#nativeStep;
		const title = row(
			compact([
				text(step.title, { role: "omp.mcpAdd.title", wrap: "word" }),
				step.optional && text("Optional", { role: "omp.mcpAdd.tag" }),
			]),
			{ gap: "sm", align: "center" },
		);
		const head = compact([title, step.lead ? text(step.lead, { role: "omp.mcpAdd.lead", wrap: "word" }) : undefined]);
		const children: NativeChild[] = [
			this.#describeProgress(step.phase),
			node("col", { role: "omp.mcpAdd.head", gap: "xs" }, head, "head"),
			...step.body,
		];
		if (step.choices) {
			const items = step.choices.map((choice, index) =>
				node(
					"item",
					{
						label: choice.label,
						...(choice.detail || choice.description ? { detail: choice.detail ?? choice.description } : {}),
						...(choice.icon ? { icon: choice.icon } : {}),
						...(choice.tag ? { value: [span(choice.tag, "mono")] } : {}),
					},
					undefined,
					String(index),
				),
			);
			// Keyed per step: a double-click's trailing event never lands on the next step's list.
			children.push(
				node(
					"list",
					{ selected: String(this.#selectedIndex), role: "omp.mcpAdd.choices" },
					items,
					`choices-${this.#currentStep}`,
				),
			);
		}
		children.push(this.#describeActions(step.actions));
		// The wizard replaces the editor in the dock; its sheet hoists into the terminal's layer.
		const sheet = node(
			"overlay",
			{ role: this.nativeRole, head: "Add MCP server", anchor: "center", size: "md", modal: true },
			[col(children, { gap: "lg" })],
			"sheet",
		);
		this.#native = col([sheet]);
		return this.#native;
	}

	/** The phase strip: phases behind filled, the current one lit, Auth dashed when the server needed none. */
	#describeProgress(phase: number): NativeNode {
		const authSkipped = phase > PHASE_AUTH && this.#state.authMethod === "none";
		const segments = PHASES.map((label, index) => {
			const skipped = index === PHASE_AUTH && authSkipped;
			const tone = index === phase ? "accent" : index > phase ? "muted" : skipped ? "neutral" : "success";
			return node(
				"col",
				{ role: "omp.mcpAdd.phase", tone, ...(skipped ? { title: "Auth · not needed" } : {}) },
				[text(label)],
				label,
			);
		});
		return node("row", { role: "omp.mcpAdd.progress", gap: "xs" }, segments, "progress");
	}

	/** Cancel on the left; Back and the step's one primary action on the right. Keys live in the tooltips. */
	#describeActions(actions: NativeStepActions): NativeNode {
		const buttons: (NativeNode | null)[] = [
			actionButton("Cancel", "cancel", { keys: actions.back === undefined ? actions.backKey : "ctrl+c" }),
			null,
		];
		if (actions.back) buttons.push(actionButton(actions.back, "back", { keys: actions.backKey }));
		if (actions.next) buttons.push(actionButton(actions.next, "next", { keys: actions.nextKey, tone: "accent" }));
		return actionBar(buttons);
	}

	/**
	 * A click on a choice is Enter on it, exactly as highlighting it with the
	 * arrows and pressing Enter; the footer's buttons run what their keys run.
	 */
	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type === "action") {
			this.#runAction(event.act);
			return;
		}
		if (event.type !== "select" && event.type !== "activate") return;
		if (leafKey(event.key) !== `choices-${this.#currentStep}`) return;
		if (this.#inputField || this.#stepKind === "async" || this.#oauthAbort) return;
		const index = Number(event.item);
		if (!Number.isInteger(index) || index < 0 || index > this.#getMaxIndexForCurrentStep()) return;
		this.#selectedIndex = index;
		this.#selectCurrentOption();
		this.#requestRender();
	}

	/** Cancel is Ctrl+C, Back is Escape, Next is Enter. */
	#runAction(act: string): void {
		switch (act) {
			case "cancel":
				this.#oauthAbort?.abort("MCP OAuth flow cancelled by user");
				this.#onCancelCallback();
				return;
			case "back":
				if (this.#oauthAbort) this.#oauthAbort.abort("MCP OAuth flow cancelled by user");
				else if (this.#inputField) this.#cancelInputStep();
				else if (this.#currentStep === "name") this.#onCancelCallback();
				else this.#goBack();
				break;
			case "next":
				if (this.#inputField) this.#inputField.submit();
				else if (this.#stepKind !== "async") this.#selectCurrentOption();
				break;
			default:
				return;
		}
		this.#requestRender();
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
			title: "Name the server",
			lead: "A unique name: it labels the server in /mcp and prefixes its tools.",
			initial: this.#state.name,
			placeholder: "github",
			note: "Letters, numbers, dash, underscore, dot and colon",
			escape: "cancel",
			optional: false,
			error: this.#validationError,
		});
	}

	#renderTransportStep(): void {
		this.#choiceStep({
			title: "How does omp reach it?",
			lead: `Pick how ${this.#state.name} talks to omp.`,
			choices: TRANSPORTS.map(transport => ({ ...TRANSPORT_CHOICES[transport], tag: transport })),
			escape: "go back",
		});
	}

	#renderCommandStep(): void {
		this.#inputStep({
			title: "Command",
			lead: "The program omp starts for this server.",
			initial: this.#state.command,
			placeholder: "npx",
			escape: "go back",
			optional: false,
		});
	}

	#renderArgsStep(): void {
		this.#inputStep({
			title: "Arguments",
			lead: `Passed to ${this.#state.command}, separated by spaces. omp tries the connection next.`,
			initial: this.#state.args,
			placeholder: "-y @modelcontextprotocol/server-github",
			optional: true,
		});
	}

	#renderUrlStep(): void {
		this.#inputStep({
			title: "Server URL",
			lead: `Where ${this.#state.name} listens. omp tries the connection next.`,
			initial: this.#state.url,
			placeholder: "https://mcp.example.com/mcp",
			note: "Starts with http:// or https://",
			escape: "go back",
			optional: false,
			error: this.#validationError,
		});
	}

	#renderAuthLocationStep(): void {
		this.#choiceStep({
			title: "Where does the key go?",
			lead: "How the server expects to receive it.",
			choices: [
				{ icon: "terminal", label: "Environment variable", description: "Set when the server starts" },
				{ icon: "globe", label: "HTTP header", description: "Sent with every request" },
			],
			escape: "go back",
		});
	}

	#renderEnvVarNameStep(): void {
		this.#inputStep({
			title: "Environment variable",
			lead: "The variable the server reads its key from.",
			initial: this.#state.envVarName,
			placeholder: "API_KEY",
			escape: "go back",
			optional: false,
		});
	}

	#renderHeaderNameStep(): void {
		this.#inputStep({
			title: "Header name",
			lead: "The HTTP header that carries the key.",
			initial: this.#state.headerName,
			placeholder: "Authorization",
			escape: "go back",
			optional: false,
		});
	}

	/** Where `scope`'s config file is: relative inside the project, else `~`-shortened. */
	#configPathLabel(scope: Scope): string {
		const cwd = getProjectDir();
		const file = getMCPConfigPath(scope, cwd);
		const relative = path.relative(cwd, file);
		return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : shortenPath(file);
	}

	#renderScopeStep(): void {
		const userPath = this.#configPathLabel("user");
		const projectPath = this.#configPathLabel("project");
		this.#choiceStep({
			title: "Where should it live?",
			lead: "Saved for you everywhere, or only in this project's config.",
			choices: [
				{ icon: "home", label: SCOPE_LABELS.user, description: userPath, detail: [span(userPath, "mono")] },
				{
					icon: "folder",
					label: SCOPE_LABELS.project,
					description: projectPath,
					detail: [span(projectPath, "mono")],
				},
			],
			escape: "go back",
		});
	}

	#renderConfirmStep(): void {
		const state = this.#state;
		const transport = state.transport ?? "stdio";
		const scope = state.scope ?? "user";
		const scopePath = this.#configPathLabel(scope);
		// `ansi` is the value in the ANSI summary; `v` the native `kv` value (it styles and fits values itself).
		const entries: { k: string; v: TspText; ansi: string }[] = [
			{ k: "Name", v: [span(state.name, "strong")], ansi: theme.fg("accent", state.name) },
			{
				k: "Transport",
				v: [span(`${TRANSPORT_CHOICES[transport].label}  `), span(transport, "mono muted")],
				ansi: transport,
			},
		];
		if (transport === "stdio") {
			entries.push({ k: "Command", v: [span(state.command, "mono")], ansi: state.command });
			if (state.args) entries.push({ k: "Arguments", v: [span(state.args, "mono")], ansi: state.args });
		} else {
			entries.push({ k: "URL", v: [span(replaceTabs(state.url), "mono")], ansi: sanitize(state.url) });
		}
		if (state.authMethod === "oauth") {
			entries.push({ k: "Auth", v: "OAuth, signed in", ansi: "OAuth (authenticated)" });
		} else if (state.authMethod === "manual") {
			const [where, name] = state.authLocation === "env" ? ["env", state.envVarName] : ["header", state.headerName];
			entries.push({
				k: "Auth",
				v: [span(where === "env" ? "API key in " : "API key in header "), span(name, "mono")],
				ansi: `API key via ${where} (${name})`,
			});
		} else {
			entries.push({ k: "Auth", v: [span("None", "muted")], ansi: "None" });
		}
		entries.push({
			k: "Saved in",
			v: [span(`${SCOPE_LABELS[scope]}  `), span(scopePath, "mono muted")],
			ansi: `${SCOPE_LABELS[scope]} (${scopePath})`,
		});

		const summary = new Container();
		for (const entry of entries) summary.addChild(new Text(`${entry.k}: ${entry.ansi}`, 0, 0));
		summary.addChild(new Spacer(1));
		summary.addChild(new Text("Save this configuration?", 0, 0));
		this.#stepKind = "confirm";
		this.#show(
			new WizardStep({
				kind: "confirm",
				heading: ansiHeading("Review", "accent", PHASE_REVIEW),
				content: summary,
				footer: new Text(
					theme.fg("muted", `[${formatKeyHint("enter")} to save, ${interruptKey()} to go back]`),
					0,
					0,
				),
			}),
			{
				phase: PHASE_REVIEW,
				title: "Review and save",
				lead: "omp connects to the server as soon as it is saved.",
				body: [
					node(
						"kv",
						{ role: "omp.mcpAdd.summary", items: entries.map(entry => ({ k: entry.k, v: entry.v })) },
						undefined,
						"summary",
					),
				],
				actions: {
					back: "Back",
					backKey: boundKeys("app.interrupt", ["escape"])[0] ?? "escape",
					next: "Save server",
					nextKey: "enter",
				},
			},
		);
	}

	/** Route enhanced clipboard text into the active wizard field, never the hidden chat editor. */
	pasteText(text: string): void {
		if (this.#stepKind === "input") this.#inputField?.pasteText(text);
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
				// Validate server name; a rejected name stays in the field to be fixed.
				this.#state.name = value;
				const nameError = this.#deps.validateServerName(value);
				if (nameError) {
					this.#validationError = nameError;
					this.#renderStep();
					return;
				}
				this.#validationError = null;
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
				// Validate URL; a rejected URL stays in the field to be fixed.
				this.#state.url = value;
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
				this.#state.transport = TRANSPORTS[this.#selectedIndex] ?? "stdio";
				this.#currentStep = this.#state.transport === "stdio" ? "command" : "url";
				break;
			}
			case "auth-method": {
				const authMethods: Array<"oauth" | "manual"> = ["oauth", "manual"];
				this.#state.authMethod = authMethods[this.#selectedIndex];
				if (this.#state.authMethod === "oauth") {
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
					return;
				}
				this.#currentStep = "oauth-auth-url";
				break;
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
			case "confirm":
				this.#complete();
				return;
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
			default:
				return 0;
		}
	}

	#goBack(): void {
		// A connection test still running for the step being left must not move the wizard on.
		this.#attempt++;
		this.#validationError = null;
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
			title: "How does it authenticate?",
			lead: `${this.#state.name} needs credentials before omp can use it.`,
			choices: [
				{ icon: "log-in", label: "Sign in with OAuth", description: "Opens your browser" },
				{ icon: "key", label: "API key or token", description: "Paste it, or run a command that prints it" },
			],
			escape: "go back",
		});
	}

	#renderOAuthAuthUrlStep(): void {
		this.#inputStep({
			title: "Authorization URL",
			lead: "The provider's OAuth authorize endpoint.",
			initial: this.#state.oauthAuthUrl,
			placeholder: "https://auth.example.com/oauth/authorize",
			escape: "go back",
			optional: false,
		});
	}

	#renderOAuthTokenUrlStep(): void {
		this.#inputStep({
			title: "Token URL",
			lead: "The endpoint that exchanges the authorization code for a token.",
			initial: this.#state.oauthTokenUrl,
			placeholder: "https://auth.example.com/oauth/token",
			escape: "go back",
			optional: false,
		});
	}

	#renderOAuthClientIdStep(): void {
		this.#inputStep({
			title: "Client ID",
			lead: "The ID of the OAuth app registered with the provider.",
			initial: this.#state.oauthClientId,
			escape: "go back",
			optional: false,
		});
	}

	#renderOAuthClientSecretStep(): void {
		this.#inputStep({
			title: "Client secret",
			lead: "Leave it empty for PKCE-only flows.",
			initial: this.#state.oauthClientSecret,
			escape: "go back",
			optional: true,
			secret: true,
		});
	}

	#renderOAuthScopesStep(): void {
		this.#inputStep({
			title: "Scopes",
			lead: "What omp may access, separated by spaces. Sign-in starts next.",
			initial: this.#state.oauthScopes,
			placeholder: "read write",
			escape: "go back",
			optional: true,
		});
	}

	#renderOAuthErrorStep(): void {
		const failure = this.#oauthFailure;
		const cancelled = failure?.cancelled ?? false;
		const intro = new Container();
		if (failure) {
			intro.addChild(new Text(failure.ansiMessage, 0, 0));
			intro.addChild(new Spacer(1));
			if (failure.tip) {
				intro.addChild(new Text(theme.fg("muted", `Tip: ${failure.tip}`), 0, 0));
				intro.addChild(new Spacer(1));
			}
		}
		intro.addChild(new Text("Choose next action:", 0, 0));
		const body = compact([
			failure && !cancelled ? errorBlock(failure.message) : undefined,
			failure?.tip ? { ...text(failure.tip, { role: "omp.mcpAdd.note", wrap: "word" }), key: "tip" } : undefined,
		]);
		this.#choiceStep({
			title: cancelled ? "Sign-in cancelled" : "Sign-in failed",
			headingTone: cancelled ? "muted" : "error",
			lead: cancelled
				? "The browser sign-in stopped before it finished."
				: "The provider didn't finish signing you in.",
			intro,
			body,
			choices: [
				{ icon: "repeat", label: "Try again", description: "Opens the browser again" },
				{ icon: "sliders", label: "Edit OAuth settings", description: "Endpoints, client and scopes" },
			],
			escape: "go back",
		});
	}

	#renderApiKeyStep(): void {
		this.#inputStep({
			title: "API key",
			lead: "Paste the key or token. Start with ! to run a command that prints it, e.g. a password manager.",
			initial: this.#state.apiKey,
			placeholder: "!op read op://dev/github/token",
			escape: "go back",
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

		const attempt = ++this.#attempt;
		const target =
			testConfig.type === "stdio" ? [testConfig.command, ...(testConfig.args ?? [])].join(" ") : testConfig.url;
		this.#asyncStep({
			phase: PHASE_CONNECTION,
			title: "Trying the connection",
			tone: "accent",
			lead: "omp connects once to see whether the server needs credentials.",
			ansi: new Text(theme.fg("muted", `Connecting to ${sanitize(target)}…`), 0, 0),
			native: [statusRow("busy", [span("Connecting to "), span(replaceTabs(target), "mono")])],
		});
		this.#requestRender();
		/** After a delay, on to the scope step unless the user stepped back meanwhile. */
		const continueToScope = (delay: number) =>
			setTimeout(() => {
				if (attempt !== this.#attempt) return;
				this.#state.authMethod = "none";
				this.#currentStep = "scope";
				this.#selectedIndex = 0;
				this.#renderStep();
				this.#requestRender();
			}, delay);

		try {
			// Try to connect - timeout is handled by the transport layer (5 seconds)
			await this.#onTestConnectionCallback(testConfig);
			if (attempt !== this.#attempt) return;

			// Success! No auth required
			this.#asyncStep({
				phase: PHASE_CONNECTION,
				title: "Connected",
				tone: "success",
				lead: "Next, choose where to save it.",
				ansi: new Text(theme.fg("success", "✓ No authentication required"), 0, 0),
				native: [statusRow("ok", "No sign-in needed")],
			});
			this.#requestRender();
			continueToScope(1000);
		} catch (error) {
			if (attempt !== this.#attempt) return;
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

				if (attempt !== this.#attempt) return;
				if (oauth) {
					this.#state.oauthAuthUrl = oauth.authorizationUrl;
					this.#state.oauthTokenUrl = oauth.tokenUrl;
					this.#state.oauthRegistrationUrl = oauth.registrationUrl || "";
					this.#state.oauthIssuerUrl = oauth.issuerUrl || "";
					this.#state.oauthClientId = oauth.clientId || "";
					this.#state.oauthScopes = oauth.scopes || "";
					this.#state.oauthResource = oauth.resource || (this.#state.transport === "stdio" ? "" : this.#state.url);
					this.#state.oauthResourceIsFallback = !oauth.resource && this.#state.transport !== "stdio";
					this.#state.authMethod = "oauth";

					// #launchOAuthFlow shows its own step at once.
					void this.#launchOAuthFlow();
					return;
				}

				// OAuth metadata unavailable: fallback to manual API key.
				this.#currentStep = "apikey";
				this.#renderStep();
				this.#requestRender();
			} else {
				// Not an auth error - just a connection failure
				const failureBody = new Container();
				failureBody.addChild(new Text(sanitize(error instanceof Error ? error.message : String(error)), 0, 0));
				failureBody.addChild(new Spacer(1));
				failureBody.addChild(new Text(theme.fg("muted", "Adding server anyway..."), 0, 0));
				this.#asyncStep({
					phase: PHASE_CONNECTION,
					title: "Couldn't connect",
					tone: "warning",
					lead: "omp saves the server anyway; fix it later with /mcp.",
					ansi: failureBody,
					native: [errorBlock(nativeErrorText(error)), statusRow("busy", "Adding the server anyway…")],
				});
				this.#requestRender();
				continueToScope(2000);
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
			this.#asyncStep({
				phase: PHASE_AUTH,
				title: "Sign-in isn't available",
				tone: "error",
				ansi: new Text("OAuth login cannot start without a host OAuth handler.", 0, 0),
				native: [statusRow("error", "OAuth login cannot start without a host OAuth handler.")],
			});
			this.#requestRender();
			return;
		}

		// Validate OAuth configuration
		if (!this.#state.oauthAuthUrl || !this.#state.oauthTokenUrl) {
			this.#asyncStep({
				phase: PHASE_AUTH,
				title: "OAuth settings incomplete",
				tone: "error",
				ansi: new Text("Authorization and Token URLs are required.", 0, 0),
				native: [statusRow("error", "Authorization and token URLs are required.")],
				footer: new Text(theme.fg("muted", `[Press ${interruptKey()} to go back]`), 0, 0),
			});
			this.#requestRender();
			return;
		}

		// Show "Authenticating..." message
		const authBody = new Container();
		authBody.addChild(new Text("Launching OAuth flow...", 0, 0));
		authBody.addChild(new Text(theme.fg("muted", "Browser will open automatically."), 0, 0));
		authBody.addChild(new Spacer(1));
		authBody.addChild(new Text(theme.fg("warning", "If browser doesn't open, copy the URL from chat."), 0, 0));
		const authHost = URL.parse(this.#state.oauthAuthUrl)?.host;
		this.#asyncStep({
			phase: PHASE_AUTH,
			title: "Sign in to continue",
			tone: "accent",
			lead: "Approve access in your browser. If it didn't open, copy the link from the chat.",
			ansi: authBody,
			native: [
				statusRow(
					"busy",
					authHost ? [span("Waiting for "), span(authHost, "mono"), span("…")] : "Waiting for the browser…",
				),
			],
			footer: new Text(theme.fg("muted", `(Press ${interruptKey()} to cancel)`), 0, 0),
			back: "Stop waiting",
		});
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
			const signedIn = statusRow("ok", "Signed in", "signed-in");
			const checks = (health: NativeNode) =>
				node("col", { role: "omp.mcpAdd.checks", gap: "sm" }, [signedIn, health], "checks");
			this.#asyncStep({
				phase: PHASE_AUTH,
				title: "Checking the server",
				tone: "success",
				lead: "omp tries the new credentials before saving.",
				ansi: healthBody,
				native: [checks(statusRow("busy", "Waiting for the server to answer…", "health"))],
			});

			// The frame ticker only repaints; a native terminal animates the described spinner itself.
			let spinnerIndex = 0;
			const spinner = isNativeRendering()
				? undefined
				: setInterval(() => {
						healthText.setText(
							theme.fg(
								"muted",
								`${spinnerFrames[spinnerIndex % spinnerFrames.length]} Checking server connection...`,
							),
						);
						spinnerIndex++;
						this.#requestRender();
					}, 80);

			let healthPassed = true;
			let healthError = "";
			let nativeHealthError = "";
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
					nativeHealthError = nativeErrorText(error);
				}
			}

			clearInterval(spinner);
			if (healthPassed) {
				healthText.setText(theme.fg("success", "✓ Health check passed"));
				this.#setNativeBody([checks(statusRow("ok", "The server answers", "health"))]);
			} else {
				healthText.setText(theme.fg("warning", "⚠ Health check failed (will still save config)"));
				healthBody.addChild(new Spacer(1));
				healthBody.addChild(new Text(theme.fg("muted", healthError), 0, 0));
				this.#setNativeBody([
					checks(statusRow("warn", "The server didn't answer; omp saves it anyway", "health")),
					errorBlock(nativeHealthError),
				]);
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
			const ansiMessage = sanitize(error instanceof Error ? error.message : String(error));
			let tip: string | undefined;
			if (cancelled) {
				tip = "Try again reopens the browser.";
			} else if (ansiMessage.includes("timeout") || ansiMessage.includes("timed out")) {
				tip = "Complete authorization faster next time.";
			} else if (ansiMessage.includes("Invalid OAuth URLs")) {
				tip = "Check that the OAuth URLs are correct.";
			} else if (ansiMessage.includes("ECONNREFUSED")) {
				tip = "Verify the OAuth server is accessible.";
			}
			this.#oauthFailure = { cancelled, message: nativeErrorText(error), ansiMessage, tip };

			// Set up as a selector step
			this.#selectedIndex = 0;
			this.#currentStep = "oauth-error";
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
