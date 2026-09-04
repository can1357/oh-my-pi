//! `/resume` session picker as an observer-local [`Panel`] (ADR 0005).
//!
//! The picker opens on the project session index, then asks the controller
//! for project/global replacements when Tab toggles scope. It keeps only the
//! detached rows and sends every effect outward on the command stream (ADR
//! 0005/0014): typed index requests plus `resume`, `session_rename`, and
//! `session_delete` console lines.
//!
//! The picker stacks a search input over a multi-line session list; here the
//! list is one `<select filter>` whose rows carry session chords: Ctrl+P
//! toggles the path
//! column, Ctrl+S the sort key, Ctrl+R renames, Ctrl+D deletes with the
//! `Delete session?` confirmation, and
//! Ctrl+Backspace deletes without it.

use std::sync::Arc;

use jiff::{Timestamp, fmt::strtime, tz::TimeZone};
use omp_core::{FastHashMap, Str, StrMut, sf};
use omp_tui::{Frame, Key, MouseReport, Prop, Size, Ui, UiContext, UiEvent, dom};

use super::{
	Outcome, Panel, PanelAction, PanelAnchor, PanelCx, PanelEvent, PanelNote,
	services::{
		ForeignSessionRow, ForeignSessionSource, ServiceResult, Services, SessionRow, SessionScope,
	},
};
use crate::host::HostCommand;

/// Default heading.
const TITLE: &str = "Resume Session";
/// Footer with session chords.
const LIST_HINT: &str =
	"[Tab scope · Del · Enter · Ctrl+P path · Ctrl+S sort · Ctrl+R rename · Esc]";
const RENAME_HINT: &str = "[Enter save · Esc cancel]";
const CONFIRM_HINT: &str = "[y delete · n/Esc keep]";
/// Foreign import pickers use the same filter/select controls but expose no
/// native-session mutation chords.
const IMPORT_HINT: &str = "[Enter import · Esc cancel]";
/// Empty-state wording.
const NO_SESSIONS: &str = "No sessions found";
/// Border, hint rule, hint, and blank rows around the list.
const FRAME_ROWS: u16 = 6;
/// Prompt-history augmentation waits for a typing pause before touching SQLite.
const HISTORY_MERGE_DELAY: std::time::Duration = std::time::Duration::from_millis(150);
/// `YYYY-MM-DD HH:MM` row stamp.
const STAMP_FORMAT: &str = "%Y-%m-%d %H:%M";
/// Stamp shown when a timestamp cannot be represented.
const NO_STAMP: &str = "????-??-?? ??:??";
/// Indent drawn for a subagent child under its parent.
const CHILD_PREFIX: &str = "└ ";

/// Which timestamp orders the list and fills the date column.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Sort {
	Modified,
	Created,
}

impl Sort {
	const fn toggled(self) -> Self {
		match self {
			Self::Modified => Self::Created,
			Self::Created => Self::Modified,
		}
	}

	const fn stamp_ms(self, row: &SessionRow) -> u64 {
		match self {
			Self::Modified => row.modified_ms,
			Self::Created => row.created_ms,
		}
	}
}

/// What the panel body shows.
enum Mode {
	/// The filterable session list.
	List,
	/// Inline title prompt for `rows[index]`.
	Rename { index: usize, text: Str },
	/// `Delete session?` confirmation for `rows[index]`.
	Confirm { index: usize },
}

/// One list row in display order.
#[derive(Clone, Copy)]
struct Shown {
	row:   usize,
	child: bool,
}

/// Result of a controller-owned foreign transcript import.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ForeignSessionImportOutcome {
	/// Source that owned the selected transcript.
	pub source:   ForeignSessionSource,
	/// Selected source transcript.
	pub selected: std::path::PathBuf,
	/// Native `.oms` journal or the typed app error.
	pub result:   ServiceResult<std::path::PathBuf>,
}

/// Result of a controller-owned project/global session-index read.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionIndexOutcome {
	/// Scope that was requested.
	pub scope:  SessionScope,
	/// Detached rows or the controller's failure.
	pub result: Result<Vec<SessionRow>, Str>,
}

/// Retained `/resume @claude|@codex` picker. It owns only detached metadata;
/// conversion and persistence remain controller-owned.
pub struct ForeignSessionPicker {
	ui:      Ui,
	ctx:     UiContext,
	zone:    TimeZone,
	source:  ForeignSessionSource,
	rows:    Vec<ForeignSessionRow>,
	cursor:  Option<usize>,
	query:   Str,
	pending: Option<std::path::PathBuf>,
	width:   u16,
	height:  u16,
}

impl ForeignSessionPicker {
	/// Reads lightweight source metadata and opens the matching import picker.
	pub fn open(source: ForeignSessionSource, cx: &PanelCx<'_>) -> Result<Self, Str> {
		let mut rows = cx
			.services
			.foreign_sessions(source)
			.map_err(|error| sf!("Failed to list {source} sessions: {error}"))?;
		rows.retain(|row| row.source == source);
		if rows.is_empty() {
			return Err(sf!("No {source} sessions found"));
		}
		let mut picker = Self {
			ui: Ui::from_root(dom! { <col/> }, cx.viewport.width, cx.ui.clone()),
			ctx: cx.ui.clone(),
			zone: TimeZone::system(),
			source,
			rows,
			cursor: None,
			query: Str::default(),
			pending: None,
			width: cx.viewport.width,
			height: SessionPicker::list_rows_for(cx.viewport),
		};
		picker.rebuild();
		Ok(picker)
	}

	fn title(&self) -> Str {
		sf!("Import {} Session", self.source)
	}

	fn stamp(&self, ms: u64) -> Str {
		i64::try_from(ms)
			.ok()
			.and_then(|ms| Timestamp::from_millisecond(ms).ok())
			.and_then(|stamp| strtime::format(STAMP_FORMAT, &stamp.to_zoned(self.zone.clone())).ok())
			.map_or_else(|| Str::new_static(NO_STAMP), Str::new)
	}

