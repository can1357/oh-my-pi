//! `/debug` tools selector plus the pure report
//! builders behind `/context`, `/hotkeys`, `/changelog`, and the `/debug
//! <key>` inspectors. Every report is markdown for a
//! [`ReportPanel`](super::report::ReportPanel); nothing here touches the
//! session DOM beyond reading the replica.

use std::{collections::VecDeque, fmt::Write as _, sync::Arc};

use flume::Receiver;
use omp_agent::{AI_COMPACT_THRESHOLD, AI_MODEL};
use omp_con::Ctx;
use omp_core::{Str, sf};
use omp_dom::Dom;
use omp_tui::{
	Frame, IntoComponent as _, Key, MouseReport, Prop, Size, Ui, UiContext, UiEvent, dom,
};

use super::{
	Panel, PanelAnchor, PanelCx, PanelEvent,
	report::ReportPanel,
	services::{DebugAction as DebugActionId, DebugOutput, DebugSseFrame, Services},
};
use crate::status_line::StatusLine;

const DEBUG_HINT: &str = "↑/↓ choose · Enter select · Esc close";
/// Border, rule, hint, and blank rows around the select list.
const DEBUG_CHROME_ROWS: u16 = 5;
/// `## ` sections shown by `/changelog` without `full`.
const RECENT_CHANGELOG_ENTRIES: usize = 3;

/// One `/debug` operation: stable key, label, and consequence.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DebugAction {
	/// Typed operation sent through [`Services`].
	pub action:      DebugActionId,
	/// Word passed back as `debug <key>`.
	pub key:         &'static str,
	/// Human-facing label.
	pub label:       &'static str,
	/// Consequence description.
	pub description: &'static str,
}

/// Supported debug operations, in menu order.
///
/// The TS implementation's `remote-debugger` row is intentionally absent:
/// ADR 0036 prohibits its
/// JavaScriptCore inspector and omp has no embedded-Python runtime inspector.
pub const DEBUG_ACTIONS: [DebugAction; 12] = [
	DebugAction {
		action:      DebugActionId::OpenArtifacts,
		key:         "open-artifacts",
		label:       "Open: artifact folder",
		description: "Open session artifacts in file manager",
	},
	DebugAction {
		action:      DebugActionId::Performance,
		key:         "performance",
		label:       "Report: performance issue",
		description: "Profile CPU, reproduce, then bundle",
	},
	DebugAction {
		action:      DebugActionId::Work,
		key:         "work",
		label:       "Profile: work scheduling",
		description: "Open flamegraph of last 30s",
	},
	DebugAction {
		action:      DebugActionId::Dump,
		key:         "dump",
		label:       "Report: dump session",
		description: "Create report bundle immediately",
	},
	DebugAction {
		action:      DebugActionId::Memory,
		key:         "memory",
		label:       "Report: memory issue",
		description: "Heap snapshot + bundle",
	},
	DebugAction {
		action:      DebugActionId::Logs,
		key:         "logs",
		label:       "View: recent logs",
		description: "Show last 50 log entries",
	},
	DebugAction {
		action:      DebugActionId::System,
		key:         "system",
		label:       "View: system info",
		description: "Show environment details",
	},
	DebugAction {
		action:      DebugActionId::Terminal,
		key:         "terminal",
		label:       "View: terminal state",
		description: "Subprotocols, geometry, scrollback strategy",
	},
	DebugAction {
		action:      DebugActionId::Protocols,
		key:         "protocols",
		label:       "Test: terminal protocols",
		description: "Styling, links, text sizing, graphics, notify",
	},
	DebugAction {
		action:      DebugActionId::RawSse,
		key:         "raw-sse",
		label:       "View: raw SSE stream",
		description: "Show live provider SSE frames",
	},
	DebugAction {
		action:      DebugActionId::Transcript,
		key:         "transcript",
		label:       "Export: TUI transcript",
		description: "Write visible TUI conversation to a temp txt",
	},
	DebugAction {
		action:      DebugActionId::ClearCache,
		key:         "clear-cache",
		label:       "Clear: artifact cache",
		description: "Remove old session artifacts",
	},
];

/// Retained `/debug` selector; Enter finishes with `debug <key>`.
pub struct DebugSelector {
	ui:    Ui,
	ctx:   UiContext,
	width: u16,
	rows:  u16,
}

