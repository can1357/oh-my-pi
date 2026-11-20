import { cmuxMultiplexer } from "./multiplexers/cmux";
import { herdrMultiplexer } from "./multiplexers/herdr";
import { orcaMultiplexer } from "./multiplexers/orca";
import { screenMultiplexer } from "./multiplexers/screen";
import { tmuxMultiplexer } from "./multiplexers/tmux";
import type { TerminalMultiplexerModule, TerminalMultiplexerNotificationRequest } from "./multiplexers/types";
import { wmuxMultiplexer } from "./multiplexers/wmux";
import { zellijMultiplexer } from "./multiplexers/zellij";

/**
 * Every multiplexer omp recognizes, in classification order within each
 * precedence tier. Adding a multiplexer means adding its module here.
 */
const registry = [
	herdrMultiplexer,
	tmuxMultiplexer,
	screenMultiplexer,
	zellijMultiplexer,
	cmuxMultiplexer,
	wmuxMultiplexer,
	orcaMultiplexer,
] as const satisfies readonly TerminalMultiplexerModule[];

/** Terminal multiplexers omp recognizes. */
export type TerminalMultiplexer = (typeof registry)[number]["id"];

const TERMINAL_MULTIPLEXERS: readonly TerminalMultiplexerModule<TerminalMultiplexer>[] = registry;
const MULTIPLEXERS_BY_ID = Object.fromEntries(
	TERMINAL_MULTIPLEXERS.map(multiplexer => [multiplexer.id, multiplexer]),
) as Record<TerminalMultiplexer, TerminalMultiplexerModule<TerminalMultiplexer>>;
const SESSION_TIER = TERMINAL_MULTIPLEXERS.filter(multiplexer => multiplexer.precedence === "session");
const OUTER_APP_TIER = TERMINAL_MULTIPLEXERS.filter(multiplexer => multiplexer.precedence === "outerApp");
const NOTIFICATION_TIER_ORDER = ["pane", "surface", "inBand"] as const;
// Innermost target first: a pane inside a surface must receive its own signal
// before the containing surface, followed by in-band rewrites. Registry order
// breaks ties within a tier (sort is stable).
const NOTIFIERS = TERMINAL_MULTIPLEXERS.flatMap(multiplexer =>
	multiplexer.notifier ? [{ multiplexer, notifier: multiplexer.notifier }] : [],
).sort((a, b) => NOTIFICATION_TIER_ORDER.indexOf(a.notifier.tier) - NOTIFICATION_TIER_ORDER.indexOf(b.notifier.tier));

/** Every environment variable multiplexer classification reads, including the TERM fallback. */
export const TERMINAL_MULTIPLEXER_ENV_KEYS: readonly string[] = [
	...TERMINAL_MULTIPLEXERS.flatMap(multiplexer => multiplexer.sessionEnvKeys),
	"TERM",
];

/**
 * The multiplexer an attached viewer runs inside, standing in for this process's
 * session markers (see {@link setViewerTerminalMultiplexer}): `null` for a direct
 * viewer, `undefined` while no viewer identity was adopted.
 */
let viewerMultiplexer: TerminalMultiplexer | null | undefined;

/**
 * Adopt the multiplexer identity of the terminal now viewing this process (a hosted
 * session reattached from elsewhere). The viewer's session markers name control
 * sockets of its own terminal, so they are never copied into the environment;
 * instead every session check against the process environment answers for this
 * viewer. Explicit environments passed by callers are unaffected. Unknown ids count
 * as a direct viewer; `undefined` returns to reading the environment.
 */
export function setViewerTerminalMultiplexer(id: string | null | undefined): void {
	if (id === undefined) {
		viewerMultiplexer = undefined;
		return;
	}
	viewerMultiplexer = id !== null && Object.hasOwn(MULTIPLEXERS_BY_ID, id) ? (id as TerminalMultiplexer) : null;
}

/** Whether `multiplexer`'s session is active in `env`, as {@link setViewerTerminalMultiplexer} may override. */
function isInsideSession(multiplexer: TerminalMultiplexerModule<TerminalMultiplexer>, env: NodeJS.ProcessEnv): boolean {
	if (viewerMultiplexer !== undefined && (env === Bun.env || env === process.env)) {
		return multiplexer.id === viewerMultiplexer;
	}
	return multiplexer.isInside(env);
}

