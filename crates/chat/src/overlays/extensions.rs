//! `/extensions` (`/status`) is a full-screen [`Panel`] with provider tabs
//! on top, a searchable inventory list on the left, the inspector on the
//! right, and a footer at
//! the bottom. Rows come from [`Services::extensions`]; Space asks the
//! controller to flip the persisted switch (`HostCommand::Service` with
//! [`Mutation::SetExtensionEnabled`]) and the row changes only once the
//! outcome comes back through [`Panel::notify`] (ADR 0005).

use std::{sync::Arc, time::Duration};

use omp_core::{Str, sf};
use omp_tui::{
	Component, Frame, IntoComponent as _, Key, MouseReport, Prop, Size, Ui, UiContext, UiEvent,
	cell_width, components::Tabs, dom,
};

use super::{
	Outcome, Panel, PanelAction, PanelAnchor, PanelEvent, PanelNote,
	services::{ExtensionKind, ExtensionRow, ExtensionStatus, Mutation, ServiceOutcome, Services},
};
use crate::host::HostCommand;

/// Footer key hints.
const FOOTER: &str = " ↑/↓: navigate · Space: toggle · ←/→: provider · PgUp/PgDn: inspector · \
                      ctrl+o: expand · Esc: close";
/// Hint for expanding folded inspector content.
const EXPAND_HINT: &str = "ctrl+o";
/// Border rows, tab bar and its rule, list search row and its blank, the
/// divider, and the footer.
const CHROME_ROWS: u16 = 8;
/// Items shown before the inspector folds a list.
const COLLAPSED_ITEMS: usize = 8;
/// Description lines shown before the inspector folds it.
const COLLAPSED_DESC_LINES: usize = 3;
const TABS_ID: &str = "extension-tabs";
/// Poll cadence while a server is still connecting.
const CONNECTING_POLL: Duration = Duration::from_secs(1);
/// Tab order restricted to the kinds this host feeds.
const KIND_ORDER: [ExtensionKind; 4] =
	[ExtensionKind::Mcp, ExtensionKind::Builtin, ExtensionKind::Python, ExtensionKind::Plugin];

/// One flattened inventory row.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Item {
	/// Kind group header (ALL view only).
	Header(ExtensionKind, usize),
	/// Index into the dashboard's rows.
	Extension(usize),
}

/// Retained Extension Control Center.
pub struct ExtensionsDashboard {
	services:  Arc<dyn Services>,
	rows:      Vec<ExtensionRow>,
	/// `None` is the ALL tab.
	tabs:      Vec<Option<ExtensionKind>>,
	tab:       usize,
	query:     String,
	items:     Vec<Item>,
	selected:  usize,
	scroll:    usize,
	expanded:  bool,
	list_rows: usize,
	ui:        Ui,
	ctx:       UiContext,
	width:     u16,
	height:    u16,
	next_wake: Option<Duration>,
}

impl ExtensionsDashboard {
	/// Opens the dashboard over the current extension roster.
	pub fn open(services: &Arc<dyn Services>, ctx: &UiContext) -> Result<Self, Str> {
		let rows = services.extensions().map_err(|error| sf!("{error}"))?;
		let mut panel = Self {
			services:  Arc::clone(services),
			rows:      Vec::new(),
			tabs:      Vec::new(),
			tab:       0,
			query:     String::new(),
			items:     Vec::new(),
			selected:  0,
			scroll:    0,
			expanded:  false,
			list_rows: 10,
			ui:        Ui::from_root(dom! { <col/> }, 80, ctx.clone()),
			ctx:       ctx.clone(),
			width:     80,
			height:    24,
			next_wake: None,
		};
		panel.replace_rows(rows);
		panel.rebuild();
		Ok(panel)
	}