impl DebugSelector {
	/// Opens the selector for a viewport width.
	#[must_use]
	pub fn open(ctx: &UiContext, width: u16) -> Self {
		let mut panel = Self {
			ui: Ui::from_root(dom! { <col/> }, width, ctx.clone()),
			ctx: ctx.clone(),
			width,
			rows: 0,
		};
		panel.rebuild(width, u16::try_from(DEBUG_ACTIONS.len()).unwrap_or(u16::MAX));
		panel
	}

	fn rebuild(&mut self, width: u16, rows: u16) {
		self.width = width;
		self.rows = rows;
		let height = rows.saturating_add(1);
		let tree = dom! {
			<box border=round title="Debug Tools" pad-x=1>
				<col>
					<select id="actions" h={height}>
						for action in DEBUG_ACTIONS {
							<option value={action.key} label={action.label}>
								<td><pre bold>{action.label}</pre></td>
								<td truncate grow><pre fg=muted>{action.description}</pre></td>
							</option>
						}
					</select>
					<hr border=round/>
					<text fg=muted truncate>{DEBUG_HINT}</text>
				</col>
			</box>
		};
		self.ui = Ui::from_root(tree, width, self.ctx.clone());
	}

	fn route(&mut self, event: UiEvent) -> PanelEvent {
		match event {
			UiEvent::Cancel => PanelEvent::Close,
			UiEvent::Changed { id, value } if id.as_str() == "actions" => {
				PanelEvent::Finish(sf!("debug {}", value.as_str()))
			},
			_ => PanelEvent::Consumed,
		}
	}
}

impl Panel for DebugSelector {
	fn id(&self) -> &'static str {
		"debug"
	}

	fn anchor(&self) -> PanelAnchor {
		PanelAnchor::Center
	}

	fn key(&mut self, key: Key) -> PanelEvent {
		if key == Key::Esc {
			return PanelEvent::Close;
		}
		let event = self.ui.handle_key(key);
		self.route(event)
	}

	fn mouse(&mut self, report: MouseReport) -> PanelEvent {
		let event = self
			.ui
			.handle_mouse_with_mods(report.col, report.row, report.kind, report.mods);
		self.route(event)
	}

	fn frame(&mut self, viewport: Size) -> &Frame {
		let rows = viewport
			.height
			.saturating_sub(DEBUG_CHROME_ROWS)
			.clamp(1, u16::try_from(DEBUG_ACTIONS.len()).unwrap_or(u16::MAX));
		if viewport.width != self.width {
			self.rebuild(viewport.width, rows);
		} else if rows != self.rows {
			self.rows = rows;
			self.ui.set_prop("actions", Prop::H, rows.saturating_add(1));
		}
		self.ui.frame()
	}
}

/// Opens the panel produced by a typed application debug operation.
pub fn open_debug(
	cx: &PanelCx<'_>,
	action: DebugActionId,
	transcript: Str,
) -> Result<Box<dyn Panel>, Str> {
	let request = super::services::DebugRequest {
		action,
		transcript,
		terminal: super::services::DebugTerminal {
			viewport:   cx.viewport,
			charset:    Str::new(format!("{:?}", cx.ui.charset)),
			graphics:   Str::new(format!("{:?}", cx.ui.graphics)),
			appearance: Str::new(format!("{:?}", cx.ui.appearance)),
		},
	};
	match cx.services.debug(request).map_err(|error| sf!("{error}"))? {
		DebugOutput::Report { title, body } => {
			Ok(Box::new(ReportPanel::new("debug-report", title, body, cx.ui)))
		},
		DebugOutput::RawSse { initial, events } => Ok(Box::new(RawSsePanel::new(
			initial,
			events,
			Arc::clone(cx.services),
			cx.ui,
			cx.viewport.width,
		))),
		DebugOutput::ProtocolProbe { summary, image } => Ok(Box::new(ProtocolProbePanel::new(
			summary,
			image.to_string_lossy().as_ref(),
			cx.ui,
			cx.viewport.width,
		))),
	}
}

/// Full-screen bounded live raw-SSE viewer. `D` writes the same session ring
/// to a redacted text artifact through [`Services::dump_raw_sse`].
pub struct RawSsePanel {
	ui:       Ui,
	ctx:      UiContext,
	frames:   VecDeque<DebugSseFrame>,
	events:   Receiver<DebugSseFrame>,
	services: Arc<dyn Services>,
	status:   Option<Str>,
	width:    u16,
	rows:     u16,
}

impl RawSsePanel {
	const MAX_FRAMES: usize = 512;