	fn display_name(row: &ForeignSessionRow) -> &str {
		row.title
			.as_deref()
			.or_else(|| {
				row.first_message
					.as_deref()
					.and_then(|message| message.lines().find(|line| !line.trim().is_empty()))
			})
			.unwrap_or(row.id.as_str())
	}

	fn cursor_to(&mut self, value: &str) {
		self.cursor = self
			.rows
			.iter()
			.position(|row| row.path.to_string_lossy() == value);
	}

	fn rebuild(&mut self) {
		struct Line {
			value:    Str,
			label:    Str,
			stamp:    Str,
			messages: Str,
			name:     Str,
			cwd:      Str,
		}
		let lines = self
			.rows
			.iter()
			.map(|row| {
				let path = row.path.to_string_lossy();
				let cwd = row.cwd.to_string_lossy();
				let mut label = StrMut::with_capacity(128);
				if let Some(title) = &row.title {
					label.push_str(title.as_str());
					label.push(' ');
				}
				if let Some(first) = &row.first_message {
					label.push_str(first.as_str());
					label.push(' ');
				}
				label.push_str(row.id.as_str());
				label.push(' ');
				label.push_str(&path);
				label.push(' ');
				label.push_str(&cwd);
				Line {
					value:    Str::new(path),
					label:    label.freeze(),
					stamp:    self.stamp(row.modified_ms),
					messages: sf!("{} msgs", row.messages),
					name:     Str::new(Self::display_name(row)),
					cwd:      Str::new(cwd),
				}
			})
			.collect::<Vec<_>>();
		let title = self.title();
		let height = self.height.saturating_add(1);
		let query = self.query.clone();
		let tree = dom! {
			<box border=round title={title} pad-x=1>
				<col>
					<select id="foreign-sessions" filter={query} h={height}>
						for line in lines {
							<option value={line.value} label={line.label}>
								<td><pre fg=muted>{line.stamp}</pre></td>
								<td align=end><pre fg=muted>{line.messages}</pre></td>
								<td truncate grow><pre>{line.name}</pre></td>
								<td truncate=start><pre fg=muted>{line.cwd}</pre></td>
							</option>
						}
					</select>
					<hr border=round/>
					<text fg=muted truncate>{IMPORT_HINT}</text>
				</col>
			</box>
		};
		self.ui = Ui::from_root(tree, self.width, self.ctx.clone());
		if let UiEvent::Highlighted { value, .. } = self.ui.handle_key(Key::Home) {
			self.cursor_to(&value);
		}
	}

	fn ui_event(&mut self, event: UiEvent) -> PanelEvent {
		match event {
			UiEvent::Cancel => PanelEvent::Close,
			UiEvent::Highlighted { value, .. } => {
				self.cursor_to(&value);
				PanelEvent::Consumed
			},
			UiEvent::Filtered { query, value, .. } => {
				self.query = query;
				match value {
					Some(value) => self.cursor_to(&value),
					None => self.cursor = None,
				}
				PanelEvent::Consumed
			},
			UiEvent::Changed { value, .. } => {
				self.cursor_to(&value);
				let Some(index) = self.cursor else {
					return PanelEvent::Consumed;
				};
				let path = self.rows[index].path.clone();
				self.pending = Some(path.clone());
				PanelEvent::Command(HostCommand::ForeignSessionImport { source: self.source, path })
			},
			_ => PanelEvent::Consumed,
		}
	}
}

impl Panel for ForeignSessionPicker {
	fn id(&self) -> &'static str {
		"foreign-sessions"
	}

	fn anchor(&self) -> PanelAnchor {
		PanelAnchor::Bottom
	}

	fn action(&mut self, _action: PanelAction) -> PanelEvent {
		PanelEvent::Ignored
	}

	fn key(&mut self, key: Key) -> PanelEvent {
		if self.pending.is_some() {
			return PanelEvent::Consumed;
		}
		if key == Key::Esc {
			return PanelEvent::Close;
		}
		let event = self.ui.handle_key(key);
		self.ui_event(event)
	}

	fn notify(&mut self, note: PanelNote<'_>) -> PanelEvent {
		let PanelNote::Outcome(Outcome::ForeignSessionImport(outcome)) = note else {
			return PanelEvent::Ignored;
		};
		if outcome.source != self.source || self.pending.as_ref() != Some(&outcome.selected) {
			return PanelEvent::Ignored;
		}
		self.pending = None;
		match &outcome.result {
			Ok(path) if path.extension().and_then(|extension| extension.to_str()) == Some("oms") => {
				PanelEvent::FinishCommand(HostCommand::SessionOpen { path: path.clone() })
			},
			Ok(_) => PanelEvent::CloseNotice(sf!("Failed to persist {} session", self.source)),
			Err(error) => PanelEvent::CloseNotice(Str::new(error.to_string())),
		}
	}

	fn mouse(&mut self, report: MouseReport) -> PanelEvent {
		if self.pending.is_some() {
			return PanelEvent::Consumed;
		}
		let event = self
			.ui
			.handle_mouse_with_mods(report.col, report.row, report.kind, report.mods);
		self.ui_event(event)
	}

	fn paste(&mut self, text: &str) -> PanelEvent {
		if self.pending.is_some() {
			return PanelEvent::Consumed;
		}
		let event = self.ui.handle_paste(text);
		self.ui_event(event)
	}

	fn frame(&mut self, viewport: Size) -> &Frame {
		let height = SessionPicker::list_rows_for(viewport);
		if height != self.height {
			self.height = height;
			self
				.ui
				.set_prop("foreign-sessions", Prop::H, height.saturating_add(1));
		}
		if viewport.width != self.width {
			self.width = viewport.width;
			self.rebuild();
		}
		self.ui.frame()
	}
}

