//! Observer-local overlays: approval prompts projected from controller-owned
//! DOM state, plus the model picker, prompt-history picker, and transient
//! notices that live only in the actor (ADR 0005).
//!
//! Every other overlay (session picker, tree, rewind, dashboards, side
//! panels) is a [`Panel`]: a retained component the host stacks, routes keys
//! to, and composites by its [`PanelAnchor`]. Panels ask for effects through
//! [`PanelEvent`] — a console line (ADR 0014), a composer recall, a notice,
//! a clipboard write — and never touch the session DOM.

use std::{
	collections::BTreeMap,
	fmt,
	sync::Arc,
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use omp_agent::{ApprovalDecision, ApprovalScope, ApprovalSource, ApprovalTicket};
use omp_con::Ctx;
use omp_core::{FastHashSet, Str, sf};
use omp_dom::{Dom, KnownTag, PropId, PropKey, Tag, Value};
use omp_tui::{
	Frame, Key, MouseReport, Prop, Size, Ui, UiContext, UiEvent,
	components::Select,
	dom,
	tsp::{
		picker::{
			ColumnFormat, Fact, Gesture, KindProps as _, PickerAct, PickerAction, PickerColumn,
			PickerItem, PickerLayout, PickerPreview, PickerProps, PickerSize,
		},
		wire::Node,
	},
};
use tokio_util::sync::CancellationToken;

use crate::{history::HistoryEntry, host::HostCommand};

/// `/agents` agent-definition browser.
pub mod agents;
/// `ask@2` dialog projected from the running tool element.
pub mod ask;
/// `/copy` transcript picker.
pub mod copy;
/// Extension `input` / `editor` text prompts (`omp.ui.input`, `omp.ui.editor`).
pub mod ext_input;
/// Extension retained overlays (`omp.ui.overlay`).
pub mod ext_overlay;
/// `/extensions` Extension Control Center dashboard.
pub mod extensions;
/// Codex quota-reset fireworks celebration.
pub mod fireworks;
/// `/git` fullscreen Git workbench.
pub mod git;
/// `/hub` live agent supervisor and its transcript viewer.
pub mod hub;
/// Debug tools selector plus the context, hotkeys, and changelog reports.
pub mod info;
/// `/live` realtime voice visualizer and typed observer reducer.
pub mod live;
/// Login dialog, logout account selector, and provider picker.
pub mod login;
/// Full-screen two-pane model picker (provider rail + model list).
pub mod models;
/// `/move` directory autocomplete editor and creation confirmation.
pub mod move_panel;
/// The notice row's history behind `/notices`.
pub mod notices;
/// Large-paste menu (wrapped block, local file, inline chip).
pub mod paste_menu;
/// `/pause` full-screen hold screen.
pub mod pause;
/// `/plan-review` plan review dialog.
pub mod plan_review;
/// Destination editor opened by Plan Review's “Save and quit” verdict.
pub mod plan_save;
/// `/plugins approve` selector over blocked plugin commands.
pub mod plugin_approvals;
/// `/plugins`, `/marketplace` plugin selector.
pub mod plugins;
/// Centered scrollable markdown report.
pub mod report;
/// Confirmation selector for spending a saved usage reset.
pub mod reset_usage;
/// Application-supplied data feeds for dashboards and account commands.
pub mod services;
/// Focused `/session info` panel.
pub mod session_info;
/// `/resume` session picker.
pub mod sessions;
/// `/settings` selector over the console variable registry.
pub mod settings;
/// Side-channel panels above the editor (`/btw`).
pub mod side;
/// `/stats` and `/trace` report builders.
pub mod stats;
/// Loader-then-result panel over one asynchronous service request.
pub mod tasks;
/// `/tree` branch explorer.
pub mod tree;
/// Full-screen `/usage` dashboard.
pub mod usage;
/// First-run workspace trust selector shown before kernel composition.
pub mod workspace_trust;

pub use models::{ModelPicker, PickerRole, RoleMark};
pub use notices::NoticeLog;
pub use services::{NoServices, Services};

/// Where the host composites a [`Panel`] frame.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PanelAnchor {
	/// Replaces the composer band for pickers.
	Bottom,
	/// Centered modal dialog at 80% width.
	Center,
	/// Full-screen dashboard.
	Full,
	/// Bottom-edge modal whose rendered frame is horizontally centered.
	BottomCenter,
	/// Side-channel panel above the editor (`/btw`, `/omfg`, `/cleanse`);
	/// the composer stays live and Esc closes it at rung 2 of the ladder.
	Side,
}

/// What a routed panel key or call asked the host to do.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PanelEvent {
	/// The panel did not consume the input.
	Ignored,
	/// The panel changed; repaint.
	Consumed,
	/// Close the panel.
	Close,
	/// Run a console line; the panel stays open.
	Run(Str),
	/// Preview one presentation convar observer-locally without mutating it.
	PreviewSetting {
		/// Convar whose presentation is being previewed.
		convar: Str,
		/// Candidate script spelling.
		value:  Str,
	},
	/// Cancel an observer-local setting preview and restore its baseline.
	CancelSettingPreview {
		/// Convar whose preview should be restored.
		convar: Str,
	},
	/// Commit a previewed setting through the con command stream, then clear
	/// the observer-local preview baseline.
	RunSetting {
		/// Convar whose preview is committed.
		convar: Str,
		/// `<convar> <value>; writecfg` command line.
		line:   Str,
	},
	/// Close the panel, then run a console line.
	Finish(Str),
	/// Close the panel, then send a typed controller command.
	FinishCommand(HostCommand),
	/// Replace Plan Review with the observer-local destination editor.
	OpenPlanSave {
		/// Exact reviewed plan contents, including in-overlay edits.
		content: Str,
		/// Reviewed plan title used to suggest `<TOPIC>_PLAN.md`.
		title:   Str,
	},
	/// Close the panel and show a transient status notice.
	CloseNotice(Str),
	/// Close the panel and place text in the composer.
	Recall(Str),
	/// Close the large-paste menu and land the held paste as chosen.
	Paste {
		/// The pasted text the menu held back.
		text:   Str,
		/// How to land it.
		choice: paste_menu::PasteChoice,
	},
	/// Show a transient status notice; the panel stays open.
	Notice(Str),
	/// Write text to the clipboard; the panel stays open.
	Copy(Str),
	/// Close the panel and answer (or dismiss, `None`) the `ask` call `id`.
	Ask {
		/// `<ask id>` the dialog was projected from.
		id:      Str,
		/// Selections in question order; `None` cancels the tool.
		answers: Option<Vec<omp_tools::ask::Selection>>,
	},
	/// Ask the controller for a mutation (ADR 0005: actor input travels back
	/// as commands; views never own mutations). The panel stays open and
	/// learns the result through [`Panel::notify`] with
	/// [`PanelNote::Outcome`].
	Command(HostCommand),
	/// Send one realtime voice control request to the application.
	Live(live::LiveControl),
}