	/// Active provider tab label.
	#[must_use]
	pub fn tab(&self) -> &'static str {
		self.tabs[self.tab].map_or("all", ExtensionKind::label)
	}

	/// Row under the cursor, when the cursor rests on an extension.
	#[must_use]
	pub fn selected(&self) -> Option<&ExtensionRow> {
		match self.items.get(self.selected)? {
			Item::Extension(index) => self.rows.get(*index),
			Item::Header(..) => None,
		}
	}

	fn replace_rows(&mut self, rows: Vec<ExtensionRow>) {
		let current = self.tabs.get(self.tab).copied().flatten();
		self.rows = rows;
		self.tabs = std::iter::once(None)
			.chain(
				KIND_ORDER
					.into_iter()
					.filter(|kind| self.rows.iter().any(|row| row.kind == *kind))
					.map(Some),
			)
			.collect();
		self.tab = self
			.tabs
			.iter()
			.position(|tab| *tab == current)
			.unwrap_or(0);
		self.next_wake = self
			.rows
			.iter()
			.any(|row| row.status == ExtensionStatus::Connecting)
			.then_some(Duration::ZERO);
		self.reflow_items(true);
	}

	/// Rebuilds the flattened list for the active tab and query. `keep`
	/// leaves the cursor on the same extension when it survives (a data
	/// refresh); tab and query changes reset it to the first row.
	fn reflow_items(&mut self, keep: bool) {
		let keep = keep
			.then(|| self.selected().map(|row| row.id.clone()))
			.flatten();
		let kind = self.tabs.get(self.tab).copied().flatten();
		let query = self.query.to_lowercase();
		let matches = |row: &ExtensionRow| {
			kind.is_none_or(|kind| row.kind == kind)
				&& (query.is_empty()
					|| row.name.to_lowercase().contains(&query)
					|| row.id.to_lowercase().contains(&query))
		};
		self.items.clear();
		if kind.is_some() || !query.is_empty() {
			self.items.extend(
				self
					.rows
					.iter()
					.enumerate()
					.filter(|(_, row)| matches(row))
					.map(|(index, _)| Item::Extension(index)),
			);
		} else {
			for kind in KIND_ORDER {
				let members: Vec<usize> = self
					.rows
					.iter()
					.enumerate()
					.filter(|(_, row)| row.kind == kind)
					.map(|(index, _)| index)
					.collect();
				if members.is_empty() {
					continue;
				}
				self.items.push(Item::Header(kind, members.len()));
				self.items.extend(members.into_iter().map(Item::Extension));
			}
		}
		self.selected = keep
			.and_then(|id| {
				self.items.iter().position(
					|item| matches!(item, Item::Extension(index) if self.rows[*index].id == id),
				)
			})
			.unwrap_or(0);
		if self.selected == 0 {
			self.scroll = 0;
		}
		self.clamp_scroll();
	}

	fn clamp_scroll(&mut self) {
		let last = self.items.len().saturating_sub(1);
		self.selected = self.selected.min(last);
		if self.selected < self.scroll {
			self.scroll = self.selected;
		} else if self.selected >= self.scroll + self.list_rows {
			self.scroll = self.selected + 1 - self.list_rows;
		}
		self.scroll = self
			.scroll
			.min(self.items.len().saturating_sub(self.list_rows));
	}

	fn move_selection(&mut self, delta: isize) -> bool {
		if self.items.is_empty() {
			return false;
		}
		let next = self
			.selected
			.saturating_add_signed(delta)
			.min(self.items.len() - 1);
		if next == self.selected {
			return false;
		}
		self.selected = next;
		self.clamp_scroll();
		true
	}

	fn switch_tab(&mut self, delta: isize) {
		let len = self.tabs.len() as isize;
		self.tab = ((self.tab as isize + delta).rem_euclid(len)) as usize;
		self.reflow_items(false);
		self.rebuild();
	}

	/// Asks the controller to flip the persisted
	/// switch behind the row; the row itself changes in [`Self::settle`].
	fn toggle_selected(&mut self) -> PanelEvent {
		let Some(row) = self.selected() else {
			return PanelEvent::Consumed;
		};
		PanelEvent::Command(HostCommand::Service(Mutation::SetExtensionEnabled {
			id:      row.id.clone(),
			enabled: !row.enabled,
		}))
	}

	/// Applies a settled extension toggle: the row flips to the state the
	/// controller confirmed and the outcome's line becomes the notice.
	fn settle(&mut self, outcome: &ServiceOutcome) -> PanelEvent {
		let Mutation::SetExtensionEnabled { id, enabled } = &outcome.mutation else {
			return PanelEvent::Ignored;
		};
		let line = match &outcome.result {
			Ok(line) => line.clone(),
			Err(error) => return PanelEvent::Notice(sf!("{error}")),
		};
		self.refresh();
		if let Some(row) = self
			.rows
			.iter_mut()
			.find(|row| row.id == *id && row.enabled != *enabled)
		{
			row.enabled = *enabled;
			row.status = if *enabled {
				ExtensionStatus::Connecting
			} else {
				ExtensionStatus::Disabled
			};
			self.next_wake = Some(Duration::ZERO);
		}
		self.rebuild();
		PanelEvent::Notice(line)
	}

	/// Re-reads the roster; a failed read keeps the rows on screen.
	fn refresh(&mut self) -> bool {
		match self.services.extensions() {
			Ok(rows) if rows != self.rows => {
				self.replace_rows(rows);
				true
			},
			_ => false,
		}
	}

	fn rebuild(&mut self) {
		let inner = self.width.saturating_sub(4).max(1);
		let left = inner / 2;
		let right = inner.saturating_sub(left + 3).max(1);
		let content_rows = self.height.saturating_sub(CHROME_ROWS).max(5);
		let list_rows = usize::from(content_rows.saturating_sub(2).max(3));
		if list_rows != self.list_rows {
			self.list_rows = list_rows;
			self.clamp_scroll();
		}
		let name_width = usize::from(left.saturating_sub(16).clamp(8, 24));
		let query = Str::new(self.query.as_str());
		let list = self
			.items
			.iter()
			.enumerate()
			.skip(self.scroll)
			.take(self.list_rows)
			.map(|(index, item)| self.list_row(*item, index == self.selected, name_width))
			.collect::<Vec<_>>();
		let empty = self.items.is_empty();
		let inspector = self.inspector(right);
		let body = dom! {
			<row gap=1>
				<col w={left}>
					<row gap=1><text fg=muted>{"Search:"}</text><row><text>{query}</text><text fg=accent>{"_"}</text></row></row>
					<text>{" "}</text>
					if empty {
						<text fg=muted truncate>{"  No extensions found for this provider."}</text>
					}
					for row in list { {row} }
				</col>
				<hr vertical border=round fg=muted/>
				<scroll id="inspector" h={content_rows} focus>
					<col w={right}>
						for line in inspector { {line} }
					</col>
				</scroll>
			</row>
		};
		// The tab set is the chip bar only; the two-column
		// body is a sibling so its height never depends on pane selection.
		let mut tabs = Tabs::new().with_str(Prop::Id, TABS_ID);
		for tab in &self.tabs {
			let count = self
				.rows
				.iter()
				.filter(|row| tab.is_none_or(|kind| row.kind == kind))
				.count();
			let label = tab.map_or("all", ExtensionKind::label);
			let title = if count > 0 && tab.is_some() {
				sf!("{label} ({count})")
			} else {
				Str::new_static(label)
			};
			let icon = tab.map_or("", tab_icon);
			tabs = tabs.pane_icon(icon, title, dom! { <col/> });
		}
		let tabs = tabs.select(self.tab as u16);
		let tree = dom! {
			<box border=round title="Extension Control Center">
				<col>
					{tabs}
					{body}
					<hr border=round/>
					<text fg=muted truncate>{FOOTER}</text>
				</col>
			</box>
		};
		self.ui = Ui::from_root(tree, self.width, self.ctx.clone());
	}

	fn list_row(&self, item: Item, selected: bool, name_width: usize) -> Box<dyn Component> {
		match item {
			Item::Header(kind, count) => {
				let icon = tab_icon(kind);
				let label = kind_heading(kind);
				let badge = sf!("({count})");
				let header = if selected {
					dom! {
						<row gap=1 bg=surface>
							<icon name={icon} fg=accent/>
							<text bold fg=accent>{label}</text>
							<text fg=accent>{badge}</text>
						</row>
					}
				} else {
					dom! {
						<row gap=1>
							<icon name={icon} fg=muted/>
							<text fg=muted>{label}</text>
							<text fg=muted>{badge}</text>
						</row>
					}
				};
				header.into_component()
			},
			Item::Extension(index) => {
				let row = &self.rows[index];
				let (icon, icon_fg) = state_icon(row);
				let name = pad_name(&row.name, name_width);
				let hint = list_hint(row);
				let hint_fg = if row.enabled && row.status == ExtensionStatus::Disabled {
					"warn"
				} else {
					"muted"
				};
				let line = if selected {
					dom! {
						<row gap=1 bg=surface>
							<text>{"  "}</text>
							<icon name={icon} fg={icon_fg}/>
							<pre bold fg=accent>{name}</pre>
							<text fg={hint_fg} truncate>{hint}</text>
						</row>
					}
				} else if row.enabled {
					dom! {
						<row gap=1>
							<text>{"  "}</text>
							<icon name={icon} fg={icon_fg}/>
							<pre>{name}</pre>
							<text fg={hint_fg} truncate>{hint}</text>
						</row>
					}
				} else {
					dom! {
						<row gap=1>
							<text>{"  "}</text>
							<icon name={icon} fg={icon_fg}/>
							<pre fg=muted>{name}</pre>
							<text fg={hint_fg} truncate>{hint}</text>
						</row>
					}
				};
				line.into_component()
			},
		}
	}

	/// Renders the inspector for the selected row.
	fn inspector(&self, width: u16) -> Vec<Box<dyn Component>> {
		let Some(row) = self.selected() else {
			return vec![
				dom! { <text fg=muted>{"Select an extension"}</text> }.into_component(),
				dom! { <text fg=muted>{"to view details"}</text> }.into_component(),
			];
		};
		let expanded = self.expanded;
		let mut lines: Vec<Box<dyn Component>> = Vec::with_capacity(24);
		let name = row.name.clone();
		lines.push(dom! { <text bold fg=accent truncate>{name}</text> }.into_component());
		lines.push(dom! { <text>{" "}</text> }.into_component());
		let (icon, icon_fg) = state_icon(row);
		let label = Str::new_static(status_label(row));
		let version = row.version.clone().unwrap_or_default();
		lines.push(
			dom! {
				<row gap=1>
					<icon name={icon} fg={icon_fg}/>
					<text fg={icon_fg}>{label}</text>
					<text fg=muted truncate>{version}</text>
				</row>
			}
			.into_component(),
		);
		lines.push(dom! { <text>{" "}</text> }.into_component());
		if let Some(description) = row.description.as_deref().filter(|text| !text.is_empty()) {
			let budget = usize::from(width.max(8)) * COLLAPSED_DESC_LINES;
			let (shown, folded) = if expanded || description.chars().count() <= budget {
				(Str::new(description), false)
			} else {
				let cut = description
					.char_indices()
					.nth(budget)
					.map_or(description.len(), |(at, _)| at);
				(Str::new(description[..cut].trim_end()), true)
			};
			lines.push(dom! { <text wrap=word>{shown}</text> }.into_component());
			if folded {
				let more = sf!("  … more ({EXPAND_HINT} to expand)");
				lines.push(dom! { <text fg=muted>{more}</text> }.into_component());
			}
			lines.push(dom! { <text>{" "}</text> }.into_component());
		}
		let origin = sf!("  via {}", kind_origin(row.kind));
		lines.push(dom! { <text fg=muted>{"Origin:"}</text> }.into_component());
		lines.push(dom! { <text italic truncate>{origin}</text> }.into_component());
		lines.push(dom! { <text>{" "}</text> }.into_component());
		for (heading, entries) in
			[("Tools", &row.tools), ("Resources", &row.resources), ("Prompts", &row.prompts)]
		{
			if entries.is_empty() {
				continue;
			}
			lines.push(dom! { <text fg=muted>{heading}</text> }.into_component());
			lines.push(dom! { <hr border=round fg=muted/> }.into_component());
			let shown = if expanded {
				entries.len()
			} else {
				entries.len().min(COLLAPSED_ITEMS)
			};
			for entry in &entries[..shown] {
				let entry = sf!("  {entry}");
				lines.push(dom! { <text fg=accent truncate>{entry}</text> }.into_component());
			}
			if shown < entries.len() {
				let more = sf!("  … {} more ({EXPAND_HINT} to expand)", entries.len() - shown);
				lines.push(dom! { <text fg=muted>{more}</text> }.into_component());
			}
			lines.push(dom! { <text>{" "}</text> }.into_component());
		}
		if let Some(error) = row.error.clone() {
			lines.push(dom! { <text fg=err wrap=word>{error}</text> }.into_component());
		}
		lines
	}
}

