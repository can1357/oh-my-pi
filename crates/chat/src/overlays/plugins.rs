//! `/marketplace` (no argument, `install`, `uninstall`) is a centered
//! `Plugins` list of every catalog
//! plugin with `@version`, `[installed]`, and `[scope]` tags plus the
//! marketplace as the hint. Enter installs (or, for an installed row,
//! uninstalls) through the controller's typed mutation stream; settled
//! outcomes return through [`Panel::notify`].

use std::sync::Arc;

use omp_core::{Str, sf};
use omp_tui::{Frame, Key, MouseReport, Prop, Size, Ui, UiContext, UiEvent, dom};

use super::{
	Outcome, Panel, PanelAnchor, PanelEvent, PanelNote,
	services::{Mutation, PluginRow, PluginsReport, Services},
};
use crate::host::HostCommand;

/// Maximum visible plugin rows.
const MAX_VISIBLE: usize = 20;
/// Border rows, divider, status row, and hint.
const CHROME_ROWS: u16 = 5;
const EMPTY_VALUE: &str = "__empty__";
const HINT_INSTALL: &str =
	"↑/↓ plugins · Enter install (uninstall when installed) · type to search · Esc close";
const HINT_UNINSTALL: &str = "↑/↓ plugins · Enter uninstall · type to search · Esc close";

/// Which selector opened: the install browser over every catalog
/// plugin or the uninstall picker over installed ones.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PluginMode {
	/// `/marketplace`, `/marketplace install`.
	Install,
	/// `/marketplace uninstall`.
	Uninstall,
}

struct InFlight {
	id:         Str,
	installing: bool,
	mutation:   Mutation,
}

/// Retained marketplace plugin selector.
pub struct PluginSelector {
	services:  Arc<dyn Services>,
	report:    PluginsReport,
	mode:      PluginMode,
	in_flight: Option<InFlight>,
	query:     Str,
	ui:        Ui,
	ctx:       UiContext,
	width:     u16,
	rows:      u16,
}

impl PluginSelector {
	/// Opens the selector over the current marketplace report.
	pub fn open(
		services: &Arc<dyn Services>,
		mode: PluginMode,
		ctx: &UiContext,
	) -> Result<Self, Str> {
		let report = services.plugins().map_err(|error| sf!("{error}"))?;
		let mut panel = Self {
			services: Arc::clone(services),
			report,
			mode,
			in_flight: None,
			query: Str::default(),
			ui: Ui::from_root(dom! { <col/> }, 80, ctx.clone()),
			ctx: ctx.clone(),
			width: 80,
			rows: 0,
		};
		panel.rows = panel.visible_rows(20);
		panel.rebuild();
		Ok(panel)
	}

	/// Plugins the selector lists, in list order.
	#[must_use]
	pub fn plugins(&self) -> Vec<&PluginRow> {
		self
			.report
			.plugins
			.iter()
			.filter(|plugin| self.mode == PluginMode::Install || plugin.installed)
			.collect()
	}

	/// The request in flight, as `(plugin id, installing)`.
	#[must_use]
	pub fn in_flight(&self) -> Option<(&str, bool)> {
		self
			.in_flight
			.as_ref()
			.map(|request| (request.id.as_str(), request.installing))
	}

	fn visible_rows(&self, height: u16) -> u16 {
		let items = self.plugins().len().max(1).min(MAX_VISIBLE) as u16;
		items.min(height.saturating_sub(CHROME_ROWS)).max(1)
	}

	fn status_line(&self) -> Str {
		match &self.in_flight {
			Some(request) if request.installing => sf!("Installing {}…", request.id),
			Some(request) => sf!("Uninstalling {}…", request.id),
			None => match self.mode {
				PluginMode::Install => {
					let count = self.report.marketplaces.len();
					if count == 1 {
						sf!("1 marketplace")
					} else {
						sf!("{count} marketplaces")
					}
				},
				PluginMode::Uninstall => {
					let count = self.plugins().len();
					if count == 1 {
						sf!("1 installed plugin")
					} else {
						sf!("{count} installed plugins")
					}
				},
			},
		}
	}