/// Settled result of a controller-run mutation a panel asked for through
/// [`PanelEvent::Command`]. The controller posts it back through the console
/// mailbox as `HostAction::Outcome`; the host hands it to every open panel.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Outcome {
	/// A Git workbench mutation settled.
	Git(git::GitOutcome),
	/// An application-state mutation (extension, agent, plugin, account,
	/// session index, usage reset) settled.
	Service(services::ServiceOutcome),
	/// An agent supervision request (revive, kill, send) settled.
	Agent(hub::AgentOutcome),
	/// A collaboration room operation settled.
	Collab(services::CollabOutcome),
	/// A project/global session-index read settled.
	SessionIndex(sessions::SessionIndexOutcome),
	/// A selected Claude Code or Codex transcript finished importing.
	ForeignSessionImport(sessions::ForeignSessionImportOutcome),
}

/// A fact delivered to an open panel after it opened.
#[derive(Clone, Copy)]
pub enum PanelNote<'a> {
	/// The replica applied a DOM event; `dom` is the updated replica.
	Dom(&'a Dom),
	/// A controller-run mutation settled.
	Outcome(&'a Outcome),
	/// A synchronous settings command settled while its editor remains open.
	SettingResult {
		/// Convar named by the originating [`PanelEvent::RunSetting`].
		convar: &'a str,
		/// User-facing validation failure, or `None` after a successful write.
		error:  Option<&'a str>,
	},
	/// Observer-only realtime voice state changed at `now` on the host clock.
	Live(&'a live::LiveUiEvent, Duration),
}

/// Panel chords the host lowers before handing a panel the raw key
/// (`app.session.*`, `app.tree.*`, `app.tools.expand`).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PanelAction {
	/// Ctrl+P: full vs relative session path.
	TogglePath,
	/// Ctrl+S: mtime vs creation-date sort.
	ToggleSort,
	/// Ctrl+R: inline rename prompt.
	Rename,
	/// Ctrl+D: delete with confirmation.
	Delete,
	/// Ctrl+Backspace (decoded as the readline `ctrl+w` chord): delete
	/// without confirmation.
	DeleteFast,
	/// Ctrl+Left / Alt+Left: fold the subtree or move to the parent.
	FoldUp,
	/// Ctrl+Right / Alt+Right: unfold the subtree or move to the first child.
	UnfoldDown,
	/// Ctrl+O: expand the focused entry.
	Expand,
}

impl PanelAction {
	/// Lowers a decoded key to its panel action.
	#[must_use]
	pub const fn from_key(key: Key) -> Option<Self> {
		Some(match key {
			Key::Ctrl('p') => Self::TogglePath,
			Key::Ctrl('s') => Self::ToggleSort,
			Key::Ctrl('r') => Self::Rename,
			Key::Ctrl('d') => Self::Delete,
			Key::Ctrl('w') => Self::DeleteFast,
			Key::WordLeft => Self::FoldUp,
			Key::WordRight => Self::UnfoldDown,
			Key::Ctrl('o') => Self::Expand,
			_ => return None,
		})
	}
}

/// Facts a panel may read while opening or running a call.
pub struct PanelCx<'a> {
	/// Detached session replica.
	pub dom:      &'a Dom,
	/// Console context (convars, registered commands).
	pub con:      &'a Ctx,
	/// Ambient renderer context.
	pub ui:       &'a UiContext,
	/// Current viewport.
	pub viewport: Size,
	/// Application-supplied data feeds; panels that poll a `Pending`
	/// request clone the handle.
	pub services: &'a Arc<dyn Services>,
}

/// A retained observer-local overlay the host stacks and routes to.
pub trait Panel {
	/// Stable identity reported through `HostCommand::Overlay` and the
	/// debug `values` op.
	fn id(&self) -> &'static str;
	/// Where the frame is composited.
	fn anchor(&self) -> PanelAnchor {
		PanelAnchor::Bottom
	}
	/// Applies one lowered panel chord. `Ignored` hands the raw key to
	/// [`Panel::key`].
	fn action(&mut self, _action: PanelAction) -> PanelEvent {
		PanelEvent::Ignored
	}
	/// Applies one raw key.
	fn key(&mut self, key: Key) -> PanelEvent;
	/// Applies pasted text.
	fn paste(&mut self, _text: &str) -> PanelEvent {
		PanelEvent::Ignored
	}
	/// Records that real input (a key or a paste) reached the panel at
	/// `now` on the host clock; called before [`Panel::key`] / [`Panel::paste`]
	/// so inactivity deadlines restart from the actual
	/// input time, never from the last periodic tick.
	fn touch(&mut self, _now: Duration) {}
	/// Applies one mouse report in panel-frame coordinates (the host
	/// subtracts the composited frame's origin). `Ignored` leaves the
	/// pointer to the document.
	fn mouse(&mut self, _report: MouseReport) -> PanelEvent {
		PanelEvent::Ignored
	}
	/// Delivers a fact that arrived while the panel was open: a DOM patch on
	/// the replica or the outcome of a mutation the panel requested.
	fn notify(&mut self, _note: PanelNote<'_>) -> PanelEvent {
		PanelEvent::Ignored
	}
	/// Applies a native TSP form change, when this panel exposes one.
	fn tsp_change(&mut self, _name: &str, _value: &serde_json::Value) -> PanelEvent {
		PanelEvent::Ignored
	}

	/// Returns a native TSP form for overlays that expose structured fields.
	fn tsp_node(&self) -> Option<omp_tui::tsp::wire::Node> {
		None
	}

	/// Applies a new ambient presentation context to retained panel state.
	fn set_context(&mut self, _ctx: &UiContext) {}