/// Retained `/resume` picker.
pub struct SessionPicker {
	ui:              Ui,
	ctx:             UiContext,
	zone:            TimeZone,
	rows:            Vec<SessionRow>,
	shown:           Vec<Shown>,
	/// Highlighted position in `shown`.
	cursor:          Option<usize>,
	query:           Str,
	mode:            Mode,
	full_path:       bool,
	sort:            Sort,
	scope:           SessionScope,
	requested:       Option<SessionScope>,
	history:         Option<Arc<dyn Services>>,
	history_matches: FastHashMap<Str, usize>,
	now:             std::time::Duration,
	history_due:     Option<std::time::Duration>,
	width:           u16,
	list_rows:       u16,
}

impl SessionPicker {
	/// Opens the picker over the host's session index in the local
	/// timezone. `Err` carries the service failure or empty-state
	/// wording when there is nothing to resume.
	pub fn open(cx: &PanelCx<'_>) -> Result<Self, Str> {
		let rows = cx
			.services
			.sessions(SessionScope::Project)
			.map_err(|error| Str::new(error.to_string()))?;
		let mut picker = Self::from_rows(rows, TimeZone::system(), cx.viewport, cx.ui)?;
		picker.history = Some(Arc::clone(cx.services));
		Ok(picker)
	}

	/// Opens the picker over `rows`, stamping dates in `zone`.
	pub fn from_rows(
		rows: Vec<SessionRow>,
		zone: TimeZone,
		viewport: Size,
		ctx: &UiContext,
	) -> Result<Self, Str> {
		if rows.is_empty() {
			return Err(Str::new_static(NO_SESSIONS));
		}
		let mut picker = Self {
			ui: Ui::from_root(dom! { <col/> }, viewport.width, ctx.clone()),
			ctx: ctx.clone(),
			zone,
			rows,
			shown: Vec::new(),
			cursor: None,
			query: Str::default(),
			mode: Mode::List,
			full_path: false,
			sort: Sort::Modified,
			scope: SessionScope::Project,
			requested: None,
			history: None,
			history_matches: FastHashMap::default(),
			now: std::time::Duration::ZERO,
			history_due: None,
			width: viewport.width,
			list_rows: Self::list_rows_for(viewport),
		};
		picker.reorder();
		picker.cursor = (!picker.shown.is_empty()).then_some(0);
		picker.rebuild();
		Ok(picker)
	}

	/// Rows still listed, in service order.
	#[must_use]
	pub fn rows(&self) -> &[SessionRow] {
		&self.rows
	}

	fn list_rows_for(viewport: Size) -> u16 {
		(viewport.height * 2 / 5).saturating_sub(FRAME_ROWS).max(5)
	}

	/// Recomputes display order: pinned first, then by the sort stamp
	/// newest first, with each subagent child indented under its parent.
	fn reorder(&mut self) {
		let sort = self.sort;
		let rows = &self.rows;
		let has_parent = |row: &SessionRow| {
			row.parent
				.as_ref()
				.is_some_and(|parent| rows.iter().any(|candidate| candidate.id == *parent))
		};
		let newest = |a: usize, b: usize| sort.stamp_ms(&rows[b]).cmp(&sort.stamp_ms(&rows[a]));
		let mut top = (0..rows.len())
			.filter(|&index| !has_parent(&rows[index]))
			.collect::<Vec<_>>();
		top.sort_by(|&a, &b| {
			rows[b]
				.pinned
				.cmp(&rows[a].pinned)
				.then_with(|| newest(a, b))
		});
		let mut shown = Vec::with_capacity(rows.len());
		for parent in top {
			shown.push(Shown { row: parent, child: false });
			let mut children = (0..rows.len())
				.filter(|&index| rows[index].parent.as_deref() == Some(rows[parent].id.as_str()))
				.collect::<Vec<_>>();
			children.sort_by(|&a, &b| newest(a, b));
			shown.extend(children.into_iter().map(|row| Shown { row, child: true }));
		}
		self.shown = shown;
	}

	fn reorder_for_query(&mut self) {
		self.reorder();
		if !self.history_matches.is_empty() {
			self.shown.sort_by_key(|shown| {
				self
					.history_matches
					.get(&self.rows[shown.row].id)
					.copied()
					.map_or((true, usize::MAX), |rank| (false, rank))
			});
		}
	}

	fn stamp(&self, ms: u64) -> Str {
		i64::try_from(ms)
			.ok()
			.and_then(|ms| Timestamp::from_millisecond(ms).ok())
			.and_then(|stamp| strtime::format(STAMP_FORMAT, &stamp.to_zoned(self.zone.clone())).ok())
			.map_or_else(|| Str::new_static(NO_STAMP), Str::new)
	}

	/// Title when named, else the id.
	fn display_name(row: &SessionRow) -> &str {
		row.title.as_deref().unwrap_or(row.id.as_str())
	}

	fn name_cell(&self, shown: Shown) -> Str {
		let row = &self.rows[shown.row];
		let base = if self.full_path {
			sf!("{}", row.path.display())
		} else {
			Str::new(Self::display_name(row))
		};
		if shown.child {
			sf!("{CHILD_PREFIX}{base}")
		} else {
			base
		}
	}

	fn current(&self) -> Option<usize> {
		self
			.cursor
			.and_then(|at| self.shown.get(at))
			.map(|shown| shown.row)
	}

	fn cursor_to(&mut self, value: &str) {
		self.cursor = self
			.shown
			.iter()
			.position(|shown| self.rows[shown.row].id.as_str() == value);
	}

