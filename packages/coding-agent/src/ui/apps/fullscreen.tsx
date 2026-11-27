/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Fullscreen apps (`omp git`, `omp ps`, the debug viewers, the console
 * monitor): one app view in a full-size overlay over a {@link Shell}, which
 * the terminal renderer draws on the alternate screen and Tern as a
 * fullscreen sheet.
 *
 * {@link presentFullscreen} opens the app on a running shell (interactive
 * mode's `/git`, `/debug`); {@link runStandalone} starts a shell of its own
 * for a CLI command and restores the terminal when the app finishes.
 */
import { type Accessor, type JSXNode, type PageProps, signal, type UiNode } from "@oh-my-pi/pi-tui";
import type { MouseTracking } from "@oh-my-pi/pi-tui/driver/io";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { sheetView, type SheetAttributes } from "../overlays/sheet";
import { Shell } from "../shell/shell";
import "../styles/apps/screen/look";
import { ensureTheme } from "../theme/service";

/** What a fullscreen app's factory receives. */
export interface FullscreenScreen {
	readonly shell: FullscreenShell;
	/** Terminal columns (reactive; follows resizes). */
	readonly columns: Accessor<number>;
	/** Terminal rows (reactive; follows resizes). */
	readonly rows: Accessor<number>;
}

/** The shell members a fullscreen app uses (interactive mode passes its `Shell`). */
export type FullscreenShell = Pick<Shell, "overlays" | "native" | "host" | "focus">;

/** A fullscreen app built by {@link presentFullscreen}'s factory. */
export interface FullscreenApp<T> {
	/** The app view (one root node; keys reach its `onKey` through the focus path). */
	view(): JSXNode;
	/** Settles when the app is done; its value is {@link presentFullscreen}'s result. */
	readonly done: Promise<T>;
	/** Node inside the view that takes keyboard focus (default: the view's root). */
	focus?(root: UiNode): UiNode;
	/** Mouse reporting while the app is open (default off). */
	readonly mouse?: MouseTracking;
	/** The page Tern draws the app as (default: a page of the session's role, all `main`). */
	readonly page?: PageProps;
	/** Tern draws the app in this sheet over the session instead of on a page of its own. */
	readonly sheet?: SheetAttributes;
	/** Runs once after the app closed. */
	dispose?(): void;
}

/** Terminal size signals following `shell`'s driver; the returned function stops following. */
function terminalSize(shell: FullscreenShell): { columns: Accessor<number>; rows: Accessor<number>; stop(): void } {
	const driver = shell.host?.driver;
	const columns = signal(driver?.columns ?? process.stdout.columns ?? 80);
	const rows = signal(driver?.rows ?? process.stdout.rows ?? 24);
	const stop =
		driver?.onResize((nextColumns, nextRows) => {
			columns.set(nextColumns);
			rows.set(nextRows);
		}) ?? (() => {});
	return { columns, rows, stop };
}

/** Open a fullscreen app on a running shell; resolves with the app's result once it closed. */
export async function presentFullscreen<T>(
	shell: FullscreenShell,
	build: (screen: FullscreenScreen) => FullscreenApp<T>,
): Promise<T> {
	const size = terminalSize(shell);
	const app = build({ shell, columns: size.columns, rows: size.rows });
	const focus = app.focus;
	const handle = shell.overlays.show(
		() =>
			app.sheet && shell.native() ? (
				sheetView(true, app.sheet, app.view())
			) : (
				<overlay key="fullscreen" size="full" role="omp.app.screen" page={app.page ?? {}}>
					{app.view()}
				</overlay>
			),
		{ focus: root => (focus ? focus(root) : (root.children()[0] ?? root)), mouse: app.mouse ?? "off" },
	);
	try {
		return await app.done;
	} finally {
		handle.close();
		size.stop();
		app.dispose?.();
	}
}

/** Options of {@link runStandalone}. */
export interface StandaloneOptions {
	/** Terminal title while the app runs. */
	readonly title?: string;
}

/**
 * Run `run` on a shell of its own on the process terminal (a CLI command),
 * restoring the terminal once it settles.
 */
export async function withStandaloneShell<T>(
	options: StandaloneOptions,
	run: (shell: Shell) => Promise<T>,
): Promise<T> {
	ensureTheme();
	const shell = new Shell();
	// Every program's surface is a session surface to Tern, as its styles expect.
	await shell.start({ theme: currentTheme, role: "omp.session", ...(options.title ? { title: options.title } : {}) });
	try {
		return await run(shell);
	} finally {
		await shell.stop();
		shell.surface.dispose();
	}
}

/** Run a fullscreen app as the whole program: {@link presentFullscreen} on a {@link withStandaloneShell} shell. */
export function runStandalone<T>(
	options: StandaloneOptions,
	build: (screen: FullscreenScreen) => FullscreenApp<T>,
): Promise<T> {
	return withStandaloneShell(options, shell => presentFullscreen(shell, build));
}
