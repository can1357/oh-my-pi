/**
 * `/stats` result: omp serves the stats dashboard in the browser. ANSI keeps
 * the dim status line; natively it is an inline notice with an
 * `Open dashboard ↗` button that opens the URL terminal-side.
 */
import { Spacer } from "../components/spacer";
import { Text } from "../components/text";
import { theme } from "../theme/theme";
import { Container } from "../tui";
import { node, span } from "../native/describe";
import type { NativeNode } from "../native/node";
import { actionButton } from "../native/overlay";

export class StatsNotice extends Container {
	readonly #native: NativeNode;

	/** `message` is the launch status line; `url` the dashboard address. */
	constructor(message: string, url: string) {
		super();
		this.addChild(new Spacer(1));
		this.addChild(new Text(message, 1, 0).setStyleFn(line => theme.fg("dim", line)));
		this.#native = node("row", { gap: "md", align: "center", wrap: true }, [
			node("text", { spans: [span(message)], role: "omp.stats", wrap: "word", grow: 1 }),
			actionButton("Open dashboard ↗", "open", { href: url, title: url }),
		]);
	}

	override describe(): NativeNode {
		return this.#native;
	}
}