	fn rebuild(&mut self) {
		let plugins = self.plugins();
		let options: Vec<(Str, Str, Str, Str)> = plugins
			.iter()
			.map(|plugin| {
				let version = plugin
					.version
					.as_ref()
					.map_or_else(Str::default, |version| sf!("@{version}"));
				let status = if plugin.installed { " [installed]" } else { "" };
				let scope = if plugin.scope.is_empty() {
					Str::default()
				} else {
					sf!(" [{}]", plugin.scope)
				};
				(
					plugin.id.clone(),
					sf!("{}{version}{status}{scope}", plugin.name),
					plugin.description.clone(),
					plugin.marketplace.clone(),
				)
			})
			.collect();
		let empty = options.is_empty();
		let empty_reason = if self.report.marketplaces.is_empty() {
			"Add a marketplace first: /marketplace add <source>"
		} else if self.mode == PluginMode::Uninstall {
			"No marketplace plugins installed"
		} else {
			"Configured marketplaces have no plugins"
		};
		let hint = match self.mode {
			PluginMode::Install => HINT_INSTALL,
			PluginMode::Uninstall => HINT_UNINSTALL,
		};
		let status = self.status_line();
		let status_fg = if self.in_flight.is_some() {
			"accent"
		} else {
			"muted"
		};
		let seed = self.query.clone();
		let height = self.rows.saturating_add(1);
		let tree = dom! {
			<box border=round title="Plugins" pad-x=1>
				<col>
					<select id="plugins" filter={seed} h={height}>
						if empty {
							<option value={EMPTY_VALUE} label="No plugins available">
								<td><pre>{"No plugins available"}</pre></td>
								<td truncate grow><pre fg=muted>{empty_reason}</pre></td>
							</option>
						}
						for (value, label, desc, marketplace) in options {
							<option value={value} label={label.clone()}>
								<td><pre>{label}</pre></td>
								<td truncate grow><pre fg=muted>{desc}</pre></td>
								<td align=end><pre fg=muted>{marketplace}</pre></td>
							</option>
						}
					</select>
					<hr border=round/>
					<text id="plugin-status" fg={status_fg} truncate>{status}</text>
					<text fg=muted truncate>{hint}</text>
				</col>
			</box>
		};
		self.ui = Ui::from_root(tree, self.width, self.ctx.clone());
	}

	/// Installs the chosen plugin, or uninstalls an installed
	/// one (the uninstall picker only lists those).
	fn choose(&mut self, id: &str) -> PanelEvent {
		if id == EMPTY_VALUE {
			return PanelEvent::Consumed;
		}
		if let Some(request) = &self.in_flight {
			return PanelEvent::Notice(sf!(
				"{} {} first",
				if request.installing {
					"Installing"
				} else {
					"Uninstalling"
				},
				request.id
			));
		}
		let Some(plugin) = self.report.plugins.iter().find(|plugin| plugin.id == id) else {
			return PanelEvent::Consumed;
		};
		let installing = !plugin.installed;
		let mutation = if installing {
			Mutation::InstallPlugin { id: Str::new(id) }
		} else {
			Mutation::UninstallPlugin { id: Str::new(id) }
		};
		self.in_flight = Some(InFlight { id: Str::new(id), installing, mutation: mutation.clone() });
		self.rebuild();
		PanelEvent::Command(HostCommand::Service(mutation))
	}

	fn route(&mut self, event: UiEvent) -> PanelEvent {
		match event {
			UiEvent::Cancel => PanelEvent::Close,
			UiEvent::Changed { id, value } if id.as_str() == "plugins" => self.choose(value.as_str()),
			UiEvent::Filtered { id, query, .. } if id.as_str() == "plugins" => {
				self.query = query;
				PanelEvent::Consumed
			},
			_ => PanelEvent::Consumed,
		}
	}
}