	fn new(
		initial: Vec<DebugSseFrame>,
		events: Receiver<DebugSseFrame>,
		services: Arc<dyn Services>,
		ctx: &UiContext,
		width: u16,
	) -> Self {
		let mut panel = Self {
			ui: Ui::from_root(dom! { <col/> }, width, ctx.clone()),
			ctx: ctx.clone(),
			frames: initial.into(),
			events,
			services,
			status: None,
			width,
			rows: 1,
		};
		panel.trim();
		panel.rebuild();
		panel
	}

	fn trim(&mut self) {
		while self.frames.len() > Self::MAX_FRAMES {
			self.frames.pop_front();
		}
	}

	fn rebuild(&mut self) {
		let visible = usize::from(self.rows.saturating_sub(4)).max(1);
		let first = self.frames.len().saturating_sub(visible);
		let tree = dom! {
			<box border=round title="Raw SSE · redacted" pad-x=1>
				<col>
					if self.frames.is_empty() {
						<text fg=muted>{"Waiting for provider SSE frames…"}</text>
					} else {
						for frame in self.frames.iter().skip(first) {
							<text bold>{format!("#{} {}", frame.sequence, frame.event)}</text>
							<pre>{frame.payload.as_str()}</pre>
						}
					}
					<hr border=round/>
					if let Some(status) = &self.status {
						<text fg=success truncate>{status.as_str()}</text>
					} else {
						<text fg=muted truncate>{"D dump · Esc close"}</text>
					}
				</col>
			</box>
		};
		self.ui = Ui::from_root(tree, self.width, self.ctx.clone());
	}
}

impl Panel for RawSsePanel {
	fn id(&self) -> &'static str {
		"debug-raw-sse"
	}

	fn anchor(&self) -> PanelAnchor {
		PanelAnchor::Full
	}

	fn key(&mut self, key: Key) -> PanelEvent {
		match key {
			Key::Esc => PanelEvent::Close,
			Key::Char('d' | 'D') => {
				self.status = Some(match self.services.dump_raw_sse() {
					Ok(path) => sf!("Saved {}", path.display()),
					Err(error) => sf!("Dump failed: {error}"),
				});
				self.rebuild();
				PanelEvent::Consumed
			},
			_ => PanelEvent::Consumed,
		}
	}

	fn frame(&mut self, viewport: Size) -> &Frame {
		if self.width != viewport.width || self.rows != viewport.height {
			self.width = viewport.width;
			self.rows = viewport.height;
			self.rebuild();
		}
		self.ui.frame()
	}

	fn tick(&mut self, _now: std::time::Duration) -> bool {
		let mut changed = false;
		while let Ok(frame) = self.events.try_recv() {
			self.frames.push_back(frame);
			changed = true;
		}
		if changed {
			self.trim();
			self.rebuild();
		}
		changed
	}
}

/// Typed terminal-protocol sampler. Its rich nodes exercise styling,
/// hyperlinks, text measurement, and the negotiated graphics renderer.
pub struct ProtocolProbePanel {
	ui:      Ui,
	ctx:     UiContext,
	summary: Str,
	image:   Str,
	width:   u16,
}

impl ProtocolProbePanel {
	fn new(summary: Str, image: &str, ctx: &UiContext, width: u16) -> Self {
		let image = Str::new(image);
		let tree = Self::tree(&summary, &image);
		Self { ui: Ui::from_root(tree, width, ctx.clone()), ctx: ctx.clone(), summary, image, width }
	}

	fn tree(summary: &Str, image_path: &Str) -> Box<dyn omp_tui::Component> {
		let image = omp_tui::components::Img::new()
			.with_str(Prop::Src, image_path.as_str())
			.with(Prop::W, 8_u16)
			.with(Prop::H, 3_u16);
		let link = omp_tui::components::Markdown::text_of(
			"[OSC 8 hyperlink](https://example.com/omp-protocol-test)",
		);
		dom! {
			<box border=round title="Terminal protocol tests" pad-x=1>
				<col gap=1>
					<row gap=2><text bold>{"bold"}</text><text italic>{"italic"}</text><text underline>{"underline"}</text></row>
					{link}
					<text>{"Text sizing/measurement: WWW iii 你好"}</text>
					{image}
					<pre>{summary.as_str()}</pre>
					<text fg=muted>{"A desktop test notification was requested · Esc close"}</text>
				</col>
			</box>
		}
		.into_component()
	}