	fn frame(&mut self, viewport: Size) -> &Frame;
	/// Advances animations (countdowns); returns whether a repaint is due.
	fn tick(&mut self, _now: Duration) -> bool {
		false
	}
	/// Next animation deadline on the host clock.
	fn next_wake(&self) -> Option<Duration> {
		None
	}
	/// Whether the panel finished on its own (an animation ran out); the
	/// host closes it after the tick that reported it.
	fn finished(&self) -> bool {
		false
	}
	/// An effect the panel wants applied after a tick that repainted (an
	/// asynchronous request settled): the host feeds it through the normal
	/// panel-event path.
	fn settled(&mut self) -> Option<PanelEvent> {
		None
	}
}

/// A panel dismissed by a controller-owned cancellation token.
///
/// Used by collaboration dialogs so a response from another peer closes the
/// local projection without synthesizing a second answer.
pub struct CancelledPanel {
	inner:  Box<dyn Panel>,
	cancel: CancellationToken,
	wake:   Duration,
}

impl CancelledPanel {
	/// Wraps a projected panel with its controller-owned lifetime.
	#[must_use]
	pub fn new(inner: Box<dyn Panel>, cancel: CancellationToken) -> Self {
		Self { inner, cancel, wake: Duration::ZERO }
	}
}

impl Panel for CancelledPanel {
	fn id(&self) -> &'static str {
		self.inner.id()
	}

	fn anchor(&self) -> PanelAnchor {
		self.inner.anchor()
	}

	fn action(&mut self, action: PanelAction) -> PanelEvent {
		if self.cancel.is_cancelled() {
			PanelEvent::Close
		} else {
			self.inner.action(action)
		}
	}

	fn key(&mut self, key: Key) -> PanelEvent {
		if self.cancel.is_cancelled() {
			PanelEvent::Close
		} else {
			self.inner.key(key)
		}
	}

	fn paste(&mut self, text: &str) -> PanelEvent {
		if self.cancel.is_cancelled() {
			PanelEvent::Close
		} else {
			self.inner.paste(text)
		}
	}

	fn touch(&mut self, now: Duration) {
		self.inner.touch(now);
	}

	fn mouse(&mut self, report: MouseReport) -> PanelEvent {
		if self.cancel.is_cancelled() {
			PanelEvent::Close
		} else {
			self.inner.mouse(report)
		}
	}

	fn notify(&mut self, note: PanelNote<'_>) -> PanelEvent {
		if self.cancel.is_cancelled() {
			PanelEvent::Close
		} else {
			self.inner.notify(note)
		}
	}

	fn set_context(&mut self, ctx: &UiContext) {
		self.inner.set_context(ctx);
	}

	fn frame(&mut self, viewport: Size) -> &Frame {
		self.inner.frame(viewport)
	}

	fn tick(&mut self, now: Duration) -> bool {
		self.wake = now.saturating_add(Duration::from_millis(50));
		self.inner.tick(now) || self.cancel.is_cancelled()
	}

	fn next_wake(&self) -> Option<Duration> {
		self
			.inner
			.next_wake()
			.map_or(Some(self.wake), |inner| Some(inner.min(self.wake)))
	}

	fn finished(&self) -> bool {
		self.cancel.is_cancelled() || self.inner.finished()
	}

	fn settled(&mut self) -> Option<PanelEvent> {
		if self.cancel.is_cancelled() {
			None
		} else {
			self.inner.settled()
		}
	}
}