impl Panel for PluginSelector {
	fn id(&self) -> &'static str {
		"plugins"
	}

	fn anchor(&self) -> PanelAnchor {
		PanelAnchor::Center
	}

	fn key(&mut self, key: Key) -> PanelEvent {
		let event = self.ui.handle_key(key);
		self.route(event)
	}

	fn paste(&mut self, text: &str) -> PanelEvent {
		let event = self.ui.handle_paste(text);
		self.route(event)
	}

	fn mouse(&mut self, report: MouseReport) -> PanelEvent {
		let event = self
			.ui
			.handle_mouse_with_mods(report.col, report.row, report.kind, report.mods);
		self.route(event)
	}

	fn frame(&mut self, viewport: Size) -> &Frame {
		let rows = self.visible_rows(viewport.height);
		if rows != self.rows {
			self.rows = rows;
			self.ui.set_prop("plugins", Prop::H, rows.saturating_add(1));
		}
		if viewport.width != self.width {
			self.width = viewport.width;
			self.rebuild();
		}
		self.ui.frame()
	}

	fn notify(&mut self, note: PanelNote<'_>) -> PanelEvent {
		let PanelNote::Outcome(Outcome::Service(outcome)) = note else {
			return PanelEvent::Ignored;
		};
		let Some(request) = &self.in_flight else {
			return PanelEvent::Ignored;
		};
		if request.mutation != outcome.mutation {
			return PanelEvent::Ignored;
		}
		self.in_flight = None;
		if outcome.result.is_ok()
			&& let Ok(report) = self.services.plugins()
		{
			self.report = report;
		}
		self.rebuild();
		match &outcome.result {
			Ok(line) => PanelEvent::Notice(line.clone()),
			Err(error) => PanelEvent::Notice(sf!("Marketplace error: {error}")),
		}
	}
}

#[cfg(test)]
mod tests {
	use omp_tui::{Mods, Mouse, MouseButton};
	use parking_lot::Mutex;

	use super::*;
	use crate::overlays::services::{MarketplaceSource, ServiceOutcome, ServiceResult};

	struct Feed {
		report: Mutex<PluginsReport>,
	}

	impl Services for Feed {
		fn plugins(&self) -> ServiceResult<PluginsReport> {
			Ok(self.report.lock().clone())
		}
	}

	fn plugin(name: &str, installed: bool) -> PluginRow {
		PluginRow {
			id: sf!("{name}@official"),
			name: Str::new(name),
			version: Some(Str::new_static("1.0.0")),
			description: sf!("The {name} plugin"),
			marketplace: Str::new_static("official"),
			installed,
			enabled: installed,
			scope: if installed {
				Str::new_static("user")
			} else {
				Str::default()
			},
			shadowed: false,
		}
	}