	fn rebuild(&mut self) {
		self.ui = Ui::from_root(Self::tree(&self.summary, &self.image), self.width, self.ctx.clone());
	}
}

impl Panel for ProtocolProbePanel {
	fn id(&self) -> &'static str {
		"debug-protocols"
	}

	fn anchor(&self) -> PanelAnchor {
		PanelAnchor::Full
	}

	fn key(&mut self, key: Key) -> PanelEvent {
		if key == Key::Esc {
			PanelEvent::Close
		} else {
			PanelEvent::Consumed
		}
	}

	fn frame(&mut self, viewport: Size) -> &Frame {
		if viewport.width != self.width {
			self.width = viewport.width;
			self.rebuild();
		}
		self.ui.frame()
	}
}

/// `/context`: estimated context usage from the replica's receipts.
#[must_use]
pub fn context_report(dom: &Dom, con: &Ctx) -> Str {
	let status = StatusLine::from_dom(dom);
	let live = AI_MODEL.get(con);
	let model = if live.is_empty() {
		status.model.clone()
	} else {
		live
	};
	let threshold = AI_COMPACT_THRESHOLD.get(con);
	let mut out = String::with_capacity(320);
	let _ = writeln!(out, "**Context · turn {}**\n", status.turns);
	let _ = writeln!(
		out,
		"- Model: {}",
		if model.is_empty() {
			"unknown"
		} else {
			model.as_str()
		}
	);
	let _ = writeln!(out, "- Input: {} tokens", status.context);
	let _ = writeln!(out, "- Window: unknown");
	let _ = writeln!(out, "- Compaction threshold: {}%", (threshold * 100.0).round());
	let _ = writeln!(out, "\n**Session totals**\n");
	let _ = writeln!(out, "- Turns: {}", status.turns);
	let _ = writeln!(out, "- Input: {} tokens", status.tokens_in);
	let _ = writeln!(out, "- Output: {} tokens", status.tokens_out);
	let _ = writeln!(out, "- Cache read: {} tokens", status.cache_read);
	let _ = writeln!(out, "- Cache write: {} tokens", status.cache_write);
	let _ = writeln!(
		out,
		"- Cost: ${}.{:04}",
		status.cost_nano_usd / 1_000_000_000,
		(status.cost_nano_usd % 1_000_000_000) / 100_000
	);
	if let Some(tps) = status.tokens_per_second {
		let _ = writeln!(out, "- Throughput: {tps:.1} tok/s");
	}
	Str::from(out)
}

/// `/hotkeys`: the fixed editor keys plus every
/// console bind, sorted by key.
#[must_use]
pub fn hotkeys_report(con: &Ctx) -> Str {
	let mac = cfg!(target_os = "macos");
	let alt = if mac { "Option" } else { "Alt" };
	let mut out = String::with_capacity(2048);
	out.push_str("**Navigation**\n| Key | Action |\n|-----|--------|\n");
	out.push_str("| `Arrow keys` | Move cursor / browse history (Up when empty) |\n");
	let _ = writeln!(out, "| `{alt}+Left/Right` | Move by word |");
	if mac {
		out.push_str("| `Ctrl+A` / `Home` / `Cmd+Left` | Start of line |\n");
		out.push_str("| `Ctrl+E` / `End` / `Cmd+Right` | End of line |\n");
	} else {
		out.push_str("| `Ctrl+A` / `Home` | Start of line |\n");
		out.push_str("| `Ctrl+E` / `End` | End of line |\n");
	}
	out.push_str("\n**Editing**\n| Key | Action |\n|-----|--------|\n");
	out.push_str("| `Enter` | Send message |\n");
	let _ = writeln!(out, "| `Shift+Enter` / `{alt}+Enter` | New line |");
	let _ = writeln!(out, "| `Ctrl+W` / `{alt}+Backspace` | Delete word backwards |");
	out.push_str("| `Ctrl+U` | Delete to start of line |\n");
	out.push_str("| `Ctrl+K` | Delete to end of line |\n");
	out.push_str("\n**Other**\n| Key | Action |\n|-----|--------|\n");
	out.push_str("| `Tab` | Path completion / accept autocomplete |\n");
	out.push_str(
		"| `#<number>` | GitHub issue/PR reference (e.g. `#3164` → `pr://`/`issue://`) |\n",
	);
	out.push_str("| `/` | Slash commands |\n");
	out.push_str("| `!` | Run bash command |\n");
	out.push_str("| `!!` | Run bash command (excluded from context) |\n");
	out.push_str("| `$` | Run Python in shared kernel |\n");
	out.push_str("| `$$` | Run Python (excluded from context) |\n");
	let binds = con.binds();
	out.push_str("\n**Bindings**\n");
	if binds.is_empty() {
		out.push_str("No keys are bound.\n");
	} else {
		out.push_str("| Key | Script |\n|-----|--------|\n");
		for (key, script) in binds {
			let _ = writeln!(out, "| `{key}` | `{}` |", script.replace('|', "\\|"));
		}
	}
	Str::from(out)
}

