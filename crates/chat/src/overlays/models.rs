//! Full-screen two-pane model picker (`cl_model_select`).
//!
//! A port of omp v1's `/models` hub (`packages/coding-agent/src/modes/
//! components/model-hub.ts`) and its `ModelBrowser` (`model-browser.ts`):
//! a provider rail — "All models" plus one row per provider with its model
//! count — beside the filterable model list. The provider comes from each
//! row's catalog route metadata ([`ModelRow::provider_id`]), never from the
//! model key's spelling, so scoped and unscoped keys group identically.
//!
//! Both panes are ordinary retained `<select>` lists in one [`Ui`]: the tree
//! owns hover bands, wheel routing, and the single visible cursor, while the
//! picker owns the scope, pane focus, query, and selection identity. A
//! scope, role, or viewport change rebuilds the tree once; query edits only
//! retext the rail's counts.

use std::{
	collections::BTreeMap,
	fmt::{self, Write as _},
};

use omp_core::{FastHashMap, Str, StrMut, sf};
use omp_tui::{
	Component, Frame, IntoComponent as _, Key, Mouse, MouseReport, Prop, Size, Ui, UiContext,
	UiEvent,
	assets::provider_logo,
	components::Select,
	dom,
	fuzzy::{Query, SearchIndex},
	tsp::{
		picker::{
			ColumnFormat, Fact, Gesture, KindProps as _, PickerAct, PickerAction, PickerChip,
			PickerColumn, PickerItem, PickerLayout, PickerPreview, PickerProps, PickerSize, TextProps,
		},
		wire::{Kind, Node},
	},
};
use serde_json::Map;
use smallvec::SmallVec;
use strum::{EnumProperty as _, IntoEnumIterator as _};

use super::{ModelRow, PickerEvent, QuickRoleRow};

/// Element id of the provider rail.
const PROVIDERS_ID: &str = "providers";
/// Element id of the model (or quick-role) list.
const MODELS_ID: &str = "models";
/// Element id of the one-line scope summary above the panes.
const STATUS_ID: &str = "model-status";
/// Element id of the highlighted model's facts line.
const FACTS_ID: &str = "model-facts";
/// Element id of the contextual key hint.
const HINT_ID: &str = "model-hint";
/// Rail value of the "All models" entry; providers use their group index.
const ALL_VALUE: &str = "all";
/// Id of the native model picker, which Tern names in its events.
pub const MODEL_PICKER_ID: &str = "model-picker";
/// Ids of the native picker's preview and its facts line.
const MODEL_PREVIEW_ID: &str = "model-picker-preview";
const MODEL_PREVIEW_FACTS_ID: &str = "model-picker-facts";
/// Fact column ids of the native picker.
const CONTEXT_COLUMN: &str = "context";
const PRICE_COLUMN: &str = "price";

/// Rows around the two panes: frame border ×2, status, rule, facts, role
/// chips, and hint.
const CHROME_ROWS: u16 = 7;
/// Shortest pane height on tiny terminals.
const MIN_LIST_ROWS: u16 = 5;
/// Provider rail width bounds (v1 `SIDEBAR_MIN_WIDTH`/`SIDEBAR_MAX_WIDTH`,
/// widened by the cursor gutter and logo cell).
const RAIL_MIN_WIDTH: u16 = 22;
const RAIL_MAX_WIDTH: u16 = 32;
/// Model-pane widths from which the context and price columns appear.
const CONTEXT_PANE_WIDTH: u16 = 44;
const COST_PANE_WIDTH: u16 = 56;

const HINT_MODELS: &str = "Enter use · Tab providers · type to search · provider/ scopes · @ \
                           roles · Alt+P task · Esc close";
const HINT_PROVIDERS: &str =
	"Up/Down providers · Enter/Right models · type to search · Alt+P task · Esc close";
const HINT_TASK: &str = "Enter use for task subagents · Tab providers · type to search · Alt+P \
                         session model · Esc close";
const HINT_ROLES: &str = "Up/Down roles · Enter apply role model · type to search · Esc close";
const ROLE_CHIP_HINT: &str = "assign highlighted · again clears";
const STATUS_ROLES: &str = "Quick role switch — applies its model and thinking for this session";
const STATUS_EMPTY: &str = "No models available in this scope";
const STATUS_NO_MATCH: &str = "No matching models";

/// A model role the picker assigns to the highlighted model with
/// `Alt+<digit>` or a click on its footer chip; the host persists it in
/// `ai_model_roles`.
#[derive(
	Clone,
	Copy,
	Debug,
	Eq,
	Hash,
	PartialEq,
	strum::EnumIter,
	strum::EnumProperty,
	strum::EnumString,
	strum::IntoStaticStr,
)]
#[strum(serialize_all = "lowercase")]
pub enum PickerRole {
	/// Default model for new sessions.
	#[strum(props(chord = "Alt+1", tone = "ok", chip = "role-default"))]
	Default,
	/// Fast, cheap model (`@smol`).
	#[strum(props(chord = "Alt+2", tone = "warn", chip = "role-smol"))]
	Smol,
	/// Deep-reasoning model (`@slow`).
	#[strum(props(chord = "Alt+3", tone = "accent", chip = "role-slow"))]
	Slow,
	/// Titles, memory, and classifiers (`@tiny`).
	#[strum(props(chord = "Alt+4", tone = "info", chip = "role-tiny"))]
	Tiny,
}

impl PickerRole {
	/// Persisted role name (`ai_model_roles` key).
	#[must_use]
	pub fn name(self) -> &'static str {
		self.into()
	}

	/// The role an `Alt+<digit>` chord assigns, in declaration order.
	#[must_use]
	pub fn from_key(key: Key) -> Option<Self> {
		let Key::Alt(digit @ '1'..='9') = key else {
			return None;
		};
		Self::iter().nth(usize::from(digit as u8 - b'1'))
	}

	fn chord(self) -> &'static str {
		self.get_str("chord").unwrap_or_default()
	}

	fn tone(self) -> &'static str {
		self.get_str("tone").unwrap_or("muted")
	}

	fn chip_id(self) -> &'static str {
		self.get_str("chip").unwrap_or_default()
	}
}

/// One role's resolved model as the picker marks it in the list.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RoleMark {
	/// Role.
	pub role: PickerRole,
	/// Catalog key of the model holding it.
	pub key:  Str,
	/// The role is unconfigured and `key` is the launch fallback (painted
	/// hollow and dim, as v1 painted auto-selected roles).
	pub auto: bool,
}

/// Which pane owns the arrow keys.
#[derive(Clone, Copy, Debug, Eq, PartialEq, strum::IntoStaticStr)]
enum Pane {
	#[strum(serialize = "providers")]
	Providers,
	#[strum(serialize = "models")]
	Models,
}

/// How a rebuild re-seats the model cursor.
#[derive(Clone, Copy, Eq, PartialEq)]
enum Restore {
	/// Back onto the tracked highlighted model when it is still listed.
	Highlight,
	/// Wherever the list lands (best query match, preselected row).
	Best,
}

/// One provider row of the rail, derived from route metadata.
struct Group {
	/// Stable provider id (`ModelRow::provider_id`, else its name).
	id:       Str,
	/// Display name.
	name:     Str,
	/// Rail option value (the group index).
	value:    Str,
	/// Element ids of its name and count cells.
	name_id:  Str,
	count_id: Str,
	/// Packaged logo source, when one exists.
	logo:     Option<Str>,
	/// Models in this provider.
	total:    u32,
}

/// Per-row presentation cached once per model list.
struct Item {
	/// Option value: the row index.
	value:    Str,
	/// Filter haystack (provider, name, key, provider id, `free`).
	label:    Str,
	/// Prepared haystack for the rail's per-provider match counts.
	search:   SearchIndex,
	name:     Str,
	provider: Str,
	context:  Str,
	cost:     Str,
	group:    u16,
}

/// Retained full-screen model picker.
pub struct ModelPicker {
	ui:            Ui,
	rows:          Vec<ModelRow>,
	items:         Vec<Item>,
	groups:        Vec<Group>,
	/// Matches per rail entry (`0` = All models) under the live query.
	counts:        Vec<u32>,
	/// Active provider scope; `None` is "All models".
	scope:         Option<u16>,
	/// The scope was chosen by a `provider/` query prefix.
	prefix_scoped: bool,
	focus:         Pane,
	/// Row index under the model cursor (selection identity).
	highlighted:   Option<usize>,
	current:       usize,
	task_current:  usize,
	quick_roles:   Vec<QuickRoleRow>,
	current_role:  Option<usize>,
	roles:         Vec<RoleMark>,
	role_mode:     bool,
	task_mode:     bool,
	session_only:  bool,
	ctx:           UiContext,
	query:         Str,
	list_rows:     u16,
	width:         u16,
	/// A rebuild deferred until the next entry point (the open-time build
	/// waits for [`ModelPicker::with_roles`] instead of building twice).
	pending:       Option<Restore>,
	/// Bumped whenever the rows or the role marks change: what the native
	/// picker's catalogue is built from.
	generation:    u64,
	/// The native picker, rebuilt only when what it shows changes.
	tsp:           TspCache,
}

/// What the native picker shows: when none of it changed, the cached node is
/// presented as it is.
#[derive(Clone, Debug, PartialEq)]
struct TspKey {
	generation:   u64,
	/// Value of the list option under the cursor.
	cursor:       Option<Str>,
	query:        Str,
	scope:        Option<u16>,
	role_mode:    bool,
	task_mode:    bool,
	current:      usize,
	task_current: usize,
	current_role: Option<usize>,
}

/// The native picker node and the state it was built for.
struct TspCache {
	key:  Option<TspKey>,
	node: Node,
}

impl ModelPicker {
	/// Opens the picker over `rows` with `current` preselected, filling
	/// `viewport`.
	///
	/// `session_only` reports whether the eventual pick should stay out of
	/// `config.cfg` (Alt+P) or be archived (Alt+M).
	#[must_use]
	pub fn open(
		rows: Vec<ModelRow>,
		current: usize,
		task_current: usize,
		quick_roles: Vec<QuickRoleRow>,
		current_role: Option<usize>,
		session_only: bool,
		viewport: Size,
		ctx: &UiContext,
	) -> Self {
		let last = rows.len().saturating_sub(1);
		let current_role = current_role.filter(|&index| index < quick_roles.len());
		let mut picker = Self {
			ui: Ui::from_root(dom! { <col/> }, viewport.width, ctx.clone()),
			items: Vec::new(),
			groups: Vec::new(),
			counts: Vec::new(),
			scope: None,
			prefix_scoped: false,
			focus: Pane::Models,
			highlighted: (!rows.is_empty()).then_some(current.min(last)),
			current: current.min(last),
			task_current: task_current.min(last),
			rows,
			quick_roles,
			current_role,
			roles: Vec::new(),
			role_mode: false,
			task_mode: false,
			session_only,
			ctx: ctx.clone(),
			query: Str::default(),
			list_rows: list_rows(viewport.height),
			width: viewport.width,
			pending: Some(Restore::Highlight),
			generation: 0,
			tsp: TspCache {
				key:  None,
				node: PickerProps::default().node(Str::new_static(MODEL_PICKER_ID), Vec::new()),
			},
		};
		picker.reindex();
		picker
	}

