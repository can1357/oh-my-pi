//! `/` slash-command roster projected from the console registry: every
//! registered command is a palette entry whose description is its doc
//! comment, whose usage ghost lists its declared arguments, and whose first
//! argument completes through the console's own completer groups. A
//! submitted `/name args` line runs as the console statement `name args`.

use std::sync::Arc;

use omp_con::{Ctx, RegItem};
use omp_core::{Str, StrMut, sf};
use omp_tui::{Command, CommandArgument, Icon};

use crate::overlays::{Services, services::ExtensionKind};

/// Palette icons for the host's console-level commands that no command
/// module declares in its `PALETTE`; anything else shows no type
/// indicator, like extension-registered commands.
const ICONS: [(&str, Icon); 14] = [
	("cl_model_select", Icon::Model),
	("cl_model_cycle", Icon::Model),
	("cl_thinking_cycle", Icon::EyeSpeechThought),
	("cl_history_search", Icon::History),
	("cl_plan_toggle", Icon::Plan),
	("cl_editor_external", Icon::External),
	("cl_clear", Icon::Trash),
	("cl_exit", Icon::Exit),
	("cl_interrupt", Icon::Stop),
	("cl_retry", Icon::Refresh),
	("cl_display_reset", Icon::Refresh),
	("help", Icon::Help),
	("find", Icon::Search),
	("exec", Icon::Config),
];

struct McpSubcommand {
	name:        &'static str,
	description: &'static str,
	usage:       &'static str,
}

const MCP_SUBCOMMANDS: &[McpSubcommand] = &[
	McpSubcommand { name: "add", description: "Add a new MCP server", usage: "<name>" },
	McpSubcommand {
		name:        "list",
		description: "List configured MCP servers",
		usage:       "",
	},
	McpSubcommand {
		name:        "remove",
		description: "Remove an MCP server",
		usage:       "<name>",
	},
	McpSubcommand { name: "test", description: "Test an MCP server", usage: "<name>" },
	McpSubcommand { name: "reauth", description: "Reauthorize OAuth", usage: "<name>" },
	McpSubcommand {
		name:        "unauth",
		description: "Remove OAuth authorization",
		usage:       "<name>",
	},
	McpSubcommand {
		name:        "enable",
		description: "Enable an MCP server",
		usage:       "<name>",
	},
	McpSubcommand {
		name:        "disable",
		description: "Disable an MCP server",
		usage:       "<name>",
	},
	McpSubcommand {
		name:        "reconnect",
		description: "Reconnect an MCP server",
		usage:       "<name>",
	},
	McpSubcommand {
		name:        "reload",
		description: "Reload MCP runtime tools",
		usage:       "",
	},
	McpSubcommand { name: "resources", description: "List MCP resources", usage: "" },
	McpSubcommand { name: "prompts", description: "List MCP prompts", usage: "" },
	McpSubcommand {
		name:        "notifications",
		description: "Show MCP notification capabilities",
		usage:       "",
	},
	McpSubcommand {
		name:        "help",
		description: "Show MCP server management help",
		usage:       "",
	},
];

/// Builds the slash palette from `con`'s registered commands: the link-time
/// `cmd!` declarations, then the dynamic long tail (prompt templates) with
/// no type indicator, like extension-registered commands.
#[must_use]
pub fn roster(con: &Arc<Ctx>) -> Vec<Command> {
	let dynamic = con
		.dynamic_cmds()
		.map(|(name, desc)| Command::new(name, first_line(desc), &[]));
	con.items()
		.filter_map(|item| match item {
			RegItem::Cmd(spec) => Some(spec),
			RegItem::Var(_) | RegItem::Action(_) => None,
		})
		.map(|spec| {
			let mut command = Command::new(spec.name, first_line(spec.desc), &[]);
			let icon = crate::commands::palette_icon(spec.name).or_else(|| {
				ICONS
					.iter()
					.find(|(name, _)| *name == spec.name)
					.map(|(_, icon)| *icon)
			});
			if let Some(icon) = icon {
				command = command.with_icon(icon);
			}
			let usage = usage(spec.args);
			if !usage.is_empty() {
				command = command.with_hint(&usage);
			}
			if !spec.args.is_empty() {
				let con = Arc::clone(con);
				let name = spec.name;
				command = command.with_dynamic_args(move |partial| {
					let mut line = StrMut::new(name);
					line.push(' ');
					line.push_str(partial);
					let cursor = line.len();
					con.complete(line.as_str(), cursor)
						.into_iter()
						.map(|suggestion| CommandArgument {
							value:       suggestion.text,
							description: suggestion.help,
							usage:       None,
						})
						.collect()
				});
			}
			command
		})
		.chain(dynamic)
		.collect()
}

