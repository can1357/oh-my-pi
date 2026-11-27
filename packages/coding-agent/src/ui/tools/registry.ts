/**
 * Tool presenters by tool name.
 *
 * A presenter module registers itself when imported (`registerToolPresenter`
 * at module scope); `./index.ts` imports every built-in one. The transcript's
 * tool block looks a call's presenter up here and falls back to the default
 * presenter for unknown tools.
 */
import type { ToolPresenter } from "./contract";

const presenters = new Map<string, ToolPresenter>();

/** Register the presenter of tool `name`. A later registration replaces an earlier one. */
export function registerToolPresenter<TArgs, TDetails>(name: string, presenter: ToolPresenter<TArgs, TDetails>): void {
	presenters.set(name, presenter as ToolPresenter);
}

/** The presenter registered for `name`, if any. */
export function toolPresenter(name: string): ToolPresenter | undefined {
	return presenters.get(name);
}

/** Names of every registered presenter, sorted. */
export function toolPresenterNames(): string[] {
	return [...presenters.keys()].sort();
}