	/// Marks the models that currently hold a role.
	#[must_use]
	pub fn with_roles(mut self, roles: Vec<RoleMark>) -> Self {
		self.set_roles(roles);
		self
	}

	/// Replaces the role marks (after an assignment) and repaints the list.
	pub fn set_roles(&mut self, roles: Vec<RoleMark>) {
		if self.roles == roles {
			return;
		}
		self.roles = roles;
		self.generation += 1;
		if self.pending.is_none() {
			self.rebuild(Restore::Highlight);
		}
	}

	/// Runs a deferred rebuild before input or presentation reads the tree.
	fn ensure(&mut self) {
		if let Some(restore) = self.pending.take() {
			self.rebuild(restore);
		}
	}

	/// Current role marks.
	#[must_use]
	pub fn role_marks(&self) -> &[RoleMark] {
		&self.roles
	}

	/// Whether the model at `index` holds `role` by explicit configuration.
	#[must_use]
	pub fn holds_role(&self, role: PickerRole, index: usize) -> bool {
		self.rows.get(index).is_some_and(|row| {
			self
				.roles
				.iter()
				.any(|mark| mark.role == role && !mark.auto && mark.key == row.key)
		})
	}

	/// Replaces the model list while the picker is open (a discovery
	/// refresh): provider groups and counts are re-derived, and the
	/// highlighted model, current model, provider scope, and quick roles are
	/// kept by identity when they still exist.
	pub fn replace_rows(&mut self, rows: Vec<ModelRow>) {
		let key_at = |index: usize| self.rows.get(index).map(|row| row.key.clone());
		let highlighted = self.highlighted.and_then(key_at);
		let current = key_at(self.current);
		let task_current = key_at(self.task_current);
		let current_role = self
			.current_role
			.and_then(|index| self.quick_roles.get(index))
			.map(|role| role.role.clone());
		#[allow(
			clippy::needless_collect,
			reason = "the keys must be read before `self.rows` is replaced"
		)]
		let quick_roles = self
			.quick_roles
			.iter()
			.filter_map(|role| Some((role.clone(), key_at(role.model)?)))
			.collect::<Vec<_>>();
		let scope = self
			.scope
			.and_then(|group| self.groups.get(usize::from(group)))
			.map(|group| group.id.clone());

		self.rows = rows;
		self.reindex();
		let find =
			|key: Option<&Str>| key.and_then(|key| self.rows.iter().position(|row| row.key == *key));
		self.highlighted = find(highlighted.as_ref());
		self.current = find(current.as_ref()).unwrap_or(0);
		self.task_current = find(task_current.as_ref()).unwrap_or(self.current);
		self.quick_roles = quick_roles
			.into_iter()
			.filter_map(|(role, key)| Some(QuickRoleRow { model: find(Some(&key))?, ..role }))
			.collect();
		self.current_role =
			current_role.and_then(|name| self.quick_roles.iter().position(|role| role.role == name));
		self.scope = scope.and_then(|id| {
			self
				.groups
				.iter()
				.position(|group| group.id == id)
				.map(|index| index as u16)
		});
		if self.scope.is_none() {
			self.prefix_scoped = false;
		}
		// Deferred: the host follows with fresh role marks, and both land in
		// one rebuild at the next frame or input.
		self.pending = Some(Restore::Highlight);
	}

	/// Restyles the retained picker without changing its query or selection.
	pub(crate) fn set_context(&mut self, ctx: &UiContext) {
		self.ctx = ctx.clone();
		self.ui.set_context(ctx.clone());
	}

	/// Whether the pick stays session-local.
	#[must_use]
	pub const fn session_only(&self) -> bool {
		self.session_only
	}

	/// Host-supplied rows in picker order.
	#[must_use]
	pub fn rows(&self) -> &[ModelRow] {
		&self.rows
	}

	/// Configured quick roles in cycle order.
	#[must_use]
	pub fn quick_roles(&self) -> &[QuickRoleRow] {
		&self.quick_roles
	}

	/// Provider id of the active scope; `None` is "All models".
	#[must_use]
	pub fn scope(&self) -> Option<&str> {
		self
			.scope
			.and_then(|group| self.groups.get(usize::from(group)))
			.map(|group| group.id.as_str())
	}

	/// Routes a key: pane switches, role chords, and rail hops are the
	/// picker's; everything else reaches the focused list.
	pub fn key(&mut self, key: Key) -> PickerEvent {
		self.ensure();
		// Keyboard input always clears the pointer's hover band, including
		// keys the picker intercepts before the tree.
		self.ui.clear_hover();
		if key == Key::Alt('p') {
			self.task_mode = !self.task_mode;
			self.role_mode = self.query.starts_with('@') && !self.task_mode;
			self.highlighted = (!self.rows.is_empty()).then_some(if self.task_mode {
				self.task_current
			} else {
				self.current
			});
			self.rebuild(Restore::Highlight);
			return PickerEvent::Consumed;
		}
		if self.role_mode {
			let event = self.ui.handle_key(key);
			return self.route(event);
		}
		if let Some(role) = PickerRole::from_key(key) {
			return self.assign(role);
		}
		match key {
			Key::Tab | Key::BackTab => {
				let other = match self.focus {
					Pane::Providers => Pane::Models,
					Pane::Models => Pane::Providers,
				};
				self.set_focus(other);
				return PickerEvent::Consumed;
			},
			Key::Left => {
				self.set_focus(Pane::Providers);
				return PickerEvent::Consumed;
			},
			Key::Right => {
				self.set_focus(Pane::Models);
				return PickerEvent::Consumed;
			},
			_ => {},
		}
		if self.focus == Pane::Providers {
			let page = i64::from(self.list_rows.max(1));
			match key {
				Key::Up => return self.hop(-1, true),
				Key::Down => return self.hop(1, true),
				Key::PageUp => return self.hop(-page, false),
				Key::PageDown => return self.hop(page, false),
				Key::Home => return self.hop(-i64::from(u16::MAX), false),
				Key::End => return self.hop(i64::from(u16::MAX), false),
				Key::Enter => {
					self.set_focus(Pane::Models);
					return PickerEvent::Consumed;
				},
				Key::Esc if self.query.is_empty() => return PickerEvent::Close,
				// Typing anywhere searches the model list (v1: "Typing anywhere
				// focuses the model list").
				Key::Char(_)
				| Key::Space
				| Key::Backspace
				| Key::WordDelete
				| Key::Ctrl('u' | 'w')
				| Key::Esc => self.set_focus(Pane::Models),
				_ => return PickerEvent::Consumed,
			}
		}
		let event = self.ui.handle_key(key);
		self.route(event)
	}

	/// Routes pasted text into the model filter.
	pub fn paste(&mut self, text: &str) -> PickerEvent {
		self.ensure();
		if self.focus == Pane::Providers {
			self.set_focus(Pane::Models);
		}
		let event = self.ui.handle_paste(text);
		self.route(event)
	}

	/// Routes pointer input anywhere on the overlay: hover bands and wheel
	/// scrolling follow the pane under the pointer, a click on the rail
	/// scopes to that provider, a first click on a model highlights it and a
	/// second click on the same model picks it (v1's settings idiom), and a
	/// click on a role chip assigns the highlighted model.
	pub fn mouse(&mut self, report: MouseReport) -> PickerEvent {
		self.ensure();
		if report.kind == Mouse::Click
			&& !self.role_mode
			&& let Some(role) = PickerRole::iter().find(|role| {
				self.ui.rect(role.chip_id()).is_some_and(|rect| {
					report.col >= rect.x
						&& report.col < rect.x.saturating_add(rect.width)
						&& report.row >= rect.y
						&& report.row < rect.y.saturating_add(rect.height)
				})
			}) {
			return self.assign(role);
		}
		let before = self.highlighted;
		let event = self
			.ui
			.handle_mouse_with_mods(report.col, report.row, report.kind, report.mods);
		if report.kind == Mouse::Click {
			// A click moves keyboard focus to the pane it landed in. A click on
			// a model row already placed the list cursor; any other landing
			// re-seats it on the tracked model.
			let focus = match self.ui.focused_id().as_deref() {
				Some(PROVIDERS_ID) => Pane::Providers,
				_ => Pane::Models,
			};
			if focus != self.focus {
				self.focus = focus;
				let on_row = matches!(&event, UiEvent::Changed { id, .. } if id.as_str() == MODELS_ID);
				if focus == Pane::Models && !on_row {
					self.restore_highlight();
				}
				self.ui.set_text(HINT_ID, self.hint());
			}
		}
		match event {
			UiEvent::Changed { id, value }
				if id.as_str() == MODELS_ID && report.kind == Mouse::Click && !self.role_mode =>
			{
				let index = value.as_str().parse().ok();
				if index.is_some() && index == before {
					return self.pick(index);
				}
				self.note_highlight(index);
				PickerEvent::Consumed
			},
			event => self.route(event),
		}
	}

	/// Reflows for a viewport, returning the frame to composite. The picker
	/// fills the viewport; a resize in either axis re-lays both panes.
	pub fn frame(&mut self, viewport: Size) -> &Frame {
		let rows = list_rows(viewport.height);
		if rows != self.list_rows || viewport.width != self.width {
			self.list_rows = rows;
			self.width = viewport.width;
			self.pending = Some(self.pending.unwrap_or(Restore::Highlight));
		}
		self.ensure();
		self.ui.frame()
	}

	fn route(&mut self, event: UiEvent) -> PickerEvent {
		match event {
			UiEvent::Cancel => PickerEvent::Close,
			UiEvent::Changed { id, value } if id.as_str() == MODELS_ID => {
				self.pick(value.as_str().parse().ok())
			},
			UiEvent::Changed { id, value } | UiEvent::Highlighted { id, value }
				if id.as_str() == PROVIDERS_ID =>
			{
				let entry = if value.as_str() == ALL_VALUE {
					Some(0)
				} else {
					value.as_str().parse::<usize>().ok().map(|group| group + 1)
				};
				if let Some(entry) = entry {
					self.prefix_scoped = false;
					self.set_scope(entry);
				}
				PickerEvent::Consumed
			},
			UiEvent::Highlighted { id, value } if id.as_str() == MODELS_ID => {
				self.note_highlight(value.as_str().parse().ok());
				PickerEvent::Consumed
			},
			UiEvent::Filtered { id, query, value } if id.as_str() == MODELS_ID => {
				self.filtered(query, value);
				PickerEvent::Consumed
			},
			_ => PickerEvent::Consumed,
		}
	}

	fn pick(&self, index: Option<usize>) -> PickerEvent {
		index.map_or(PickerEvent::Consumed, |index| {
			if self.role_mode {
				PickerEvent::PickRole(index)
			} else if self.task_mode {
				PickerEvent::PickTask(index)
			} else {
				PickerEvent::Pick(index)
			}
		})
	}

	fn assign(&self, role: PickerRole) -> PickerEvent {
		self
			.highlighted
			.filter(|_| !self.role_mode)
			.map_or(PickerEvent::Consumed, |index| PickerEvent::AssignRole { role, index })
	}

	/// Applies one query edit: a leading `@` switches to quick roles, a
	/// `provider/` prefix scopes to that provider (and selects it in the
	/// rail), and a provider scope that loses its last match falls back to
	/// All models so results never silently vanish (v1 `#onQueryChanged`).
	fn filtered(&mut self, query: Str, value: Option<Str>) {
		let role_mode = query.starts_with('@') && !self.task_mode;
		self.query = query;
		if role_mode != self.role_mode {
			self.role_mode = role_mode;
			self.focus = Pane::Models;
			self.rebuild(Restore::Best);
			return;
		}
		if self.role_mode {
			self.show_detail(value.and_then(|value| value.as_str().parse().ok()));
			return;
		}
		match self.prefix_group() {
			Some(group) if self.scope != Some(group) => {
				self.scope = Some(group);
				self.prefix_scoped = true;
				self.rebuild(Restore::Best);
				return;
			},
			Some(_) => {},
			None if self.prefix_scoped => {
				self.prefix_scoped = false;
				self.scope = None;
				self.rebuild(Restore::Best);
				return;
			},
			None => {},
		}
		self.recount();
		if let Some(group) = self.scope
			&& !self.query.trim().is_empty()
			&& self.counts[usize::from(group) + 1] == 0
		{
			self.scope = None;
			self.rebuild(Restore::Best);
			return;
		}
		self.retext_counts();
		self.note_highlight(value.and_then(|value| value.as_str().parse().ok()));
	}

	/// Rail group named by a `provider/` query prefix (id or display name,
	/// case-insensitively).
	fn prefix_group(&self) -> Option<u16> {
		let (head, _) = self.query.split_once('/')?;
		let head = head.trim();
		if head.is_empty() {
			return None;
		}
		self
			.groups
			.iter()
			.position(|group| {
				group.id.eq_ignore_ascii_case(head) || group.name.eq_ignore_ascii_case(head)
			})
			.map(|index| index as u16)
	}

	/// Moves the rail by `delta` entries (wrapping single steps, clamping
	/// page and edge jumps) and scopes the list to the landing entry.
	fn hop(&mut self, delta: i64, wrap: bool) -> PickerEvent {
		let count = self.groups.len() as i64 + 1;
		let at = self.scope.map_or(0, |group| i64::from(group) + 1);
		let next = if wrap {
			(at + delta).rem_euclid(count)
		} else {
			(at + delta).clamp(0, count - 1)
		};
		if next != at {
			self.prefix_scoped = false;
			self.set_scope(next as usize);
		}
		PickerEvent::Consumed
	}

	/// Scopes the list to rail entry `entry` (`0` = All models).
	fn set_scope(&mut self, entry: usize) {
		let scope = entry
			.checked_sub(1)
			.filter(|group| *group < self.groups.len())
			.map(|group| group as u16);
		if scope != self.scope {
			self.scope = scope;
			self.rebuild(Restore::Highlight);
		}
	}

	fn set_focus(&mut self, pane: Pane) {
		if pane == Pane::Providers && self.role_mode {
			return;
		}
		self.focus = pane;
		self.ui.focus_id(pane.into());
		if pane == Pane::Models {
			self.restore_highlight();
		}
		self.ui.set_text(HINT_ID, self.hint());
	}

	/// Re-seats the model cursor on the tracked highlighted model.
	fn restore_highlight(&mut self) {
		if self.role_mode {
			return;
		}
		let Some(value) = self
			.highlighted
			.and_then(|index| self.items.get(index))
			.map(|item| item.value.clone())
		else {
			return;
		};
		self
			.ui
			.with_component_mut::<Select, _>(MODELS_ID, |select| select.highlight_value(&value));
	}

	fn note_highlight(&mut self, index: Option<usize>) {
		if !self.role_mode {
			self.highlighted = index.filter(|index| *index < self.rows.len());
		}
		self.show_detail(index);
	}

	/// Re-derives provider groups and per-row presentation from `rows`.
	fn reindex(&mut self) {
		let mut by_id: FastHashMap<Str, u16> = FastHashMap::default();
		let mut groups: Vec<(Str, Str)> = Vec::new();
		let mut membership = Vec::with_capacity(self.rows.len());
		for row in &self.rows {
			let id = if row.provider_id.is_empty() {
				row.provider.clone()
			} else {
				row.provider_id.clone()
			};
			let group = *by_id.entry(id.clone()).or_insert_with(|| {
				let name = if row.provider.is_empty() {
					id.clone()
				} else {
					row.provider.clone()
				};
				groups.push((id, name));
				(groups.len() - 1) as u16
			});
			membership.push(group);
		}
		// Rail order: providers alphabetically by display name (v1 sorted
		// the sidebar by provider id with `localeCompare`).
		let mut order: Vec<u16> = (0..groups.len() as u16).collect();
		order.sort_by_cached_key(|&group| groups[usize::from(group)].1.to_lowercase());
		let mut rank = vec![0u16; groups.len()];
		for (position, &group) in order.iter().enumerate() {
			rank[usize::from(group)] = position as u16;
		}
		let mut totals = vec![0u32; groups.len()];
		for group in &mut membership {
			*group = rank[usize::from(*group)];
			totals[usize::from(*group)] += 1;
		}
		self.groups = order
			.iter()
			.enumerate()
			.map(|(position, &group)| {
				let (id, name) = groups[usize::from(group)].clone();
				Group {
					logo: provider_logo(id.as_str())
						.is_some()
						.then(|| sf!("asset://login/{id}")),
					value: sf!("{position}"),
					name_id: sf!("provider-name-{position}"),
					count_id: sf!("provider-count-{position}"),
					total: totals[position],
					id,
					name,
				}
			})
			.collect();
		self.items = self
			.rows
			.iter()
			.zip(membership)
			.enumerate()
			.map(|(index, (row, group))| {
				let label = search_label(row);
				Item {
					value: sf!("{index}"),
					search: SearchIndex::new(label.as_str()),
					label,
					name: if row.name.is_empty() {
						row.key.clone()
					} else {
						row.name.clone()
					},
					provider: if row.provider.is_empty() {
						row.provider_id.clone()
					} else {
						row.provider.clone()
					},
					context: row
						.context
						.map_or_else(Str::default, |tokens| sf!("{} ctx", compact_count(tokens))),
					cost: cost_pair(row.input_mtok, row.output_mtok),
					group,
				}
			})
			.collect();
		self.counts = vec![0; self.groups.len() + 1];
		self.generation += 1;
		self.recount();
	}

	/// Recomputes rail counts: totals without a query, matches under one.
	fn recount(&mut self) {
		self.counts.iter_mut().for_each(|count| *count = 0);
		let query = Query::new(&self.query).filter(|_| !self.query.starts_with('@'));
		for item in &self.items {
			if query
				.as_ref()
				.is_none_or(|query| item.search.score(query).is_some())
			{
				self.counts[0] += 1;
				self.counts[usize::from(item.group) + 1] += 1;
			}
		}
	}

	/// Retexts the rail counts in place and dims providers without matches.
	fn retext_counts(&mut self) {
		let all = sf!("{}", self.counts[0]);
		self.ui.set_text("provider-count-all", all);
		for (index, group) in self.groups.iter().enumerate() {
			let count = self.counts[index + 1];
			self.ui.set_text(&group.count_id, sf!("{count}"));
			self.ui.set_prop(&group.name_id, Prop::Dim, count == 0);
		}
		self.ui.set_text(STATUS_ID, self.status());
	}

	fn rebuild(&mut self, restore: Restore) {
		if self.role_mode {
			self.focus = Pane::Models;
		}
		self.recount();
		self.ui = Ui::from_root(self.tree(), self.width, self.ctx.clone());
		if !self.query.is_empty() {
			let query = self.query.clone();
			self
				.ui
				.with_component_mut::<Select, _>(MODELS_ID, |select| select.set_query(&query));
		}
		self.ui.focus_id(self.focus.into());
		if restore == Restore::Highlight {
			self.restore_highlight();
		}
		// Focus entry may have moved the list cursor after the tree was
		// placed; re-place so the window scrolls to it.
		self.ui.invalidate(MODELS_ID);
		let under = self
			.ui
			.with_component::<Select, _>(MODELS_ID, Select::highlighted_value)
			.flatten()
			.and_then(|value| value.as_str().parse().ok());
		self.note_highlight(under);
		self.ui.set_text(STATUS_ID, self.status());
	}

	const fn title(&self) -> &'static str {
		if self.role_mode {
			"Switch Quick Role"
		} else if self.task_mode {
			"Switch Task Model"
		} else {
			"Switch Model"
		}
	}

	fn hint(&self) -> &'static str {
		if self.role_mode {
			HINT_ROLES
		} else if self.focus == Pane::Providers {
			HINT_PROVIDERS
		} else if self.task_mode {
			HINT_TASK
		} else {
			HINT_MODELS
		}
	}

	/// One-line scope summary (v1 `#statusRow`).
	fn status(&self) -> Str {
		if self.role_mode {
			return Str::new_static(STATUS_ROLES);
		}
		let entry = self.scope.map_or(0, |group| usize::from(group) + 1);
		let total = self
			.scope
			.map_or(self.rows.len() as u32, |group| self.groups[usize::from(group)].total);
		if total == 0 {
			return Str::new_static(STATUS_EMPTY);
		}
		let matches = self.counts[entry];
		if matches == 0 {
			return Str::new_static(STATUS_NO_MATCH);
		}
		let mut line = StrMut::with_capacity(64);
		if self.task_mode {
			line.push_str("Task subagent model · ");
		}
		match self.scope {
			Some(group) => line.push_str(self.groups[usize::from(group)].name.as_str()),
			None => line.push_str("All models"),
		}
		let _ = if self.query.is_empty() {
			write!(line, " · {total} {}", if total == 1 { "model" } else { "models" })
		} else {
			write!(line, " · {matches} of {total} match")
		};
		if self.session_only && !self.task_mode {
			line.push_str(" · session-only switch");
		}
		line.freeze()
	}

	fn show_detail(&mut self, selected: Option<usize>) {
		let text = self.detail(selected).unwrap_or_else(|| sf!(" "));
		self.ui.set_text(FACTS_ID, text);
	}

	/// The facts line of the model list option `selected` (a row index, or a
	/// quick-role index in `@` mode): the model's facts and the roles it holds.
	fn detail(&self, selected: Option<usize>) -> Option<Str> {
		let row = if self.role_mode {
			selected
				.and_then(|index| self.quick_roles.get(index))
				.and_then(|role| self.rows.get(role.model))
		} else {
			selected.and_then(|index| self.rows.get(index))
		}?;
		let mut facts = model_facts(row);
		if self.roles.iter().any(|mark| mark.key == row.key) {
			let mut line = StrMut::new(facts.as_str());
			for mark in self.roles.iter().filter(|mark| mark.key == row.key) {
				push_fact(&mut line, format_args!("{}", mark.role.name()));
			}
			facts = line.freeze();
		}
		Some(facts)
	}

	fn rail_width(&self) -> u16 {
		let longest = self
			.groups
			.iter()
			.map(|group| omp_tui::cell_width(&group.name))
			.max()
			.unwrap_or(0)
			.max(omp_tui::cell_width("All models"));
		let digits = count_digits(self.rows.len() as u32);
		longest
			.saturating_add(digits)
			.saturating_add(8)
			.clamp(RAIL_MIN_WIDTH, RAIL_MAX_WIDTH)
			.min(self.width / 3)
	}

	/// Builds the whole two-pane tree for the current state.
	fn tree(&self) -> Box<dyn Component> {
		struct Entry {
			value:    Str,
			name:     Str,
			name_id:  Str,
			count:    Str,
			count_id: Str,
			logo:     Option<Str>,
			icon:     &'static str,
			active:   bool,
			dim:      bool,
		}
		let searching = !self.query.trim().is_empty() && !self.role_mode;
		let entries = std::iter::once(Entry {
			value:    Str::new_static(ALL_VALUE),
			name:     Str::new_static("All models"),
			name_id:  Str::new_static("provider-name-all"),
			count:    sf!("{}", self.counts[0]),
			count_id: Str::new_static("provider-count-all"),
			logo:     None,
			icon:     "model",
			active:   self.scope.is_none(),
			dim:      false,
		})
		.chain(self.groups.iter().enumerate().map(|(index, group)| {
			let count = self.counts[index + 1];
			Entry {
				value:    group.value.clone(),
				name:     group.name.clone(),
				name_id:  group.name_id.clone(),
				count:    sf!("{count}"),
				count_id: group.count_id.clone(),
				logo:     group.logo.clone(),
				icon:     "enabled",
				active:   self.scope == Some(index as u16),
				dim:      searching && count == 0,
			}
		}))
		.collect::<Vec<_>>();
		let rows = self.list_rows;
		let rail = self.rail_width();
		let title = self.title();
		let status = self.status();
		let hint = self.hint();
		let list = if self.role_mode {
			self.roles_list(rows)
		} else {
			self.models_list(rows, rail)
		};
		let chips = !self.role_mode;
		dom! {
			<box border=round title={title} pad-x=1>
				<col>
					<text id={STATUS_ID} fg=muted truncate>{status}</text>
					<row h={rows} gap=1>
						<select id={PROVIDERS_ID} h={rows} w={rail}>
							for entry in entries {
								<option value={entry.value} label={entry.name.clone()} active={entry.active}>
									<td>
										match entry.logo {
											Some(src) => <img src={src} w=2 h=1/>,
											None => <icon name={entry.icon} fg={if entry.active { "accent" } else { "ok" }}/>,
										}
									</td>
									<td truncate grow>
										<pre id={entry.name_id} fg={if entry.active { "accent" } else { "fg" }} bold={entry.active} dim={entry.dim}>{entry.name}</pre>
									</td>
									<td align=end><pre id={entry.count_id} fg=muted>{entry.count}</pre></td>
								</option>
							}
						</select>
						<hr/>
						{list}
					</row>
					<hr border=round/>
					<text id={FACTS_ID} fg=muted truncate>{" "}</text>
					if chips {
						<row gap=2>
							for role in PickerRole::iter() {
								<row id={role.chip_id()}>
									<pre fg=muted>{role.chord()}{" "}</pre>
									<icon name="enabled" fg={role.tone()}/>
									<pre fg={role.tone()}>{" "}{role.name()}</pre>
								</row>
							}
							<text fg=muted truncate grow>{ROLE_CHIP_HINT}</text>
						</row>
					} else {
						<text>{" "}</text>
					}
					<text id={HINT_ID} fg=muted truncate>{hint}</text>
				</col>
			</box>
		}
		.into_component()
	}

	/// The right pane: the scoped, filterable model list.
	fn models_list(&self, rows: u16, rail: u16) -> Box<dyn Component> {
		struct Line {
			value:    Str,
			label:    Str,
			provider: Str,
			name:     Str,
			current:  bool,
			roles:    SmallVec<(PickerRole, bool), 4>,
			context:  Str,
			cost:     Str,
		}
		let marks = self
			.roles
			.iter()
			.filter_map(|mark| {
				let row = self.rows.iter().position(|row| row.key == mark.key)?;
				Some((row, mark.role, mark.auto))
			})
			.collect::<SmallVec<(usize, PickerRole, bool), 4>>();
		let current = if self.task_mode {
			self.task_current
		} else {
			self.current
		};
		let scoped = |item: &&Item| self.scope.is_none_or(|group| item.group == group);
		let pane = self.width.saturating_sub(rail).saturating_sub(6);
		let in_scope = || self.items.iter().filter(scoped);
		let show_provider = self.scope.is_none();
		// The marks column carries the current-model mark and role chips, so
		// name truncation never hides either.
		let show_marks = marks.iter().any(|(row, ..)| scoped(&&self.items[*row]))
			|| self.items.get(current).is_some_and(|item| scoped(&item));
		let show_context =
			pane >= CONTEXT_PANE_WIDTH && in_scope().any(|item| !item.context.is_empty());
		let show_cost = pane >= COST_PANE_WIDTH && in_scope().any(|item| !item.cost.is_empty());
		let lines = self
			.items
			.iter()
			.enumerate()
			.filter(|(_, item)| scoped(item))
			.map(|(index, item)| Line {
				value:    item.value.clone(),
				label:    item.label.clone(),
				provider: item.provider.clone(),
				name:     item.name.clone(),
				current:  index == current,
				roles:    marks
					.iter()
					.filter(|(row, ..)| *row == index)
					.map(|(_, role, auto)| (*role, *auto))
					.collect(),
				context:  item.context.clone(),
				cost:     item.cost.clone(),
			})
			.collect::<Vec<_>>();
		let current_mark = if self.task_mode {
			Str::new_static("task")
		} else {
			Str::new_static("current")
		};
		dom! {
			<select id={MODELS_ID} filter h={rows} grow>
				for line in lines {
					<option value={line.value} label={line.label} recommended={line.current}>
						if show_provider {
							<td truncate><pre fg=fg bg=border>{" "}{line.provider}{" "}</pre></td>
						}
						<td truncate grow><pre>{line.name}</pre></td>
						if show_marks {
							<td>
								if line.current { <pre fg=ok>{current_mark.clone()}{" "}</pre> }
								for (role, auto) in line.roles {
									<icon name={if auto { "shadowed" } else { "enabled" }} fg={if auto { "muted" } else { role.tone() }}/>
									<pre fg={if auto { "muted" } else { role.tone() }}>{" "}{role.name()}{" "}</pre>
								}
							</td>
						}
						if show_context { <td align=end><pre fg=muted>{line.context}</pre></td> }
						if show_cost { <td align=end><pre fg=muted>{line.cost}</pre></td> }
					</option>
				}
			</select>
		}
		.into_component()
	}

	/// The right pane in `@` mode: the configured quick roles.
	fn roles_list(&self, rows: u16) -> Box<dyn Component> {
		struct RoleLine {
			value:    Str,
			label:    Str,
			role:     Str,
			model:    Str,
			current:  bool,
			thinking: Option<Str>,
		}
		let lines = self
			.quick_roles
			.iter()
			.enumerate()
			.filter_map(|(index, role)| {
				let model = self.rows.get(role.model)?;
				let name = if model.name.is_empty() {
					model.key.clone()
				} else {
					model.name.clone()
				};
				Some(RoleLine {
					value:    sf!("{index}"),
					label:    sf!("@{} {} {} {}", role.role, model.provider, name, model.key),
					role:     sf!("@{}", role.role),
					model:    name,
					current:  Some(index) == self.current_role,
					thinking: role.thinking.clone(),
				})
			})
			.collect::<Vec<_>>();
		dom! {
			<select id={MODELS_ID} filter h={rows} grow>
				for line in lines {
					<option value={line.value} label={line.label} recommended={line.current}>
						<td truncate><pre fg=accent>{line.role}</pre></td>
						<td truncate grow>
							<pre>{line.model}</pre>
							if line.current { <pre fg=ok>{" current"}</pre> }
						</td>
						if let Some(thinking) = line.thinking {
							<td align=end><pre fg=muted>{thinking}</pre></td>
						}
					</option>
				}
			</select>
		}
		.into_component()
	}
}