/// Attaches live service-backed argument sources after the console registry
/// has been projected. Extension and template command names are already
/// present through `Ctx::dynamic_cmds`; MCP additionally completes its
/// subcommands and the current MCP server roster.
#[must_use]
pub fn with_service_completions(
	mut roster: Vec<Command>,
	services: Arc<dyn Services>,
) -> Vec<Command> {
	for command in &mut roster {
		if command.name() != "mcp" {
			continue;
		}
		let services = Arc::clone(&services);
		*command = command
			.clone()
			.with_dynamic_args(move |partial| mcp_arguments(services.as_ref(), partial));
		break;
	}
	roster
}

fn mcp_arguments(services: &dyn Services, partial: &str) -> Box<[CommandArgument]> {
	let Some((raw_subcommand, name_prefix)) = partial.split_once(' ') else {
		let prefix = partial.to_ascii_lowercase();
		return MCP_SUBCOMMANDS
			.iter()
			.filter(|subcommand| subcommand.name.starts_with(&prefix))
			.map(|subcommand| CommandArgument {
				value:       Str::new_static(subcommand.name),
				description: Str::new_static(subcommand.description),
				usage:       (!subcommand.usage.is_empty()).then(|| Str::new_static(subcommand.usage)),
			})
			.collect();
	};
	if name_prefix.contains(char::is_whitespace) {
		return Box::default();
	}
	let subcommand = raw_subcommand.to_ascii_lowercase();
	if !matches!(
		subcommand.as_str(),
		"enable" | "disable" | "test" | "remove" | "reconnect" | "reauth" | "unauth"
	) {
		return Box::default();
	}
	let Ok(rows) = services.extensions() else {
		return Box::default();
	};
	let prefix = name_prefix.to_ascii_lowercase();
	let mut names = rows
		.into_iter()
		.filter(|row| row.kind == ExtensionKind::Mcp)
		.filter(|row| row.name.to_ascii_lowercase().starts_with(&prefix))
		.map(|row| {
			let description = row
				.description
				.unwrap_or_else(|| Str::new_static("MCP server"));
			CommandArgument { value: sf!("{raw_subcommand} {}", row.name), description, usage: None }
		})
		.collect::<Vec<_>>();
	names.sort_by(|left, right| {
		left
			.value
			.to_ascii_lowercase()
			.cmp(&right.value.to_ascii_lowercase())
	});
	names.dedup_by(|left, right| left.value.eq_ignore_ascii_case(&right.value));
	names.into_boxed_slice()
}

/// First line of a doc-comment description, without its leading space.
fn first_line(desc: &str) -> &str {
	desc.lines().next().unwrap_or_default().trim()
}

/// `<required> [optional]` usage text from declared arguments.
fn usage(args: &[omp_con::ArgSpec]) -> Str {
	let mut out = StrMut::new("");
	for (index, arg) in args.iter().enumerate() {
		if index > 0 {
			out.push(' ');
		}
		let (open, close) = if arg.required { ('<', '>') } else { ('[', ']') };
		out.push(open);
		out.push_str(arg.name);
		out.push(close);
	}
	out.freeze()
}

#[cfg(test)]
mod tests {
	use omp_con::{CtxBuilder, DynamicCmdSpec};
	use omp_tui::{EditorCompletion, SlashCommands, SuggestionDisplay};

	use super::*;

	struct McpServices;

	impl Services for McpServices {
		fn extensions(
			&self,
		) -> crate::overlays::services::ServiceResult<Vec<crate::overlays::services::ExtensionRow>>
		{
			use crate::overlays::services::{ExtensionKind, ExtensionRow, ExtensionStatus};
			Ok(vec![
				ExtensionRow {
					id:          "alpha".into(),
					name:        "Alpha".into(),
					kind:        ExtensionKind::Mcp,
					status:      ExtensionStatus::Ready,
					enabled:     true,
					version:     None,
					description: Some("Primary server".into()),
					tools:       Vec::new(),
					resources:   Vec::new(),
					prompts:     Vec::new(),
					error:       None,
				},
				ExtensionRow {
					id:          "python".into(),
					name:        "Alpha Python".into(),
					kind:        ExtensionKind::Python,
					status:      ExtensionStatus::Ready,
					enabled:     true,
					version:     None,
					description: None,
					tools:       Vec::new(),
					resources:   Vec::new(),
					prompts:     Vec::new(),
					error:       None,
				},
			])
		}
	}

