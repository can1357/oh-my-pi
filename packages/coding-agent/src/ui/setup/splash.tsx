/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The startup splash: the omp lockup over a starfield, "Press ⏎ to begin".
 * The setup wizard opens on it; first launches show it alone before the
 * app. Natively it is the lockup and the hint; the terminal draws the
 * animated backdrop (`../styles/setup/splash.ts`).
 */
import { type Accessor, effect, type JSXNode, type KeyEvent, untrack } from "@oh-my-pi/pi-tui";
import "../styles/setup";
import type { SplashTerm } from "../styles/setup/splash";

/** How long the splash plays before it ends by itself. */
export const SPLASH_MS = 2600;

/** Keys that end the splash. */
export function isSkipKey(key: KeyEvent): boolean {
	return key.id === "enter" || key.id === "space" || key.id === "escape";
}

/** The splash body: lockup and hint; `start` is the clock time the animation counts from. */
export function SplashView(props: {
	readonly version: string;
	readonly start: number;
	/** Node key (the wizard keys its phases). */
	readonly nodeKey?: string;
	readonly onKey?: (key: KeyEvent) => boolean;
	readonly onSkip?: () => void;
}): JSXNode {
	const term: SplashTerm = { start: props.start };
	return (
		<col
			key={props.nodeKey}
			role="omp.setup.splash"
			grow={1}
			align="center"
			actions={{ click: "skip" }}
			term={term}
			onKey={props.onKey}
			onAction={act => {
				if (act === "skip") props.onSkip?.();
			}}
		>
			<spacer key="top" grow={1} />
			<row key="lockup" role="omp.welcome.lockup" align="center" gap="md">
				<image key="logo" role="omp.welcome.logo" builtin="omp" alt="omp" w={128} />
				<col key="mark" role="omp.welcome.mark">
					<text
						key="omp.welcome.wordmark"
						role="omp.welcome.wordmark"
						wrap="none"
						spans={[{ s: "strong", t: "omp" }]}
					/>
					<text
						key="omp.welcome.version"
						role="omp.welcome.version"
						wrap="none"
						spans={[{ s: "dim mono", t: `v${props.version}` }]}
					/>
				</col>
			</row>
			<spacer key="bottom" grow={1} />
			<row key="hint" role="omp.setup.hint" align="center" gap="xs">
				<text spans={[{ s: "muted", t: "Press" }]} />
				<kbd keys={["enter"]} />
				<text spans={[{ s: "muted", t: "to begin" }]} />
			</row>
		</col>
	);
}

export interface StartupSplashProps {
	readonly version: string;
	/** Clock (ms) the animation and the time-out read. */
	readonly now: Accessor<number>;
	/** The splash ended (a key, a click, or the time ran out). */
	onDone(): void;
}

/** The standalone startup splash: ends on Enter/Space/Escape, a click, or after {@link SPLASH_MS}. */
export function StartupSplash(props: StartupSplashProps): JSXNode {
	const start = untrack(props.now);
	let done = false;
	const finish = (): void => {
		if (done) return;
		done = true;
		props.onDone();
	};
	effect(() => {
		if (props.now() - start >= SPLASH_MS) untrack(finish);
	});
	return (
		<SplashView
			version={props.version}
			start={start}
			onSkip={finish}
			onKey={key => {
				if (!isSkipKey(key)) return false;
				finish();
				return true;
			}}
		/>
	);
}