/// Deferred panel constructor posted by a console command; the host runs
/// it with its live facts. Compared by identity.
#[derive(Clone)]
pub struct PanelOpener(Arc<dyn Fn(&PanelCx<'_>) -> Result<Box<dyn Panel>, Str> + Send + Sync>);

impl PanelOpener {
	/// Wraps a constructor.
	pub fn new(
		open: impl Fn(&PanelCx<'_>) -> Result<Box<dyn Panel>, Str> + Send + Sync + 'static,
	) -> Self {
		Self(Arc::new(open))
	}

	/// Runs the constructor.
	pub fn open(&self, cx: &PanelCx<'_>) -> Result<Box<dyn Panel>, Str> {
		(self.0)(cx)
	}
}

impl fmt::Debug for PanelOpener {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.write_str("PanelOpener")
	}
}

impl PartialEq for PanelOpener {
	fn eq(&self, other: &Self) -> bool {
		Arc::ptr_eq(&self.0, &other.0)
	}
}

impl Eq for PanelOpener {}

/// Deferred host-side effect posted by a console command that needs the
/// host's facts but opens nothing; its event runs through the panel path.
#[derive(Clone)]
pub struct PanelCall(Arc<dyn Fn(&PanelCx<'_>) -> PanelEvent + Send + Sync>);

impl PanelCall {
	/// Wraps a call.
	pub fn new(call: impl Fn(&PanelCx<'_>) -> PanelEvent + Send + Sync + 'static) -> Self {
		Self(Arc::new(call))
	}

	/// Runs the call.
	pub fn call(&self, cx: &PanelCx<'_>) -> PanelEvent {
		(self.0)(cx)
	}
}

impl fmt::Debug for PanelCall {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.write_str("PanelCall")
	}
}

impl PartialEq for PanelCall {
	fn eq(&self, other: &Self) -> bool {
		Arc::ptr_eq(&self.0, &other.0)
	}
}

impl Eq for PanelCall {}

const HISTORY_HINT: &str =
	"↑/↓ prompts · Enter edit · Ctrl+Enter submit · Ctrl+C copy · type search · Esc close";
const FRAME_ROWS: u16 = 6;

/// One open approval prompt projected from `<queues><prompts>`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ApprovalOverlay {
	/// Stable prompt identity returned with the decision.
	pub id:      Str,
	/// Short user-facing operation title.
	pub title:   Str,
	/// Explanation supplied by host policy.
	pub reason:  Str,
	/// Default scope offered by the controller.
	pub scope:   ApprovalScope,
	/// Whether every requirement of the prompt offers a session-wide grant;
	/// only then does `a` answer it. The policy behind a once-only prompt (a
	/// path sandbox amendment) refuses a session answer.
	pub session: bool,
	/// Controller-set deadline after which the kernel answers with the
	/// prompt's default (`timeout-ms`); `None` waits indefinitely.
	pub timeout: Option<Duration>,
}

impl ApprovalOverlay {
	/// Builds the decision represented by an approval hotkey; `a` is no
	/// answer when the prompt offers no session-wide grant.
	#[must_use]
	pub fn decision(&self, key: char) -> Option<ApprovalDecision> {
		let (approved, scope) = match key {
			'y' => (true, self.scope.clone()),
			'a' if self.session => (true, ApprovalScope::Session),
			'n' => (false, ApprovalScope::Once),
			_ => return None,
		};
		Some(ApprovalDecision {
			approved,
			scope,
			source: ApprovalSource::User,
			decided_by: None,
			reason: None,
			audited: false,
		})
	}
}

/// One model shown by the picker, built by the application from the catalog.
#[derive(Clone, Debug, PartialEq)]
pub struct ModelRow {
	/// Stable catalog model key (`provider/model`).
	pub key:         Str,
	/// Human-readable model name.
	pub name:        Str,
	/// Stable provider identifier used to resolve its packaged logo.
	pub provider_id: Str,
	/// Human-readable provider name.
	pub provider:    Str,
	/// Context-window size in tokens, when known.
	pub context:     Option<u64>,
	/// Input price in dollars per million tokens, when known.
	pub input_mtok:  Option<f64>,
	/// Output price in dollars per million tokens, when known.
	pub output_mtok: Option<f64>,
	/// Supported thinking efforts ordered least to most intensive; empty for
	/// non-reasoning models.
	pub efforts:     Vec<Str>,
}

/// One configured Ctrl+P role exposed as a virtual `@role` picker row.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct QuickRoleRow {
	/// Role name without the leading `@`.
	pub role:     Str,
	/// Index of the role's resolved model in [`ModelPicker::rows`].
	pub model:    usize,
	/// Role-specific thinking level, when configured.
	pub thinking: Option<Str>,
}

/// What a routed picker key did.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PickerEvent {
	/// The picker consumed the key and remains open.
	Consumed,
	/// Close without choosing.
	Close,
	/// Choose the model at this row index for the session.
	Pick(usize),
	/// Choose the model at this row index for task subagents.
	PickTask(usize),
	/// Apply the configured quick role at this role-row index.
	PickRole(usize),
	/// Assign (or, when it already holds the role, clear) `role` to the
	/// model at this row index; the picker stays open.
	AssignRole {
		/// Role the highlighted model should hold.
		role:  PickerRole,
		/// Row index of the highlighted model.
		index: usize,
	},
	/// Put this prompt text back into the composer.
	Recall(Str),
	/// Submit this prompt directly from history.
	SubmitHistory(Str),
	/// Copy this prompt while keeping history open.
	CopyHistory(Str),
}

/// Retained Ctrl+R prompt-history picker.
pub struct HistoryPicker {
	ui:         Ui,
	source:     Vec<HistoryEntry>,
	entries:    Vec<HistoryEntry>,
	services:   Option<Arc<dyn Services>>,
	selected:   Option<usize>,
	ctx:        UiContext,
	query:      Str,
	width:      u16,
	rows:       u16,
	/// Bumped whenever the listed entries change.
	generation: u64,
	/// The native picker and the `(generation, selected)` it was built for.
	tsp:        (Option<(u64, Option<usize>)>, Node),
}

impl HistoryPicker {
	/// Opens the picker over durable entries, newest first.
	#[must_use]
	pub fn open(
		entries: Vec<HistoryEntry>,
		services: Option<Arc<dyn Services>>,
		width: u16,
		ctx: &UiContext,
	) -> Self {
		let selected = (!entries.is_empty()).then_some(0);
		let mut picker = Self {
			ui: Ui::from_root(dom! { <col/> }, width, ctx.clone()),
			source: entries.clone(),
			entries,
			services,
			selected,
			ctx: ctx.clone(),
			query: Str::default(),
			width,
			rows: 6,
			generation: 0,
			tsp: (None, PickerProps::default().node(Str::new_static(HISTORY_PICKER_ID), Vec::new())),
		};
		picker.rebuild();
		picker
	}

	/// Restyles the retained picker without changing its query or selection.
	pub(crate) fn set_context(&mut self, ctx: &UiContext) {
		self.ctx = ctx.clone();
		self.ui.set_context(ctx.clone());
	}

	/// Entries in current query order.
	#[must_use]
	pub fn entries(&self) -> &[HistoryEntry] {
		&self.entries
	}

	/// Routes a key into the filter and list.
	pub fn key(&mut self, key: Key) -> PickerEvent {
		if matches!(key, Key::Ctrl('c') | Key::Copy) {
			return self
				.selected_prompt()
				.map_or(PickerEvent::Consumed, PickerEvent::CopyHistory);
		}
		if key == Key::FollowUp {
			return self
				.selected_prompt()
				.map_or(PickerEvent::Consumed, PickerEvent::SubmitHistory);
		}
		let event = self.ui.handle_key(key);
		self.route(event)
	}

	/// Routes pasted text into the filter.
	pub fn paste(&mut self, text: &str) -> PickerEvent {
		let event = self.ui.handle_paste(text);
		self.route(event)
	}

	/// Routes pointer input through the picker hit map.
	pub fn mouse(&mut self, report: MouseReport) -> PickerEvent {
		let event = self
			.ui
			.handle_mouse_with_mods(report.col, report.row, report.kind, report.mods);
		self.route(event)
	}

	/// Reflows for a viewport, returning the frame to composite.
	pub fn frame(&mut self, viewport: Size) -> &Frame {
		let rows = (viewport.height * 2 / 5).saturating_sub(FRAME_ROWS).max(5);
		if rows != self.rows {
			self.rows = rows;
			self.ui.set_prop("prompts", Prop::H, rows.saturating_add(1));
		}
		if self.width != viewport.width {
			self.width = viewport.width;
			self.rebuild();
		}
		self.ui.frame()
	}

	fn selected_prompt(&self) -> Option<Str> {
		self
			.selected
			.and_then(|index| self.entries.get(index))
			.map(|entry| entry.prompt.clone())
	}

	fn route(&mut self, event: UiEvent) -> PickerEvent {
		match event {
			UiEvent::Cancel => PickerEvent::Close,
			UiEvent::Highlighted { id, value } if id.as_str() == "prompts" => {
				self.selected = value.as_str().parse::<usize>().ok();
				PickerEvent::Consumed
			},
			UiEvent::Changed { id, value } if id.as_str() == "prompts" => value
				.as_str()
				.parse::<usize>()
				.ok()
				.and_then(|index| self.entries.get(index))
				.map(|entry| entry.prompt.clone())
				.map_or(PickerEvent::Consumed, PickerEvent::Recall),
			UiEvent::Filtered { id, query, .. } if id.as_str() == "prompts" => {
				self.query = query;
				self.refresh_entries();
				// Reset the cursor to the highest-ranked result after
				// every query edit.
				self.selected = (!self.entries.is_empty()).then_some(0);
				self.rebuild();
				PickerEvent::Consumed
			},
			_ => PickerEvent::Consumed,
		}
	}

	fn refresh_entries(&mut self) {
		let query = self.query.trim();
		let tokens = history_query_tokens(&query);
		let mut entries = if query.is_empty() {
			self
				.services
				.as_ref()
				.and_then(|services| services.history_recent(100).ok())
				.unwrap_or_default()
		} else {
			self
				.services
				.as_ref()
				.and_then(|services| services.history_search(&query, 100).ok())
				.unwrap_or_default()
		};
		let mut seen = entries
			.iter()
			.map(|entry| entry.prompt.clone())
			.collect::<FastHashSet<_>>();
		for entry in &self.source {
			if entries.len() == 100 {
				break;
			}
			let matches = query.is_empty()
				|| (!tokens.is_empty() && {
					let prompt = entry.prompt.to_lowercase();
					tokens.iter().all(|token| prompt.contains(token))
				});
			if matches && seen.insert(entry.prompt.clone()) {
				entries.push(entry.clone());
			}
		}
		self.entries = entries;
		self.generation += 1;
	}

	fn rebuild(&mut self) {
		let seed = self.query.clone();
		let height = self.rows.saturating_add(1);
		let now = std::time::SystemTime::now()
			.duration_since(std::time::UNIX_EPOCH)
			.ok()
			.and_then(|duration| i64::try_from(duration.as_secs()).ok())
			.unwrap_or_default();
		let options = self
			.entries
			.iter()
			.enumerate()
			.map(|(index, entry)| {
				let first = entry.prompt.lines().next().unwrap_or_default();
				let more = entry.prompt.lines().count().saturating_sub(1);
				let label = if more > 0 {
					sf!("{first} (+{more} lines)")
				} else {
					Str::new(first)
				};
				let age = relative_history_time(now, entry.created_at);
				(sf!("{index}"), label, entry.prompt.clone(), age)
			})
			.collect::<Vec<_>>();
		let empty = options.is_empty();
		let empty_message = if self.query.is_empty() {
			"No history yet"
		} else {
			"No matching history"
		};
		let tree = dom! {
			<box border=round title="Search History" pad-x=1>
				<col>
					<select id="prompts" filter={seed} h={height}>
						for (value, label, search, age) in options {
							<option value={value} label={search}>
								<td truncate grow><pre>{label}</pre></td>
								if let Some(age) = age { <td><pre fg=muted>{age}</pre></td> }
							</option>
						}
					</select>
					if empty { <text fg=muted>{empty_message}</text> }
					<hr border=round/>
					<text fg=muted truncate>{HISTORY_HINT}</text>
				</col>
			</box>
		};
		self.ui = Ui::from_root(tree, self.width, self.ctx.clone());
	}

	/// The history list as a data-first TSP `picker` (v1 history search):
	/// the listed prompts as items keyed by their history row id, the
	/// selected one named by that id, and no preview pane.
	///
	/// The node is rebuilt only when the list or its selection changed.
	pub fn tsp_node(&mut self) -> &Node {
		let key = (self.generation, self.selected);
		if self.tsp.0 != Some(key) {
			self.tsp = (Some(key), self.build_tsp_node());
		}
		&self.tsp.1
	}

	fn build_tsp_node(&self) -> Node {
		let now = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.ok()
			.and_then(|duration| i64::try_from(duration.as_secs()).ok())
			.unwrap_or_default();
		let items = self
			.entries
			.iter()
			.map(|entry| {
				let mut facts = BTreeMap::new();
				if let Some(age) = relative_history_time(now, entry.created_at) {
					facts.insert(Str::new_static(HISTORY_AGE_COLUMN), Fact::Text(age));
				}
				PickerItem {
					id: history_item_id(entry),
					label: Str::new(entry.prompt.lines().next().unwrap_or_default().trim()),
					detail: None,
					mono: false,
					facts,
					chips: Vec::new(),
					title: None,
				}
			})
			.collect();
		PickerProps {
			title: Some(Str::new_static("Search History")),
			icon: Some(Str::new_static("history")),
			noun: Some(Str::new_static("prompts")),
			size: Some(PickerSize::Md),
			layout: Some(PickerLayout::Rows),
			query: Some(self.query.clone()),
			placeholder: Some(Str::new_static("Search prompts…")),
			columns: vec![PickerColumn {
				id:     Str::new_static(HISTORY_AGE_COLUMN),
				head:   None,
				format: Some(ColumnFormat::Time),
			}],
			items,
			selected: self
				.selected
				.and_then(|index| self.entries.get(index))
				.map(history_item_id),
			preview: Some(PickerPreview::None),
			actions: vec![PickerAction::confirm("Edit"), PickerAction::close()],
			empty: Some(Str::new_static(if self.query.is_empty() {
				"No history yet"
			} else {
				"No matching history"
			})),
			..PickerProps::default()
		}
		.node(Str::new_static(HISTORY_PICKER_ID), Vec::new())
	}

	/// Applies a Tern pointer gesture on the native picker the way the cell
	/// list's keys do (v1 history search): `select` moves the cursor to the
	/// prompt, `activate` and the `confirm` action put it back into the
	/// composer, `close` and `cancel` close. A prompt the list does not show
	/// is ignored.
	pub fn tsp_gesture(&mut self, gesture: Gesture) -> PickerEvent {
		let (item, activate) = match gesture {
			Gesture::Act(PickerAct::Close | PickerAct::Cancel) => return PickerEvent::Close,
			Gesture::Act(PickerAct::Confirm) => {
				return self
					.selected_prompt()
					.map_or(PickerEvent::Consumed, PickerEvent::Recall);
			},
			Gesture::Select(item) => (item, false),
			Gesture::Activate(item) => (item, true),
		};
		let Some(index) = item
			.parse::<i64>()
			.ok()
			.and_then(|id| self.entries.iter().position(|entry| entry.id == id))
		else {
			return PickerEvent::Consumed;
		};
		let value = sf!("{index}");
		let shown = self
			.ui
			.with_component_mut::<Select, _>("prompts", |select| select.highlight_value(&value))
			.unwrap_or(false);
		if !shown {
			return PickerEvent::Consumed;
		}
		self.ui.invalidate("prompts");
		self.selected = Some(index);
		if activate {
			self
				.selected_prompt()
				.map_or(PickerEvent::Consumed, PickerEvent::Recall)
		} else {
			PickerEvent::Consumed
		}
	}
}

/// Id of the native history picker, which Tern names in its events.
pub const HISTORY_PICKER_ID: &str = "history-picker";
/// Fact column of a prompt's age.
const HISTORY_AGE_COLUMN: &str = "when";

/// A history prompt's native picker id: its history row id, which survives
/// the list being filtered or reordered.
fn history_item_id(entry: &HistoryEntry) -> Str {
	sf!("{}", entry.id)
}

fn history_query_tokens(query: &str) -> Vec<String> {
	query
		.split(|character: char| !character.is_alphanumeric())
		.filter(|token| !token.is_empty())
		.map(str::to_lowercase)
		.collect()
}

fn relative_history_time(now: i64, then: i64) -> Option<Str> {
	if then <= 0 {
		return None;
	}
	let seconds = now.saturating_sub(then).max(0);
	Some(if seconds < 60 {
		Str::new_static("now")
	} else if seconds < 3_600 {
		sf!("{}m", seconds / 60)
	} else if seconds < 86_400 {
		sf!("{}h", seconds / 3_600)
	} else if seconds < 604_800 {
		sf!("{}d", seconds / 86_400)
	} else if seconds < 2_592_000 {
		sf!("{}w", seconds / 604_800)
	} else if seconds < 31_536_000 {
		sf!("{}mo", seconds / 2_592_000)
	} else {
		sf!("{}y", seconds / 31_536_000)
	})
}

/// Local overlay kind. Overlay state never enters the authoritative DOM.
pub enum Overlay {
	/// Session/task model picker.
	Models(ModelPicker),
	/// Prompt-history picker.
	History(HistoryPicker),
	/// Tool approval prompt projected from the session queue.
	Approval(ApprovalOverlay),
	/// Command-owned panel (session picker, tree, dashboards, side panels).
	Panel(Box<dyn Panel>),
}

impl Overlay {
	fn set_context(&mut self, ctx: &UiContext) {
		match self {
			Self::Models(picker) => picker.set_context(ctx),
			Self::History(picker) => picker.set_context(ctx),
			Self::Panel(panel) => panel.set_context(ctx),
			Self::Approval(_) => {},
		}
	}

	/// Stable identity for `HostCommand::Overlay` and the debug `values` op.
	#[must_use]
	pub fn id(&self) -> &'static str {
		match self {
			Self::Models(_) => "models",
			Self::History(_) => "history",
			Self::Approval(_) => "approval",
			Self::Panel(panel) => panel.id(),
		}
	}

	/// Whether this overlay holds keyboard focus (everything but a side
	/// panel, which leaves the composer live).
	#[must_use]
	pub fn modal(&self) -> bool {
		match self {
			Self::Panel(panel) => panel.anchor() != PanelAnchor::Side,
			_ => true,
		}
	}
}