	#[allow(
		clippy::unnecessary_wraps,
		reason = "dynamic command handlers use the fallible console signature"
	)]
	fn dynamic_command(_ctx: &Ctx, _name: &str, _args: &[omp_con::Arg]) -> omp_con::ConResult<()> {
		Ok(())
	}

	fn labels(suggestions: &omp_tui::Suggestions) -> Vec<&str> {
		suggestions
			.items
			.iter()
			.map(|item| match item.display() {
				SuggestionDisplay::Text(label) => label.as_str(),
				SuggestionDisplay::Emoji { .. } => unreachable!(),
			})
			.collect()
	}

	#[test]
	fn console_builtins_become_palette_rows_with_usage_and_icons() {
		let con = Arc::new(CtxBuilder::default().build());
		let roster = roster(&con);
		let help = roster
			.iter()
			.find(|command| command.name() == "help")
			.expect("`help` is a console builtin");
		assert_eq!(help.icon(), Some(Icon::Help));
		assert!(help.description().starts_with("Shows a name"), "{}", help.description());
		let mut slash = SlashCommands::new(roster);
		let rows = slash.suggest("/he", 3).expect("slash rows");
		assert!(labels(&rows).iter().any(|label| *label == "help"), "{:?}", labels(&rows));
		// The usage ghost lists the declared optional argument.
		assert_eq!(slash.hint("/help ", 6).as_deref(), Some("[name]"));
	}

	#[test]
	fn product_commands_carry_their_module_palette_icon() {
		// Every `/command` row shows its type
		// indicator; the icon comes from the declaring module's `PALETTE`,
		// not from the console-level side table.
		let con = Arc::new(CtxBuilder::default().build());
		let roster = roster(&con);
		let by_name = |name: &str| {
			roster
				.iter()
				.find(|command| command.name() == name)
				.unwrap_or_else(|| panic!("`{name}` is a registered slash command"))
		};
		assert_eq!(by_name("settings").icon(), Some(Icon::Gear));
		assert_eq!(by_name("model").icon(), Some(Icon::Model));
		assert_eq!(by_name("plan").icon(), Some(Icon::Plan));
		assert_eq!(by_name("git").icon(), Some(Icon::Branch));
	}

	#[test]
	fn first_argument_completes_through_the_console_completer() {
		let con = Arc::new(CtxBuilder::default().build());
		let mut slash = SlashCommands::new(roster(&con));
		let rows = slash.suggest("/help fi", 8).expect("argument rows");
		assert!(labels(&rows).iter().any(|label| *label == "find"), "{:?}", labels(&rows));
	}

	#[test]
	fn dynamic_extension_and_template_names_join_the_slash_roster() {
		// This test owns only the runtime source. Static builtins have their
		// own roster proof above and intentionally fuzzy-match `/ext`.
		let con = Arc::new(CtxBuilder::default().isolated().build());
		con.register_dynamic_cmd(DynamicCmdSpec {
			name:    "extension-action".into(),
			desc:    "Extension command".into(),
			handler: dynamic_command,
		})
		.expect("extension command");
		con.register_dynamic_cmd(DynamicCmdSpec {
			name:    "review-template".into(),
			desc:    "Prompt template".into(),
			handler: dynamic_command,
		})
		.expect("template command");
		let mut slash = SlashCommands::new(roster(&con));
		assert_eq!(labels(&slash.suggest("/ext", 4).expect("extension row")), ["extension-action"]);
		assert_eq!(labels(&slash.suggest("/review", 7).expect("template row")), ["review-template"]);
	}

	#[test]
	fn mcp_completes_subcommands_then_live_server_names() {
		let con = Arc::new(CtxBuilder::default().build());
		let roster = with_service_completions(roster(&con), Arc::new(McpServices));
		let mut slash = SlashCommands::new(roster);
		let subcommands = slash.suggest("/mcp te", 7).expect("MCP subcommands");
		assert_eq!(labels(&subcommands), ["test"]);
		assert_eq!(subcommands.items[0].value(), "test ");
		let servers = slash.suggest("/mcp test al", 12).expect("MCP server names");
		assert_eq!(servers.items.len(), 1, "non-MCP extension rows stay hidden");
		assert_eq!(servers.items[0].value(), "test Alpha ");
	}
}
