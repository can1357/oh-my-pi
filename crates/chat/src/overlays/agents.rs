//! `/agents` definitions browser as a full-screen observer-local [`Panel`]
//! (ADR 0005). A sidebar of scopes (`All agents`,
//! one row per definition source), a body listing agents with
//! type-to-filter search and a pinned detail block, and a footer that turns
//! into a chip strip while configuring one agent.
//!
//! omp agent definitions are `<agent>.cfg` class scripts (ADR 0013), so the
//! strip carries only the two knobs the class file owns: `enabled`
//! (`sv_task_disabled_agents`, flipped by the controller through
//! `HostCommand::Service` with [`Mutation::SetAgentEnabled`]; the row
//! changes when the outcome arrives in [`Panel::notify`]) and the read-only
//! `model` shown from the cfg's `ai_model` line. Per-agent
//! model/prewalk/advisor overrides
//! and the AI-drafted "New agent" flow have no cfg-side seam here.

use std::sync::Arc;

use omp_core::{Str, sf};
use omp_tui::{Frame, IntoComponent, Key, MouseReport, Size, Ui, UiContext, UiEvent, dom};

use super::{
	Outcome, Panel, PanelAction, PanelAnchor, PanelCx, PanelEvent, PanelNote, Services,
	services::{AgentRow, Mutation, ServiceOutcome},
};
use crate::host::HostCommand;

/// Sidebar width clamp.
const SIDEBAR_MIN_WIDTH: u16 = 16;
const SIDEBAR_MAX_WIDTH: u16 = 24;
/// Rows the pinned detail block occupies (rule + three lines).
const DETAIL_ROWS: u16 = 4;
/// Border, rule, and footer rows around the panes.
const CHROME_ROWS: u16 = 4;
const TITLE: &str = "Agents";
/// Footer hints for each focus region.
const LIST_HINT: &str =
	"Enter configure · Space enable/disable · ↑/↓ rows · type to search · Ctrl+R reload · Esc close";
const SCOPE_HINT: &str = "↑/↓ scopes · →/Enter agents · Esc close";
const STRIP_HINT: &str = "←/→ choose · Enter open · Esc cancel";
const SEARCH_PLACEHOLDER: &str = "type to filter";
const SELECT_HINT: &str = "Select an agent to inspect";

/// Definition sources in sidebar order.
const SOURCES: [(&str, &str); 3] =
	[("project", "Project"), ("user", "User"), ("bundled", "Bundled")];

/// Which sidebar scope is active.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Scope {
	All,
	/// Index into [`SOURCES`].
	Source(usize),
}

/// Which pane owns the cursor.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Focus {
	Scope,
	List,
}

/// Chip strip opened by Enter on an agent.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Chip {
	Enabled,
	Model,
}

impl Chip {
	const ALL: [Self; 2] = [Self::Enabled, Self::Model];
}

/// Retained `/agents` browser.
pub struct AgentsHub {
	ui:       Ui,
	ctx:      UiContext,
	services: Arc<dyn Services>,
	agents:   Vec<AgentRow>,
	/// Indices into `agents` shown by the active scope and query.
	rows:     Vec<usize>,
	scope:    Scope,
	focus:    Focus,
	index:    usize,
	scroll:   usize,
	query:    String,
	/// Open strip: the agent being configured and the highlighted chip.
	strip:    Option<(usize, usize)>,
	notice:   Option<Str>,
	error:    Option<Str>,
	width:    u16,
	height:   u16,
}

impl AgentsHub {
	/// Opens the browser over the host's agent definitions.
	pub fn open(cx: &PanelCx<'_>) -> Self {
		let (agents, error) = load(cx.services.as_ref());
		let mut hub = Self {
			ui: Ui::from_root(dom! { <col/> }.into_component(), cx.viewport.width, cx.ui.clone()),
			ctx: cx.ui.clone(),
			services: Arc::clone(cx.services),
			agents,
			rows: Vec::new(),
			scope: Scope::All,
			focus: Focus::List,
			index: 0,
			scroll: 0,
			query: String::new(),
			strip: None,
			notice: None,
			error,
			width: cx.viewport.width,
			height: cx.viewport.height,
		};
		hub.build_rows();
		hub.rebuild();
		hub
	}