/// Retained local overlay stack plus the transient status notice and the
/// history behind it.
#[derive(Default)]
pub struct Overlays {
	stack:   Vec<Overlay>,
	notices: NoticeLog,
}

impl Overlays {
	/// Applies a new ambient context to every retained overlay.
	pub fn set_context(&mut self, ctx: &UiContext) {
		for overlay in &mut self.stack {
			overlay.set_context(ctx);
		}
	}

	/// Pushes an overlay on top of the stack.
	pub fn show(&mut self, overlay: Overlay) {
		self.stack.push(overlay);
	}

	/// Shows a transient status line, cleared by the next
	/// key; it never displaces an interactive overlay. A notice posted while
	/// another is showing replaces it in the row, which counts it as `+N
	/// more`; every notice stays listed by `/notices`.
	pub fn notify(&mut self, text: impl Into<Str>) {
		self.notices.post(text.into());
	}

	/// Delivers a controller or DOM fact to open panels from newest to
	/// oldest. Exactly one panel owns any request, so the first consumed
	/// event wins while unrelated panels remain observers.
	pub fn notify_panels(&mut self, note: PanelNote<'_>) -> PanelEvent {
		for overlay in self.stack.iter_mut().rev() {
			let Overlay::Panel(panel) = overlay else {
				continue;
			};
			let event = panel.notify(note);
			if event != PanelEvent::Ignored {
				return event;
			}
		}
		PanelEvent::Ignored
	}

