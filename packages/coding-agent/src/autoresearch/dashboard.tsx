/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The autoresearch dashboard on the extension UI: the widget above the
 * composer (collapsed line, expanded card, or the running-only line) and the
 * `ctrl+shift+x` sheet overlay. The runtime mutates in place; every
 * `updateWidget` replaces the widget, and {@link DashboardController.requestRender}
 * redraws an open sheet.
 */
import { nativeRendering, signal } from "@oh-my-pi/pi-tui";
import type { ExtensionUIContext } from "../extensibility/extensions";
import { AutoresearchSheet, AutoresearchWidget, autoresearchSheet } from "../ui/apps/autoresearch/dashboard";
import { type AutoresearchDashboardRuntime, shouldShowDashboard } from "../ui/apps/autoresearch/model";
import { sheetView } from "../ui/overlays/sheet";

const WIDGET_KEY = "autoresearch";

/** Widget and overlay capabilities of an extension context. */
export interface AutoresearchDashboardHost {
	readonly hasUI: boolean;
	readonly ui: Pick<ExtensionUIContext, "setWidget" | "custom">;
}

/** Dashboard lifecycle and rendering controls. */
export interface DashboardController {
	clear(ctx: AutoresearchDashboardHost): void;
	/** Redraw an open sheet after the runtime changed. */
	requestRender(): void;
	showOverlay(ctx: AutoresearchDashboardHost, runtime: AutoresearchDashboardRuntime): Promise<void>;
	updateWidget(ctx: AutoresearchDashboardHost, runtime: AutoresearchDashboardRuntime): void;
}

/** Create a dashboard backed by the host's widget and overlay surfaces. */
export function createDashboardController(): DashboardController {
	const revision = signal(0);
	return {
		clear(ctx) {
			if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
		},
		requestRender() {
			revision.update(n => n + 1);
		},
		updateWidget(ctx, runtime) {
			if (!ctx.hasUI) return;
			if (!shouldShowDashboard(runtime)) {
				ctx.ui.setWidget(WIDGET_KEY, undefined);
				return;
			}
			ctx.ui.setWidget(WIDGET_KEY, () => <AutoresearchWidget runtime={runtime} />);
		},
		async showOverlay(ctx, runtime) {
			if (!ctx.hasUI || !shouldShowDashboard(runtime)) return;
			await ctx.ui.custom<void>(
				(ui, _theme, _keybindings, done) =>
					sheetView(
						nativeRendering(),
						autoresearchSheet(runtime, revision),
						<AutoresearchSheet
							runtime={runtime}
							terminalRows={ui.size().rows}
							revision={revision}
							onClose={() => done(undefined)}
						/>,
					),
				{ overlay: true },
			);
		},
	};
}