/// `/changelog [full]`: the first [`RECENT_CHANGELOG_ENTRIES`] `## `
/// sections unless `full`; `None` when the text has no entries.
#[must_use]
pub fn changelog_report(text: &str, full: bool) -> Option<Str> {
	let limit = if full {
		usize::MAX
	} else {
		RECENT_CHANGELOG_ENTRIES
	};
	let mut rendered = String::new();
	let mut shown = 0;
	for (index, entry) in text.split("\n## ").enumerate() {
		let entry = entry.trim();
		if entry.is_empty() || (index == 0 && !entry.starts_with("## ")) {
			continue;
		}
		if shown == limit {
			break;
		}
		if !rendered.is_empty() {
			rendered.push_str("\n\n");
		}
		if index > 0 {
			rendered.push_str("## ");
		}
		rendered.push_str(entry);
		shown += 1;
	}
	(!rendered.is_empty()).then(|| Str::from(rendered))
}

#[cfg(test)]
mod tests {
	use std::{path::PathBuf, sync::Arc};

	use omp_tui::{Mods, Mouse, MouseButton};
	use parking_lot::Mutex;

	use super::*;

	#[derive(Default)]
	struct DebugDouble {
		calls: Mutex<Vec<DebugActionId>>,
	}

	impl Services for DebugDouble {
		fn debug(
			&self,
			request: super::super::services::DebugRequest,
		) -> super::super::services::ServiceResult<DebugOutput> {
			self.calls.lock().push(request.action);
			Ok(match request.action {
				DebugActionId::RawSse => {
					let (_tx, events) = flume::bounded(1);
					DebugOutput::RawSse {
						initial: vec![DebugSseFrame {
							sequence: 7,
							event:    Str::new_static("sse"),
							payload:  Str::new_static("data: scripted-frame"),
						}],
						events,
					}
				},
				DebugActionId::Protocols => DebugOutput::ProtocolProbe {
					summary: Str::new_static("protocol-double"),
					image:   PathBuf::from("/tmp/protocol.png"),
				},
				_ => DebugOutput::Report {
					title: "Debug double",
					body:  Str::new_static("operation completed"),
				},
			})
		}

		fn dump_raw_sse(&self) -> super::super::services::ServiceResult<PathBuf> {
			Ok(PathBuf::from("/tmp/raw-sse.txt"))
		}
	}

	fn mouse(kind: Mouse, col: u16, row: u16, button: MouseButton) -> MouseReport {
		MouseReport { kind, col, row, button, mods: Mods::default(), pressed: true }
	}

	fn point(text: &str, needle: &str) -> (u16, u16) {
		text
			.lines()
			.enumerate()
			.find_map(|(row, line)| {
				let byte = line.find(needle)?;
				Some((omp_tui::cell_width(&line[..byte]), u16::try_from(row).unwrap()))
			})
			.expect("text point")
	}

	#[test]
	fn debug_selector_enter_finishes_with_the_chosen_key() {
		let ctx = UiContext::default();
		let mut panel = DebugSelector::open(&ctx, 72);
		let text = omp_tui::frame_text(panel.frame(Size { width: 72, height: 20 }));
		assert!(text.contains("Debug Tools"), "title missing:\n{text}");
		assert!(text.contains("Open session artifacts"), "row missing:\n{text}");
		assert!(text.contains(DEBUG_HINT), "hint missing:\n{text}");
		assert_eq!(panel.key(Key::Enter), PanelEvent::Finish(sf!("debug open-artifacts")));
		assert_eq!(panel.key(Key::Down), PanelEvent::Consumed);
		assert_eq!(panel.key(Key::Enter), PanelEvent::Finish(sf!("debug performance")));
		assert_eq!(panel.key(Key::Esc), PanelEvent::Close);
	}

