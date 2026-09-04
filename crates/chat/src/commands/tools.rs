//! Tool and extension commands: `/tools`, `/extensions`, `/marketplace`,
//! `/plugins`, and `/reload-plugins`. Each handler posts a panel opener or a
//! host call; the data comes from the application's [`Services`] feeds, the
//! presentation is a report, a dashboard, or a selector — never a journal
//! entry.

use std::fmt::Write as _;

use omp_con::ConError;
use omp_core::{Str, sf};
use omp_tui::Icon;

use super::PaletteEntry;
use crate::{
	actions::{HostAction, post},
	host::HostCommand,
	overlays::{
		Panel, PanelAnchor, PanelCall, PanelCx, PanelEvent, PanelOpener,
		extensions::ExtensionsDashboard,
		plugins::{PluginMode, PluginSelector},
		report::ReportPanel,
		services::{Mutation, PluginsReport, ToolRow},
		tasks::{PendingPanel, Settle},
	},
};

/// Palette icons for this module's commands.
pub const PALETTE: &[PaletteEntry] = &[
	PaletteEntry { name: "tools", icon: Icon::Tools },
	PaletteEntry { name: "extensions", icon: Icon::ExtensionCommand },
	PaletteEntry { name: "status", icon: Icon::ExtensionCommand },
	PaletteEntry { name: "plugins", icon: Icon::Package },
	PaletteEntry { name: "marketplace", icon: Icon::Cart },
	PaletteEntry { name: "reload-plugins", icon: Icon::Refresh },
];

/// A panel a command opened, or the notice explaining why it could not.
type Opened = Result<Box<dyn Panel>, Str>;

/// `/marketplace` help text for the TUI.
const MARKETPLACE_HELP: &str = "Marketplace commands:
  /marketplace                              Browse and install plugins
  /marketplace add <source>                  Add a marketplace (e.g. owner/repo)
  /marketplace remove <name>                 Remove a marketplace
  /marketplace update [name]                 Re-fetch catalog(s)
  /marketplace list                          List configured marketplaces
  /marketplace discover [marketplace]        Browse available plugins
  /marketplace install <name@marketplace>    Install a plugin
  /marketplace uninstall <name@marketplace>  Uninstall a plugin
  /marketplace installed                     List installed plugins
  /marketplace upgrade [name@marketplace]    Upgrade plugin(s)

Quick start:
  /marketplace add anthropics/claude-plugins-official
  /marketplace                               (opens interactive browser)";

/// `/plugins` subcommands.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PluginsOp {
	/// List installed plugins.
	List,
	/// Enable or disable one plugin.
	SetEnabled {
		/// `name@marketplace` (or a unique bare name).
		id:      Str,
		/// `true` for `enable`.
		enabled: bool,
	},
}

/// `/marketplace` subcommands.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MarketplaceOp {
	/// No argument: the interactive install browser.
	Browse,
	/// `add <source>`.
	Add(Str),
	/// `remove <name>`.
	Remove(Str),
	/// `update [name]`.
	Update(Option<Str>),
	/// `list`.
	List,
	/// `discover [marketplace]`.
	Discover(Option<Str>),
	/// `install [name@marketplace]`; `None` opens the selector.
	Install(Option<Str>),
	/// `uninstall [name@marketplace]`; `None` opens the selector.
	Uninstall(Option<Str>),
	/// `installed`.
	Installed,
	/// `upgrade [name@marketplace]`.
	Upgrade(Option<Str>),
	/// `help`.
	Help,
}

fn usage(message: &'static str) -> ConError {
	ConError::Usage(Str::new_static(message))
}

/// Parses `/plugins [list|enable <id>|disable <id>]`.
pub fn plugins_op(words: Option<Str>) -> Result<PluginsOp, ConError> {
	let text = words.as_deref().unwrap_or("").trim();
	let (verb, rest) = text
		.split_once(char::is_whitespace)
		.map_or((text, ""), |(verb, rest)| (verb, rest.trim()));
	let id = |enabled: bool| {
		(!rest.is_empty())
			.then(|| PluginsOp::SetEnabled { id: Str::new(rest), enabled })
			.ok_or_else(|| ConError::Usage(sf!("Usage: /plugins {verb} <name@marketplace>")))
	};
	match verb {
		"" | "list" => Ok(PluginsOp::List),
		"enable" => id(true),
		"disable" => id(false),
		_ => {
			Err(usage("Usage: /plugins [list|enable <name@marketplace>|disable <name@marketplace>]"))
		},
	}
}