	/// Definitions as loaded, sorted by source then name.
	#[must_use]
	pub fn agents(&self) -> &[AgentRow] {
		&self.agents
	}

	fn reload(&mut self) {
		let selected = self.selected().map(|agent| agent.name.clone());
		let (agents, error) = load(self.services.as_ref());
		self.agents = agents;
		self.error = error;
		self.build_rows();
		if let Some(name) = selected
			&& let Some(at) = self
				.rows
				.iter()
				.position(|&index| self.agents[index].name == name)
		{
			self.index = at;
		}
		self.clamp();
	}

	fn scopes(&self) -> Vec<Scope> {
		let mut scopes = vec![Scope::All];
		for (index, (source, _)) in SOURCES.iter().enumerate() {
			if self
				.agents
				.iter()
				.any(|agent| agent.source.as_str() == *source)
			{
				scopes.push(Scope::Source(index));
			}
		}
		scopes
	}

	fn build_rows(&mut self) {
		let query = self.query.trim().to_ascii_lowercase();
		let tokens = query.split_whitespace().collect::<Vec<_>>();
		self.rows = self
			.agents
			.iter()
			.enumerate()
			.filter(|(_, agent)| match self.scope {
				Scope::All => true,
				Scope::Source(source) => agent.source.as_str() == SOURCES[source].0,
			})
			.filter(|(_, agent)| {
				tokens.is_empty() || {
					let haystack = sf!(
						"{} {} {} {}",
						agent.name,
						agent.description,
						agent.source,
						agent.model.as_deref().unwrap_or_default()
					)
					.to_ascii_lowercase();
					tokens.iter().all(|token| haystack.contains(token))
				}
			})
			.map(|(index, _)| index)
			.collect();
	}

	fn clamp(&mut self) {
		self.index = self.index.min(self.rows.len().saturating_sub(1));
	}

	fn selected(&self) -> Option<&AgentRow> {
		self.rows.get(self.index).map(|&index| &self.agents[index])
	}

	fn move_scope(&mut self, delta: isize) {
		let scopes = self.scopes();
		let at = scopes
			.iter()
			.position(|scope| *scope == self.scope)
			.unwrap_or(0);
		let next = (at as isize + delta).rem_euclid(scopes.len() as isize) as usize;
		self.scope = scopes[next];
		self.build_rows();
		self.index = 0;
		self.scroll = 0;
	}

	/// Type-to-filter: any printable character extends the query and
	/// moves the cursor to the first match.
	fn type_query(&mut self, ch: char) {
		self.query.push(ch);
		self.focus = Focus::List;
		self.build_rows();
		self.index = 0;
		self.scroll = 0;
	}

	/// Asks the controller to flip the selected agent; the row changes in
	/// [`Self::settle`] once the outcome comes back.
	fn toggle_selected(&mut self) -> PanelEvent {
		let Some(&index) = self.rows.get(self.index) else {
			return PanelEvent::Consumed;
		};
		let agent = &self.agents[index];
		PanelEvent::Command(HostCommand::Service(Mutation::SetAgentEnabled {
			name:    agent.name.clone(),
			enabled: !agent.enabled,
		}))
	}

	/// Applies a settled agent toggle to its row and the status line.
	fn settle(&mut self, outcome: &ServiceOutcome) -> PanelEvent {
		let Mutation::SetAgentEnabled { name, enabled } = &outcome.mutation else {
			return PanelEvent::Ignored;
		};
		match &outcome.result {
			Ok(_) => {
				if let Some(agent) = self.agents.iter_mut().find(|agent| agent.name == *name) {
					agent.enabled = *enabled;
				}
				self.notice = Some(sf!("{name} {}", outcome.mutation.verb()));
				self.error = None;
			},
			Err(error) => self.error = Some(Str::new(error.to_string())),
		}
		self.rebuild();
		PanelEvent::Consumed
	}

	fn activate_chip(&mut self) -> PanelEvent {
		let Some((index, chip)) = self.strip.take() else {
			return PanelEvent::Consumed;
		};
		match Chip::ALL[chip] {
			Chip::Enabled => {
				if let Some(at) = self.rows.iter().position(|&row| row == index) {
					self.index = at;
				}
				self.rebuild();
				self.toggle_selected()
			},
			Chip::Model => {
				let agent = &self.agents[index];
				let message = match &agent.path {
					Some(path) => sf!("{} model: edit {}", agent.name, path.display()),
					None => sf!("{} model: bundled class, inherits the session model", agent.name),
				};
				self.rebuild();
				PanelEvent::Notice(message)
			},
		}
	}