impl ModelPicker {
	/// The model list as a data-first TSP `picker` (v1 model hub): every row
	/// is an item keyed by its catalog key (a quick role by `@role`), `order`
	/// is what the list shows under the live scope and query, `selected`
	/// names the row under the cursor, and the children preview it.
	///
	/// The node is rebuilt only when what it shows changed, so presenting an
	/// unchanged picker costs a comparison. The whole catalogue rides one
	/// message; the encoder chunks it under the terminal's `apc` limit.
	pub fn tsp_node(&mut self) -> &Node {
		self.ensure();
		let cursor = self
			.ui
			.with_component::<Select, _>(MODELS_ID, Select::highlighted_value)
			.flatten();
		let key = TspKey {
			generation: self.generation,
			cursor,
			query: self.query.clone(),
			scope: self.scope,
			role_mode: self.role_mode,
			task_mode: self.task_mode,
			current: self.current,
			task_current: self.task_current,
			current_role: self.current_role,
		};
		if self.tsp.key.as_ref() != Some(&key) {
			self.tsp.node = self.build_tsp_node(key.cursor.as_deref());
			self.tsp.key = Some(key);
		}
		&self.tsp.node
	}

	/// Applies a Tern pointer gesture on the native picker the way the cell
	/// list's keys do (v1 `routePickerItem`): `select` moves the cursor to the
	/// row and previews it, `activate` and the `confirm` action pick, `close`
	/// and `cancel` close. A row the list does not show is ignored.
	pub fn tsp_gesture(&mut self, gesture: Gesture) -> PickerEvent {
		self.ensure();
		let (item, activate) = match gesture {
			Gesture::Act(PickerAct::Close | PickerAct::Cancel) => return PickerEvent::Close,
			Gesture::Act(PickerAct::Confirm) => {
				let under = self
					.ui
					.with_component::<Select, _>(MODELS_ID, Select::highlighted_value)
					.flatten()
					.and_then(|value| value.as_str().parse().ok());
				return self.pick(under);
			},
			Gesture::Select(item) => (item, false),
			Gesture::Activate(item) => (item, true),
		};
		let Some((value, index)) = self.option_for(&item) else {
			return PickerEvent::Consumed;
		};
		if self.focus != Pane::Models {
			self.set_focus(Pane::Models);
		}
		let shown = self
			.ui
			.with_component_mut::<Select, _>(MODELS_ID, |select| select.highlight_value(&value))
			.unwrap_or(false);
		if !shown {
			return PickerEvent::Consumed;
		}
		self.ui.invalidate(MODELS_ID);
		self.note_highlight(Some(index));
		if activate {
			self.pick(Some(index))
		} else {
			PickerEvent::Consumed
		}
	}