impl Panel for ExtensionsDashboard {
	fn id(&self) -> &'static str {
		"extensions"
	}

	fn anchor(&self) -> PanelAnchor {
		PanelAnchor::Full
	}

	fn action(&mut self, action: PanelAction) -> PanelEvent {
		match action {
			PanelAction::Expand => {
				self.expanded = !self.expanded;
				self.rebuild();
				PanelEvent::Consumed
			},
			_ => PanelEvent::Ignored,
		}
	}

	fn key(&mut self, key: Key) -> PanelEvent {
		match key {
			Key::Esc => {
				if self.query.is_empty() {
					return PanelEvent::Close;
				}
				self.query.clear();
				self.reflow_items(false);
				self.rebuild();
				PanelEvent::Consumed
			},
			Key::PageUp | Key::PageDown => match self.ui.handle_key(key) {
				UiEvent::Cancel => PanelEvent::Close,
				_ => PanelEvent::Consumed,
			},
			Key::Tab | Key::Right => {
				self.switch_tab(1);
				PanelEvent::Consumed
			},
			Key::BackTab | Key::Left => {
				self.switch_tab(-1);
				PanelEvent::Consumed
			},
			Key::Up | Key::Char('k') => {
				if self.move_selection(-1) {
					self.expanded = false;
					self.rebuild();
				}
				PanelEvent::Consumed
			},
			Key::Down | Key::Char('j') => {
				if self.move_selection(1) {
					self.expanded = false;
					self.rebuild();
				}
				PanelEvent::Consumed
			},
			Key::Space | Key::Enter => self.toggle_selected(),
			Key::Backspace => {
				if self.query.pop().is_some() {
					self.reflow_items(false);
					self.rebuild();
				}
				PanelEvent::Consumed
			},
			Key::Char(character) if !character.is_control() => {
				self.query.push(character);
				self.reflow_items(false);
				self.rebuild();
				PanelEvent::Consumed
			},
			_ => PanelEvent::Consumed,
		}
	}

	fn mouse(&mut self, report: MouseReport) -> PanelEvent {
		let event = self
			.ui
			.handle_mouse_with_mods(report.col, report.row, report.kind, report.mods);
		if event == UiEvent::Cancel {
			return PanelEvent::Close;
		}
		let selected = self
			.ui
			.values()
			.get(TABS_ID)
			.and_then(serde_json::Value::as_str)
			.map(str::to_owned);
		if let Some(selected) = selected {
			let label = selected
				.split_once(" (")
				.map_or(selected.as_str(), |(label, _)| label);
			if let Some(tab) = self
				.tabs
				.iter()
				.position(|tab| tab.map_or("all", ExtensionKind::label) == label)
				&& tab != self.tab
			{
				self.tab = tab;
				self.reflow_items(false);
				self.rebuild();
			}
		}
		PanelEvent::Consumed
	}

	fn notify(&mut self, note: PanelNote<'_>) -> PanelEvent {
		match note {
			PanelNote::Outcome(Outcome::Service(outcome)) => self.settle(outcome),
			PanelNote::Outcome(_)
			| PanelNote::Dom(_)
			| PanelNote::Live(..)
			| PanelNote::SettingResult { .. } => PanelEvent::Ignored,
		}
	}

	fn frame(&mut self, viewport: Size) -> &Frame {
		if viewport.width != self.width || viewport.height != self.height {
			self.width = viewport.width;
			self.height = viewport.height;
			self.rebuild();
		}
		self.ui.frame()
	}

	fn tick(&mut self, now: Duration) -> bool {
		let Some(due) = self.next_wake else {
			return false;
		};
		if now < due {
			return false;
		}
		let changed = self.refresh();
		if self.next_wake.is_some() {
			self.next_wake = Some(now + CONNECTING_POLL);
		}
		if changed {
			self.rebuild();
		}
		changed
	}

	fn next_wake(&self) -> Option<Duration> {
		self.next_wake
	}
}