	fn strip_key(&mut self, key: Key) -> PanelEvent {
		let Some((_, chip)) = self.strip.as_mut() else {
			return PanelEvent::Consumed;
		};
		match key {
			Key::Esc => self.strip = None,
			Key::Left | Key::Up | Key::BackTab => {
				*chip = (*chip + Chip::ALL.len() - 1) % Chip::ALL.len();
			},
			Key::Right | Key::Down | Key::Tab => *chip = (*chip + 1) % Chip::ALL.len(),
			Key::Enter => return self.activate_chip(),
			_ => return PanelEvent::Consumed,
		}
		self.rebuild();
		PanelEvent::Consumed
	}

	fn sidebar_width(&self) -> u16 {
		let longest = self
			.scopes()
			.into_iter()
			.map(|scope| {
				let (label, count) = self.scope_label(scope);
				label.len() + count.len() + 5
			})
			.max()
			.unwrap_or(0);
		u16::try_from(longest)
			.unwrap_or(SIDEBAR_MAX_WIDTH)
			.clamp(SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH)
	}

	fn scope_label(&self, scope: Scope) -> (&'static str, Str) {
		match scope {
			Scope::All => ("All agents", sf!("{}", self.agents.len())),
			Scope::Source(source) => {
				let count = self
					.agents
					.iter()
					.filter(|agent| agent.source.as_str() == SOURCES[source].0)
					.count();
				(SOURCES[source].1, sf!("{count}"))
			},
		}
	}

	fn sidebar(&self, rows: u16) -> Vec<Box<dyn omp_tui::Component>> {
		let mut lines: Vec<Box<dyn omp_tui::Component>> = Vec::with_capacity(usize::from(rows));
		for (position, scope) in self.scopes().into_iter().enumerate() {
			if position == 1 {
				lines.push(dom! { <text>{" "}</text> }.into_component());
			}
			let (label, count) = self.scope_label(scope);
			let active = scope == self.scope;
			let cursor = active && self.focus == Focus::Scope;
			lines.push(dom! {
				<row gap=1>
					if cursor { <icon name="cursor" fg=accent/> } else { <text>{" "}</text> }
					<icon name="agents" fg=accent/>
					if active { <text bold fg=accent truncate grow>{label}</text> } else { <text truncate grow>{label}</text> }
					<text fg=muted>{count}</text>
				</row>
			}.into_component());
		}
		pad(&mut lines, rows);
		lines
	}

	fn status_row(&self) -> Box<dyn omp_tui::Component> {
		if let Some(error) = &self.error {
			let error = error.clone();
			return dom! { <pre fg=err truncate>{" "}{error}</pre> }.into_component();
		}
		if let Some(notice) = &self.notice {
			let notice = notice.clone();
			return dom! { <pre fg=ok truncate>{" "}{notice}</pre> }.into_component();
		}
		let label = match self.scope {
			Scope::All => Str::new_static("All agents"),
			Scope::Source(source) => sf!("{} agents", SOURCES[source].1),
		};
		let count = sf!(" {label} · {}", self.rows.len());
		dom! { <text fg=muted truncate>{count}</text> }.into_component()
	}