	fn rebuild(&mut self) {
		let target = self.current().map(|row| self.rows[row].id.clone());
		self.ui = match &self.mode {
			Mode::List => self.build_list(),
			Mode::Rename { index, text } => self.build_rename(*index, text.clone()),
			Mode::Confirm { index } => self.build_confirm(*index),
		};
		if matches!(self.mode, Mode::List)
			&& let Some(target) = target
		{
			self.restore_cursor(&target);
		}
	}

	fn build_list(&self) -> Ui {
		struct Line {
			value:    Str,
			label:    Str,
			stamp:    Str,
			messages: Str,
			name:     Str,
			agent:    Option<Str>,
			pinned:   bool,
		}
		let lines = self
			.shown
			.iter()
			.map(|&shown| {
				let row = &self.rows[shown.row];
				let mut label = StrMut::with_capacity(96);
				if let Some(title) = &row.title {
					label.push_str(title.as_str());
					label.push(' ');
				}
				label.push_str(row.id.as_str());
				label.push(' ');
				let _ = std::fmt::Write::write_fmt(&mut label, format_args!("{}", row.path.display()));
				if let Some(agent) = &row.agent {
					label.push(' ');
					label.push_str(agent.as_str());
				}
				// Prompt matches lead the selector's search rank without
				// exposing private prompt text in the visible session row.
				if self.history_matches.contains_key(&row.id) {
					label = StrMut::new(self.query.clone());
				}
				Line {
					value:    row.id.clone(),
					label:    label.freeze(),
					stamp:    self.stamp(self.sort.stamp_ms(row)),
					messages: sf!("{} msgs", row.messages),
					name:     self.name_cell(shown),
					agent:    row.agent.clone(),
					pinned:   row.pinned,
				}
			})
			.collect::<Vec<_>>();
		let seed = self.query.clone();
		let height = self.list_rows.saturating_add(1);
		let title = self.list_title();
		let tree = dom! {
			<box border=round title={title} pad-x=1>
				<col>
					<select id="sessions" filter={seed} h={height}>
						for line in lines {
							<option value={line.value} label={line.label}>
								<td><pre fg=muted>{line.stamp}</pre></td>
								<td align=end><pre fg=muted>{line.messages}</pre></td>
								<td truncate=start grow>
									if line.pinned { <icon name="pin" fg=accent/> }
									<pre>{line.name}</pre>
								</td>
								if let Some(agent) = line.agent { <td truncate><pre fg=muted>{agent}</pre></td> }
							</option>
						}
					</select>
					<hr border=round/>
					<text fg=muted truncate>{LIST_HINT}</text>
				</col>
			</box>
		};
		Ui::from_root(tree, self.width, self.ctx.clone())
	}

	/// Suffixes the heading with the listing scope.
	fn list_title(&self) -> Str {
		let sort = match self.sort {
			Sort::Modified => "modified",
			Sort::Created => "created",
		};
		let scope = match self.requested.unwrap_or(self.scope) {
			SessionScope::Project => "project",
			SessionScope::All => "all projects",
		};
		sf!("{TITLE} (by {sort} · {scope})")
	}

	fn build_rename(&self, index: usize, text: Str) -> Ui {
		let name = sf!("Rename session: {}", Self::display_name(&self.rows[index]));
		let tree = dom! {
			<box border=round title={TITLE} pad-x=1>
				<col>
					<text fg=muted truncate>{name}</text>
					<input id="rename" value={text} placeholder="New title" submit/>
					<hr border=round/>
					<text fg=muted truncate>{RENAME_HINT}</text>
				</col>
			</box>
		};
		Ui::from_root(tree, self.width, self.ctx.clone())
	}

	fn build_confirm(&self, index: usize) -> Ui {
		let question = sf!("Delete {}? y/n", Self::display_name(&self.rows[index]));
		let tree = dom! {
			<box border=round title={TITLE} pad-x=1>
				<col>
					<text fg=warn truncate>{question}</text>
					<hr border=round/>
					<text fg=muted truncate>{CONFIRM_HINT}</text>
				</col>
			</box>
		};
		Ui::from_root(tree, self.width, self.ctx.clone())
	}

	/// Walks a freshly built list's cursor back onto `target`. The select
	/// wraps single steps, so one full lap without a hit means the row is
	/// filtered out; the cursor then rests on the first visible row.
	fn restore_cursor(&mut self, target: &str) {
		let mut first: Option<Str> = None;
		for _ in 0..self.shown.len() {
			let UiEvent::Highlighted { value, .. } = self.ui.handle_key(Key::Down) else {
				break;
			};
			if value.as_str() == target {
				self.cursor_to(target);
				return;
			}
			match &first {
				None => first = Some(value),
				Some(seen) if *seen == value => break,
				Some(_) => {},
			}
		}
		if let UiEvent::Highlighted { value, .. } = self.ui.handle_key(Key::Home) {
			self.cursor_to(&value);
		}
	}

	fn enter_mode(&mut self, mode: Mode) -> PanelEvent {
		self.mode = mode;
		self.rebuild();
		PanelEvent::Consumed
	}

	fn resume_line(row: &SessionRow) -> Str {
		let mut line = StrMut::new("resume ");
		push_quoted(&mut line, &row.path.display().to_string());
		line.freeze()
	}

	fn delete_now(&mut self, index: usize) -> PanelEvent {
		let row = self.rows.remove(index);
		let line = sf!("session_delete {}", row.id);
		self.reorder_for_query();
		self.cursor = self
			.cursor
			.map(|at| at.min(self.shown.len().saturating_sub(1)))
			.filter(|_| !self.shown.is_empty());
		self.mode = Mode::List;
		self.rebuild();
		PanelEvent::Run(line)
	}

	fn rename_now(&mut self, index: usize, title: &str) -> PanelEvent {
		let title = title.trim();
		self.mode = Mode::List;
		if title.is_empty() {
			self.rebuild();
			return PanelEvent::Consumed;
		}
		self.rows[index].title = Some(Str::new(title));
		let mut line = StrMut::new("session_rename ");
		line.push_str(self.rows[index].id.as_str());
		line.push(' ');
		push_quoted(&mut line, title);
		self.rebuild();
		PanelEvent::Run(line.freeze())
	}