	#[test]
	fn debug_inventory_matches_pi_except_the_adr_0036_js_debugger_deviation() {
		let keys = DEBUG_ACTIONS
			.iter()
			.map(|action| action.key)
			.collect::<Vec<_>>();
		assert_eq!(keys, [
			"open-artifacts",
			"performance",
			"work",
			"dump",
			"memory",
			"logs",
			"system",
			"terminal",
			"protocols",
			"raw-sse",
			"transcript",
			"clear-cache",
		]);
		assert!(!keys.contains(&"remote-debugger"));
		assert_eq!(
			DEBUG_ACTIONS
				.iter()
				.map(|action| action.action)
				.collect::<Vec<_>>(),
			[
				DebugActionId::OpenArtifacts,
				DebugActionId::Performance,
				DebugActionId::Work,
				DebugActionId::Dump,
				DebugActionId::Memory,
				DebugActionId::Logs,
				DebugActionId::System,
				DebugActionId::Terminal,
				DebugActionId::Protocols,
				DebugActionId::RawSse,
				DebugActionId::Transcript,
				DebugActionId::ClearCache,
			]
		);
	}

	#[test]
	fn every_debug_row_executes_a_typed_service_operation() {
		let dom = Dom::default();
		let con = Ctx::new();
		let ui = UiContext::default();
		let double = Arc::new(DebugDouble::default());
		let services: Arc<dyn Services> = double.clone();
		let cx = PanelCx {
			dom:      &dom,
			con:      &con,
			ui:       &ui,
			viewport: Size::new(80, 24),
			services: &services,
		};
		for row in DEBUG_ACTIONS {
			let mut panel = open_debug(&cx, row.action, Str::new_static("transcript"))
				.expect("typed operation opens");
			let text = omp_tui::frame_text(panel.frame(Size::new(80, 24)));
			match row.action {
				DebugActionId::RawSse => {
					assert!(text.contains("scripted-frame"), "{text}");
					assert_eq!(panel.key(Key::Char('d')), PanelEvent::Consumed);
					let dumped = omp_tui::frame_text(panel.frame(Size::new(80, 24)));
					assert!(dumped.contains("/tmp/raw-sse.txt"), "{dumped}");
				},
				DebugActionId::Protocols => assert!(text.contains("protocol-double"), "{text}"),
				_ => assert!(text.contains("operation completed"), "{text}"),
			}
		}
		assert_eq!(double.calls.lock().len(), DEBUG_ACTIONS.len());
	}

	#[test]
	fn debug_selector_click_commits_the_hit_row() {
		let ctx = UiContext::default();
		let mut panel = DebugSelector::open(&ctx, 60);
		let text = omp_tui::frame_text(panel.frame(Size { width: 60, height: 12 }));
		let (col, row) = point(&text, "system");
		assert_eq!(
			panel.mouse(mouse(Mouse::Click, col, row, MouseButton::Left)),
			PanelEvent::Finish(sf!("debug system"))
		);
	}

	#[test]
	fn hotkeys_report_lists_console_binds_sorted_by_key() {
		let con = Ctx::new();
		con.bind("alt+p", "cl_models").unwrap();
		con.bind("alt+a", "cl_agents").unwrap();
		let report = hotkeys_report(&con);
		assert!(report.contains("| `alt+p` | `cl_models` |"), "{report}");
		let a = report.find("`alt+a`").unwrap();
		let p = report.find("`alt+p`").unwrap();
		assert!(a < p, "binds sorted by key:\n{report}");
		assert!(report.contains("**Navigation**"));
		assert!(report.contains("| `/` | Slash commands |"));
	}

	#[test]
	fn changelog_report_limits_recent_sections_and_rejects_empty() {
		let text = "# Changelog\n\n## 1.3\n- c\n\n## 1.2\n- b\n\n## 1.1\n- a\n\n## 1.0\n- z\n";
		let recent = changelog_report(text, false).unwrap();
		assert_eq!(
			recent
				.lines()
				.filter(|line| line.starts_with("## "))
				.count(),
			3
		);
		assert!(recent.starts_with("## 1.3"));
		let full = changelog_report(text, true).unwrap();
		assert_eq!(full.lines().filter(|line| line.starts_with("## ")).count(), 4);
		assert_eq!(changelog_report("# Changelog\n\nnothing yet\n", true), None);
	}

	#[test]
	fn context_report_reads_the_compaction_threshold() {
		let con = Ctx::new();
		let dom = Dom::default();
		let report = context_report(&dom, &con);
		assert!(report.contains("Compaction threshold: 80%"), "{report}");
		assert!(report.contains("Window: unknown"), "{report}");
	}
}