	/// The list option (its value and index) a native picker row id names in
	/// the current mode.
	fn option_for(&self, item: &str) -> Option<(Str, usize)> {
		if self.role_mode {
			let role = item.strip_prefix('@')?;
			let index = self
				.quick_roles
				.iter()
				.position(|quick| quick.role.as_str() == role)?;
			return Some((sf!("{index}"), index));
		}
		let index = self.rows.iter().position(|row| row.key.as_str() == item)?;
		Some((self.items[index].value.clone(), index))
	}

	fn build_tsp_node(&self, cursor: Option<&str>) -> Node {
		let role_ids: Vec<Str> = self
			.quick_roles
			.iter()
			.map(|role| sf!("@{}", role.role))
			.collect();
		let mut items: Vec<PickerItem> = self
			.rows
			.iter()
			.zip(&self.items)
			.map(|(row, item)| {
				let mut facts = BTreeMap::new();
				if !item.context.is_empty() {
					facts.insert(Str::new_static(CONTEXT_COLUMN), Fact::Text(item.context.clone()));
				}
				if !item.cost.is_empty() {
					facts.insert(Str::new_static(PRICE_COLUMN), Fact::Text(item.cost.clone()));
				}
				PickerItem {
					id: row.key.clone(),
					label: item.name.clone(),
					detail: (!item.provider.is_empty()).then(|| item.provider.clone()),
					mono: false,
					facts,
					chips: self
						.roles
						.iter()
						.filter(|mark| mark.key == row.key)
						.map(|mark| PickerChip {
							text: Str::new_static(mark.role.name()),
							on:   !mark.auto,
							auto: mark.auto,
						})
						.collect(),
					title: None,
				}
			})
			.collect();
		items.extend(
			self
				.quick_roles
				.iter()
				.zip(&role_ids)
				.filter_map(|(role, id)| {
					let model = self.rows.get(role.model)?;
					Some(PickerItem {
						id:     id.clone(),
						label:  id.clone(),
						detail: Some(if model.name.is_empty() {
							model.key.clone()
						} else {
							model.name.clone()
						}),
						mono:   false,
						facts:  BTreeMap::new(),
						chips:  Vec::new(),
						title:  None,
					})
				}),
		);
		// List option values are row indexes, or quick-role indexes in `@` mode.
		let id_of = |value: &str| -> Option<Str> {
			let index: usize = value.parse().ok()?;
			if self.role_mode {
				role_ids.get(index).cloned()
			} else {
				self.rows.get(index).map(|row| row.key.clone())
			}
		};
		let order = self
			.ui
			.with_component::<Select, _>(MODELS_ID, |select| {
				select
					.visible_values()
					.filter_map(|value| id_of(value))
					.collect::<Vec<_>>()
			})
			.unwrap_or_default();
		let current = if self.role_mode {
			self
				.current_role
				.and_then(|index| role_ids.get(index).cloned())
		} else {
			let current = if self.task_mode {
				self.task_current
			} else {
				self.current
			};
			self.rows.get(current).map(|row| row.key.clone())
		};
		let total = if self.role_mode {
			self.quick_roles.len() as u32
		} else {
			self
				.scope
				.map_or(self.rows.len() as u32, |group| self.groups[usize::from(group)].total)
		};
		let under = cursor.and_then(|value| value.parse::<usize>().ok());
		let preview = self
			.detail(under)
			.map(|facts| {
				vec![Node {
					id: Str::new_static(MODEL_PREVIEW_ID),
					k:  Kind::Col,
					p:  Map::new(),
					c:  vec![
						TextProps { text: facts }
							.node(Str::new_static(MODEL_PREVIEW_FACTS_ID), Vec::new()),
					],
				}]
			})
			.unwrap_or_default();
		PickerProps {
			title: Some(Str::new_static(self.title())),
			icon: None,
			noun: Some(Str::new_static(if self.role_mode { "roles" } else { "models" })),
			size: Some(PickerSize::Lg),
			layout: Some(PickerLayout::Rows),
			query: Some(self.query.clone()),
			placeholder: Some(Str::new_static("Search models…")),
			columns: vec![
				PickerColumn {
					id:     Str::new_static(CONTEXT_COLUMN),
					head:   Some(Str::new_static("Context")),
					format: Some(ColumnFormat::Text),
				},
				PickerColumn {
					id:     Str::new_static(PRICE_COLUMN),
					head:   Some(Str::new_static("Price")),
					format: Some(ColumnFormat::Text),
				},
			],
			items,
			order: Some(order),
			selected: cursor.and_then(id_of),
			current: current.into_iter().collect(),
			total: Some(total),
			preview: Some(PickerPreview::Side),
			actions: vec![PickerAction::confirm("Select"), PickerAction::close()],
			empty: Some(Str::new_static(if self.query.trim().is_empty() {
				STATUS_EMPTY
			} else {
				STATUS_NO_MATCH
			})),
		}
		.node(Str::new_static(MODEL_PICKER_ID), preview)
	}
}