	fn list_key(&mut self, key: Key) -> PanelEvent {
		if key == Key::Tab {
			if self.requested.is_some() {
				return PanelEvent::Consumed;
			}
			let scope = match self.scope {
				SessionScope::Project => SessionScope::All,
				SessionScope::All => SessionScope::Project,
			};
			self.requested = Some(scope);
			self.rebuild();
			return PanelEvent::Command(HostCommand::SessionIndex { scope });
		}
		// Delete, or Backspace on an empty
		// query, asks to delete the highlighted session.
		if key == Key::Delete || (key == Key::Backspace && self.query.is_empty()) {
			return self.action(PanelAction::Delete);
		}
		let event = self.ui.handle_key(key);
		self.list_event(event)
	}

	/// Applies what the list widget reported for a key or pointer gesture:
	/// highlight moves the cursor, filtering re-seats it, activation (Enter
	/// or a click on a row) resumes.
	fn list_event(&mut self, event: UiEvent) -> PanelEvent {
		match event {
			UiEvent::Cancel => PanelEvent::Close,
			UiEvent::Highlighted { value, .. } => {
				self.cursor_to(&value);
				PanelEvent::Consumed
			},
			UiEvent::Filtered { query, value, .. } => {
				self.query = query;
				self.history_matches.clear();
				self.history_due = (self.query.trim().chars().count() >= 2)
					.then_some(self.now.saturating_add(HISTORY_MERGE_DELAY));
				self.reorder_for_query();
				match value {
					Some(value) => self.cursor_to(&value),
					None => self.cursor = None,
				}
				self.rebuild();
				if self.cursor.is_none()
					&& let UiEvent::Highlighted { value, .. } = self.ui.handle_key(Key::Home)
				{
					self.cursor_to(&value);
				}
				PanelEvent::Consumed
			},
			UiEvent::Changed { value, .. } => {
				self.cursor_to(&value);
				self.current().map_or(PanelEvent::Consumed, |row| {
					PanelEvent::Finish(Self::resume_line(&self.rows[row]))
				})
			},
			_ => PanelEvent::Consumed,
		}
	}

	fn apply_history_ranking(&mut self) -> bool {
		let matches = self
			.history
			.as_ref()
			.and_then(|history| {
				history
					.history_matching_session_ids(self.query.as_str(), 500)
					.ok()
			})
			.unwrap_or_default();
		self.history_matches = matches
			.into_iter()
			.enumerate()
			.map(|(rank, id)| (id, rank))
			.collect();
		if self.history_matches.is_empty() {
			return false;
		}
		let selected = self.current().map(|index| self.rows[index].id.clone());
		self.reorder_for_query();
		self.cursor = selected
			.as_ref()
			.and_then(|id| {
				self
					.shown
					.iter()
					.position(|shown| self.rows[shown.row].id == *id)
			})
			.or_else(|| (!self.shown.is_empty()).then_some(0));
		self.rebuild();
		true
	}

	fn rename_key(&mut self, key: Key) -> PanelEvent {
		let event = self.ui.handle_key(key);
		self.rename_event(event)
	}

	fn rename_event(&mut self, event: UiEvent) -> PanelEvent {
		let Mode::Rename { index, .. } = self.mode else {
			return PanelEvent::Ignored;
		};
		match event {
			UiEvent::Cancel => self.enter_mode(Mode::List),
			UiEvent::Submit => {
				let Mode::Rename { text, .. } = std::mem::replace(&mut self.mode, Mode::List) else {
					return PanelEvent::Ignored;
				};
				self.rename_now(index, &text)
			},
			UiEvent::Changed { value, .. } => {
				self.mode = Mode::Rename { index, text: value };
				PanelEvent::Consumed
			},
			_ => PanelEvent::Consumed,
		}
	}

	fn confirm_key(&mut self, key: Key) -> PanelEvent {
		let Mode::Confirm { index } = self.mode else {
			return PanelEvent::Ignored;
		};
		match key {
			Key::Char('y' | 'Y') | Key::Enter => self.delete_now(index),
			Key::Char('n' | 'N') | Key::Esc => self.enter_mode(Mode::List),
			_ => PanelEvent::Consumed,
		}
	}
}

/// Appends `text` as a quoted console atom.
fn push_quoted(line: &mut StrMut, text: &str) {
	line.push('"');
	for ch in text.chars() {
		if matches!(ch, '"' | '\\') {
			line.push('\\');
		}
		line.push(ch);
	}
	line.push('"');
}