	fn point(text: &str, needle: &str) -> (u16, u16) {
		text
			.lines()
			.enumerate()
			.find_map(|(row, line)| {
				let byte = line.find(needle)?;
				Some((omp_tui::cell_width(&line[..byte]), u16::try_from(row).ok()?))
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

	fn feed(plugins: Vec<PluginRow>, marketplaces: usize) -> Arc<Feed> {
		let sources = (0..marketplaces)
			.map(|index| MarketplaceSource {
				name: sf!("market{index}"),
				uri:  sf!("org/repo{index}"),
			})
			.collect::<Vec<_>>();
		Arc::new(Feed {
			report: Mutex::new(PluginsReport {
				marketplaces: sources.iter().map(|source| source.name.clone()).collect(),
				plugins,
				sources,
			}),
		})
	}

	fn open(feed: &Arc<Feed>, mode: PluginMode) -> PluginSelector {
		let services: Arc<dyn Services> = Arc::clone(feed) as Arc<dyn Services>;
		PluginSelector::open(&services, mode, &UiContext::default()).expect("selector opens")
	}

	#[test]
	fn selector_lists_plugins_with_pi_tags_and_marketplace_hint() {
		let feed = feed(vec![plugin("linter", true), plugin("docs", false)], 1);
		let mut panel = open(&feed, PluginMode::Install);
		let text = omp_tui::frame_text(panel.frame(Size { width: 110, height: 20 }));
		assert!(text.contains("Plugins"), "title missing:\n{text}");
		assert!(text.contains("linter@1.0.0 [installed] [user]"), "installed row missing:\n{text}");
		assert!(text.contains("docs@1.0.0"), "available row missing:\n{text}");
		assert!(text.contains("official"), "marketplace hint missing:\n{text}");
		assert!(text.contains("Enter install"), "hint missing:\n{text}");
		assert_eq!(panel.key(Key::Esc), PanelEvent::Close);
	}

	#[test]
	fn clicking_a_plugin_emits_the_same_typed_mutation_as_enter() {
		let feed = feed(vec![plugin("docs", false)], 1);
		let mut panel = open(&feed, PluginMode::Install);
		let painted = omp_tui::frame_text(panel.frame(Size { width: 110, height: 20 }));
		let (col, row) = point(&painted, "docs@1.0.0");
		assert_eq!(
			panel.mouse(click(col, row)),
			PanelEvent::Command(HostCommand::Service(Mutation::InstallPlugin {
				id: Str::new_static("docs@official"),
			}))
		);
	}

	#[test]
	fn enter_installs_then_settles_from_the_controller_outcome() {
		let feed = feed(vec![plugin("docs", false), plugin("linter", true)], 1);
		let mut panel = open(&feed, PluginMode::Install);
		panel.frame(Size { width: 110, height: 20 });
		let mutation = Mutation::InstallPlugin { id: Str::new_static("docs@official") };
		assert_eq!(
			panel.key(Key::Enter),
			PanelEvent::Command(HostCommand::Service(mutation.clone()))
		);
		assert_eq!(panel.in_flight(), Some(("docs@official", true)));
		let text = omp_tui::frame_text(panel.frame(Size { width: 110, height: 20 }));
		assert!(text.contains("Installing docs@official…"), "pending row missing:\n{text}");
		assert!(
			matches!(panel.key(Key::Enter), PanelEvent::Notice(text) if text.contains("Installing")),
			"a second Enter waits for the request"
		);
		feed.report.lock().plugins[0].installed = true;
		let outcome = Outcome::Service(ServiceOutcome {
			mutation,
			result: Ok(Str::new_static("Installed docs from official")),
		});
		assert_eq!(
			panel.notify(PanelNote::Outcome(&outcome)),
			PanelEvent::Notice(Str::new_static("Installed docs from official"))
		);
		assert_eq!(panel.in_flight(), None);
		let text = omp_tui::frame_text(panel.frame(Size { width: 110, height: 20 }));
		assert!(text.contains("docs@1.0.0 [installed]"), "list refreshed from services:\n{text}");
	}

	#[test]
	fn empty_catalog_explains_the_missing_marketplace() {
		let feed = feed(Vec::new(), 0);
		let mut panel = open(&feed, PluginMode::Install);
		let text = omp_tui::frame_text(panel.frame(Size { width: 110, height: 20 }));
		assert!(text.contains("No plugins available"), "empty row missing:\n{text}");
		assert!(
			text.contains("Add a marketplace first: /marketplace add <source>"),
			"empty reason missing:\n{text}"
		);
		assert_eq!(panel.key(Key::Enter), PanelEvent::Consumed);
		let feed = feed_with_market();
		let mut panel = open(&feed, PluginMode::Install);
		let text = omp_tui::frame_text(panel.frame(Size { width: 110, height: 20 }));
		assert!(text.contains("Configured marketplaces have no plugins"), "reason missing:\n{text}");
	}

	fn feed_with_market() -> Arc<Feed> {
		feed(Vec::new(), 1)
	}

	#[test]
	fn uninstall_mode_lists_only_installed_plugins() {
		let feed = feed(vec![plugin("docs", false), plugin("linter", true)], 1);
		let mut panel = open(&feed, PluginMode::Uninstall);
		assert_eq!(panel.plugins().len(), 1);
		let text = omp_tui::frame_text(panel.frame(Size { width: 110, height: 20 }));
		assert!(text.contains("linter@1.0.0 [installed]"), "installed row missing:\n{text}");
		assert!(!text.contains("docs@"), "available rows hidden:\n{text}");
		assert!(text.contains("Enter uninstall"), "hint missing:\n{text}");
	}
}