/// Resolves a role selector (`ai_model_roles` value) to a roster row.
///
/// Tries the exact key, the key with a `:thinking`/`:route` annotation
/// stripped, a bare model id matching a key's last segment, then a display
/// name. The catalog owns real selector resolution; this only locates the
/// row to mark.
#[must_use]
pub fn resolve_role_selector<'a>(rows: &'a [ModelRow], selector: &str) -> Option<&'a ModelRow> {
	let selector = selector.trim();
	let bare = selector
		.rsplit_once(':')
		.filter(|(model, annotation)| {
			!model.is_empty()
				&& annotation
					.chars()
					.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
		})
		.map_or(selector, |(model, _)| model);
	[selector, bare].into_iter().find_map(|wanted| {
		rows.iter().find(|row| row.key == wanted).or_else(|| {
			rows.iter().find(|row| {
				row.key.rsplit_once('/').is_some_and(|(_, id)| id == wanted)
					|| row.name.as_str().eq_ignore_ascii_case(wanted)
			})
		})
	})
}

/// Pane height for a viewport height.
const fn list_rows(height: u16) -> u16 {
	let rows = height.saturating_sub(CHROME_ROWS);
	if rows < MIN_LIST_ROWS {
		MIN_LIST_ROWS
	} else {
		rows
	}
}

const fn count_digits(mut value: u32) -> u16 {
	let mut digits = 1;
	while value >= 10 {
		value /= 10;
		digits += 1;
	}
	digits
}

/// The fuzzy haystack for one row: provider name, model name, key, the
/// provider id when it differs from its name (so `provider/` queries match),
/// and `free` for zero-cost models (v1 `modelSearchText`).
fn search_label(row: &ModelRow) -> Str {
	let mut label = StrMut::with_capacity(96);
	let _ = write!(label, "{} {} {}", row.provider, row.name, row.key);
	if !row.provider_id.is_empty() && !row.provider_id.eq_ignore_ascii_case(&row.provider) {
		label.push(' ');
		label.push_str(row.provider_id.as_str());
	}
	if row.input_mtok == Some(0.0) && row.output_mtok == Some(0.0) {
		label.push_str(" free");
	}
	label.freeze()
}

/// `$in/out` per-million price pair, `free` when both legs are zero (v1
/// `formatCostPair`); empty when the catalog prices neither leg.
fn cost_pair(input: Option<f64>, output: Option<f64>) -> Str {
	let mut out = StrMut::with_capacity(16);
	match (input, output) {
		(None, None) => return Str::default(),
		(Some(input), Some(output)) if input <= 0.0 && output <= 0.0 => {
			return Str::new_static("free");
		},
		(Some(input), Some(output)) => {
			out.push('$');
			push_price(&mut out, input);
			out.push('/');
			push_price(&mut out, output);
		},
		(Some(input), None) => {
			out.push('$');
			push_price(&mut out, input);
			out.push_str(" in");
		},
		(None, Some(output)) => {
			out.push('$');
			push_price(&mut out, output);
			out.push_str(" out");
		},
	}
	out.freeze()
}

/// v1 price spelling: whole dollars from 100, one decimal from 10, else two,
/// trailing zeros trimmed.
fn push_price(out: &mut StrMut, value: f64) {
	if value <= 0.0 {
		out.push('0');
		return;
	}
	let start = out.len();
	let _ = if value >= 100.0 {
		write!(out, "{}", value.round())
	} else if value >= 10.0 {
		write!(out, "{value:.1}")
	} else {
		write!(out, "{value:.2}")
	};
	if out.as_str()[start..].contains('.') {
		while out.as_str().ends_with('0') {
			out.truncate(out.len() - 1);
		}
		if out.as_str().ends_with('.') {
			out.truncate(out.len() - 1);
		}
	}
}

/// The highlighted model's facts line: name, provider, context, prices, and
/// thinking efforts.
pub(super) fn model_facts(row: &ModelRow) -> Str {
	let mut line = StrMut::with_capacity(96);
	let name = if row.name.is_empty() {
		&row.key
	} else {
		&row.name
	};
	push_fact(&mut line, format_args!("{name}"));
	push_fact(&mut line, format_args!("{}", row.provider));
	if let Some(context) = row.context {
		push_fact(&mut line, format_args!("{} context", compact_count(context)));
	}
	match (row.input_mtok, row.output_mtok) {
		(Some(input), Some(output)) => {
			push_fact(&mut line, format_args!("${input}/${output} per Mtok"));
		},
		(Some(input), None) => push_fact(&mut line, format_args!("${input} in per Mtok")),
		(None, Some(output)) => push_fact(&mut line, format_args!("${output} out per Mtok")),
		(None, None) => {},
	}
	if !row.efforts.is_empty() {
		let mut efforts = StrMut::new("thinking ");
		for (index, effort) in row.efforts.iter().enumerate() {
			if index > 0 {
				efforts.push('/');
			}
			efforts.push_str(effort.as_str());
		}
		push_fact(&mut line, format_args!("{}", efforts.as_str()));
	}
	line.freeze()
}

fn push_fact(line: &mut StrMut, fact: fmt::Arguments<'_>) {
	if !line.is_empty() {
		line.push_str(" · ");
	}
	let _ = write!(line, "{fact}");
}

fn compact_count(value: u64) -> Str {
	if value >= 1_000_000 {
		sf!("{:.1}m", value as f64 / 1_000_000.0)
	} else if value >= 1_000 {
		sf!("{:.0}k", value as f64 / 1_000.0)
	} else {
		sf!("{value}")
	}
}

#[cfg(test)]
mod tests {
	use omp_tui::{Mods, MouseButton, frame_text};

	use super::*;

	const VIEW: Size = Size::new(100, 40);
	/// Columns holding the frame edge, padding, and the provider rail at
	/// [`VIEW`]'s width; the model list starts after them.
	const RAIL: usize = 27;

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

	/// A row whose key says nothing reliable about its provider: grouping
	/// must come from route metadata alone.
	fn routed(key: &'static str, provider_id: &'static str, provider: &'static str) -> ModelRow {
		ModelRow {
			key:         Str::new_static(key),
			name:        Str::new_static(key),
			provider_id: Str::new_static(provider_id),
			provider:    Str::new_static(provider),
			context:     Some(200_000),
			input_mtok:  Some(3.0),
			output_mtok: Some(15.0),
			efforts:     Vec::new(),
		}
	}

	fn catalog() -> Vec<ModelRow> {
		vec![
			routed("claude-opus", "anthropic", "Anthropic"),
			routed("gpt-5", "openai", "OpenAI"),
			routed("claude-haiku", "anthropic", "Anthropic"),
			// A scoped key naming another vendor: the route says openrouter.
			routed("anthropic/claude-sonnet", "openrouter", "OpenRouter"),
		]
	}

	fn picker(rows: Vec<ModelRow>, current: usize, task_current: usize) -> ModelPicker {
		ModelPicker::open(
			rows,
			current,
			task_current,
			Vec::new(),
			None,
			true,
			VIEW,
			&UiContext::default(),
		)
	}

	fn text(picker: &mut ModelPicker) -> String {
		frame_text(picker.frame(VIEW))
	}

