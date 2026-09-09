//! Extended CLI help assembled from native environment and tool metadata.

use std::fmt::Write as _;

use clap::Args as _;

/// Native environment variables understood during bootstrap and launch.
pub const ENVIRONMENT_VARIABLES: &[(&str, &str)] = &[
	("OMP_PROFILE", "named profile selected before settings load"),
	("OMP_DATA_DIR", "application data and credential root"),
	("OMP_CONFIG_FILES", "platform-separated command-stream cfg overlays"),
	("OMP_DEFAULT_MODEL", "primary model-role override"),
	("OMP_SMOL_MODEL", "fast/low-cost model-role override"),
	("OMP_SLOW_MODEL", "deep-reasoning model-role override"),
	("OMP_PLAN_MODEL", "planning model-role override"),
	("OMP_CODING_AGENT_SESSION_DIR", "session storage and lookup directory"),
	("OMP_NO_PTY", "disable PTY-backed shell execution when set to 1"),
	("OMP_WORKTREE_DIR", "isolated worktree base directory"),
	("OMP_PY_SITE", "supervised CPython site-packages root"),
];

/// Renders one `-s, --long <VALUE>` column for a named launch option.
fn option_column(argument: &clap::Arg) -> Option<String> {
	let long = argument.get_long()?;
	let mut column = argument
		.get_short()
		.map_or_else(|| format!("    --{long}"), |short| format!("-{short}, --{long}"));
	for alias in argument.get_visible_aliases().into_iter().flatten() {
		let _ = write!(column, ", --{alias}");
	}
	if argument.get_action().takes_values() {
		let value = argument
			.get_value_names()
			.and_then(<[_]>::first)
			.map_or_else(
				|| long.to_ascii_uppercase().replace('-', "_"),
				|name| name.as_str().to_owned(),
			);
		let _ = write!(column, " <{value}>");
	}
	Some(column)
}

/// Appends one aligned summary line per visible named option, skipping longs
/// listed in `excluded`.
fn append_options(output: &mut String, command: &clap::Command, excluded: &[&str]) {
	for argument in command.get_arguments() {
		let Some(long) = argument.get_long() else {
			continue;
		};
		if excluded.contains(&long) || argument.is_hide_set() {
			continue;
		}
		let Some(column) = option_column(argument) else {
			continue;
		};
		let help = argument
			.get_help()
			.map(ToString::to_string)
			.unwrap_or_default();
		let summary = help.lines().next().unwrap_or_default();
		let _ = writeln!(output, "  {column:<36} {summary}");
	}
}

/// Renders the extended reference appended to clap's root help: the launch
/// option surface shared by `chat`/`print`, transport routing, environment
/// variables, and built-in tools.
pub fn render() -> String {
	let chat = crate::cli::ChatArgs::augment_args(clap::Command::new("chat"));
	let print = crate::cli::PrintArgs::augment_args(clap::Command::new("print"));
	let mut excluded: Vec<&str> = vec!["help", "version"];
	let mut output = String::from(
		"Launch options (default `chat` command; accepted before or without a command):\n",
	);
	output.push_str(concat!(
		"      --profile <NAME>             Select an isolated profile before settings load\n",
		"      --alias <COMMAND>           Install a shell wrapper for the selected profile and \
		 exit\n",
		"  -p, --print                     Process the prompt non-interactively and exit\n",
	));
	append_options(&mut output, &chat, &excluded);
	excluded.extend(chat.get_arguments().filter_map(clap::Arg::get_long));
	output.push_str("\nHeadless additions (`-p`/`--print`, a leading prompt, or piped stdin):\n");
	append_options(&mut output, &print, &excluded);
	output.push_str(
		"\n`--mode <rpc|rpc-ui|acp>` routes to the matching stdio server command; `--mode \
		 <text|json>` selects print output.\n",
	);
	output.push_str("\nEnvironment variables:\n");
	for (name, description) in ENVIRONMENT_VARIABLES {
		let _ = writeln!(output, "  {name:<24} {description}");
	}
	output.push_str("\nBuilt-in tools:\n  ");
	let names = omp_tools::builtin_tool_identities()
		.iter()
		.filter(|tool| !tool.hidden)
		.map(|tool| tool.name)
		.collect::<Vec<_>>();
	output.push_str(&names.join(", "));
	output
}