/// Returns an `icons.tsv` name and its theme token.
fn state_icon(row: &ExtensionRow) -> (&'static str, &'static str) {
	if !row.enabled {
		return ("disabled", "muted");
	}
	match row.status {
		ExtensionStatus::Ready => ("enabled", "ok"),
		ExtensionStatus::Connecting => ("running", "muted"),
		ExtensionStatus::Disconnected => ("shadowed", "muted"),
		ExtensionStatus::Failed => ("error", "err"),
		ExtensionStatus::Disabled => ("disabled", "warn"),
	}
}

/// Returns the row's status label.
fn status_label(row: &ExtensionRow) -> &'static str {
	if !row.enabled {
		return "Disabled (manually disabled)";
	}
	match (row.kind, row.status) {
		(ExtensionKind::Mcp, ExtensionStatus::Ready) => "Connected",
		(ExtensionKind::Mcp, ExtensionStatus::Connecting) => "Connecting",
		(ExtensionKind::Mcp, ExtensionStatus::Disconnected) => "Not connected",
		(ExtensionKind::Mcp, ExtensionStatus::Failed) => "Connection failed",
		(_, ExtensionStatus::Ready) => "Active",
		(_, ExtensionStatus::Connecting) => "Loading",
		(_, ExtensionStatus::Disconnected) => "Not loaded",
		(_, ExtensionStatus::Failed) => "Failed",
		(_, ExtensionStatus::Disabled) => "Inactive",
	}
}