	/// Pane lines (below the status row) split into rail and list halves.
	fn panes(text: &str) -> impl Iterator<Item = (usize, String, String)> + '_ {
		text
			.lines()
			.enumerate()
			.skip(2)
			.take_while(|(_, line)| !line.starts_with('├'))
			.map(|(row, line)| {
				(row, line.chars().take(RAIL).collect(), line.chars().skip(RAIL).collect())
			})
	}

	fn rail_row(text: &str, name: &str) -> String {
		panes(text)
			.find_map(|(_, rail, _)| rail.contains(name).then_some(rail))
			.unwrap_or_else(|| panic!("{name} rail row:\n{text}"))
	}

	fn list_row(text: &str, name: &str) -> String {
		panes(text)
			.find_map(|(_, _, list)| list.contains(name).then_some(list))
			.unwrap_or_else(|| panic!("{name} list row:\n{text}"))
	}

	/// Frame cell of `needle` in the rail (`rail`) or the list.
	fn cell(text: &str, needle: &str, rail: bool) -> (u16, u16) {
		panes(text)
			.find_map(|(row, left, right)| {
				let (half, offset) = if rail { (left, 0) } else { (right, RAIL) };
				let byte = half.find(needle)?;
				Some((omp_tui::cell_width(&half[..byte]) + offset as u16, row as u16))
			})
			.unwrap_or_else(|| panic!("{needle:?} is painted:\n{text}"))
	}

	fn report(kind: Mouse, (col, row): (u16, u16)) -> MouseReport {
		MouseReport {
			kind,
			col,
			row,
			button: MouseButton::Left,
			mods: Mods::default(),
			pressed: true,
		}
	}

	fn cursor() -> String {
		UiContext::default().charset.cursor().trim().to_owned()
	}

	#[test]
	fn rail_groups_by_route_provider_with_counts_in_name_order() {
		let mut picker = picker(catalog(), 0, 0);
		let shown = text(&mut picker);
		assert_eq!(picker.frame(VIEW).size(), VIEW, "the picker fills the viewport");
		assert!(rail_row(&shown, "All models").trim_end().ends_with('4'), "{shown}");
		assert!(rail_row(&shown, "Anthropic").trim_end().ends_with('2'), "{shown}");
		assert!(rail_row(&shown, "OpenAI").trim_end().ends_with('1'), "{shown}");
		assert!(
			rail_row(&shown, "OpenRouter").trim_end().ends_with('1'),
			"the key's `anthropic/` spelling never groups it:\n{shown}"
		);
		let order = panes(&shown)
			.filter_map(|(row, rail, _)| {
				["Anthropic", "OpenAI", "OpenRouter"]
					.into_iter()
					.find(|name| rail.contains(&format!("{name} ")))
					.map(|name| (row, name))
			})
			.map(|(_, name)| name)
			.collect::<Vec<_>>();
		assert_eq!(order, ["Anthropic", "OpenAI", "OpenRouter"], "{shown}");
		assert!(shown.contains("All models · 4 models"), "{shown}");
		assert!(list_row(&shown, "gpt-5").contains("$3/15"), "v1 cost pair column:\n{shown}");
		assert!(list_row(&shown, "gpt-5").contains("200k ctx"), "{shown}");
	}

	#[test]
	fn cost_pairs_follow_v1_spelling() {
		assert_eq!(cost_pair(Some(3.0), Some(15.0)).as_str(), "$3/15");
		assert_eq!(cost_pair(Some(0.25), Some(1.25)).as_str(), "$0.25/1.25");
		assert_eq!(cost_pair(Some(12.5), Some(150.0)).as_str(), "$12.5/150");
		assert_eq!(cost_pair(Some(0.0), Some(0.0)).as_str(), "free");
		assert_eq!(cost_pair(Some(0.5), None).as_str(), "$0.5 in");
		assert_eq!(cost_pair(None, None).as_str(), "");
	}

	#[test]
	fn provider_prefix_scopes_the_list_and_selects_the_rail_entry() {
		let mut picker = picker(catalog(), 0, 0);
		for ch in "openai/".chars() {
			assert_eq!(picker.key(Key::Char(ch)), PickerEvent::Consumed);
		}
		assert_eq!(picker.scope(), Some("openai"));
		let shown = text(&mut picker);
		assert!(shown.contains("OpenAI · 1 of 1 match"), "{shown}");
		assert!(!shown.contains("claude-opus"), "{shown}");
		assert_eq!(picker.key(Key::Enter), PickerEvent::Pick(1));

		// Deleting the slash drops the prefix scope back to All models.
		assert_eq!(picker.key(Key::Backspace), PickerEvent::Consumed);
		assert_eq!(picker.scope(), None);

		// A display name works as the prefix too; the rest still filters.
		let mut picker = picker_over(catalog());
		for ch in "Anthropic/haiku".chars() {
			picker.key(Key::Char(ch));
		}
		assert_eq!(picker.scope(), Some("anthropic"));
		assert_eq!(picker.key(Key::Enter), PickerEvent::Pick(2));
	}

	fn picker_over(rows: Vec<ModelRow>) -> ModelPicker {
		picker(rows, 0, 0)
	}

	/// Clearing a `provider/` query rebuilds with fresh totals and scrolls
	/// the list back to the model under the cursor.
	#[test]
	fn clearing_a_prefix_restores_totals_and_scrolls_to_the_cursor() {
		let mut rows = (0..60).map(|_| row("vendor", "model")).collect::<Vec<_>>();
		rows[50] = row("anthropic", "Claude Opus 5");
		let mut picker = picker(rows, 50, 0);
		for ch in "anthropic/".chars() {
			picker.key(Key::Char(ch));
		}
		assert_eq!(picker.scope(), Some("anthropic"));
		assert!(
			rail_row(&text(&mut picker), "vendor")
				.trim_end()
				.ends_with('0')
		);
		assert_eq!(picker.key(Key::Esc), PickerEvent::Consumed);
		assert_eq!(picker.scope(), None);
		let shown = text(&mut picker);
		assert!(rail_row(&shown, "All models").trim_end().ends_with("60"), "{shown}");
		assert!(rail_row(&shown, "vendor").trim_end().ends_with("59"), "{shown}");
		assert!(
			list_row(&shown, "Claude Opus 5").contains(&cursor()),
			"the window follows the cursor:\n{shown}"
		);
	}

	#[test]
	fn a_scope_without_matches_falls_back_to_all_models() {
		let mut picker = picker(catalog(), 0, 0);
		picker.key(Key::Tab);
		picker.key(Key::Down);
		assert_eq!(picker.scope(), Some("anthropic"));
		for ch in "gpt".chars() {
			picker.key(Key::Char(ch));
		}
		assert_eq!(picker.scope(), None, "no anthropic model matches `gpt`");
		let shown = text(&mut picker);
		assert!(rail_row(&shown, "OpenAI").trim_end().ends_with('1'), "{shown}");
		assert!(rail_row(&shown, "Anthropic").trim_end().ends_with('0'), "{shown}");
		assert_eq!(picker.key(Key::Enter), PickerEvent::Pick(1));

		for ch in "zzz".chars() {
			picker.key(Key::Char(ch));
		}
		assert!(text(&mut picker).contains(STATUS_NO_MATCH));
	}

	#[test]
	fn tab_and_arrows_move_focus_between_panes_and_hop_providers() {
		let mut picker = picker(catalog(), 0, 0);
		let cursor = cursor();
		let shown = text(&mut picker);
		assert!(list_row(&shown, "claude-opus").contains(&cursor), "list focused at open:\n{shown}");
		assert_eq!(shown.matches(&cursor).count(), 1, "one visible cursor:\n{shown}");

		assert_eq!(picker.key(Key::Left), PickerEvent::Consumed);
		let shown = text(&mut picker);
		assert!(rail_row(&shown, "All models").contains(&cursor), "{shown}");
		assert!(shown.contains(HINT_PROVIDERS), "{shown}");
		assert_eq!(
			shown.matches(&cursor).count(),
			1,
			"the rail cursor replaces the list's:\n{shown}"
		);

		// Up wraps from All models to the last provider; Down wraps back.
		picker.key(Key::Up);
		assert_eq!(picker.scope(), Some("openrouter"));
		picker.key(Key::Down);
		assert_eq!(picker.scope(), None);
		picker.key(Key::End);
		assert_eq!(picker.scope(), Some("openrouter"));
		picker.key(Key::Home);
		assert_eq!(picker.scope(), None);
		picker.key(Key::PageDown);
		assert_eq!(picker.scope(), Some("openrouter"), "a page clamps at the last provider");
		picker.key(Key::PageUp);
		picker.key(Key::Down);
		assert_eq!(picker.scope(), Some("anthropic"));
		let shown = text(&mut picker);
		assert!(!shown.contains("gpt-5"), "the list follows the rail:\n{shown}");
		assert!(rail_row(&shown, "Anthropic").contains(&cursor), "{shown}");

		// Enter dives into the list; Down + Enter picks the second anthropic model.
		assert_eq!(picker.key(Key::Enter), PickerEvent::Consumed);
		picker.key(Key::Down);
		assert_eq!(picker.key(Key::Enter), PickerEvent::Pick(2));

		// Tab toggles back; typing from the rail searches the list.
		picker.key(Key::Tab);
		assert!(text(&mut picker).contains(HINT_PROVIDERS));
		picker.key(Key::Char('h'));
		assert!(text(&mut picker).contains("Enter use · Tab providers"), "typing focuses the list");
		assert_eq!(picker.key(Key::Enter), PickerEvent::Pick(2));

		// Right from the rail, then Esc clears the query before closing.
		let mut picker = picker_over(catalog());
		picker.key(Key::Left);
		picker.key(Key::Right);
		picker.key(Key::Char('g'));
		assert_eq!(picker.key(Key::Esc), PickerEvent::Consumed);
		assert_eq!(picker.key(Key::Esc), PickerEvent::Close);
	}

	#[test]
	fn mouse_hovers_scrolls_and_clicks_across_both_panes() {
		let mut picker = picker(catalog(), 0, 0);
		let shown = text(&mut picker);

		// Hover paints the theme's hover band on the row under the pointer;
		// a keystroke clears it.
		let gpt = cell(&shown, "gpt-5", false);
		picker.mouse(report(Mouse::Move, gpt));
		let hover = UiContext::default().theme.hover;
		assert_eq!(
			picker
				.frame(VIEW)
				.cell(gpt.0, gpt.1)
				.style()
				.background_color(),
			hover
		);
		picker.key(Key::Home);
		assert_ne!(
			picker
				.frame(VIEW)
				.cell(gpt.0, gpt.1)
				.style()
				.background_color(),
			hover
		);

		// Hovering the rail bands the rail row instead.
		let openai = cell(&shown, "OpenAI", true);
		picker.mouse(report(Mouse::Move, openai));
		assert_eq!(
			picker
				.frame(VIEW)
				.cell(openai.0, openai.1)
				.style()
				.background_color(),
			hover
		);
		assert_ne!(
			picker
				.frame(VIEW)
				.cell(gpt.0, gpt.1)
				.style()
				.background_color(),
			hover
		);

		// First click highlights, second click on the same model picks.
		assert_eq!(picker.mouse(report(Mouse::Click, gpt)), PickerEvent::Consumed);
		assert!(text(&mut picker).contains("gpt-5 · OpenAI"), "facts follow the click");
		assert_eq!(picker.mouse(report(Mouse::Click, gpt)), PickerEvent::Pick(1));

		// A click on the rail scopes to that provider and focuses the rail.
		let openrouter = cell(&shown, "OpenRouter", true);
		assert_eq!(picker.mouse(report(Mouse::Click, openrouter)), PickerEvent::Consumed);
		assert_eq!(picker.scope(), Some("openrouter"));
		assert!(text(&mut picker).contains(HINT_PROVIDERS));

		// The wheel over the rail hops providers; over the list it moves the
		// model cursor without leaving the rail.
		picker.mouse(report(Mouse::WheelUp, openrouter));
		assert_eq!(picker.scope(), Some("openai"));
		let all = cell(&text(&mut picker), "All models", true);
		picker.mouse(report(Mouse::Click, all));
		assert_eq!(picker.scope(), None);
		let shown = text(&mut picker);
		assert!(shown.contains("gpt-5 · OpenAI"), "the click-highlighted model is kept:\n{shown}");
		picker.mouse(report(Mouse::WheelDown, cell(&shown, "claude-opus", false)));
		assert!(
			text(&mut picker).contains("claude-haiku · Anthropic"),
			"wheel moved the model cursor"
		);
		assert_eq!(picker.key(Key::Right), PickerEvent::Consumed);
		assert_eq!(picker.key(Key::Enter), PickerEvent::Pick(2));
	}

	/// A click on a model while the rail holds focus moves focus to the list
	/// with the cursor on the clicked row, not on the previously tracked one.
	#[test]
	fn clicking_a_model_from_the_rail_focuses_the_clicked_row() {
		let mut picker = picker(catalog(), 0, 0);
		picker.key(Key::Left);
		let shown = text(&mut picker);
		let haiku = cell(&shown, "claude-haiku", false);
		assert_eq!(picker.mouse(report(Mouse::Click, haiku)), PickerEvent::Consumed);
		let shown = text(&mut picker);
		assert!(list_row(&shown, "claude-haiku").contains(&cursor()), "{shown}");
		assert!(shown.contains("claude-haiku · Anthropic"), "{shown}");
		assert_eq!(picker.key(Key::Enter), PickerEvent::Pick(2));
	}

	#[test]
	fn role_chords_and_chips_assign_the_highlighted_model() {
		let mut picker = picker(catalog(), 0, 0).with_roles(vec![
			RoleMark { role: PickerRole::Smol, key: Str::new_static("gpt-5"), auto: false },
			RoleMark { role: PickerRole::Default, key: Str::new_static("claude-opus"), auto: true },
		]);
		let shown = text(&mut picker);
		assert!(list_row(&shown, "gpt-5").contains("smol"), "{shown}");
		assert!(list_row(&shown, "claude-opus").contains("default"), "{shown}");
		assert!(shown.contains("Alt+2") && shown.contains("Alt+4"), "{shown}");
		assert!(picker.holds_role(PickerRole::Smol, 1));
		assert!(!picker.holds_role(PickerRole::Default, 0), "auto marks are not configured roles");

		assert_eq!(picker.key(Key::Alt('3')), PickerEvent::AssignRole {
			role:  PickerRole::Slow,
			index: 0,
		});
		picker.key(Key::Down);
		let chip = shown
			.lines()
			.enumerate()
			.find_map(|(row, line)| {
				let byte = line.find("tiny")?;
				Some((omp_tui::cell_width(&line[..byte]), row as u16))
			})
			.expect("tiny chip painted");
		assert_eq!(picker.mouse(report(Mouse::Click, chip)), PickerEvent::AssignRole {
			role:  PickerRole::Tiny,
			index: 1,
		});
		assert_eq!(PickerRole::from_key(Key::Alt('9')), None);
		assert_eq!(PickerRole::from_key(Key::Alt('1')), Some(PickerRole::Default));

		picker.set_roles(vec![RoleMark {
			role: PickerRole::Slow,
			key:  Str::new_static("gpt-5"),
			auto: false,
		}]);
		let shown = text(&mut picker);
		assert!(list_row(&shown, "gpt-5").contains("slow"), "{shown}");
		assert!(shown.contains("gpt-5 · OpenAI"), "the highlight survives the repaint:\n{shown}");
	}

	#[test]
	fn role_selectors_resolve_keys_annotations_ids_and_names() {
		let rows = vec![row("anthropic", "claude-opus"), routed("gpt-5", "openai", "OpenAI")];
		let key = |selector: &str| resolve_role_selector(&rows, selector).map(|row| row.key.as_str());
		assert_eq!(key("anthropic/claude-opus"), Some("anthropic/claude-opus"));
		assert_eq!(key("anthropic/claude-opus:high"), Some("anthropic/claude-opus"));
		assert_eq!(key("claude-opus"), Some("anthropic/claude-opus"));
		assert_eq!(key("gpt-5"), Some("gpt-5"));
		assert_eq!(key("openai/gpt-5"), None, "no catalog row is invented");
		assert_eq!(key("@smol"), None);
	}

	#[test]
	fn a_replaced_list_keeps_the_selection_and_scope_by_identity() {
		let mut picker = picker(catalog(), 0, 0);
		picker.key(Key::Left);
		picker.key(Key::Down);
		picker.key(Key::Right);
		picker.key(Key::Down);
		assert!(text(&mut picker).contains("claude-haiku · Anthropic"));

		// Discovery reorders, adds a provider, and drops gpt-5.
		let mut rows = vec![
			routed("gemini", "google", "Google"),
			routed("claude-haiku", "anthropic", "Anthropic"),
			routed("claude-new", "anthropic", "Anthropic"),
			routed("claude-opus", "anthropic", "Anthropic"),
		];
		picker.replace_rows(rows.clone());
		assert_eq!(picker.scope(), Some("anthropic"));
		let shown = text(&mut picker);
		assert!(shown.contains("claude-haiku · Anthropic"), "highlight kept:\n{shown}");
		assert!(rail_row(&shown, "Anthropic").trim_end().ends_with('3'), "{shown}");
		assert!(rail_row(&shown, "Google").trim_end().ends_with('1'), "{shown}");
		assert!(!shown.contains("OpenAI"), "{shown}");
		assert!(list_row(&shown, "claude-opus").contains("current"), "current kept by key:\n{shown}");
		assert_eq!(picker.key(Key::Enter), PickerEvent::Pick(1));

		// The scoped provider vanishing falls back to All models.
		rows.retain(|row| row.provider_id != "anthropic");
		picker.replace_rows(rows);
		assert_eq!(picker.scope(), None);
		assert!(text(&mut picker).contains("All models · 1 model"));
		assert_eq!(picker.key(Key::Enter), PickerEvent::Pick(0));
	}

	#[test]
	fn resize_relayouts_to_the_new_viewport() {
		let rows = (0..60).map(|_| row("vendor", "model")).collect::<Vec<_>>();
		let mut picker = picker(rows, 50, 0);
		for size in [Size::new(80, 20), Size::new(140, 50), Size::new(60, 12)] {
			let frame = picker.frame(size);
			assert_eq!(frame.size(), size, "fills {size:?}");
			let shown = frame_text(frame);
			assert!(shown.contains("current"), "the current row stays visible at {size:?}:\n{shown}");
		}
		assert_eq!(picker.key(Key::Enter), PickerEvent::Pick(50));
	}

	#[test]
	fn absent_model_facts_are_omitted() {
		let facts = model_facts(&row("p", "Model"));
		assert!(!facts.contains("ctx"));
		assert!(!facts.contains('$'));
		assert!(!facts.contains("thinking"));
	}

	#[test]
	fn typing_filters_models() {
		let mut picker = picker(vec![row("alpha", "first"), row("beta", "second")], 0, 0);
		assert_eq!(picker.key(Key::Char('b')), PickerEvent::Consumed);
		assert_eq!(picker.key(Key::Enter), PickerEvent::Pick(1));
	}

	#[test]
	fn down_then_enter_picks_the_next_model() {
		let mut picker = picker(vec![row("alpha", "first"), row("beta", "second")], 0, 0);
		assert_eq!(picker.key(Key::Down), PickerEvent::Consumed);
		assert_eq!(picker.key(Key::Enter), PickerEvent::Pick(1));
	}

	#[test]
	fn escape_closes_the_picker() {
		let mut picker = picker(vec![row("alpha", "first")], 0, 0);
		assert_eq!(picker.key(Key::Esc), PickerEvent::Close);
	}

	#[test]
	fn alt_p_toggles_task_mode_and_picks_the_task_model() {
		let mut picker = picker(vec![row("alpha", "first"), row("beta", "second")], 0, 1);
		assert_eq!(picker.key(Key::Alt('p')), PickerEvent::Consumed);
		assert_eq!(picker.key(Key::Enter), PickerEvent::PickTask(1));
	}

	#[test]
	fn leading_at_switches_to_quick_roles_and_returns_the_role() {
		let rows = vec![row("alpha", "first"), row("beta", "second")];
		let roles = vec![
			QuickRoleRow {
				role:     Str::new_static("default"),
				model:    0,
				thinking: Some(Str::new_static("medium")),
			},
			QuickRoleRow {
				role:     Str::new_static("slow"),
				model:    1,
				thinking: Some(Str::new_static("high")),
			},
		];
		let mut picker =
			ModelPicker::open(rows, 0, 0, roles, Some(0), true, VIEW, &UiContext::default());
		for ch in "@slow".chars() {
			assert_eq!(picker.key(Key::Char(ch)), PickerEvent::Consumed);
		}
		let shown = omp_tui::frame_text(picker.frame(Size::new(100, 40)));
		assert!(shown.contains("Switch Quick Role"), "{shown}");
		assert!(shown.contains("@slow"), "{shown}");
		assert!(!shown.contains("@default"), "{shown}");
		assert_eq!(picker.key(Key::Enter), PickerEvent::PickRole(1));
		assert_eq!(picker.quick_roles()[1].thinking.as_deref(), Some("high"));
	}

	#[test]
	fn picker_frame_paints_title_rows_and_hint() {
		let mut picker = picker(vec![row("anthropic", "Claude"), row("openai", "GPT")], 0, 0);
		let frame = picker.frame(Size::new(100, 40));
		let text = omp_tui::frame_text(frame);
		assert!(text.contains("Switch Model"), "{text}");
		assert!(text.contains("Claude"), "{text}");
		assert!(text.contains("current"), "{text}");
		assert!(text.contains("Esc close"), "{text}");
	}

	/// A fresh picker over a large catalog opens scrolled to the current
	/// model with the cursor marker on its row, and the facts line names
	/// the same model (current model preselected and
	/// visible).
	#[test]
	fn picker_opens_scrolled_to_the_current_model_with_the_cursor_on_it() {
		let rows: Vec<ModelRow> = (0..300)
			.map(|index| {
				if index == 250 {
					row("anthropic", "Claude Opus 5")
				} else {
					row("vendor", "model")
				}
			})
			.collect();
		let mut picker = picker(rows, 250, 0);
		let frame = picker.frame(Size::new(100, 40));
		let text = omp_tui::frame_text(frame);
		let cursor = UiContext::default().charset.cursor().trim().to_owned();
		let row = text
			.lines()
			.find(|line| line.contains("Claude Opus 5") && line.contains("current"))
			.unwrap_or_else(|| panic!("the current model row is on screen:\n{text}"));
		assert!(row.contains(&cursor), "the cursor marker sits on the current row: {row:?}");
		assert!(text.contains("Claude Opus 5 · anthropic"), "facts describe the cursor row:\n{text}");
		assert_eq!(picker.key(Key::Enter), PickerEvent::Pick(250), "Enter keeps the current model");
	}

	/// Filtering by a model name ranks whole-word matches ahead of scattered
	/// subsequences, keeps the current model first among them, and moves the
	/// cursor and facts line to the best match.
	#[test]
	fn picker_filter_ranks_the_current_whole_word_match_first() {
		let rows = vec![
			row("abliteration", "llama-3"),
			row("openrouter", "Qwen Plus"),
			row("openrouter", "gpt-oss-120b"),
			row("zai", "glm-4-plus"),
			row("openrouter", "Claude Opus 5"),
			row("anthropic", "Claude Opus 5"),
			row("anthropic", "Claude Opus 4.6"),
		];
		let mut picker = picker(rows, 5, 0);
		for ch in "opus".chars() {
			assert_eq!(picker.key(Key::Char(ch)), PickerEvent::Consumed);
		}
		let text = omp_tui::frame_text(picker.frame(Size::new(100, 40)));
		assert!(!text.contains("Qwen Plus"), "o-p-u-s across words is not a match:\n{text}");
		assert!(!text.contains("gpt-oss"), "{text}");
		assert!(text.contains("3/7"), "three whole-word matches:\n{text}");
		assert!(text.contains("Claude Opus 5 · anthropic"), "facts follow the best match:\n{text}");
		assert_eq!(picker.key(Key::Enter), PickerEvent::Pick(5), "the current model ranks first");
	}

	/// What one presenter output did to the reference document: the frames
	/// it applied (chunked bodies joined as Tern joins them) and the largest
	/// body one APC string carried.
	struct Applied {
		frames:  Vec<omp_tui::tsp::wire::Frame>,
		chunked: usize,
		largest: usize,
	}

	fn apply(doc: &mut omp_tui::tsp::doc::Document, output: &[u8]) -> Applied {
		let mut applied = Applied { frames: Vec::new(), chunked: 0, largest: 0 };
		let mut joined = Vec::new();
		let mut rest = output;
		while let Some(start) = rest.windows(2).position(|w| w == b"\x1b_") {
			let after = &rest[start + 2..];
			let end = after
				.windows(2)
				.position(|w| w == b"\x1b\\")
				.expect("terminated message");
			let raw = omp_tui::tsp::frame::split(&after[..end]).expect("a TSP message");
			rest = &after[end + 2..];
			applied.largest = applied.largest.max(raw.body.len());
			joined.extend_from_slice(raw.body);
			if raw.param("m") == Some("1") {
				continue;
			}
			if raw.param("c").is_some() {
				applied.chunked += 1;
			}
			let body = std::mem::take(&mut joined);
			if raw.verb == "f" {
				let frame: omp_tui::tsp::wire::Frame =
					serde_json::from_slice(&body).expect("valid frame JSON");
				let rejected = doc.apply(&frame);
				assert!(rejected.is_empty(), "frame had rejected ops: {rejected:?}");
				applied.frames.push(frame);
			}
		}
		applied
	}

	/// A live session surface with the picker presented as its sheet.
	fn mounted(
		picker: &mut ModelPicker,
	) -> (crate::tsp::Surface, omp_tui::tsp::doc::Document, Applied) {
		let mut surface = crate::tsp::Surface::optimistic(false);
		let mut doc = omp_tui::tsp::doc::Document::new("omp-chat");
		let mut out = Vec::new();
		surface
			.present(
				&mut out,
				&[],
				"",
				0,
				"",
				std::time::Duration::ZERO,
				crate::settings::TspStreamPacing::Raw,
			)
			.expect("session frame");
		surface
			.present_sheet(&mut out, crate::tsp::Sheet::Picker, Some(picker.tsp_node()))
			.expect("picker frame");
		let applied = apply(&mut doc, &out);
		acknowledge(&mut surface, &applied);
		(surface, doc, applied)
	}

	/// Tern acknowledges every frame it applied, freeing the credits.
	fn acknowledge(surface: &mut crate::tsp::Surface, applied: &Applied) {
		if let Some(s) = applied.frames.iter().map(|frame| frame.s).max() {
			surface.incoming(omp_tui::tsp::frame::Incoming::Event(omp_tui::tsp::wire::Event::Ack {
				sf: Str::new_static("omp-chat"),
				s,
			}));
		}
	}

	fn sheet(doc: &omp_tui::tsp::doc::Document) -> PickerProps {
		let node = doc.get(MODEL_PICKER_ID).expect("the picker is mounted");
		omp_tui::tsp::picker::read(&node).expect("picker props")
	}

	fn preview(doc: &omp_tui::tsp::doc::Document) -> String {
		doc.get(MODEL_PREVIEW_FACTS_ID)
			.and_then(|node| {
				node
					.p
					.get("text")
					.and_then(|text| text.as_str())
					.map(str::to_owned)
			})
			.unwrap_or_default()
	}

	/// The native picker carries the catalogue as `items` keyed by catalog
	/// key, names the cursor row by that key and previews it; moving the
	/// cursor patches `selected` and the preview text in place and never
	/// resends the catalogue.
	#[test]
	fn the_native_picker_is_data_first_and_patches_only_what_moved() {
		let rows = catalog();
		let mut picker = picker(rows.clone(), 1, 0);
		let (mut surface, mut doc, _) = mounted(&mut picker);
		let props = sheet(&doc);
		let keys: Vec<&str> = rows.iter().map(|row| row.key.as_str()).collect();
		assert_eq!(
			props
				.items
				.iter()
				.map(|item| item.id.as_str())
				.collect::<Vec<_>>(),
			keys
		);
		assert_eq!(
			props
				.order
				.as_ref()
				.map(|order| order.iter().map(Str::as_str).collect::<Vec<_>>()),
			Some(keys.clone()),
			"every row is shown, in list order"
		);
		assert_eq!(props.selected.as_deref(), Some("gpt-5"), "the cursor opens on the current model");
		assert_eq!(props.current.iter().map(Str::as_str).collect::<Vec<_>>(), ["gpt-5"]);
		assert!(preview(&doc).starts_with("gpt-5"), "the children preview the cursor row");
		assert!(
			doc.get(MODEL_PICKER_ID)
				.is_some_and(|node| node.c.iter().all(|child| child.k != Kind::Item)),
			"rows are data, not item children"
		);

		assert_eq!(picker.key(Key::Down), PickerEvent::Consumed);
		let mut out = Vec::new();
		surface
			.present_sheet(&mut out, crate::tsp::Sheet::Picker, Some(picker.tsp_node()))
			.expect("patch frame");
		let applied = apply(&mut doc, &out);
		let [frame] = applied.frames.as_slice() else {
			panic!("one frame patches the picker: {:?}", applied.frames);
		};
		for op in &frame.ops {
			let omp_tui::tsp::wire::Op::Set { id, props } = op else {
				panic!("a cursor move only sets props: {op:?}");
			};
			assert!(!props.contains_key("items"), "the catalogue is not resent: {id} {props:?}");
		}
		assert_eq!(sheet(&doc).selected.as_deref(), Some("claude-haiku"));
		assert!(preview(&doc).starts_with("claude-haiku"), "the preview follows the cursor");
		acknowledge(&mut surface, &applied);

		let mut out = Vec::new();
		surface
			.present_sheet(&mut out, crate::tsp::Sheet::Picker, Some(picker.tsp_node()))
			.expect("no frame");
		assert!(out.is_empty(), "an unchanged picker sends nothing");
	}

	/// Typing filters the native picker through `query` and `order`, the rows
	/// the list shows, while `items` stays the whole catalogue.
	#[test]
	fn the_native_picker_follows_the_filter_through_order() {
		let mut picker = picker(catalog(), 0, 0);
		for ch in "claude".chars() {
			picker.key(Key::Char(ch));
		}
		let (_, doc, _) = mounted(&mut picker);
		let props = sheet(&doc);
		assert_eq!(props.query.as_deref(), Some("claude"));
		assert_eq!(props.items.len(), 4, "the catalogue stays whole");
		let order = props.order.expect("order");
		assert!(!order.iter().any(|id| id.as_str() == "gpt-5"), "{order:?}");
		assert_eq!(order.len(), 3, "{order:?}");
		assert!(props.selected.is_some_and(|id| order.contains(&id)));
	}

	/// A catalogue over the `apc` limit rides one frame chunked under the
	/// limit, and Tern's joined document holds every row.
	#[test]
	fn a_catalogue_over_the_apc_limit_is_chunked_and_arrives_whole() {
		let rows: Vec<ModelRow> = (0..2_000)
			.map(|index| ModelRow {
				key:         sf!("provider-{}/model-with-a-long-name-{index}", index % 17),
				name:        sf!("Model With A Long Display Name {index}"),
				provider_id: sf!("provider-{}", index % 17),
				provider:    sf!("Provider {}", index % 17),
				context:     Some(200_000),
				input_mtok:  Some(3.0),
				output_mtok: Some(15.0),
				efforts:     Vec::new(),
			})
			.collect();
		let mut picker = picker(rows, 0, 0);
		let (_, doc, applied) = mounted(&mut picker);
		assert!(applied.chunked > 0, "a catalogue this large is chunked");
		assert!(
			applied.largest <= omp_tui::tsp::DEFAULT_APC_LIMIT,
			"an APC string carried {} bytes",
			applied.largest
		);
		assert_eq!(sheet(&doc).items.len(), 2_000, "every row arrives");
	}

	/// Tern's pointer gestures do what the list's keys do: `select` moves the
	/// cursor and picks nothing, `activate` and `confirm` pick (for task
	/// subagents in task mode), `close` closes, and a row the list does not
	/// show is ignored.
	#[test]
	fn native_gestures_preview_on_select_and_pick_on_activate_or_confirm() {
		let mut picker = picker(catalog(), 0, 0);
		let select = |id: &str| Gesture::Select(Str::new(id));
		let activate = |id: &str| Gesture::Activate(Str::new(id));
		assert_eq!(picker.tsp_gesture(select("claude-haiku")), PickerEvent::Consumed);
		assert_eq!(picker.highlighted, Some(2), "select moves the cursor");
		assert_eq!(picker.key(Key::Enter), PickerEvent::Pick(2), "the keys agree with the move");
		assert_eq!(picker.tsp_gesture(select("claude-haiku")), PickerEvent::Consumed);
		assert_eq!(picker.tsp_gesture(Gesture::Act(PickerAct::Confirm)), PickerEvent::Pick(2));
		assert_eq!(picker.tsp_gesture(activate("gpt-5")), PickerEvent::Pick(1));
		assert_eq!(picker.tsp_gesture(activate("no/such-model")), PickerEvent::Consumed);
		assert_eq!(picker.tsp_gesture(Gesture::Act(PickerAct::Close)), PickerEvent::Close);

		for ch in "gpt".chars() {
			picker.key(Key::Char(ch));
		}
		assert_eq!(
			picker.tsp_gesture(activate("claude-haiku")),
			PickerEvent::Consumed,
			"a row the filter hides is not picked"
		);

		let mut task = picker_over(catalog());
		assert_eq!(task.key(Key::Alt('p')), PickerEvent::Consumed);
		assert_eq!(task.tsp_gesture(activate("gpt-5")), PickerEvent::PickTask(1));
	}
}