/**
 * Whether an explicit session marker identifies the current provider.
 *
 * TERM is intentionally excluded: it is a classification fallback, not proof
 * that a particular multiplexer session owns the current grid.
 */
export function hasTerminalMultiplexerSession(
	multiplexer: TerminalMultiplexer,
	env: NodeJS.ProcessEnv = Bun.env,
): boolean {
	return isInsideSession(MULTIPLEXERS_BY_ID[multiplexer], env);
}

/**
 * Every multiplexer whose explicit session markers are present, in registry
 * order. Nested sessions all appear; TERM is not consulted.
 */
export function terminalMultiplexerSessions(
	env: NodeJS.ProcessEnv = Bun.env,
): TerminalMultiplexerModule<TerminalMultiplexer>[] {
	return TERMINAL_MULTIPLEXERS.filter(multiplexer => isInsideSession(multiplexer, env));
}

/**
 * Whether OSC 11 background replies are trusted on this platform. Any active
 * session with `backgroundQueryBrokenOn` matching the platform makes the entire
 * path untrusted; TERM-only classification does not identify an active session.
 */
export function isTerminalBackgroundQueryTrusted(
	env: NodeJS.ProcessEnv = Bun.env,
	platform: NodeJS.Platform = process.platform,
): boolean {
	return !TERMINAL_MULTIPLEXERS.some(
		multiplexer => isInsideSession(multiplexer, env) && multiplexer.backgroundQueryBrokenOn?.includes(platform),
	);
}

/**
 * The multiplexer TERM names, whether or not its session markers survived.
 * This is classification's TERM fallback; session markers are not consulted.
 */
export function terminalMultiplexerForTerm(
	env: NodeJS.ProcessEnv = Bun.env,
): TerminalMultiplexerModule<TerminalMultiplexer> | undefined {
	const term = env.TERM?.toLowerCase() ?? "";
	return TERMINAL_MULTIPLEXERS.find(
		multiplexer => multiplexer.termPrefix !== undefined && term.startsWith(multiplexer.termPrefix),
	);
}

/**
 * Registry entry for the multiplexer hosting the current process, or
 * `undefined` for a direct terminal. Same precedence as
 * {@link classifyTerminalMultiplexer}.
 */
export function classifyTerminalMultiplexerModule(
	env: NodeJS.ProcessEnv = Bun.env,
): TerminalMultiplexerModule<TerminalMultiplexer> | undefined {
	return (
		SESSION_TIER.find(multiplexer => isInsideSession(multiplexer, env)) ??
		terminalMultiplexerForTerm(env) ??
		OUTER_APP_TIER.find(multiplexer => isInsideSession(multiplexer, env))
	);
}

/**
 * Classify which terminal multiplexer hosts the current process, or `null` for
 * a direct terminal. Single source of truth for both the render-path gate
 * (`isInsideTerminalMultiplexer`) and the debug snapshot label.
 *
 * Session markers are authoritative. TERM can also survive when those markers
 * are stripped (`sudo` without -E, `su`, env-sanitizing launchers/ssh), so a
 * `tmux`/`screen` TERM prefix comes next. Outer applications such as Orca rank
 * last so a multiplexer running inside them wins.
 */
export function classifyTerminalMultiplexer(env: NodeJS.ProcessEnv = Bun.env): TerminalMultiplexer | null {
	return classifyTerminalMultiplexerModule(env)?.id ?? null;
}

/** True when the classified multiplexer owns the current screen grid. */
export function isInsideTerminalMultiplexer(env: NodeJS.ProcessEnv = Bun.env): boolean {
	return classifyTerminalMultiplexerModule(env)?.ownsScreenGrid ?? false;
}

/**
 * Offer a notification to every active session's notifier, innermost tier
 * first. Returns whether one delivered it; otherwise the terminal fallback
 * applies unchanged.
 */
export function routeTerminalMultiplexerNotification(request: TerminalMultiplexerNotificationRequest): boolean {
	return NOTIFIERS.some(({ multiplexer, notifier }) => multiplexer.isInside(request.env) && notifier.send(request));
}
