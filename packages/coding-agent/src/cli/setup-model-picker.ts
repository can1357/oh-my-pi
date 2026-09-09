/**
 * Standalone TUI model picker used by `omp setup speech`.
 *
 * Mirrors {@link ./session-picker.ts} for the standalone-TUI lifecycle: spin up
 * a one-shot {@link TUI} over a {@link SelectList}, resolve on select/cancel, and
 * tear the UI down. The standalone TUI auto-renders on input, so no manual
 * render wiring is needed beyond `addChild`/`setFocus`/`start`.
 */
import { ProcessTerminal, type SelectItem, SelectList, TUI } from "@oh-my-pi/pi-tui";
import { getSelectListTheme } from "../modes/theme/theme";

/**
 * Show a single-column model picker and resolve with the chosen item's value,
 * or `null` if the user cancelled. `currentValue` pre-selects the matching row.
 */
export async function selectSetupModel(
	title: string,
	items: SelectItem[],
	currentValue: string,
): Promise<string | null> {
	const { promise, resolve } = Promise.withResolvers<string | null>();
	const ui = new TUI(new ProcessTerminal());
	let resolved = false;

	const finish = (value: string | null): void => {
		if (resolved) return;
		resolved = true;
		ui.stop();
		resolve(value);
	};

	const list = new SelectList(items, Math.min(items.length, 10), getSelectListTheme());
	const currentIndex = items.findIndex(item => item.value === currentValue);
	if (currentIndex >= 0) list.setSelectedIndex(currentIndex);
	list.onSelect = item => finish(item.value);
	list.onCancel = () => finish(null);

	process.stdout.write(`${title}\n`);
	ui.addChild(list);
	ui.setFocus(list);
	ui.start();
	return promise;
}