	fn list(&mut self, rows: u16) -> Vec<Box<dyn omp_tui::Component>> {
		let mut lines: Vec<Box<dyn omp_tui::Component>> = Vec::with_capacity(usize::from(rows));
		let query = Str::new(self.query.as_str());
		lines.push(dom! {
			<row>
				<pre fg=muted>{" search: "}</pre>
				if query.is_empty() { <text fg=muted truncate>{SEARCH_PLACEHOLDER}</text> } else { <text fg=accent truncate>{query}</text> }
			</row>
		}.into_component());
		lines.push(dom! { <text>{" "}</text> }.into_component());
		let visible = usize::from(rows.saturating_sub(DETAIL_ROWS).saturating_sub(2).max(3));
		if self.index < self.scroll {
			self.scroll = self.index;
		} else if self.index >= self.scroll + visible {
			self.scroll = self.index + 1 - visible;
		}
		self.scroll = self.scroll.min(self.rows.len().saturating_sub(visible));
		let name_width = self
			.rows
			.iter()
			.map(|&index| self.agents[index].name.chars().count())
			.max()
			.unwrap_or(0);
		let list_focused = self.focus == Focus::List;
		for (position, &index) in self.rows.iter().enumerate().skip(self.scroll).take(visible) {
			let agent = &self.agents[index];
			let selected = position == self.index;
			let cursor = selected && list_focused;
			let name = sf!("{:width$}", agent.name.as_str(), width = name_width);
			let source = agent.source.clone();
			let model = agent.model.clone().unwrap_or_default();
			let enabled = agent.enabled;
			lines.push(dom! {
				<row gap=1>
					if cursor { <icon name="cursor" fg=accent/> } else { <text>{" "}</text> }
					if enabled { <icon name="enabled" fg=ok/> } else { <icon name="disabled" fg=muted/> }
					if !enabled { <pre fg=muted>{name}</pre> } else if selected { <pre bold fg=accent>{name}</pre> } else { <pre>{name}</pre> }
					<pre fg=muted grow truncate>{" "}{source}</pre>
					if !model.is_empty() { <text fg=warn truncate>{model}</text> }
				</row>
			}.into_component());
		}
		pad(&mut lines, rows.saturating_sub(DETAIL_ROWS));
		lines.push(dom! { <hr fg=border/> }.into_component());
		match self.selected() {
			Some(agent) => {
				let description = agent.description.clone();
				let model = agent
					.model
					.clone()
					.unwrap_or_else(|| Str::new_static("(session model)"));
				let tools = if agent.tools.is_empty() {
					Str::new_static("full roster")
				} else {
					Str::new(agent.tools.join(", "))
				};
				let path = agent
					.path
					.as_ref()
					.map(|path| Str::new(path.display().to_string()))
					.unwrap_or_default();
				lines.push(dom! { <pre fg=muted truncate>{" "}{description}</pre> }.into_component());
				lines.push(
					dom! {
						<row>
							<pre fg=muted>{" model: "}</pre>
							<text truncate>{model}</text>
						</row>
					}
					.into_component(),
				);
				lines.push(dom! {
					<row gap=3>
						<row><pre fg=muted>{" tools: "}</pre><text truncate>{tools}</text></row>
						if !path.is_empty() { <row><pre fg=muted>{"path: "}</pre><text fg=muted truncate>{path}</text></row> }
					</row>
				}.into_component());
			},
			None => {
				lines.push(dom! { <pre fg=muted>{" "}{SELECT_HINT}</pre> }.into_component());
				pad(&mut lines, rows);
			},
		}
		lines
	}

	fn footer(&self) -> Box<dyn omp_tui::Component> {
		if let Some((index, chip)) = self.strip {
			let agent = &self.agents[index];
			let name = agent.name.clone();
			let enabled = agent.enabled;
			let toggle = if enabled { "disable" } else { "enable" };
			let model = sf!("model: {}", agent.model.as_deref().unwrap_or("auto"));
			let chips = Chip::ALL
				.iter()
				.enumerate()
				.map(|(at, kind)| {
					let label = match kind {
						Chip::Enabled => Str::new_static(toggle),
						Chip::Model => model.clone(),
					};
					(at == chip, *kind, label)
				})
				.collect::<Vec<_>>();
			return dom! {
				<row gap=1>
					<text fg=accent>{name}</text>
					<text fg=muted>{"→"}</text>
					for (selected, kind, label) in chips {
						if selected {
							<row bg=surface>
								<text fg=accent>{"["}</text>
								if kind == Chip::Enabled && enabled { <pre fg=muted>{" "}{label}{" "}</pre> } else if kind == Chip::Enabled { <pre fg=ok>{" "}{label}{" "}</pre> } else { <pre fg=accent>{" "}{label}{" "}</pre> }
								<text fg=accent>{"]"}</text>
							</row>
						} else if kind == Chip::Enabled && enabled {
							<pre fg=muted>{" "}{label}{" "}</pre>
						} else if kind == Chip::Enabled {
							<pre fg=ok>{" "}{label}{" "}</pre>
						} else {
							<pre fg=accent>{" "}{label}{" "}</pre>
						}
					}
				</row>
			}.into_component();
		}
		let hint = match self.focus {
			Focus::Scope => SCOPE_HINT,
			Focus::List => LIST_HINT,
		};
		dom! { <text fg=muted truncate>{hint}</text> }.into_component()
	}