/// Returns the row's compact list hint.
fn list_hint(row: &ExtensionRow) -> Str {
	if !row.enabled || row.status == ExtensionStatus::Disabled {
		return Str::new_static("inactive");
	}
	match row.status {
		ExtensionStatus::Connecting => Str::new_static("connecting…"),
		ExtensionStatus::Disconnected | ExtensionStatus::Failed => Str::new_static("unavailable"),
		ExtensionStatus::Ready | ExtensionStatus::Disabled => {
			let mut parts: Vec<Str> = Vec::with_capacity(3);
			if !row.tools.is_empty() || row.kind == ExtensionKind::Mcp {
				parts.push(plural(row.tools.len(), "tool"));
			}
			if !row.resources.is_empty() {
				parts.push(plural(row.resources.len(), "resource"));
			}
			if !row.prompts.is_empty() {
				parts.push(plural(row.prompts.len(), "prompt"));
			}
			if parts.is_empty() {
				return row.version.clone().unwrap_or_default();
			}
			Str::new(
				parts
					.iter()
					.map(Str::as_str)
					.collect::<Vec<_>>()
					.join(" · "),
			)
		},
	}
}

fn plural(count: usize, noun: &str) -> Str {
	if count == 1 {
		sf!("1 {noun}")
	} else {
		sf!("{count} {noun}s")
	}
}

