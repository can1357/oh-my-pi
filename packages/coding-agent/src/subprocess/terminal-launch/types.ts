import type { TerminalMultiplexer } from "@oh-my-pi/pi-tui/terminal-multiplexer";
import type { terminalLaunchCapabilities } from "./providers";

export interface PlacementCapabilities {
	displayName: string;
	execution?: readonly string[];
	/** Descriptive noun for the accepted target, or `false` when the placement rejects one. */
	target?: string | false;
	direction?: readonly string[];
	floating?: true;
	floatingDirectionExclusive?: true;
	focus?: true;
	name?: true;
	label?: true;
	shellGrammar?: "posix";
	cwdShellInput?: true;
	/**
	 * Minimum provider CLI version for the placement itself (`launch`) or for an
	 * option that changes the CLI invocation (`focus: false`, an explicit `target`);
	 * the backend checks it before launching.
	 */
	minimumVersion?: { readonly launch?: string; readonly focus?: string; readonly target?: string };
}

export type SupportedMultiplexerCapabilities = { displayName: string; supported: true } & (
	| { pane: PlacementCapabilities; window?: PlacementCapabilities }
	| { pane?: PlacementCapabilities; window: PlacementCapabilities }
);

export interface UnsupportedMultiplexerCapabilities {
	displayName: string;
	supported: false;
	reason: string;
}

export type TerminalLaunchMultiplexer = {
	[M in TerminalMultiplexer]: (typeof terminalLaunchCapabilities)[M] extends { supported: true } ? M : never;
}[TerminalMultiplexer];

export type TerminalLaunchPlacement = "pane" | "window";

export interface TerminalLaunchPlacementInfo {
	multiplexer: TerminalLaunchMultiplexer;
	displayName: string;
	placementLabel: string;
	shellGrammar?: "posix";
}

type CapabilityValues<C, K extends PropertyKey> = K extends keyof C
	? C[K] extends readonly (infer Value)[]
		? Value
		: never
	: never;

type TargetOption<C> = C extends { target: false }
	? { target?: never }
	: C extends { target: string }
		? { target?: string }
		: { target?: never };

type ExecutionOption<C> = C extends { execution: readonly string[] }
	? { execution?: CapabilityValues<C, "execution"> }
	: { execution?: never };

type DirectionAndFloatingOptions<C> = C extends { floatingDirectionExclusive: true }
	? { floating: true; direction?: never } | { floating?: false; direction?: CapabilityValues<C, "direction"> }
	: {
			direction?: CapabilityValues<C, "direction">;
			floating?: C extends { floating: true } ? boolean : never;
		};

type OptionalStringOption<C, K extends "name" | "label"> =
	C extends Record<K, true> ? { [P in K]?: string } : { [P in K]?: never };

type FocusOption<C> = C extends { focus: true } ? { focus?: boolean } : { focus?: never };

type ShellGrammarOption<C> = C extends { shellGrammar: "posix" } ? { shellGrammar: "posix" } : { shellGrammar?: never };

type RequestOptions<C> = TargetOption<C> &
	ExecutionOption<C> &
	DirectionAndFloatingOptions<C> &
	OptionalStringOption<C, "name"> &
	OptionalStringOption<C, "label"> &
	FocusOption<C> &
	ShellGrammarOption<C>;

type RequestForPlacement<Multiplexer extends TerminalMultiplexer, Placement extends TerminalLaunchPlacement, C> = {
	multiplexer: Multiplexer;
	placement: Placement;
	command: readonly string[];
	cwd: string;
} & RequestOptions<C>;

/** Requests a provider accepts, derived from that provider's own capability entry. */
export type TerminalLaunchRequestFor<Multiplexer extends TerminalMultiplexer, Entry> = {
	[Placement in Extract<keyof Entry, TerminalLaunchPlacement>]: RequestForPlacement<
		Multiplexer,
		Placement,
		Entry[Placement]
	>;
}[Extract<keyof Entry, TerminalLaunchPlacement>];

/** Launch requests per supported provider, derived from the canonical capability map. */
export type TerminalLaunchRequestMap = {
	[M in TerminalLaunchMultiplexer]: TerminalLaunchRequestFor<M, (typeof terminalLaunchCapabilities)[M]>;
};

/** Requests are derived from the canonical capability map, excluding unsupported providers and impossible options. */
export type TerminalLaunchRequest = TerminalLaunchRequestMap[TerminalLaunchMultiplexer];

export interface TerminalLaunchResult {
	multiplexer: TerminalLaunchMultiplexer;
	placement: TerminalLaunchPlacement;
	/** Provider-native pane, terminal handle, tab, workspace, window, or session ID when the CLI reports one. */
	id?: string;
	/** Set when the command started but the provider could not show it where requested. */
	warning?: string;
}

export interface TerminalLaunchCliResult {
	stdout: string;
	exitCode: number | null;
}

/**
 * Receives the exact argv dispatched to a backend CLI and its process cwd. When `env` is set,
 * it replaces the inherited environment for that CLI process.
 */
export type TerminalLaunchCliRunner = (
	argv: readonly string[],
	cwd: string,
	env?: NodeJS.ProcessEnv,
) => Promise<TerminalLaunchCliResult>;

/** Shared runtime inputs supplied to every provider backend. */
export interface TerminalLaunchBackendContext {
	environment: NodeJS.ProcessEnv;
	platform: NodeJS.Platform;
	runCli: TerminalLaunchCliRunner;
}

/** Backend that executes the requests its provider's capability entry allows. */
export type TerminalLaunchBackend<Multiplexer extends TerminalMultiplexer, Capabilities> = (
	request: TerminalLaunchRequestFor<Multiplexer, Capabilities>,
	context: TerminalLaunchBackendContext,
) => Promise<TerminalLaunchResult>;

/** A supported provider's launch capabilities and the backend that executes them. */
export interface TerminalLaunchProvider<
	Multiplexer extends TerminalMultiplexer,
	Capabilities extends SupportedMultiplexerCapabilities,
> {
	capabilities: Capabilities;
	launch: TerminalLaunchBackend<Multiplexer, Capabilities>;
}

/** Sanitized launch failure. Messages deliberately omit command argv, stdout, and stderr. */
export class TerminalLaunchError extends Error {
	constructor(
		message: string,
		public readonly multiplexer: TerminalMultiplexer,
		public readonly placement: TerminalLaunchPlacement,
		public readonly operation: string,
		public readonly exitCode?: number | null,
	) {
		super(message);
		this.name = "TerminalLaunchError";
	}
}

/** @internal Dependency seam for deterministic CLI behavior tests. */
export interface TerminalLaunchDependencies {
	environment?: () => NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	runCli?: TerminalLaunchCliRunner;
}