	fn rebuild(&mut self) {
		let content_rows = self.height.saturating_sub(CHROME_ROWS).max(10);
		let sidebar_width = self.sidebar_width();
		let body_width = self.width.saturating_sub(sidebar_width + 5).max(20);
		let sidebar = self.sidebar(content_rows);
		let mut body = vec![self.status_row()];
		body.extend(self.list(content_rows.saturating_sub(1)));
		let footer = self.footer();
		let hint = if self.strip.is_some() { STRIP_HINT } else { "" };
		let tree = dom! {
			<box border=round title={TITLE}>
				<col>
					<row gap=1>
						<col w={sidebar_width}>
							for line in sidebar { {line} }
						</col>
						<hr vertical border=round fg=muted/>
						<col w={body_width}>
							for line in body { {line} }
						</col>
					</row>
					<hr border=round/>
					<row gap=2>
						{footer}
						if !hint.is_empty() { <text fg=muted truncate>{hint}</text> }
					</row>
				</col>
			</box>
		}
		.into_component();
		self.ui = Ui::from_root(tree, self.width, self.ctx.clone());
	}
}

fn load(services: &dyn Services) -> (Vec<AgentRow>, Option<Str>) {
	match services.agents() {
		Ok(mut agents) => {
			agents.sort_by(|left, right| {
				source_rank(&left.source)
					.cmp(&source_rank(&right.source))
					.then_with(|| left.name.cmp(&right.name))
			});
			(agents, None)
		},
		Err(error) => (Vec::new(), Some(Str::new(error.to_string()))),
	}
}

fn source_rank(source: &str) -> usize {
	SOURCES
		.iter()
		.position(|(name, _)| *name == source)
		.unwrap_or(SOURCES.len())
}

fn pad(lines: &mut Vec<Box<dyn omp_tui::Component>>, rows: u16) {
	while lines.len() < usize::from(rows) {
		lines.push(dom! { <text>{" "}</text> }.into_component());
	}
	lines.truncate(usize::from(rows));
}

impl Panel for AgentsHub {
	fn id(&self) -> &'static str {
		"agents"
	}

	fn anchor(&self) -> PanelAnchor {
		PanelAnchor::Full
	}

	fn action(&mut self, action: PanelAction) -> PanelEvent {
		match action {
			// Ctrl+R reloads here; the host lowers it to `Rename`.
			PanelAction::Rename if self.strip.is_none() => {
				self.reload();
				self.rebuild();
				PanelEvent::Consumed
			},
			_ => PanelEvent::Ignored,
		}
	}

	fn key(&mut self, key: Key) -> PanelEvent {
		if self.strip.is_some() {
			return self.strip_key(key);
		}
		match key {
			Key::Esc => {
				if self.query.is_empty() {
					return PanelEvent::Close;
				}
				self.query.clear();
				self.build_rows();
				self.clamp();
			},
			Key::Tab | Key::BackTab => {
				self.focus = match self.focus {
					Focus::Scope => Focus::List,
					Focus::List => Focus::Scope,
				};
			},
			Key::Left => self.focus = Focus::Scope,
			Key::Right => self.focus = Focus::List,
			Key::Up if self.focus == Focus::Scope => self.move_scope(-1),
			Key::Down if self.focus == Focus::Scope => self.move_scope(1),
			Key::Enter if self.focus == Focus::Scope => self.focus = Focus::List,
			Key::Up => self.index = self.index.saturating_sub(1),
			Key::Down => {
				self.index = (self.index + 1).min(self.rows.len().saturating_sub(1));
			},
			Key::Enter => {
				if let Some(&index) = self.rows.get(self.index) {
					self.strip = Some((index, 0));
				}
			},
			Key::Space if self.query.is_empty() => return self.toggle_selected(),
			Key::Backspace => {
				if self.query.pop().is_some() {
					self.build_rows();
					self.clamp();
				}
			},
			Key::Space => self.type_query(' '),
			Key::Char(ch) if !ch.is_control() => self.type_query(ch),
			_ => return PanelEvent::Ignored,
		}
		self.rebuild();
		PanelEvent::Consumed
	}

	fn mouse(&mut self, report: MouseReport) -> PanelEvent {
		match self
			.ui
			.handle_mouse_with_mods(report.col, report.row, report.kind, report.mods)
		{
			UiEvent::Cancel => PanelEvent::Close,
			_ => PanelEvent::Consumed,
		}
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

	fn paste(&mut self, text: &str) -> PanelEvent {
		if self.strip.is_some() {
			return PanelEvent::Consumed;
		}
		self
			.query
			.extend(text.chars().filter(|ch| !ch.is_control()));
		self.focus = Focus::List;
		self.build_rows();
		self.index = 0;
		self.scroll = 0;
		self.rebuild();
		PanelEvent::Consumed
	}

	fn frame(&mut self, viewport: Size) -> &Frame {
		if viewport.width != self.width || viewport.height != self.height {
			self.width = viewport.width;
			self.height = viewport.height;
			self.rebuild();
		}
		self.ui.frame()
	}
}