/// Pads or truncates a name to `width` cells.
fn pad_name(name: &str, width: usize) -> Str {
	let cells = usize::from(cell_width(name));
	if cells >= width {
		let mut text = String::with_capacity(width);
		let mut used = 0usize;
		for character in name.chars() {
			let next = usize::from(cell_width(character.encode_utf8(&mut [0; 4])));
			if used + next > width {
				break;
			}
			used += next;
			text.push(character);
		}
		text.extend(std::iter::repeat_n(' ', width - used));
		return Str::new(text);
	}
	let mut text = String::with_capacity(width);
	text.push_str(name);
	text.extend(std::iter::repeat_n(' ', width - cells));
	Str::new(text)
}

const fn tab_icon(kind: ExtensionKind) -> &'static str {
	match kind {
		ExtensionKind::Mcp => "mcp",
		ExtensionKind::Builtin => "package",
		ExtensionKind::Python => "python",
		ExtensionKind::Plugin => "puzzle",
	}
}

/// Heading for an extension kind.
const fn kind_heading(kind: ExtensionKind) -> &'static str {
	match kind {
		ExtensionKind::Mcp => "MCP Servers",
		ExtensionKind::Builtin => "Built-in Extensions",
		ExtensionKind::Python => "Python Extensions",
		ExtensionKind::Plugin => "Marketplace Plugins",
	}
}

/// Provider-origin label for an extension kind.
const fn kind_origin(kind: ExtensionKind) -> &'static str {
	match kind {
		ExtensionKind::Mcp => "mcp.json (MCP server)",
		ExtensionKind::Builtin => "omp (built-in)",
		ExtensionKind::Python => "omp ext (Python extension)",
		ExtensionKind::Plugin => "marketplace (plugin)",
	}
}

#[cfg(test)]
mod tests {
	use omp_tui::{Mods, Mouse, MouseButton};
	use parking_lot::Mutex;

	use super::*;
	use crate::overlays::services::ServiceResult;

	#[derive(Default)]
	struct Feed {
		rows: Mutex<Vec<ExtensionRow>>,
	}

	impl Services for Feed {
		fn extensions(&self) -> ServiceResult<Vec<ExtensionRow>> {
			Ok(self.rows.lock().clone())
		}
	}

	/// What the controller would do with the mutation: persist the flip so
	/// the next `extensions()` read reflects it, then settle the outcome.
	fn settle(feed: &Feed, mutation: &Mutation) -> Outcome {
		if let Mutation::SetExtensionEnabled { id, enabled } = mutation {
			let mut rows = feed.rows.lock();
			if let Some(row) = rows.iter_mut().find(|row| row.id == *id) {
				row.enabled = *enabled;
				row.status = if *enabled {
					ExtensionStatus::Ready
				} else {
					ExtensionStatus::Disabled
				};
			}
		}
		Outcome::Service(ServiceOutcome {
			mutation: mutation.clone(),
			result:   Ok(sf!("Extension {}", mutation.verb())),
		})
	}

	fn point(text: &str, needle: &str) -> (u16, u16) {
		text
			.lines()
			.enumerate()
			.find_map(|(row, line)| {
				let byte = line.find(needle)?;
				Some((cell_width(&line[..byte]), u16::try_from(row).ok()?))
			})
			.expect("text point")
	}

	fn click(col: u16, row: u16) -> MouseReport {
		MouseReport {
			kind: Mouse::Click,
			col,
			row,
			button: MouseButton::Left,
			mods: Mods::default(),
			pressed: true,
		}
	}

	fn row(id: &str, kind: ExtensionKind, status: ExtensionStatus) -> ExtensionRow {
		ExtensionRow {
			id: Str::new(id),
			name: Str::new(id.split_once(':').map_or(id, |(_, name)| name)),
			kind,
			status,
			enabled: status != ExtensionStatus::Disabled,
			version: Some(Str::new_static("1.2.0")),
			description: Some(Str::new_static("Reads GitHub issues and pull requests.")),
			tools: vec![Str::new_static("issue_read"), Str::new_static("pr_list")],
			resources: Vec::new(),
			prompts: Vec::new(),
			error: None,
		}
	}