impl Panel for SessionPicker {
	fn id(&self) -> &'static str {
		"sessions"
	}

	fn anchor(&self) -> PanelAnchor {
		PanelAnchor::Bottom
	}

	fn action(&mut self, action: PanelAction) -> PanelEvent {
		if !matches!(self.mode, Mode::List) {
			return PanelEvent::Ignored;
		}
		match action {
			PanelAction::TogglePath => {
				self.full_path = !self.full_path;
				self.rebuild();
				PanelEvent::Consumed
			},
			PanelAction::ToggleSort => {
				self.sort = self.sort.toggled();
				self.reorder_for_query();
				self.rebuild();
				PanelEvent::Consumed
			},
			PanelAction::Rename => match self.current() {
				Some(index) => {
					let text = self.rows[index].title.clone().unwrap_or_default();
					self.enter_mode(Mode::Rename { index, text })
				},
				None => PanelEvent::Consumed,
			},
			PanelAction::Delete => match self.current() {
				Some(index) => self.enter_mode(Mode::Confirm { index }),
				None => PanelEvent::Consumed,
			},
			// With a query typed, Ctrl+W stays the filter's word rubout.
			PanelAction::DeleteFast if !self.query.is_empty() => PanelEvent::Ignored,
			PanelAction::DeleteFast => match self.current() {
				Some(index) => self.delete_now(index),
				None => PanelEvent::Consumed,
			},
			PanelAction::FoldUp | PanelAction::UnfoldDown | PanelAction::Expand => PanelEvent::Ignored,
		}
	}

	fn key(&mut self, key: Key) -> PanelEvent {
		match self.mode {
			Mode::List => self.list_key(key),
			Mode::Rename { .. } => self.rename_key(key),
			Mode::Confirm { .. } => self.confirm_key(key),
		}
	}

	fn touch(&mut self, now: std::time::Duration) {
		self.now = now;
	}

	fn tick(&mut self, now: std::time::Duration) -> bool {
		self.now = now;
		if !self.history_due.is_some_and(|due| due <= now) {
			return false;
		}
		self.history_due = None;
		self.apply_history_ranking()
	}

	fn next_wake(&self) -> Option<std::time::Duration> {
		self.history_due
	}

	fn notify(&mut self, note: PanelNote<'_>) -> PanelEvent {
		let PanelNote::Outcome(Outcome::SessionIndex(outcome)) = note else {
			return PanelEvent::Ignored;
		};
		if self.requested != Some(outcome.scope) {
			return PanelEvent::Ignored;
		}
		self.requested = None;
		let rows = match &outcome.result {
			Ok(rows) => rows.clone(),
			Err(error) => {
				self.rebuild();
				return PanelEvent::Notice(error.clone());
			},
		};
		let selected = self.current().map(|index| self.rows[index].id.clone());
		self.scope = outcome.scope;
		self.rows = rows;
		self.reorder_for_query();
		self.cursor = selected
			.as_ref()
			.and_then(|id| {
				self
					.shown
					.iter()
					.position(|shown| self.rows[shown.row].id == *id)
			})
			.or_else(|| (!self.shown.is_empty()).then_some(0));
		self.mode = Mode::List;
		self.rebuild();
		PanelEvent::Consumed
	}

	fn mouse(&mut self, report: MouseReport) -> PanelEvent {
		if matches!(self.mode, Mode::Confirm { .. }) {
			return PanelEvent::Consumed;
		}
		let event = self
			.ui
			.handle_mouse_with_mods(report.col, report.row, report.kind, report.mods);
		match self.mode {
			Mode::List => self.list_event(event),
			Mode::Rename { .. } | Mode::Confirm { .. } => self.rename_event(event),
		}
	}

	fn paste(&mut self, text: &str) -> PanelEvent {
		match self.mode {
			Mode::Confirm { .. } => PanelEvent::Consumed,
			Mode::List => {
				let event = self.ui.handle_paste(text);
				self.list_event(event)
			},
			Mode::Rename { index, .. } => {
				if let UiEvent::Changed { value, .. } = self.ui.handle_paste(text) {
					self.mode = Mode::Rename { index, text: value };
				}
				PanelEvent::Consumed
			},
		}
	}

	fn frame(&mut self, viewport: Size) -> &Frame {
		let rows = Self::list_rows_for(viewport);
		if rows != self.list_rows {
			self.list_rows = rows;
			self
				.ui
				.set_prop("sessions", Prop::H, rows.saturating_add(1));
		}
		if self.width != viewport.width {
			self.width = viewport.width;
			self.rebuild();
		}
		self.ui.frame()
	}
}

#[cfg(test)]
mod tests {
	use std::path::PathBuf;

	use super::*;

	fn row(id: &str, title: Option<&str>, modified_ms: u64, created_ms: u64) -> SessionRow {
		SessionRow {
			id: Str::new(id),
			path: PathBuf::from(format!("/tmp/sessions/{id}.jsonl")),
			title: title.map(Str::new),
			created_ms,
			modified_ms,
			messages: 12,
			parent: None,
			agent: None,
			pinned: false,
		}
	}

	const VIEWPORT: Size = Size { width: 90, height: 30 };
	// 2025-01-15 10:30 UTC / 2024-12-31 23:59 UTC
	const MODIFIED: u64 = 1_736_937_000_000;
	const CREATED: u64 = 1_735_689_540_000;

	fn picker(rows: Vec<SessionRow>) -> SessionPicker {
		SessionPicker::from_rows(rows, TimeZone::UTC, VIEWPORT, &UiContext::default()).unwrap()
	}

	fn text(picker: &mut SessionPicker) -> String {
		omp_tui::frame_text(picker.frame(VIEWPORT))
	}

	struct HistoryMatches;

	impl Services for HistoryMatches {
		fn history_matching_session_ids(
			&self,
			query: &str,
			_limit: usize,
		) -> ServiceResult<Vec<Str>> {
			Ok((query == "needle")
				.then(|| vec![Str::new_static("target")])
				.unwrap_or_default())
		}
	}

	#[test]
	fn prompt_matches_participate_in_session_search_without_disclosure() {
		let mut picker = picker(vec![
			row("noise", Some("Ordinary"), MODIFIED, CREATED),
			row("target", Some("Private match"), MODIFIED - 1, CREATED),
		]);
		picker.history = Some(Arc::new(HistoryMatches));
		picker.touch(std::time::Duration::ZERO);
		assert_eq!(picker.paste("needle"), PanelEvent::Consumed);
		assert_eq!(picker.next_wake(), Some(HISTORY_MERGE_DELAY));
		assert!(picker.tick(HISTORY_MERGE_DELAY));
		let shown = text(&mut picker);
		assert!(shown.contains("Private match"), "{shown}");
		assert!(!shown.contains("Ordinary"), "{shown}");
		assert!(!shown.contains("secret prompt body"), "{shown}");
		assert_eq!(
			picker.key(Key::Enter),
			PanelEvent::Finish(Str::new("resume \"/tmp/sessions/target.jsonl\""))
		);
	}