	/// Every stacked overlay, bottom first.
	pub fn iter_mut(&mut self) -> impl DoubleEndedIterator<Item = &mut Overlay> + ExactSizeIterator {
		self.stack.iter_mut()
	}

	/// Number of stacked overlays.
	#[must_use]
	pub const fn depth(&self) -> usize {
		self.stack.len()
	}

	/// Whether the topmost overlay is a side-channel panel.
	#[must_use]
	pub fn side_panel(&self) -> bool {
		matches!(self.stack.last(), Some(Overlay::Panel(panel)) if panel.anchor() == PanelAnchor::Side)
	}

	/// Reprojects the first pending approval from the detached DOM replica.
	///
	/// A pending approval always wins; when none is pending, a stale approval
	/// overlay is cleared and any other local overlay is retained.
	pub fn sync_approval(&mut self, dom: &Dom) {
		let approval = dom
			.children(dom.queues())
			.iter()
			.filter_map(|handle| dom.get(*handle))
			.find(|node| node.tag == Tag::Known(KnownTag::Prompts))
			.into_iter()
			.flat_map(|prompts| prompts.kids.iter())
			.filter_map(|handle| dom.get(*handle))
			.find(|node| {
				node.tag == Tag::Known(KnownTag::Prompt)
					&& text_prop(node, PropId::Kind) == Some("approval")
					&& matches!(text_prop(node, PropId::Status), Some("pending" | "open"))
			})
			.and_then(|node| {
				let id = text_prop(node, PropId::Id)?;
				let scope = custom_text(node, "scope")
					.unwrap_or("once")
					.parse::<ApprovalScope>()
					.expect("approval scope parsing is infallible");
				let timeout = node
					.prop(&PropKey::Custom(Str::new_static("timeout-ms")))
					.and_then(|value| match value {
						Value::Int(ms) => u64::try_from(*ms).ok(),
						_ => None,
					})
					.filter(|ms| *ms > 0)
					.map(Duration::from_millis);
				// The journaled ticket is the one record of what each merged
				// requirement offers; an unreadable one offers no session grant.
				let session = custom_text(node, "ticket")
					.and_then(|ticket| serde_json::from_str::<ApprovalTicket>(ticket).ok())
					.is_some_and(|ticket| ticket.offers(&ApprovalScope::Session));
				Some(ApprovalOverlay {
					id: Str::new(id),
					title: Str::new(text_prop(node, PropId::Label).unwrap_or("Approval required")),
					reason: Str::new(text_prop(node, PropId::Detail).unwrap_or_default()),
					scope,
					session,
					timeout,
				})
			});
		let at = self
			.stack
			.iter()
			.position(|overlay| matches!(overlay, Overlay::Approval(_)));
		match (approval, at) {
			(Some(approval), Some(at)) => {
				self.stack.remove(at);
				self.stack.push(Overlay::Approval(approval));
			},
			(Some(approval), None) => self.stack.push(Overlay::Approval(approval)),
			(None, Some(at)) => {
				self.stack.remove(at);
			},
			(None, None) => {},
		}
	}

