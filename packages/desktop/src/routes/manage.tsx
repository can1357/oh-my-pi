import { useState } from "react";
import { McpScreen } from "../manage/McpScreen";
import { PluginsScreen } from "../manage/PluginsScreen";
import { SettingsScreen } from "../manage/SettingsScreen";
import { useBridge } from "../rpc/useBridge";

type Section = "settings" | "plugins" | "mcp";

const SECTIONS: Array<{ id: Section; label: string }> = [
	{ id: "settings", label: "Settings" },
	{ id: "plugins", label: "Plugins" },
	{ id: "mcp", label: "MCP" },
];

/**
 * Management screens.
 *
 * Settings and plugins go through short-lived CLI calls and need no session.
 * `/mcp` is a slash command, so it needs a live one — it reuses the `scratch`
 * tab, which `agent_start` will re-attach to rather than spawn a second time.
 */
export function ManageRoute() {
	const [section, setSection] = useState<Section>("settings");
	/*
	 * Only MCP needs a session. Settings and plugins go through short-lived CLI
	 * calls, and starting a sidecar for them cost ~4s and ~285MB to look at a
	 * form — and, with the pool capped at three, could evict a session that was
	 * mid-turn to make room.
	 */
	const { bridge, snapshot } = useBridge("scratch", { autoStart: section === "mcp" });

	return (
		<main className="omp-main omp-main--manage">
			<nav className="omp-panel__tabs" role="tablist">
				{SECTIONS.map(entry => (
					<button
						className="omp-panel__tab"
						key={entry.id}
						type="button"
						role="tab"
						aria-selected={section === entry.id}
						onClick={() => setSection(entry.id)}
					>
						{entry.label}
					</button>
				))}
			</nav>

			<div className="omp-screen__scroll">
				{section === "settings" ? <SettingsScreen /> : null}
				{section === "plugins" ? <PluginsScreen /> : null}
				{section === "mcp" ? <McpScreen bridge={bridge} commands={snapshot.commands} /> : null}
			</div>
		</main>
	);
}