	#[test]
	fn empty_index_reports_no_sessions() {
		let error =
			SessionPicker::from_rows(Vec::new(), TimeZone::UTC, VIEWPORT, &UiContext::default())
				.err()
				.unwrap();
		assert_eq!(error.as_str(), "No sessions found");
	}

	#[test]
	fn row_shows_stamp_messages_and_title() {
		let mut picker = picker(vec![row("01HABC", Some("Fix the parser"), MODIFIED, CREATED)]);
		let shown = text(&mut picker);
		assert!(shown.contains("Resume Session"), "title missing:\n{shown}");
		assert!(shown.contains("2025-01-15 10:30"), "modified stamp missing:\n{shown}");
		assert!(shown.contains("12 msgs"), "message count missing:\n{shown}");
		assert!(shown.contains("Fix the parser"), "title missing:\n{shown}");
		assert!(!shown.contains("/tmp/sessions"), "path shown before Ctrl+P:\n{shown}");
		assert!(shown.contains("Ctrl+R rename"), "hint missing:\n{shown}");
	}

	#[test]
	fn untitled_row_falls_back_to_id_and_ctrl_p_shows_path() {
		let mut picker = picker(vec![row("01HABC", None, MODIFIED, CREATED)]);
		let shown = text(&mut picker);
		assert!(shown.contains("01HABC"), "id missing:\n{shown}");
		assert_eq!(picker.action(PanelAction::TogglePath), PanelEvent::Consumed);
		let shown = text(&mut picker);
		assert!(shown.contains("/tmp/sessions/01HABC.jsonl"), "path missing:\n{shown}");
	}

	#[test]
	fn enter_emits_resume_with_the_highlighted_path() {
		let mut picker = picker(vec![
			row("newer", Some("Newer"), MODIFIED, CREATED),
			row("older", Some("Older"), MODIFIED - 60_000, CREATED),
		]);
		assert_eq!(picker.key(Key::Down), PanelEvent::Consumed);
		assert_eq!(
			picker.key(Key::Enter),
			PanelEvent::Finish(Str::new("resume \"/tmp/sessions/older.jsonl\""))
		);
	}

	#[test]
	fn ctrl_s_flips_the_shown_stamp_and_order() {
		let mut picker = picker(vec![
			row("a", Some("A"), MODIFIED, CREATED - 120_000),
			row("b", Some("B"), MODIFIED - 60_000, CREATED),
		]);
		let shown = text(&mut picker);
		assert!(shown.contains("2025-01-15 10:30"), "{shown}");
		assert!(!shown.contains("2024-12-31 23:59"), "{shown}");
		assert_eq!(picker.action(PanelAction::ToggleSort), PanelEvent::Consumed);
		let shown = text(&mut picker);
		assert!(shown.contains("2024-12-31 23:59"), "created stamp missing:\n{shown}");
		assert!(!shown.contains("2025-01-15 10:30"), "modified stamp still shown:\n{shown}");
		assert!(
			shown.contains("Resume Session (by created · project)"),
			"title suffix missing:\n{shown}"
		);
		// B was created last, so it now leads and Enter resumes it.
		assert_eq!(
			picker.key(Key::Enter),
			PanelEvent::Finish(Str::new("resume \"/tmp/sessions/b.jsonl\""))
		);
	}

	#[test]
	fn ctrl_d_then_y_deletes_the_highlighted_row() {
		let mut picker = picker(vec![
			row("keep", Some("Keep me"), MODIFIED, CREATED),
			row("gone", Some("Drop me"), MODIFIED - 60_000, CREATED),
		]);
		picker.key(Key::Down);
		assert_eq!(picker.action(PanelAction::Delete), PanelEvent::Consumed);
		let shown = text(&mut picker);
		assert!(shown.contains("Delete Drop me? y/n"), "confirmation missing:\n{shown}");
		assert_eq!(picker.key(Key::Char('y')), PanelEvent::Run(Str::new("session_delete gone")));
		assert_eq!(picker.rows().len(), 1);
		let shown = text(&mut picker);
		assert!(!shown.contains("Drop me"), "deleted row still listed:\n{shown}");
		assert!(shown.contains("Keep me"), "{shown}");
		// The cursor clamps onto the remaining row.
		assert_eq!(
			picker.key(Key::Enter),
			PanelEvent::Finish(Str::new("resume \"/tmp/sessions/keep.jsonl\""))
		);
	}

	/// A click on a session row resumes
	/// it, and the wheel moves the highlight without committing.
	#[test]
	fn click_on_a_row_resumes_it_and_wheel_moves_the_highlight() {
		use omp_tui::{Mods, Mouse, MouseButton};

		let mut picker = picker(vec![
			row("newer", Some("Newer"), MODIFIED, CREATED),
			row("older", Some("Older"), MODIFIED - 60_000, CREATED),
		]);
		let shown = text(&mut picker);
		let (col, row) = shown
			.lines()
			.enumerate()
			.find_map(|(row, line)| {
				let byte = line.find("Older")?;
				Some((omp_tui::cell_width(&line[..byte]), u16::try_from(row).unwrap()))
			})
			.expect("the Older row is painted");
		let report = |kind, button| MouseReport {
			kind,
			col,
			row,
			button,
			mods: Mods::default(),
			pressed: true,
		};
		assert_eq!(
			picker.mouse(report(Mouse::WheelDown, MouseButton::WheelDown)),
			PanelEvent::Consumed
		);
		assert_eq!(picker.current(), Some(1), "the wheel highlights without resuming");
		assert_eq!(picker.mouse(report(Mouse::WheelUp, MouseButton::WheelUp)), PanelEvent::Consumed);
		assert_eq!(picker.current(), Some(0));
		assert_eq!(
			picker.mouse(report(Mouse::Click, MouseButton::Left)),
			PanelEvent::Finish(Str::new("resume \"/tmp/sessions/older.jsonl\""))
		);
	}