/// Parses `/marketplace [subcommand] [args]`.
pub fn marketplace_op(words: Option<Str>) -> Result<MarketplaceOp, ConError> {
	let text = words.as_deref().unwrap_or("").trim();
	let (verb, rest) = text
		.split_once(char::is_whitespace)
		.map_or((text, ""), |(verb, rest)| (verb, rest.trim()));
	let optional = || (!rest.is_empty()).then(|| Str::new(rest));
	Ok(match verb {
		"" => MarketplaceOp::Browse,
		"add" => {
			MarketplaceOp::Add(optional().ok_or_else(|| usage("Usage: /marketplace add <source>"))?)
		},
		"remove" | "rm" => MarketplaceOp::Remove(
			optional().ok_or_else(|| usage("Usage: /marketplace remove <name>"))?,
		),
		"update" => MarketplaceOp::Update(optional()),
		"list" => MarketplaceOp::List,
		"discover" => MarketplaceOp::Discover(optional()),
		"install" => MarketplaceOp::Install(optional()),
		"uninstall" => MarketplaceOp::Uninstall(optional()),
		"installed" => MarketplaceOp::Installed,
		"upgrade" => MarketplaceOp::Upgrade(optional()),
		"help" => MarketplaceOp::Help,
		_ => {
			return Err(ConError::Usage(sf!(
				"Unknown /marketplace subcommand: {verb}. Use /marketplace help for available \
				 commands."
			)));
		},
	})
}

/// `/tools` report: `* name` for tools in the session roster, `- name`
/// for the rest, with revision, tier, and the first description line.
/// `None` when the kernel has no tools.
#[must_use]
pub fn tools_report(rows: &[ToolRow], roster: &[Str]) -> Option<Str> {
	if rows.is_empty() {
		return None;
	}
	let active = |row: &ToolRow| {
		if roster.is_empty() {
			row.active
		} else {
			roster.iter().any(|name| name == &row.name)
		}
	};
	let active_count = rows.iter().filter(|row| active(row)).count();
	let mut body = String::with_capacity(rows.len() * 64);
	let _ = write!(body, "**Tools** ({active_count} active / {} available)\n\n", rows.len());
	for row in rows {
		let marker = if active(row) { '*' } else { '-' };
		let _ = write!(body, "{marker} `{}@{}`", row.name, row.rev);
		if let Some(tier) = &row.tier {
			let _ = write!(body, " [{tier}]");
		}
		if let Some(summary) = row
			.description
			.lines()
			.next()
			.filter(|line| !line.is_empty())
		{
			let _ = write!(body, " — {summary}");
		}
		if !active(row) {
			body.push_str(" _(disabled)_");
		}
		body.push('\n');
	}
	Some(Str::new(body))
}

/// `/plugins` list: installed marketplace plugins with version, state,
/// scope, and shadowing. `None` when nothing is installed.
#[must_use]
pub fn plugins_report(report: &PluginsReport) -> Option<Str> {
	let installed = report
		.plugins
		.iter()
		.filter(|plugin| plugin.installed)
		.collect::<Vec<_>>();
	if installed.is_empty() {
		return None;
	}
	let mut body = String::from("marketplace plugins:\n");
	for plugin in installed {
		let _ = write!(
			body,
			"  {} v{}{} [{}]{}\n",
			plugin.id,
			plugin.version.as_deref().unwrap_or("?"),
			if plugin.enabled { "" } else { " (disabled)" },
			if plugin.scope.is_empty() {
				"user"
			} else {
				plugin.scope.as_str()
			},
			if plugin.shadowed { " [shadowed]" } else { "" }
		);
	}
	Some(Str::new(body))
}

/// `/marketplace list` / bare `/marketplace` (non-TUI) text.
fn marketplaces_text(report: &PluginsReport) -> Str {
	if report.sources.is_empty() {
		return Str::new_static("No marketplaces configured.");
	}
	let mut body = String::from("Marketplaces:\n");
	for source in &report.sources {
		let _ = writeln!(body, "  {}  {}", source.name, source.uri);
	}
	Str::new(body)
}

/// `/marketplace discover` text.
fn discover_text(report: &PluginsReport, marketplace: Option<&str>) -> Str {
	let plugins = report
		.plugins
		.iter()
		.filter(|plugin| marketplace.is_none_or(|name| plugin.marketplace == name))
		.collect::<Vec<_>>();
	if plugins.is_empty() {
		return if report.sources.is_empty() {
			Str::new_static(
				"No marketplaces configured. Try:\n  /marketplace add \
				 anthropics/claude-plugins-official",
			)
		} else {
			Str::new_static("No plugins available in configured marketplaces")
		};
	}
	let mut body = String::from("Available plugins:\n");
	for plugin in plugins {
		let _ = write!(body, "  {}", plugin.name);
		if let Some(version) = &plugin.version {
			let _ = write!(body, "@{version}");
		}
		if !plugin.description.is_empty() {
			let _ = write!(body, " - {}", plugin.description);
		}
		body.push('\n');
	}
	Str::new(body)
}