	/// Pops the topmost observer-local overlay.
	pub fn dismiss(&mut self) -> Option<Overlay> {
		self.stack.pop()
	}

	/// Removes the overlay with stable identity `id` wherever it sits in
	/// the stack; returns whether one was open.
	pub fn close_id(&mut self, id: &str) -> bool {
		match self.stack.iter().rposition(|overlay| overlay.id() == id) {
			Some(at) => {
				self.stack.remove(at);
				true
			},
			None => false,
		}
	}

	/// Whether an overlay with stable identity `id` is open.
	#[must_use]
	pub fn is_open(&self, id: &str) -> bool {
		self.stack.iter().any(|overlay| overlay.id() == id)
	}

	/// Drops the transient notice, keeping every interactive overlay.
	pub fn clear_notice(&mut self) {
		self.notices.clear_visible();
	}

	/// Returns the topmost overlay.
	#[must_use]
	pub fn active(&self) -> Option<&Overlay> {
		self.stack.last()
	}

	/// Returns the topmost overlay mutably.
	pub fn active_mut(&mut self) -> Option<&mut Overlay> {
		self.stack.last_mut()
	}

	/// Whether the topmost overlay holds keyboard focus.
	#[must_use]
	pub fn modal(&self) -> bool {
		self.stack.last().is_some_and(Overlay::modal)
	}

	/// Whether the topmost overlay takes pointer input: every modal overlay
	/// and a side panel (which scrolls and clicks while the composer stays
	/// live). Drives terminal mouse tracking.
	#[must_use]
	pub fn pointer(&self) -> bool {
		self.stack.last().is_some()
	}

	/// Returns the pending approval, when one is stacked.
	#[must_use]
	pub fn approval(&self) -> Option<&ApprovalOverlay> {
		self.stack.iter().rev().find_map(|overlay| match overlay {
			Overlay::Approval(approval) => Some(approval),
			_ => None,
		})
	}

	/// Returns the visible notice text.
	#[must_use]
	pub fn notice(&self) -> Option<&str> {
		self.notices.visible().map(Str::as_str)
	}

	/// The notice row's `+N more (/notices)` label, when notices stacked
	/// under the visible one.
	#[must_use]
	pub const fn notice_more(&self) -> Option<&Str> {
		self.notices.more()
	}

	/// Every retained notice, for `/notices`.
	#[must_use]
	pub const fn notice_log(&self) -> &NoticeLog {
		&self.notices
	}
}

/// User prompts on the live chain, newest first, for the history picker.
#[must_use]
pub fn prompt_history(dom: &Dom) -> Vec<Str> {
	let mut prompts = Vec::new();
	for turn in dom.children(dom.body()).iter().rev() {
		for child in dom.children(*turn).iter().rev() {
			let Some(node) = dom.get(*child) else {
				continue;
			};
			if node.tag != Tag::Known(KnownTag::User) {
				continue;
			}
			let Some(text) = node.content.as_ref() else {
				continue;
			};
			if !text.trim().is_empty() && !prompts.contains(text) {
				prompts.push(text.clone());
			}
		}
	}
	prompts
}

fn text_prop(node: &omp_dom::Node, prop: PropId) -> Option<&str> {
	node.prop(&prop.into()).and_then(Value::as_str)
}

fn custom_text<'a>(node: &'a omp_dom::Node, name: &'static str) -> Option<&'a str> {
	node
		.prop(&PropKey::Custom(Str::new_static(name)))
		.and_then(Value::as_str)
}

#[cfg(test)]
mod tests {
	use super::*;

	fn row(provider: &'static str, name: &'static str) -> ModelRow {
		ModelRow {
			key:         sf!("{provider}/{name}"),
			name:        Str::new_static(name),
			provider_id: Str::new_static(provider),
			provider:    Str::new_static(provider),
			context:     None,
			input_mtok:  None,
			output_mtok: None,
			efforts:     Vec::new(),
		}
	}

	fn picker(rows: Vec<ModelRow>, current: usize, task_current: usize) -> ModelPicker {
		ModelPicker::open(
			rows,
			current,
			task_current,
			Vec::new(),
			None,
			true,
			Size::new(100, 40),
			&UiContext::default(),
		)
	}

	/// The native history picker names prompts by their history row id and
	/// its gestures do what the keys do: `select` moves the cursor and recalls
	/// nothing, `activate` and `confirm` recall, `close` closes, and an id the
	/// list does not show is ignored.
	#[test]
	fn history_picker_native_rows_are_keyed_by_row_id_and_gestures_recall() {
		use omp_tui::tsp::picker::{Gesture, PickerAct, PickerProps, read};

		let entry = |id: i64, prompt: &'static str| HistoryEntry {
			id,
			prompt: Str::new_static(prompt),
			created_at: 0,
			cwd: None,
			session_id: None,
		};
		let entries = vec![entry(7, "newest deploy"), entry(-1, "older\nsecond line")];
		let mut picker = HistoryPicker::open(entries, None, 80, &UiContext::default());
		let props: PickerProps = read(picker.tsp_node()).expect("picker props");
		assert_eq!(
			props
				.items
				.iter()
				.map(|item| (item.id.as_str(), item.label.as_str()))
				.collect::<Vec<_>>(),
			[("7", "newest deploy"), ("-1", "older")]
		);
		assert_eq!(props.selected.as_deref(), Some("7"));

