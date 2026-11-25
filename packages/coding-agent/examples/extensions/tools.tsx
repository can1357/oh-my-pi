/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Tools Extension
 *
 * Provides a /tools command to enable/disable tools interactively.
 * Tool selection persists across session reloads and respects branch navigation.
 *
 * Usage:
 * 1. Copy this file to ~/.omp/agent/extensions/ (legacy: ~/.pi/agent/extensions/) or your project's .omp/extensions/
 * 2. Use /tools to open the tool selector
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { For, type KeyEvent, signal } from "@oh-my-pi/pi-tui";

// State persisted to session
interface ToolsState {
	enabledTools: string[];
}

export default function toolsExtension(pi: ExtensionAPI) {
	// Track enabled tools
	let enabledTools: Set<string> = new Set();
	let allTools: string[] = [];

	// Persist current state
	function persistState() {
		pi.appendEntry<ToolsState>("tools-config", {
			enabledTools: Array.from(enabledTools),
		});
	}

	// Apply current tool selection
	async function applyTools() {
		await pi.setActiveTools(Array.from(enabledTools));
	}

	// Find the last tools-config entry in the current branch
	async function restoreFromBranch(ctx: ExtensionContext) {
		allTools = pi.getAllTools().map(t => t.name);

		// Get entries in current branch only
		const branchEntries = ctx.sessionManager.getBranch();
		let savedTools: string[] | undefined;

		for (const entry of branchEntries) {
			if (entry.type === "custom" && (entry as { customType?: string }).customType === "tools-config") {
				const data = (entry as { data?: ToolsState }).data;
				if (data?.enabledTools) {
					savedTools = data.enabledTools;
				}
			}
		}

		if (savedTools) {
			// Restore saved tool selection (filter to only tools that still exist)
			enabledTools = new Set(savedTools.filter((t: string) => allTools.includes(t)));
			await applyTools();
		} else {
			// No saved state - sync with currently active tools
			enabledTools = new Set(pi.getActiveTools());
		}
	}

	// Register /tools command
	pi.registerCommand("tools", {
		description: "Enable/disable tools",
		handler: async (_args, ctx) => {
			// Refresh tool list
			allTools = pi.getAllTools().map(t => t.name);

			await ctx.ui.custom<undefined>((_ui, _theme, _keybindings, done) => {
				// Signals drive the view: changing them redraws the rows that read them.
				const cursor = signal(0);
				const enabled = signal<ReadonlySet<string>>(new Set(enabledTools));

				const toggle = (tool: string) => {
					if (enabledTools.has(tool)) enabledTools.delete(tool);
					else enabledTools.add(tool);
					enabled.set(new Set(enabledTools));
					void applyTools();
					persistState();
				};

				// The root node takes keyboard focus: keys arrive at its onKey.
				const onKey = (key: KeyEvent): boolean => {
					switch (key.id) {
						case "up":
						case "k":
							cursor.set(Math.max(0, cursor() - 1));
							return true;
						case "down":
						case "j":
							cursor.set(Math.min(allTools.length - 1, cursor() + 1));
							return true;
						case "space":
						case "enter":
							toggle(allTools[cursor()]!);
							return true;
						case "escape":
							done(undefined);
							return true;
						default:
							return false;
					}
				};

				return (
					<col onKey={onKey}>
						<text spans={[{ t: "Tool Configuration", s: "accent strong" }]} />
						<For each={allTools}>
							{(tool, index) => (
								<text
									spans={() => [
										{ t: index() === cursor() ? "› " : "  ", s: "accent" },
										{ t: enabled().has(tool) ? "[x] " : "[ ] " },
										{ t: tool, s: index() === cursor() ? "strong" : undefined },
									]}
								/>
							)}
						</For>
						<text spans={[{ t: "↑/↓ move · space toggle · esc close", s: "muted" }]} />
					</col>
				);
			});
		},
	});

	// Restore state on session start
	pi.on("session_start", async (_event, ctx) => {
		await restoreFromBranch(ctx);
	});

	// Restore state when navigating the session tree
	pi.on("session_tree", async (_event, ctx) => {
		await restoreFromBranch(ctx);
	});

	// Restore state after branching
	pi.on("session_branch", async (_event, ctx) => {
		await restoreFromBranch(ctx);
	});
}