/// `/marketplace installed` text.
fn installed_text(report: &PluginsReport) -> Str {
	let installed = report
		.plugins
		.iter()
		.filter(|plugin| plugin.installed)
		.collect::<Vec<_>>();
	if installed.is_empty() {
		return Str::new_static("No marketplace plugins installed");
	}
	let mut body = String::from("Installed plugins:\n");
	for plugin in installed {
		let _ = writeln!(
			body,
			"  {} [{}]{}",
			plugin.id,
			if plugin.scope.is_empty() {
				"user"
			} else {
				plugin.scope.as_str()
			},
			if plugin.shadowed { " [shadowed]" } else { "" }
		);
	}
	Str::new(body)
}

/// Wraps a preformatted text block as a markdown report body.
fn preformatted(text: &str) -> Str {
	sf!("```\n{}\n```", text.trim_end())
}

fn report(id: &'static str, title: &'static str, body: Str, cx: &PanelCx<'_>) -> Box<dyn Panel> {
	Box::new(ReportPanel::new(id, title, body, cx.ui))
}

fn services_error(error: impl std::fmt::Display) -> Str {
	sf!("Marketplace error: {error}")
}

/// Opens a loader over a marketplace request that settles with a line.
fn pending(
	id: &'static str,
	title: &'static str,
	message: Str,
	started: Result<
		crate::overlays::services::Pending<Str>,
		crate::overlays::services::ServiceError,
	>,
	cx: &PanelCx<'_>,
) -> Opened {
	let pending = started.map_err(services_error)?;
	Ok(Box::new(PendingPanel::new(
		id,
		PanelAnchor::Center,
		title,
		message,
		pending,
		None,
		Settle::Show,
		cx.ui,
	)))
}

fn open_selector(mode: PluginMode, cx: &PanelCx<'_>) -> Opened {
	PluginSelector::open(cx.services, mode, cx.ui)
		.map(|panel| Box::new(panel) as Box<dyn Panel>)
		.map_err(services_error)
}

fn marketplace_report(cx: &PanelCx<'_>) -> Result<PluginsReport, Str> {
	cx.services.plugins().map_err(services_error)
}

/// Builds the panel a `/marketplace` subcommand opens.
fn open_marketplace(op: &MarketplaceOp, cx: &PanelCx<'_>) -> Opened {
	Ok(match op {
		MarketplaceOp::Browse | MarketplaceOp::Install(None) => {
			return open_selector(PluginMode::Install, cx);
		},
		MarketplaceOp::Uninstall(None) => return open_selector(PluginMode::Uninstall, cx),
		MarketplaceOp::Help => {
			report("marketplace", "Marketplace", preformatted(MARKETPLACE_HELP), cx)
		},
		MarketplaceOp::List => {
			let text = marketplaces_text(&marketplace_report(cx)?);
			report("marketplace", "Marketplaces", preformatted(&text), cx)
		},
		MarketplaceOp::Discover(marketplace) => {
			let text = discover_text(&marketplace_report(cx)?, marketplace.as_deref());
			report("marketplace", "Available plugins", preformatted(&text), cx)
		},
		MarketplaceOp::Installed => {
			let text = installed_text(&marketplace_report(cx)?);
			report("marketplace", "Installed plugins", preformatted(&text), cx)
		},
		MarketplaceOp::Install(Some(_)) | MarketplaceOp::Uninstall(Some(_)) => {
			return Err(Str::new_static("Plugin mutation must travel through the controller"));
		},
		MarketplaceOp::Update(name) => {
			let message = name
				.as_ref()
				.map_or_else(|| sf!("Updating marketplaces…"), |name| sf!("Updating {name}…"));
			return pending(
				"marketplace",
				"Marketplace",
				message,
				cx.services.update_marketplace(name.as_deref()),
				cx,
			);
		},
		MarketplaceOp::Upgrade(spec) => {
			let message = spec
				.as_ref()
				.map_or_else(|| sf!("Upgrading plugins…"), |spec| sf!("Upgrading {spec}…"));
			return pending(
				"marketplace",
				"Marketplace",
				message,
				cx.services.upgrade_plugins(spec.as_deref()),
				cx,
			);
		},
		MarketplaceOp::Add(_) | MarketplaceOp::Remove(_) => {
			return Err(Str::new_static("Marketplace sources change through a host call"));
		},
	})
}