	fn feed() -> Arc<Feed> {
		Arc::new(Feed {
			rows: Mutex::new(vec![
				row("mcp:github", ExtensionKind::Mcp, ExtensionStatus::Ready),
				row("mcp:linear", ExtensionKind::Mcp, ExtensionStatus::Connecting),
				row("ext:acme.hello", ExtensionKind::Python, ExtensionStatus::Ready),
			]),
		})
	}

	fn open(feed: &Arc<Feed>) -> ExtensionsDashboard {
		let services: Arc<dyn Services> = Arc::clone(feed) as Arc<dyn Services>;
		ExtensionsDashboard::open(&services, &UiContext::default()).expect("dashboard opens")
	}

	#[test]
	fn dashboard_renders_tabs_rows_inspector_and_footer() {
		let feed = feed();
		let mut panel = open(&feed);
		let text = omp_tui::frame_text(panel.frame(Size { width: 120, height: 24 }));
		assert!(text.contains("Extension Control Center"), "title missing:\n{text}");
		assert!(text.contains("all"), "all tab missing:\n{text}");
		assert!(text.contains("mcp (2)"), "mcp tab missing:\n{text}");
		assert!(text.contains("python (1)"), "python tab missing:\n{text}");
		assert!(text.contains("MCP Servers (2)"), "kind header missing:\n{text}");
		assert!(text.contains("github"), "row missing:\n{text}");
		assert!(text.contains("2 tools"), "list hint missing:\n{text}");
		assert!(text.contains("connecting…"), "connecting hint missing:\n{text}");
		assert!(text.contains("Search:"), "search row missing:\n{text}");
		assert!(text.contains("Space: toggle"), "footer missing:\n{text}");
		assert!(text.contains("Esc: close"), "footer missing:\n{text}");
		assert!(text.contains("Select an extension"), "header row selects nothing:\n{text}");
		assert_eq!(panel.key(Key::Down), PanelEvent::Consumed);
		let text = omp_tui::frame_text(panel.frame(Size { width: 120, height: 24 }));
		assert!(text.contains("Connected"), "inspector status missing:\n{text}");
		assert!(text.contains("issue_read"), "inspector tools missing:\n{text}");
		assert!(text.contains("Origin:"), "origin missing:\n{text}");
	}

	#[test]
	fn clicking_a_provider_tab_updates_the_dashboard_projection() {
		let feed = feed();
		let mut panel = open(&feed);
		let size = Size { width: 120, height: 24 };
		let painted = omp_tui::frame_text(panel.frame(size));
		let (col, row) = point(&painted, "mcp (2)");
		assert_eq!(panel.mouse(click(col, row)), PanelEvent::Consumed);
		assert_eq!(panel.tab(), "mcp");
		assert_eq!(panel.selected().map(|row| row.id.as_str()), Some("mcp:github"));
	}

	#[test]
	fn right_switches_provider_tab_and_flattens_the_list() {
		let feed = feed();
		let mut panel = open(&feed);
		panel.frame(Size { width: 120, height: 24 });
		assert_eq!(panel.tab(), "all");
		assert_eq!(panel.key(Key::Right), PanelEvent::Consumed);
		assert_eq!(panel.tab(), "mcp");
		assert_eq!(panel.selected().map(|row| row.id.as_str()), Some("mcp:github"));
		let text = omp_tui::frame_text(panel.frame(Size { width: 120, height: 24 }));
		assert!(!text.contains("MCP Servers (2)"), "provider view is flat:\n{text}");
		assert!(!text.contains("acme.hello"), "other kinds hidden:\n{text}");
		assert_eq!(panel.key(Key::Right), PanelEvent::Consumed);
		assert_eq!(panel.tab(), "python");
		assert_eq!(panel.key(Key::Right), PanelEvent::Consumed);
		assert_eq!(panel.tab(), "all", "tabs wrap");
		assert_eq!(panel.key(Key::Left), PanelEvent::Consumed);
		assert_eq!(panel.tab(), "python");
	}