#[cfg(test)]
mod tests {
	use std::{path::PathBuf, sync::Arc};

	use omp_con::Ctx;
	use omp_dom::Dom;

	use super::*;
	use crate::overlays::services::{ServiceError, ServiceOutcome, ServiceResult};

	struct TestServices {
		rows: Vec<AgentRow>,
	}

	impl Services for TestServices {
		fn agents(&self) -> ServiceResult<Vec<AgentRow>> {
			Ok(self.rows.clone())
		}
	}

	fn agent(name: &str, source: &str, model: Option<&str>, path: Option<&str>) -> AgentRow {
		AgentRow {
			name:        Str::new(name),
			source:      Str::new(source),
			description: sf!("{name} description"),
			model:       model.map(Str::new),
			tools:       Vec::new(),
			enabled:     true,
			path:        path.map(PathBuf::from),
		}
	}

	fn hub(rows: Vec<AgentRow>) -> (AgentsHub, Arc<TestServices>) {
		let services = Arc::new(TestServices { rows });
		let dyn_services: Arc<dyn Services> = Arc::clone(&services) as Arc<dyn Services>;
		let dom = Dom::default();
		let con = Ctx::new();
		let ctx = UiContext::default();
		let cx = PanelCx {
			dom:      &dom,
			con:      &con,
			ui:       &ctx,
			viewport: Size { width: 100, height: 30 },
			services: &dyn_services,
		};
		(AgentsHub::open(&cx), services)
	}

	fn text(hub: &mut AgentsHub) -> String {
		omp_tui::frame_text(hub.frame(Size { width: 100, height: 30 }))
	}

	#[test]
	fn renders_rows_scopes_detail_and_footer() {
		let (mut hub, _) = hub(vec![
			agent("sonic", "project", Some("@smol"), Some("/p/.omp/sonic.cfg")),
			agent("task", "bundled", None, None),
		]);
		let painted = text(&mut hub);
		assert!(painted.contains("Agents"), "{painted}");
		assert!(painted.contains("All agents"), "{painted}");
		assert!(painted.contains("Project"), "{painted}");
		assert!(painted.contains("Bundled"), "{painted}");
		assert!(!painted.contains("User"), "empty sources are hidden:\n{painted}");
		assert!(painted.contains("sonic"), "{painted}");
		assert!(painted.contains("@smol"), "{painted}");
		assert!(painted.contains("model: @smol"), "detail block missing:\n{painted}");
		assert!(painted.contains("sonic.cfg"), "{painted}");
		assert!(painted.contains("Enter configure"), "{painted}");
		assert!(painted.contains("All agents · 2"), "{painted}");
	}

	#[test]
	fn space_toggles_through_the_controller_and_notice_shows() {
		let (mut hub, _) = hub(vec![agent("sonic", "project", None, None)]);
		let mutation =
			Mutation::SetAgentEnabled { name: Str::new_static("sonic"), enabled: false };
		assert_eq!(hub.key(Key::Space), PanelEvent::Command(HostCommand::Service(mutation.clone())));
		assert!(hub.agents()[0].enabled, "rows change only after the owner settles");
		let outcome = Outcome::Service(ServiceOutcome {
			mutation,
			result: Ok(Str::new_static("Agent sonic disabled")),
		});
		assert_eq!(hub.notify(PanelNote::Outcome(&outcome)), PanelEvent::Consumed);
		assert!(!hub.agents()[0].enabled);
		let painted = text(&mut hub);
		assert!(painted.contains("sonic disabled"), "{painted}");
	}

