import { CancellableLoader, Container, Spacer, Text, type TUI } from "../index";
import type { Theme } from "../theme/theme";
import { DynamicBorder } from "../chrome/dynamic-border";
import { editorKey } from "../chrome/keybinding-hints";
import type { NativeNode } from "../native/node";
import { card } from "../native/describe";
import { actionHint, hintsRow } from "../native/overlay";

/** Loader wrapped with borders for hook UI */
export class BorderedLoader extends Container {
	#loader: CancellableLoader;
	#native: NativeNode | undefined;

	constructor(tui: TUI, theme: Theme, message: string) {
		super();
		const borderColor = (s: string) => theme.fg("border", s);
		this.addChild(new DynamicBorder(borderColor));
		this.#loader = new CancellableLoader(
			tui,
			s => theme.fg("accent", s),
			s => theme.fg("muted", s),
			message,
		);
		this.addChild(this.#loader);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("muted", `${editorKey("tui.select.cancel")} cancel`), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder(borderColor));
	}

	get signal(): AbortSignal {
		return this.#loader.signal;
	}

	set onAbort(fn: (() => void) | undefined) {
		this.#loader.onAbort = fn;
	}

	override invalidate(): void {
		this.#native = undefined;
		super.invalidate();
	}

	override describe(): NativeNode {
		this.#native ??= card({ role: "omp.hook.loader" }, [
			this.#loader,
			hintsRow([actionHint("tui.select.cancel", "cancel")]),
		]);
		return this.#native;
	}

	handleInput(data: string): void {
		this.#loader.handleInput(data);
	}

	override dispose(): void {
		this.#loader.dispose();
	}
}