	#[test]
	fn space_asks_the_controller_and_flips_the_row_on_the_outcome() {
		let feed = feed();
		let mut panel = open(&feed);
		panel.frame(Size { width: 120, height: 24 });
		panel.key(Key::Right);
		let expected =
			Mutation::SetExtensionEnabled { id: Str::new_static("mcp:github"), enabled: false };
		assert_eq!(
			panel.key(Key::Space),
			PanelEvent::Command(HostCommand::Service(expected.clone())),
			"Space travels to the controller as a typed command"
		);
		assert_eq!(
			panel.selected().map(|row| row.enabled),
			Some(true),
			"the row waits for the controller's outcome"
		);
		let text = omp_tui::frame_text(panel.frame(Size { width: 120, height: 24 }));
		assert!(!text.contains("inactive"), "row flipped before the outcome:\n{text}");
		let outcome = settle(&feed, &expected);
		assert_eq!(
			panel.notify(PanelNote::Outcome(&outcome)),
			PanelEvent::Notice(Str::new_static("Extension disabled"))
		);
		assert_eq!(panel.selected().map(|row| row.enabled), Some(false));
		let text = omp_tui::frame_text(panel.frame(Size { width: 120, height: 24 }));
		assert!(text.contains("inactive"), "disabled hint missing:\n{text}");
		assert!(text.contains("Disabled (manually disabled)"), "badge missing:\n{text}");
		let expected =
			Mutation::SetExtensionEnabled { id: Str::new_static("mcp:github"), enabled: true };
		assert_eq!(
			panel.key(Key::Enter),
			PanelEvent::Command(HostCommand::Service(expected.clone()))
		);
		let outcome = settle(&feed, &expected);
		assert_eq!(
			panel.notify(PanelNote::Outcome(&outcome)),
			PanelEvent::Notice(Str::new_static("Extension enabled"))
		);
		assert_eq!(panel.selected().map(|row| row.enabled), Some(true));
	}

	#[test]
	fn foreign_outcomes_are_ignored_and_failures_surface_as_notices() {
		let feed = feed();
		let mut panel = open(&feed);
		panel.key(Key::Right);
		let foreign = Outcome::Service(ServiceOutcome {
			mutation: Mutation::ReloadExtensions,
			result:   Ok(Str::new_static("Reloaded")),
		});
		assert_eq!(panel.notify(PanelNote::Outcome(&foreign)), PanelEvent::Ignored);
		let failed = Outcome::Service(ServiceOutcome {
			mutation: Mutation::SetExtensionEnabled {
				id:      Str::new_static("mcp:github"),
				enabled: false,
			},
			result:   Err(crate::overlays::services::ServiceError::Unavailable("extensions")),
		});
		assert!(matches!(
			panel.notify(PanelNote::Outcome(&failed)),
			PanelEvent::Notice(text) if text.contains("unavailable")
		));
		assert_eq!(
			panel.selected().map(|row| row.enabled),
			Some(true),
			"a failed toggle leaves the row"
		);
	}

	#[test]
	fn search_filters_and_escape_clears_before_closing() {
		let feed = feed();
		let mut panel = open(&feed);
		panel.frame(Size { width: 120, height: 24 });
		for character in "lin".chars() {
			assert_eq!(panel.key(Key::Char(character)), PanelEvent::Consumed);
		}
		assert_eq!(panel.selected().map(|row| row.id.as_str()), Some("mcp:linear"));
		let text = omp_tui::frame_text(panel.frame(Size { width: 120, height: 24 }));
		assert!(text.contains("Search: lin_"), "query missing:\n{text}");
		assert!(!text.contains("github"), "filtered rows hidden:\n{text}");
		assert_eq!(panel.key(Key::Esc), PanelEvent::Consumed, "first Esc clears the query");
		assert!(panel.selected().is_none(), "cleared search returns to the grouped view");
		assert_eq!(panel.key(Key::Esc), PanelEvent::Close);
	}

	#[test]
	fn expand_action_unfolds_the_inspector() {
		let feed = feed();
		feed.rows.lock()[0].tools = (0..12).map(|index| sf!("tool_{index}")).collect();
		let mut panel = open(&feed);
		panel.frame(Size { width: 100, height: 40 });
		panel.key(Key::Down);
		let text = omp_tui::frame_text(panel.frame(Size { width: 100, height: 40 }));
		assert!(text.contains("… 4 more (ctrl+o to expand)"), "fold hint missing:\n{text}");
		assert_eq!(panel.action(PanelAction::Expand), PanelEvent::Consumed);
		let text = omp_tui::frame_text(panel.frame(Size { width: 100, height: 40 }));
		assert!(text.contains("tool_11"), "expanded list missing:\n{text}");
		assert_eq!(panel.action(PanelAction::Rename), PanelEvent::Ignored);
	}

	#[test]
	fn connecting_rows_poll_the_feed_until_settled() {
		let feed = feed();
		let mut panel = open(&feed);
		assert_eq!(panel.next_wake(), Some(Duration::ZERO));
		assert!(!panel.tick(Duration::ZERO), "unchanged rows repaint nothing");
		assert_eq!(panel.next_wake(), Some(CONNECTING_POLL));
		feed.rows.lock()[1].status = ExtensionStatus::Ready;
		assert!(panel.tick(CONNECTING_POLL), "settled server repaints");
		assert_eq!(panel.next_wake(), None, "nothing left to poll");
	}
}