omp_con::cmd! {
	/// Shows the tools currently visible to the agent.
	tools() = |ctx, _args| {
		post(ctx, HostAction::Open(PanelOpener::new(|cx| {
			let rows = cx.services.tools().map_err(|error| sf!("{error}"))?;
			let roster = omp_session::components::lifecycle::roster(cx.dom);
			let body = tools_report(&rows, &roster)
				.ok_or_else(|| Str::new_static("No tools are available."))?;
			Ok(report("tools", "Tools", body, cx))
		})))
	};

	/// Opens the Extension Control Center dashboard.
	extensions() = |ctx, _args| {
		post(ctx, HostAction::Open(PanelOpener::new(|cx| {
			ExtensionsDashboard::open(cx.services, cx.ui)
				.map(|panel| Box::new(panel) as Box<dyn Panel>)
		})))
	};

	/// Opens the Extension Control Center dashboard (alias of `extensions`).
	status() = |ctx, _args| {
		post(ctx, HostAction::Open(PanelOpener::new(|cx| {
			ExtensionsDashboard::open(cx.services, cx.ui)
				.map(|panel| Box::new(panel) as Box<dyn Panel>)
		})))
	};

	/// Views and manages installed plugins: `/plugins [list|enable <id>|disable <id>]`.
	plugins(?op: Str, ?id: Str) = |ctx, args| {
		match plugins_op(super::rest(args, 0))? {
			PluginsOp::List => post(ctx, HostAction::Open(PanelOpener::new(|cx| {
				let body = plugins_report(&marketplace_report(cx)?)
					.ok_or_else(|| Str::new_static("No plugins installed"))?;
				Ok(report("plugins", "Plugins", preformatted(&body), cx))
			}))),
			PluginsOp::SetEnabled { id, enabled } => post(ctx, HostAction::Call(PanelCall::new(move |_cx| {
				PanelEvent::Command(HostCommand::Service(Mutation::SetPluginEnabled {
					id: id.clone(),
					enabled,
				}))
			}))),
		}
	};

	/// Manages marketplace plugin sources and installed plugins: `/marketplace [add|remove|update|list|discover|install|uninstall|installed|upgrade|help]`.
	marketplace(?op: Str, ?args: Str) = |ctx, args| {
		match marketplace_op(super::rest(args, 0))? {
			MarketplaceOp::Add(source) => post(ctx, HostAction::Call(PanelCall::new(move |cx| {
				match cx.services.add_marketplace(&source) {
					Ok(line) => PanelEvent::Notice(line),
					Err(error) => PanelEvent::Notice(services_error(error)),
				}
			}))),
			MarketplaceOp::Remove(name) => post(ctx, HostAction::Call(PanelCall::new(move |cx| {
				match cx.services.remove_marketplace(&name) {
					Ok(line) => PanelEvent::Notice(line),
					Err(error) => PanelEvent::Notice(services_error(error)),
				}
			}))),
			MarketplaceOp::Install(Some(id)) => post(ctx, HostAction::Call(PanelCall::new(move |_cx| {
				PanelEvent::Command(HostCommand::Service(Mutation::InstallPlugin { id: id.clone() }))
			}))),
			MarketplaceOp::Uninstall(Some(id)) => post(ctx, HostAction::Call(PanelCall::new(move |_cx| {
				PanelEvent::Command(HostCommand::Service(Mutation::UninstallPlugin { id: id.clone() }))
			}))),
			op => post(ctx, HostAction::Open(PanelOpener::new(move |cx| open_marketplace(&op, cx)))),
		}
	};

	/// Reloads all plugins (skills, commands, hooks, tools, agents, MCP).
	"reload-plugins"() = |ctx, _args| {
		post(ctx, HostAction::Call(PanelCall::new(|_cx| {
			PanelEvent::Command(HostCommand::Service(Mutation::ReloadExtensions))
		})))
	};
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::overlays::services::PluginRow;

	fn tool(name: &str, active: bool, tier: Option<&'static str>) -> ToolRow {
		ToolRow {
			name: Str::new(name),
			description: sf!("{name} does things.\nMore detail."),
			rev: 1,
			tier: tier.map(Str::new_static),
			active,
			source: Str::new_static("builtin"),
		}
	}

	#[test]
	fn tools_report_marks_roster_membership_and_counts() {
		let rows = [tool("read", true, Some("core")), tool("computer", true, None)];
		let body = tools_report(&rows, &[Str::new_static("read")]).expect("tools exist");
		assert!(body.starts_with("**Tools** (1 active / 2 available)"), "{body}");
		assert!(body.contains("* `read@1` [core] — read does things."), "{body}");
		assert!(body.contains("- `computer@1` — computer does things. _(disabled)_"), "{body}");
		let all = tools_report(&rows, &[]).expect("tools exist");
		assert!(all.starts_with("**Tools** (2 active / 2 available)"), "{all}");
		assert_eq!(tools_report(&[], &[]), None);
	}

	#[test]
	fn plugins_op_parses_list_enable_and_disable() {
		assert_eq!(plugins_op(None).unwrap(), PluginsOp::List);
		assert_eq!(plugins_op(Some(Str::new_static("list"))).unwrap(), PluginsOp::List);
		assert_eq!(
			plugins_op(Some(Str::new_static("enable docs@official"))).unwrap(),
			PluginsOp::SetEnabled { id: Str::new_static("docs@official"), enabled: true }
		);
		assert_eq!(
			plugins_op(Some(Str::new_static("disable docs"))).unwrap(),
			PluginsOp::SetEnabled { id: Str::new_static("docs"), enabled: false }
		);
		assert!(plugins_op(Some(Str::new_static("enable"))).is_err());
		assert!(plugins_op(Some(Str::new_static("frobnicate"))).is_err());
	}

	#[test]
	fn marketplace_op_parses_every_pi_subcommand() {
		let parse = |text: &'static str| marketplace_op(Some(Str::new_static(text))).unwrap();
		assert_eq!(marketplace_op(None).unwrap(), MarketplaceOp::Browse);
		assert_eq!(parse("add owner/repo"), MarketplaceOp::Add(Str::new_static("owner/repo")));
		assert_eq!(parse("rm official"), MarketplaceOp::Remove(Str::new_static("official")));
		assert_eq!(parse("update"), MarketplaceOp::Update(None));
		assert_eq!(
			parse("update official"),
			MarketplaceOp::Update(Some(Str::new_static("official")))
		);
		assert_eq!(parse("list"), MarketplaceOp::List);
		assert_eq!(parse("discover"), MarketplaceOp::Discover(None));
		assert_eq!(parse("install"), MarketplaceOp::Install(None));
		assert_eq!(
			parse("install docs@official"),
			MarketplaceOp::Install(Some(Str::new_static("docs@official")))
		);
		assert_eq!(parse("uninstall"), MarketplaceOp::Uninstall(None));
		assert_eq!(parse("installed"), MarketplaceOp::Installed);
		assert_eq!(parse("upgrade"), MarketplaceOp::Upgrade(None));
		assert_eq!(parse("help"), MarketplaceOp::Help);
		assert!(marketplace_op(Some(Str::new_static("add"))).is_err());
		assert!(marketplace_op(Some(Str::new_static("bogus"))).is_err());
	}

	#[test]
	fn plugin_texts_follow_pi_wording() {
		let mut report = PluginsReport::default();
		assert_eq!(plugins_report(&report), None);
		assert_eq!(marketplaces_text(&report).as_str(), "No marketplaces configured.");
		assert!(discover_text(&report, None).contains("No marketplaces configured. Try:"));
		assert_eq!(installed_text(&report).as_str(), "No marketplace plugins installed");
		report
			.sources
			.push(crate::overlays::services::MarketplaceSource {
				name: Str::new_static("official"),
				uri:  Str::new_static("anthropics/claude-plugins-official"),
			});
		report.marketplaces.push(Str::new_static("official"));
		assert_eq!(
			discover_text(&report, None).as_str(),
			"No plugins available in configured marketplaces"
		);
		report.plugins.push(PluginRow {
			id:          Str::new_static("docs@official"),
			name:        Str::new_static("docs"),
			version:     Some(Str::new_static("1.2.0")),
			description: Str::new_static("Docs helper"),
			marketplace: Str::new_static("official"),
			installed:   true,
			enabled:     false,
			scope:       Str::new_static("project"),
			shadowed:    false,
		});
		assert_eq!(
			plugins_report(&report).unwrap().as_str(),
			"marketplace plugins:\n  docs@official v1.2.0 (disabled) [project]\n"
		);
		assert_eq!(
			marketplaces_text(&report).as_str(),
			"Marketplaces:\n  official  anthropics/claude-plugins-official\n"
		);
		assert_eq!(
			discover_text(&report, Some("official")).as_str(),
			"Available plugins:\n  docs@1.2.0 - Docs helper\n"
		);
		assert_eq!(
			installed_text(&report).as_str(),
			"Installed plugins:\n  docs@official [project]\n"
		);
		assert!(MARKETPLACE_HELP.starts_with("Marketplace commands:"));
	}
}