	#[test]
	fn ctrl_d_then_n_keeps_the_row() {
		let mut picker = picker(vec![row("keep", Some("Keep me"), MODIFIED, CREATED)]);
		picker.action(PanelAction::Delete);
		assert_eq!(picker.key(Key::Char('n')), PanelEvent::Consumed);
		assert_eq!(picker.rows().len(), 1);
		assert!(text(&mut picker).contains("Keep me"));
	}

	#[test]
	fn delete_fast_skips_confirmation() {
		let mut picker = picker(vec![row("gone", Some("Drop me"), MODIFIED, CREATED)]);
		assert_eq!(
			picker.action(PanelAction::DeleteFast),
			PanelEvent::Run(Str::new("session_delete gone"))
		);
		assert!(picker.rows().is_empty());
	}

	#[test]
	fn ctrl_r_typing_and_enter_emits_rename_and_updates_the_row() {
		let mut picker = picker(vec![row("01HABC", None, MODIFIED, CREATED)]);
		assert_eq!(picker.action(PanelAction::Rename), PanelEvent::Consumed);
		assert!(text(&mut picker).contains("Rename session: 01HABC"));
		for ch in "Say \"hi\"".chars() {
			assert_eq!(picker.key(Key::Char(ch)), PanelEvent::Consumed);
		}
		assert_eq!(
			picker.key(Key::Enter),
			PanelEvent::Run(Str::new("session_rename 01HABC \"Say \\\"hi\\\"\""))
		);
		assert_eq!(picker.rows()[0].title.as_deref(), Some("Say \"hi\""));
		assert!(text(&mut picker).contains("Say \"hi\""));
	}

	#[test]
	fn rename_esc_returns_to_the_list_unchanged() {
		let mut picker = picker(vec![row("01HABC", Some("Old"), MODIFIED, CREATED)]);
		picker.action(PanelAction::Rename);
		picker.key(Key::Char('x'));
		assert_eq!(picker.key(Key::Esc), PanelEvent::Consumed);
		assert_eq!(picker.rows()[0].title.as_deref(), Some("Old"));
		assert_eq!(picker.key(Key::Esc), PanelEvent::Close);
	}

	#[test]
	fn esc_closes_the_list() {
		let mut picker = picker(vec![row("01HABC", Some("Old"), MODIFIED, CREATED)]);
		assert_eq!(picker.key(Key::Esc), PanelEvent::Close);
	}

	#[test]
	fn tab_requests_global_index_and_applies_the_typed_outcome() {
		let mut picker = picker(vec![row("project", Some("Project"), MODIFIED, CREATED)]);
		assert!(matches!(
			picker.key(Key::Tab),
			PanelEvent::Command(HostCommand::SessionIndex { scope: SessionScope::All })
		));
		assert_eq!(
			picker.rows()[0].id.as_str(),
			"project",
			"old projection stays visible while loading"
		);
		assert!(text(&mut picker).contains("all projects"));

		let outcome = Outcome::SessionIndex(SessionIndexOutcome {
			scope:  SessionScope::All,
			result: Ok(vec![row("global", Some("Global"), MODIFIED + 1, CREATED)]),
		});
		assert_eq!(picker.notify(PanelNote::Outcome(&outcome)), PanelEvent::Consumed);
		assert_eq!(picker.rows()[0].id.as_str(), "global");
		let shown = text(&mut picker);
		assert!(shown.contains("Global"), "{shown}");
		assert!(shown.contains("all projects"), "{shown}");

		assert!(matches!(
			picker.key(Key::Tab),
			PanelEvent::Command(HostCommand::SessionIndex { scope: SessionScope::Project })
		));
	}

	#[test]
	fn children_indent_under_their_parent_and_orphans_carry_the_agent() {
		let mut child = row("child", Some("Child"), MODIFIED + 1_000, CREATED);
		child.parent = Some(Str::new("parent"));
		child.agent = Some(Str::new("worker"));
		let mut orphan = row("orphan", Some("Orphan"), MODIFIED - 5_000, CREATED);
		orphan.parent = Some(Str::new("missing"));
		orphan.agent = Some(Str::new("scout"));
		let mut pinned = row("pinned", Some("Pinned"), MODIFIED - 9_000, CREATED);
		pinned.pinned = true;
		let mut picker =
			picker(vec![row("parent", Some("Parent"), MODIFIED, CREATED), child, orphan, pinned]);
		let shown = text(&mut picker);
		let at = |needle: &str| {
			shown
				.find(needle)
				.unwrap_or_else(|| panic!("{needle} missing:\n{shown}"))
		};
		assert!(at("Pinned") < at("Parent"), "pinned row must lead:\n{shown}");
		assert!(at("Parent") < at("└ Child"), "child must follow its parent:\n{shown}");
		assert!(at("└ Child") < at("Orphan"), "{shown}");
		assert!(shown.contains("worker"), "child agent missing:\n{shown}");
		assert!(shown.contains("scout"), "orphan agent missing:\n{shown}");
	}

	#[test]
	fn typing_filters_and_enter_resumes_the_match() {
		let mut picker = picker(vec![
			row("alpha", Some("Alpha work"), MODIFIED, CREATED),
			row("beta", Some("Beta work"), MODIFIED - 60_000, CREATED),
		]);
		for ch in "beta".chars() {
			picker.key(Key::Char(ch));
		}
		let shown = text(&mut picker);
		assert!(!shown.contains("Alpha work"), "filter left the non-match:\n{shown}");
		assert_eq!(
			picker.key(Key::Enter),
			PanelEvent::Finish(Str::new("resume \"/tmp/sessions/beta.jsonl\""))
		);
	}
}