		assert_eq!(picker.tsp_gesture(Gesture::Select(Str::new_static("-1"))), PickerEvent::Consumed);
		let props: PickerProps = read(picker.tsp_node()).expect("picker props");
		assert_eq!(props.selected.as_deref(), Some("-1"), "select moves the selection");
		assert_eq!(
			picker.key(Key::Enter),
			PickerEvent::Recall(Str::new_static("older\nsecond line")),
			"the cell list's cursor moved with it"
		);
		assert_eq!(
			picker.tsp_gesture(Gesture::Act(PickerAct::Confirm)),
			PickerEvent::Recall(Str::new_static("older\nsecond line"))
		);
		assert_eq!(
			picker.tsp_gesture(Gesture::Activate(Str::new_static("7"))),
			PickerEvent::Recall(Str::new_static("newest deploy"))
		);
		assert_eq!(
			picker.tsp_gesture(Gesture::Activate(Str::new_static("42"))),
			PickerEvent::Consumed
		);
		assert_eq!(picker.tsp_gesture(Gesture::Act(PickerAct::Close)), PickerEvent::Close);
	}

	#[test]
	fn history_picker_searches_recalls_copies_and_submits() {
		let entries = vec![
			HistoryEntry {
				id:         2,
				prompt:     Str::new_static("newest deploy"),
				created_at: i64::MAX,
				cwd:        None,
				session_id: Some(Str::new_static("two")),
			},
			HistoryEntry {
				id:         1,
				prompt:     Str::new_static("older\nsecond line"),
				created_at: 0,
				cwd:        None,
				session_id: Some(Str::new_static("one")),
			},
		];
		use omp_tui::{Mods, Mouse, MouseButton};

		let mut pointer_picker =
			HistoryPicker::open(entries.clone(), None, 80, &UiContext::default());
		let frame = omp_tui::frame_text(pointer_picker.frame(Size::new(80, 30)));
		let (col, row) = frame
			.lines()
			.enumerate()
			.find_map(|(row, line)| {
				let byte = line.find("older")?;
				Some((omp_tui::cell_width(&line[..byte]), u16::try_from(row).unwrap()))
			})
			.expect("older prompt row is painted");
		assert_eq!(
			pointer_picker.mouse(MouseReport {
				kind: Mouse::Click,
				col,
				row,
				button: MouseButton::Left,
				mods: Mods::default(),
				pressed: true,
			}),
			PickerEvent::Recall(Str::new_static("older\nsecond line"))
		);

		let mut picker = HistoryPicker::open(entries, None, 80, &UiContext::default());
		assert_eq!(
			picker.key(Key::Ctrl('c')),
			PickerEvent::CopyHistory(Str::new_static("newest deploy"))
		);
		assert_eq!(
			picker.key(Key::FollowUp),
			PickerEvent::SubmitHistory(Str::new_static("newest deploy"))
		);
		assert_eq!(picker.key(Key::Down), PickerEvent::Consumed);
		assert_eq!(
			picker.key(Key::Enter),
			PickerEvent::Recall(Str::new_static("older\nsecond line"))
		);
		for character in "deploy".chars() {
			assert_eq!(picker.key(Key::Char(character)), PickerEvent::Consumed);
		}
		assert_eq!(picker.entries().len(), 1);
		let text = omp_tui::frame_text(picker.frame(Size::new(80, 30)));
		assert!(text.contains("Search History"), "{text}");
		assert!(text.contains("newest deploy"), "{text}");
		assert!(!text.contains("(+1 lines)"), "{text}");

		picker.key(Key::Ctrl('u'));
		for character in "zzzz".chars() {
			picker.key(Key::Char(character));
		}
		let text = omp_tui::frame_text(picker.frame(Size::new(80, 30)));
		assert!(text.contains("No matching history"), "{text}");
	}

	#[test]
	fn notices_never_displace_a_modal_overlay_and_clear_on_request() {
		let mut overlays = Overlays::default();
		overlays.notify("hi");
		assert_eq!(overlays.notice(), Some("hi"));
		assert!(!overlays.modal());
		overlays.clear_notice();
		assert!(overlays.active().is_none());
		overlays.show(Overlay::Models(picker(vec![row("a", "b")], 0, 0)));
		overlays.notify("still");
		overlays.clear_notice();
		assert!(overlays.modal());
		assert_eq!(overlays.notice(), None);
	}

	struct Side;

	impl Panel for Side {
		fn id(&self) -> &'static str {
			"side"
		}

		fn anchor(&self) -> PanelAnchor {
			PanelAnchor::Side
		}

		fn key(&mut self, _key: Key) -> PanelEvent {
			PanelEvent::Ignored
		}

		fn frame(&mut self, _viewport: Size) -> &Frame {
			unreachable!("never painted in this test")
		}
	}

	#[test]
	fn overlays_stack_and_a_pending_approval_always_rises_to_the_top() {
		let mut overlays = Overlays::default();
		overlays.show(Overlay::Panel(Box::new(Side)));
		assert!(overlays.side_panel());
		assert!(!overlays.modal());
		overlays.show(Overlay::Models(picker(vec![row("a", "b")], 0, 0)));
		assert!(overlays.modal());
		assert_eq!(overlays.depth(), 2);
		assert_eq!(overlays.dismiss().map(|overlay| overlay.id()), Some("models"));
		assert_eq!(overlays.active().map(Overlay::id), Some("side"));
	}

	#[test]
	fn panel_actions_lower_the_pi_session_and_tree_chords() {
		assert_eq!(PanelAction::from_key(Key::Ctrl('p')), Some(PanelAction::TogglePath));
		assert_eq!(PanelAction::from_key(Key::Ctrl('s')), Some(PanelAction::ToggleSort));
		assert_eq!(PanelAction::from_key(Key::Ctrl('r')), Some(PanelAction::Rename));
		assert_eq!(PanelAction::from_key(Key::Ctrl('d')), Some(PanelAction::Delete));
		assert_eq!(PanelAction::from_key(Key::Ctrl('w')), Some(PanelAction::DeleteFast));
		assert_eq!(PanelAction::from_key(Key::WordLeft), Some(PanelAction::FoldUp));
		assert_eq!(PanelAction::from_key(Key::WordRight), Some(PanelAction::UnfoldDown));
		assert_eq!(PanelAction::from_key(Key::Ctrl('o')), Some(PanelAction::Expand));
		assert_eq!(PanelAction::from_key(Key::Char('x')), None);
	}
}