	#[test]
	fn strip_enter_toggles_and_model_chip_notices() {
		let (mut hub, _) =
			hub(vec![agent("sonic", "project", Some("@smol"), Some("/p/.omp/sonic.cfg"))]);
		assert_eq!(hub.key(Key::Enter), PanelEvent::Consumed);
		let painted = text(&mut hub);
		assert!(painted.contains("sonic →"), "strip missing:\n{painted}");
		assert!(painted.contains("[ disable ]"), "{painted}");
		assert!(painted.contains("model: @smol"), "{painted}");
		assert!(painted.contains("←/→ choose"), "{painted}");
		assert_eq!(hub.key(Key::Right), PanelEvent::Consumed);
		assert_eq!(
			hub.key(Key::Enter),
			PanelEvent::Notice(Str::new_static("sonic model: edit /p/.omp/sonic.cfg"))
		);
		assert!(hub.strip.is_none());
		assert_eq!(hub.key(Key::Enter), PanelEvent::Consumed);
		assert!(matches!(
			hub.key(Key::Enter),
			PanelEvent::Command(HostCommand::Service(Mutation::SetAgentEnabled {
				name,
				enabled: false,
			})) if name == "sonic"
		));
		assert_eq!(hub.key(Key::Enter), PanelEvent::Consumed);
		assert_eq!(hub.key(Key::Esc), PanelEvent::Consumed);
		assert!(hub.strip.is_none());
	}

	#[test]
	fn typing_filters_and_esc_clears_before_closing() {
		let (mut hub, _) =
			hub(vec![agent("sonic", "project", None, None), agent("task", "bundled", None, None)]);
		assert_eq!(hub.key(Key::Char('t')), PanelEvent::Consumed);
		assert_eq!(hub.key(Key::Char('a')), PanelEvent::Consumed);
		assert_eq!(hub.rows.len(), 1);
		let painted = text(&mut hub);
		assert!(painted.contains("search: ta"), "{painted}");
		assert!(!painted.contains("sonic"), "{painted}");
		assert_eq!(hub.key(Key::Esc), PanelEvent::Consumed);
		assert_eq!(hub.rows.len(), 2);
		assert_eq!(hub.key(Key::Esc), PanelEvent::Close);
	}

	#[test]
	fn scope_pane_narrows_rows_and_reload_refetches() {
		let (mut hub, _) =
			hub(vec![agent("sonic", "project", None, None), agent("task", "bundled", None, None)]);
		assert_eq!(hub.key(Key::Left), PanelEvent::Consumed);
		let painted = text(&mut hub);
		assert!(painted.contains("↑/↓ scopes"), "{painted}");
		assert_eq!(hub.key(Key::Down), PanelEvent::Consumed);
		assert_eq!(hub.scope, Scope::Source(0));
		assert_eq!(hub.rows.len(), 1);
		assert_eq!(hub.key(Key::Enter), PanelEvent::Consumed);
		assert_eq!(hub.focus, Focus::List);
		assert_eq!(hub.action(PanelAction::Rename), PanelEvent::Consumed);
		assert_eq!(hub.agents().len(), 2);
		assert_eq!(hub.action(PanelAction::Delete), PanelEvent::Ignored);
	}

	#[test]
	fn toggle_failure_shows_the_error_row() {
		let (mut hub, _) = hub(vec![agent("broken", "project", None, None)]);
		let mutation =
			Mutation::SetAgentEnabled { name: Str::new_static("broken"), enabled: false };
		assert_eq!(hub.key(Key::Space), PanelEvent::Command(HostCommand::Service(mutation.clone())));
		let outcome = Outcome::Service(ServiceOutcome {
			mutation,
			result: Err(ServiceError::Unavailable("agent toggling")),
		});
		assert_eq!(hub.notify(PanelNote::Outcome(&outcome)), PanelEvent::Consumed);
		assert!(hub.agents()[0].enabled);
		let painted = text(&mut hub);
		assert!(painted.contains("unavailable"), "{painted}");
	}
}
