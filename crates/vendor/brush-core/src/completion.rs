//! Implements programmable command completion support.

use std::{
	borrow::Cow,
	collections::HashMap,
	path::{Path, PathBuf},
};

use brush_parser::unquote_str;
use clap::ValueEnum;
use strum::IntoEnumIterator;

use crate::{
	Shell, commands, env, error, escape, expansion, extensions, interfaces, jobs, namedoptions,
	patterns,
	sys::{self, users},
	trace_categories, traps,
	variables::{self, ShellValueLiteral},
};

/// Type of action to take to generate completion candidates.
#[derive(Clone, Debug, ValueEnum)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum CompleteAction {
	/// Complete with valid aliases.
	#[clap(name = "alias")]
	Alias,
	/// Complete with names of array shell variables.
	#[clap(name = "arrayvar")]
	ArrayVar,
	/// Complete with names of key bindings.
	#[clap(name = "binding")]
	Binding,
	/// Complete with names of shell builtins.
	#[clap(name = "builtin")]
	Builtin,
	/// Complete with names of executable commands.
	#[clap(name = "command")]
	Command,
	/// Complete with directory names.
	#[clap(name = "directory")]
	Directory,
	/// Complete with names of disabled shell builtins.
	#[clap(name = "disabled")]
	Disabled,
	/// Complete with names of enabled shell builtins.
	#[clap(name = "enabled")]
	Enabled,
	/// Complete with names of exported shell variables.
	#[clap(name = "export")]
	Export,
	/// Complete with filenames.
	#[clap(name = "file")]
	File,
	/// Complete with names of shell functions.
	#[clap(name = "function")]
	Function,
	/// Complete with valid user groups.
	#[clap(name = "group")]
	Group,
	/// Complete with names of valid shell help topics.
	#[clap(name = "helptopic")]
	HelpTopic,
	/// Complete with the system's hostname(s).
	#[clap(name = "hostname")]
	HostName,
	/// Complete with the command names of shell-managed jobs.
	#[clap(name = "job")]
	Job,
	/// Complete with valid shell keywords.
	#[clap(name = "keyword")]
	Keyword,
	/// Complete with the command names of running shell-managed jobs.
	#[clap(name = "running")]
	Running,
	/// Complete with names of system services.
	#[clap(name = "service")]
	Service,
	/// Complete with the names of options settable via shopt.
	#[clap(name = "setopt")]
	SetOpt,
	/// Complete with the names of options settable via set -o.
	#[clap(name = "shopt")]
	ShOpt,
	/// Complete with the names of trappable signals.
	#[clap(name = "signal")]
	Signal,
	/// Complete with the command names of stopped shell-managed jobs.
	#[clap(name = "stopped")]
	Stopped,
	/// Complete with valid usernames.
	#[clap(name = "user")]
	User,
	/// Complete with names of shell variables.
	#[clap(name = "variable")]
	Variable,
}

/// Options influencing how command completions are generated.
#[derive(Clone, Debug, Eq, Hash, PartialEq, ValueEnum)]
pub enum CompleteOption {
	/// Perform rest of default completions if no completions are generated.
	#[clap(name = "bashdefault")]
	BashDefault,
	/// Use default filename completion if no completions are generated.
	#[clap(name = "default")]
	Default,
	/// Treat completions as directory names.
	#[clap(name = "dirnames")]
	DirNames,
	/// Treat completions as filenames.
	#[clap(name = "filenames")]
	FileNames,
	/// Suppress default auto-quotation of completions.
	#[clap(name = "noquote")]
	NoQuote,
	/// Do not sort completions.
	#[clap(name = "nosort")]
	NoSort,
	/// Do not append a trailing space to completions at the end of the input
	/// line.
	#[clap(name = "nospace")]
	NoSpace,
	/// Also generate directory completions.
	#[clap(name = "plusdirs")]
	PlusDirs,
}

/// Encapsulates the shell's programmable command completion configuration.
#[derive(Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct Config {
	commands: HashMap<String, Spec>,

	/// Optionally, a completion spec to be used as a default, when earlier
	/// matches yield no candidates.
	pub default:      Option<Spec>,
	/// Optionally, a completion spec to be used when the command line is empty.
	pub empty_line:   Option<Spec>,
	/// Optionally, a completion spec to be used for the initial word of a
	/// command line.
	pub initial_word: Option<Spec>,

	/// Optionally, stores the current completion options in effect. May be
	/// mutated while a completion generation is in-flight.
	pub current_completion_options: Option<GenerationOptions>,

	/// Fallback options to use when 'default' completions are requested (not to
	/// be confused with the 'default' completion spec, nor 'bashdefault'
	/// completions).
	pub fallback_options: FallbackOptions,
}

/// Options for fallback completions.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct FallbackOptions {
	/// If true, mark directory completions with a trailing slash.
	pub mark_directories:           bool,
	/// If true, mark symlinked directory completions with a trailing slash.
	pub mark_symlinked_directories: bool,
}

impl Default for FallbackOptions {
	fn default() -> Self {
		Self { mark_directories: true, mark_symlinked_directories: false }
	}
}

/// Options for generating completions.
#[derive(Clone, Debug, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct GenerationOptions {
	//
	// Options
	/// Perform rest of default completions if no completions are generated.
	pub bash_default: bool,
	/// Use default readline-style filename completion if no completions are
	/// generated.
	pub default:      bool,
	/// Treat completions as directory names.
	pub dir_names:    bool,
	/// Treat completions as filenames.
	pub file_names:   bool,
	/// Do not add usual quoting for completions.
	pub no_quote:     bool,
	/// Do not sort completions.
	pub no_sort:      bool,
	/// Do not append typical space to a completion at the end of the input line.
	pub no_space:     bool,
	/// Also complete with directory names.
	pub plus_dirs:    bool,
}

/// Encapsulates a command completion specification; provides policy for how to
/// generate completions for a given input.
#[derive(Clone, Debug, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct Spec {
	//
	// Options
	/// Options to use for completion.
	pub options: GenerationOptions,

	//
	// Generators
	/// Actions to take to generate completions.
	pub actions:       Vec<CompleteAction>,
	/// Optionally, a glob pattern whose expansion will be used as completions.
	pub glob_pattern:  Option<String>,
	/// Optionally, a list of words to use as completions.
	pub word_list:     Option<String>,
	/// Optionally, the name of a shell function to invoke to generate
	/// completions.
	pub function_name: Option<String>,
	/// Optionally, the name of a command to execute to generate completions.
	pub command:       Option<String>,

	//
	// Filters
	/// Optionally, a pattern to filter completions.
	pub filter_pattern:          Option<String>,
	/// If true, completion candidates matching `filter_pattern` are removed;
	/// otherwise, those not matching it are removed.
	pub filter_pattern_excludes: bool,

	//
	// Transformers
	/// Optionally, provides a prefix to be prepended to all completion
	/// candidates.
	pub prefix: Option<String>,
	/// Optionally, provides a suffix to be prepended to all completion
	/// candidates.
	pub suffix: Option<String>,
}

/// Describes what triggered the completion process.
#[derive(Clone, Copy, Debug, Default)]
pub enum CompletionTrigger {
	/// Interactive completion triggered by Tab key (normal completion).
	#[default]
	InteractiveComplete,
	/// Programmatic generation via the `compgen` builtin.
	Programmatic,
}

impl CompletionTrigger {
	/// Returns the `COMP_TYPE` value for this trigger.
	pub const fn comp_type(self) -> i32 {
		match self {
			Self::InteractiveComplete => 9, // TAB = normal completion
			Self::Programmatic => 0,
		}
	}

	/// Returns the `COMP_KEY` value for this trigger.
	pub const fn comp_key(self) -> i32 {
		match self {
			Self::InteractiveComplete => 9, // TAB key
			Self::Programmatic => 0,
		}
	}
}

/// Encapsulates context used during completion generation.
#[derive(Debug)]
pub struct Context<'a> {
	/// The token to complete.
	pub token_to_complete: &'a str,

	/// If available, the name of the command being invoked.
	pub command_name:    Option<&'a str>,
	/// If there was one, the token preceding the one being completed.
	pub preceding_token: Option<&'a str>,

	/// The 0-based index of the token to complete.
	pub token_index: usize,

	/// The input line.
	pub input_line:   &'a str,
	/// The 0-based index of the cursor in the input line.
	pub cursor_index: usize,
	/// The tokens in the input line.
	pub tokens:       &'a [&'a CompletionToken<'a>],

	/// What triggered the completion.
	pub trigger: CompletionTrigger,
}

impl Spec {
	/// Generates completion candidates using this specification.
	///
	/// # Arguments
	///
	/// * `shell` - The shell instance to use for completion generation.
	/// * `context` - The context in which completion is being generated.
	#[expect(clippy::too_many_lines)]
	pub async fn get_completions(
		&self,
		shell: &mut Shell<impl extensions::ShellExtensions>,
		context: &Context<'_>,
	) -> Result<Answer, crate::error::Error> {
		// Store the current options in the shell; this is needed since the compopt
		// built-in has the ability of modifying the options for an in-flight
		// completion process.
		shell.completion_config_mut().current_completion_options = Some(self.options.clone());

		// Generate completions based on any provided actions (and on words).
		let mut candidates = self.generate_action_completions(shell, context).await?;
		if let Some(word_list) = &self.word_list {
			let params = shell.default_exec_params();
			// Per POSIX / bash docs, -W word list is subject to shell expansion
			// and field splitting but NOT pathname expansion (globbing).
			let options =
				crate::expansion::ExpanderOptions { pathname_expand: false, ..Default::default() };
			let words = crate::expansion::full_expand_and_split_word_with_options(
				shell, &params, word_list, &options,
			)
			.await?;
			for word in words {
				if word.starts_with(context.token_to_complete) {
					candidates.push(word);
				}
			}
		}

		if let Some(glob_pattern) = &self.glob_pattern {
			let pattern = patterns::Pattern::from(glob_pattern.as_str())
				.set_extended_globbing(shell.options().extended_globbing)
				.set_case_insensitive(shell.options().case_insensitive_pathname_expansion);

			let expansions = pattern
				.expand(
					shell.working_dir(),
					Some(&patterns::Pattern::accept_all_expand_filter),
					&patterns::FilenameExpansionOptions::default(),
				)?
				.into_paths();

			for expansion in expansions {
				candidates.push(expansion);
			}
		}
		if let Some(function_name) = &self.function_name {
			let call_result = self
				.call_completion_function(shell, function_name.as_str(), context)
				.await?;

			match call_result {
				Answer::RestartCompletionProcess => return Ok(call_result),
				Answer::Candidates(mut new_candidates, _options) => {
					candidates.append(&mut new_candidates);
				},
			}
		}
		if let Some(command) = &self.command {
			let mut new_candidates = self
				.call_completion_command(shell, command.as_str(), context)
				.await?;
			candidates.append(&mut new_candidates);
		}

		// Apply filter pattern, if present. Anything the filter selects gets removed.
		if let Some(filter_pattern) = &self.filter_pattern
			&& !filter_pattern.is_empty()
		{
			let mut updated = Vec::new();

			for candidate in candidates {
				let matches = completion_filter_pattern_matches(
					filter_pattern.as_str(),
					candidate.as_str(),
					context.token_to_complete,
					shell,
				)?;

				if self.filter_pattern_excludes != matches {
					updated.push(candidate);
				}
			}

			candidates = updated;
		}

		// Add prefix and/or suffix, if present.
		if self.prefix.is_some() || self.suffix.is_some() {
			let empty = String::new();
			let prefix = self.prefix.as_ref().unwrap_or(&empty);
			let suffix = self.suffix.as_ref().unwrap_or(&empty);

			let mut updated = Vec::new();
			for candidate in candidates {
				updated.push(std::format!("{prefix}{candidate}{suffix}"));
			}

			candidates = updated;
		}

		//
		// Now apply options
		//

		let options = if let Some(options) = &shell.completion_config().current_completion_options {
			options
		} else {
			&self.options
		};

		let mut processing_options = ProcessingOptions {
			treat_as_filenames:               options.file_names,
			no_autoquote_filenames:           options.no_quote,
			no_trailing_space_at_end_of_line: options.no_space,
		};

		if options.plus_dirs || options.dir_names {
			// Also add dir name completion.
			let mut dir_candidates =
				get_file_completions(shell, context.token_to_complete, /* must_be_dir */ true).await;
			candidates.append(&mut dir_candidates);
		}

		// If we still have no candidates, and bashdefault completions were requested,
		// then generate those.
		if candidates.is_empty() && options.bash_default {
			// TODO(completions): it's not clear what default "bash" completions means. From
			// basic testing, this doesn't seem to include basic file and directory name
			// completion.
			tracing::debug!(target: trace_categories::COMPLETION, "unimplemented: complete -o bashdefault");
		}

		// If we still have no candidates, and default completions were requested, then
		// generate those.
		if candidates.is_empty() && options.default {
			// N.B. We approximate "default" readline completion behavior by getting file
			// and dir completions.
			let must_be_dir = options.dir_names;

			let mut default_candidates =
				get_file_completions(shell, context.token_to_complete, must_be_dir).await;
			candidates.append(&mut default_candidates);

			if shell.completion_config().fallback_options.mark_directories {
				processing_options.treat_as_filenames = true;
			}
		}

		// Sort, unless blocked by options.
		if !self.options.no_sort {
			candidates.sort();
		}

		Ok(Answer::Candidates(candidates, processing_options))
	}

	#[expect(clippy::too_many_lines)]
	async fn generate_action_completions(
		&self,
		shell: &Shell<impl extensions::ShellExtensions>,
		context: &Context<'_>,
	) -> Result<Vec<String>, error::Error> {
		let mut candidates = Vec::new();

		let token = context.token_to_complete;

		for action in &self.actions {
			match action {
				CompleteAction::Alias => {
					for name in shell.aliases().keys() {
						if name.starts_with(token) {
							candidates.push(name.clone());
						}
					}
				},
				CompleteAction::ArrayVar => {
					for (name, var) in shell.env().iter() {
						if var.value().is_array() && name.starts_with(token) {
							candidates.push(name.to_owned());
						}
					}
				},
				CompleteAction::Binding => {
					for input_func in interfaces::InputFunction::iter() {
						let name: &'static str = input_func.into();
						if name.starts_with(token) {
							candidates.push(name.to_string());
						}
					}
				},
				CompleteAction::Builtin => {
					for name in shell.builtins().keys() {
						if name.starts_with(token) {
							candidates.push(name.to_owned());
						}
					}
				},
				CompleteAction::Command => {
					let mut command_completions =
						get_external_command_completions(shell, context.token_to_complete);
					candidates.append(&mut command_completions);
					for name in shell.builtins().keys() {
						if name.starts_with(token) {
							candidates.push(name.to_owned());
						}
					}
					for keyword in shell.get_keywords() {
						if keyword.starts_with(token) {
							candidates.push(keyword.to_string());
						}
					}
					for (name, _) in shell.funcs().iter() {
						candidates.push(name.to_owned());
					}
				},
				CompleteAction::Directory => {
					let mut file_completions =
						get_file_completions(shell, context.token_to_complete, true).await;
					candidates.append(&mut file_completions);
				},
				CompleteAction::Disabled => {
					for (name, registration) in shell.builtins() {
						if registration.disabled && name.starts_with(token) {
							candidates.push(name.to_owned());
						}
					}
				},
				CompleteAction::Enabled => {
					for (name, registration) in shell.builtins() {
						if !registration.disabled && name.starts_with(token) {
							candidates.push(name.to_owned());
						}
					}
				},
				CompleteAction::Export => {
					for (key, value) in shell.env().iter() {
						if value.is_exported() && key.starts_with(token) {
							candidates.push(key.to_owned());
						}
					}
				},
				CompleteAction::File => {
					let mut file_completions =
						get_file_completions(shell, context.token_to_complete, false).await;
					candidates.append(&mut file_completions);
				},
				CompleteAction::Function => {
					for (name, _) in shell.funcs().iter() {
						candidates.push(name.to_owned());
					}
				},
				CompleteAction::Group => {
					for group_name in users::get_all_groups()? {
						if group_name.starts_with(token) {
							candidates.push(group_name);
						}
					}
				},
				CompleteAction::HelpTopic => {
					// For now, we only have help topics for built-in commands.
					for name in shell.builtins().keys() {
						if name.starts_with(token) {
							candidates.push(name.to_owned());
						}
					}
				},
				CompleteAction::HostName => {
					// N.B. We only retrieve one hostname.
					if let Ok(name) = sys::network::get_hostname() {
						let name = name.to_string_lossy();
						if name.starts_with(token) {
							candidates.push(name.to_string());
						}
					}
				},
				CompleteAction::Job => {
					for job in &shell.jobs().jobs {
						let command_name = job.command_name();
						if command_name.starts_with(token) {
							candidates.push(command_name.to_owned());
						}
					}
				},
				CompleteAction::Keyword => {
					for keyword in shell.get_keywords() {
						if keyword.starts_with(token) {
							candidates.push(keyword.to_string());
						}
					}
				},
				CompleteAction::Running => {
					for job in &shell.jobs().jobs {
						if matches!(job.state, jobs::JobState::Running) {
							let command_name = job.command_name();
							if command_name.starts_with(token) {
								candidates.push(command_name.to_owned());
							}
						}
					}
				},
				CompleteAction::Service => {
					tracing::debug!(target: trace_categories::COMPLETION, "unimplemented: complete -A service");
				},
				CompleteAction::SetOpt => {
					for option in namedoptions::options(namedoptions::ShellOptionKind::SetO).iter() {
						if option.name.starts_with(token) {
							candidates.push(option.name.to_owned());
						}
					}
				},
				CompleteAction::ShOpt => {
					for option in namedoptions::options(namedoptions::ShellOptionKind::Shopt).iter() {
						if option.name.starts_with(token) {
							candidates.push(option.name.to_owned());
						}
					}
				},
				CompleteAction::Signal => {
					for signal in traps::TrapSignal::iterator() {
						if signal.as_str().starts_with(token) {
							candidates.push(signal.as_str().to_string());
						}
					}
				},
				CompleteAction::Stopped => {
					for job in &shell.jobs().jobs {
						if matches!(job.state, jobs::JobState::Stopped) {
							let command_name = job.command_name();
							if command_name.starts_with(token) {
								candidates.push(job.command_name().to_owned());
							}
						}
					}
				},
				CompleteAction::User => {
					for user_name in users::get_all_users()? {
						if user_name.starts_with(token) {
							candidates.push(user_name);
						}
					}
				},
				CompleteAction::Variable => {
					for (key, _) in shell.env().iter() {
						if key.starts_with(token) {
							candidates.push(key.to_owned());
						}
					}
				},
			}
		}

		Ok(candidates)
	}

	async fn call_completion_command(
		&self,
		shell: &Shell<impl extensions::ShellExtensions>,
		command_name: &str,
		context: &Context<'_>,
	) -> Result<Vec<String>, error::Error> {
		// Move to a subshell so we can start filling out variables.
		let mut shell = shell.clone();

		let vars_and_values: Vec<(&str, ShellValueLiteral)> = vec![
			("COMP_LINE", context.input_line.into()),
			("COMP_POINT", context.cursor_index.to_string().into()),
			("COMP_KEY", context.trigger.comp_key().to_string().into()),
			("COMP_TYPE", context.trigger.comp_type().to_string().into()),
		];

		// Fill out variables.
		for (var, value) in vars_and_values {
			shell.env_mut().update_or_add(
				var,
				value,
				|v| {
					v.export();
					Ok(())
				},
				env::EnvironmentLookup::Anywhere,
				env::EnvironmentScope::Global,
			)?;
		}

		// Compute args.
		let mut args = vec![context.command_name.unwrap_or(""), context.token_to_complete];
		if let Some(preceding_token) = context.preceding_token {
			args.push(preceding_token);
		}

		// Compose the full command line.
		let mut command_line = command_name.to_owned();
		for arg in args {
			command_line.push(' ');

			let escaped_arg = escape::quote_if_needed(arg, escape::QuoteMode::SingleQuote);
			command_line.push_str(escaped_arg.as_ref());
		}

		// Run the command.
		let params = shell.default_exec_params();
		let output =
			commands::invoke_command_in_subshell_and_get_output(&mut shell, &params, command_line)
				.await?;

		// Split results.
		let mut candidates = Vec::new();
		for line in output.lines() {
			candidates.push(line.to_owned());
		}

		Ok(candidates)
	}

	async fn call_completion_function(
		&self,
		shell: &mut Shell<impl extensions::ShellExtensions>,
		function_name: &str,
		context: &Context<'_>,
	) -> Result<Answer, error::Error> {
		// TODO(completions): Don't pollute the persistent environment with these?
		let vars_and_values: Vec<(&str, ShellValueLiteral)> = vec![
			("COMP_LINE", context.input_line.into()),
			("COMP_POINT", context.cursor_index.to_string().into()),
			("COMP_KEY", context.trigger.comp_key().to_string().into()),
			("COMP_TYPE", context.trigger.comp_type().to_string().into()),
			(
				"COMP_WORDS",
				context
					.tokens
					.iter()
					.map(|t| t.text)
					.collect::<Vec<_>>()
					.into(),
			),
			("COMP_CWORD", context.token_index.to_string().into()),
		];

		tracing::debug!(target: trace_categories::COMPLETION, "[calling completion func '{function_name}']: {}",
            vars_and_values.iter().map(|(k, v)| std::format!("{k}={v}")).collect::<Vec<String>>().join(" "));

		let mut vars_to_remove = Vec::with_capacity(vars_and_values.len());
		for (var, value) in vars_and_values {
			shell.env_mut().update_or_add(
				var,
				value,
				|_| Ok(()),
				env::EnvironmentLookup::Anywhere,
				env::EnvironmentScope::Global,
			)?;

			vars_to_remove.push(var);
		}

		let mut args = vec![context.command_name.unwrap_or(""), context.token_to_complete];
		if let Some(preceding_token) = context.preceding_token {
			args.push(preceding_token);
		}

		// Suppress trap delivery during completion function invocation.
		// N.B. We use manual acquire/release rather than an RAII guard because an
		// RAII guard would need to hold `&mut Shell`, preventing the mutable borrow
		// required by `invoke_function()`. This is safe because `invoke_result` is
		// captured into a variable (never early-returned with `?`), so
		// `release_trap_delivery_block()` always runs.
		shell.acquire_trap_delivery_block();

		let params = shell.default_exec_params();
		let invoke_result = shell
			.invoke_function(function_name, args.iter(), &params)
			.await;

		tracing::debug!(target: trace_categories::COMPLETION, "[completion function '{function_name}' returned: {invoke_result:?}]");

		shell.release_trap_delivery_block();

		// Make a best-effort attempt to unset the temporary variables.
		for var_name in vars_to_remove {
			let _ = shell.env_mut().unset(var_name);
		}

		let result = invoke_result.unwrap_or_else(|e| {
            tracing::warn!(target: trace_categories::COMPLETION, "error while running completion function '{function_name}': {e}");
            1 // Report back a non-zero exit code.
        });

		// When the function returns the special value 124, then it's a request
		// for us to restart the completion process.
		if result == 124 {
			Ok(Answer::RestartCompletionProcess)
		} else {
			if let Some(reply) = shell.env_mut().unset("COMPREPLY")? {
				tracing::debug!(target: trace_categories::COMPLETION, "[completion function yielded: {reply:?}]");

				match reply.value() {
					variables::ShellValue::IndexedArray(values) => {
						return Ok(Answer::Candidates(
							values.values().map(|v| v.to_owned()).collect(),
							ProcessingOptions::default(),
						));
					},
					variables::ShellValue::String(s) => {
						let candidates = vec![s.to_owned()];
						return Ok(Answer::Candidates(candidates, ProcessingOptions::default()));
					},
					_ => (),
				}
			}

			Ok(Answer::Candidates(Vec::new(), ProcessingOptions::default()))
		}
	}
}

/// Represents a set of generated command completions.
#[derive(Debug, Default)]
pub struct Completions {
	/// The index in the input line where the completions should be inserted.
	/// Represented as a byte offset into the input line; must be at a clean
	/// character boundary.
	pub insertion_index: usize,
	/// The number of elements in the input line that should be removed before
	/// insertion. Represented as a byte count; must capture an exact character
	/// boundary.
	pub delete_count:    usize,
	/// The ordered set of completions.
	pub candidates:      Vec<String>,
	/// Options for processing the candidates.
	pub options:         ProcessingOptions,
}

/// Options governing how command completion candidates are processed after
/// being generated.
#[derive(Debug)]
pub struct ProcessingOptions {
	/// Treat completions as file names.
	pub treat_as_filenames:               bool,
	/// Don't auto-quote completions that are file names.
	pub no_autoquote_filenames:           bool,
	/// Don't append a trailing space to completions at the end of the input
	/// line.
	pub no_trailing_space_at_end_of_line: bool,
}

/// Represents a token in the input line being completed.
#[derive(Debug, Clone, Copy)]
pub struct CompletionToken<'a> {
	/// The text of the token.
	pub text:  &'a str,
	/// The start of the token, expressed as a byte offset into the input line.
	pub start: usize,
}

impl CompletionToken<'_> {
	/// Returns the length of the token, expressed as a byte count.
	pub const fn length(&self) -> usize {
		self.text.len()
	}

	/// Returns the end of the token, expressed as a byte offset into the input
	/// line.
	pub const fn end(&self) -> usize {
		self.start + self.length()
	}
}

impl Default for ProcessingOptions {
	fn default() -> Self {
		Self {
			treat_as_filenames:               true,
			no_autoquote_filenames:           false,
			no_trailing_space_at_end_of_line: false,
		}
	}
}

/// Encapsulates a completion answer.
pub enum Answer {
	/// The completion process generated a set of candidates along with options
	/// controlling how to process them.
	Candidates(Vec<String>, ProcessingOptions),
	/// The completion process needs to be restarted.
	RestartCompletionProcess,
}

const EMPTY_COMMAND: &str = "_EmptycmD_";
const DEFAULT_COMMAND: &str = "_DefaultCmD_";
const INITIAL_WORD: &str = "_InitialWorD_";

impl Config {
	/// Removes all registered completion specs.
	pub fn clear(&mut self) {
		self.commands.clear();
		self.empty_line = None;
		self.default = None;
		self.initial_word = None;
	}

	/// Ensures the named completion spec is no longer registered; returns
	/// whether a removal operation was required.
	///
	/// # Arguments
	///
	/// * `name` - The name of the completion spec to remove.
	pub fn remove(&mut self, name: &str) -> bool {
		match name {
			EMPTY_COMMAND => {
				let result = self.empty_line.is_some();
				self.empty_line = None;
				result
			},
			DEFAULT_COMMAND => {
				let result = self.default.is_some();
				self.default = None;
				result
			},
			INITIAL_WORD => {
				let result = self.initial_word.is_some();
				self.initial_word = None;
				result
			},
			_ => self.commands.remove(name).is_some(),
		}
	}

	/// Returns an iterator over the completion specs.
	pub fn iter(&self) -> impl Iterator<Item = (&String, &Spec)> {
		self.commands.iter()
	}

	/// If present, returns the completion spec for the command of the given
	/// name.
	///
	/// # Arguments
	///
	/// * `name` - The name of the command.
	pub fn get(&self, name: &str) -> Option<&Spec> {
		match name {
			EMPTY_COMMAND => self.empty_line.as_ref(),
			DEFAULT_COMMAND => self.default.as_ref(),
			INITIAL_WORD => self.initial_word.as_ref(),
			_ => self.commands.get(name),
		}
	}

	/// If present, sets the provided completion spec to be associated with the
	/// command of the given name.
	///
	/// # Arguments
	///
	/// * `name` - The name of the command.
	/// * `spec` - The completion spec to associate with the command.
	pub fn set(&mut self, name: &str, spec: Spec) {
		match name {
			EMPTY_COMMAND => {
				self.empty_line = Some(spec);
			},
			DEFAULT_COMMAND => {
				self.default = Some(spec);
			},
			INITIAL_WORD => {
				self.initial_word = Some(spec);
			},
			_ => {
				self.commands.insert(name.to_owned(), spec);
			},
		}
	}

	/// Returns a mutable reference to the completion spec for the command of the
	/// given name; if the command already was associated with a spec, returns
	/// a reference to that existing spec. Otherwise registers a new default
	/// spec and returns a mutable reference to it.
	///
	/// # Arguments
	///
	/// * `name` - The name of the command.
	#[allow(
		clippy::missing_panics_doc,
		clippy::unwrap_used,
		reason = "these unwrap calls should not fail"
	)]
	pub fn get_or_add_mut(&mut self, name: &str) -> &mut Spec {
		match name {
			EMPTY_COMMAND => {
				if self.empty_line.is_none() {
					self.empty_line = Some(Spec::default());
				}
				self.empty_line.as_mut().unwrap()
			},
			DEFAULT_COMMAND => {
				if self.default.is_none() {
					self.default = Some(Spec::default());
				}
				self.default.as_mut().unwrap()
			},
			INITIAL_WORD => {
				if self.initial_word.is_none() {
					self.initial_word = Some(Spec::default());
				}
				self.initial_word.as_mut().unwrap()
			},
			_ => self.commands.entry(name.to_owned()).or_default(),
		}
	}

	/// Generates completions for the given input line and cursor position.
	///
	/// # Arguments
	///
	/// * `shell` - The shell instance to use for completion generation.
	/// * `input` - The input line for which completions are being generated.
	/// * `position` - The 0-based index of the cursor in the input line.
	#[expect(clippy::string_slice)]
	pub async fn get_completions(
		&self,
		shell: &mut Shell<impl extensions::ShellExtensions>,
		input: &str,
		position: usize,
	) -> Result<Completions, error::Error> {
		const MAX_RESTARTS: u32 = 10;

		// Make a best-effort attempt to tokenize.
		let tokens = Self::tokenize_input_for_completion(shell, input);

		let cursor = position;
		let mut preceding_token = None;
		let mut completion_prefix = "";
		let mut insertion_index = cursor;
		let mut completion_token_index = tokens.len();

		// Copy a set of references to the tokens; we will adjust this list as
		// we find we need to insert an empty token.
		let mut adjusted_tokens: Vec<&CompletionToken<'_>> = tokens.iter().collect();

		// Try to find which token we are in.
		for (i, token) in tokens.iter().enumerate() {
			// If the cursor is before the start of the token, then it's between
			// this token and the one that preceded it (or it's before the first
			// token if this is the first token).
			if cursor < token.start {
				// TODO(completions): Should insert an empty token here; the position looks to
				// have been between this token and the preceding one.
				completion_token_index = i;
				break;
			}
			// If the cursor is anywhere from the first char of the token up to
			// (and including) the first char after the token, then this we need
			// to generate completions to replace/update this token. We'll pay
			// attention to the position to figure out the prefix that we should
			// be completing.
			else if cursor >= token.start && cursor <= token.end() {
				// Update insertion index.
				insertion_index = token.start;

				// Update prefix.
				let offset_into_token = cursor - insertion_index;
				let token_str = token.text;
				completion_prefix = &token_str[..offset_into_token];

				// Update token index.
				completion_token_index = i;

				break;
			}

			// Otherwise, we need to keep looking. Update what we think the
			// preceding token may be.
			preceding_token = Some(token);
		}

		// If the position is after the last token, then we need to insert an empty
		// token for the new token to be generated.
		let empty_token = CompletionToken { text: "", start: input.len() };
		if completion_token_index == tokens.len() {
			adjusted_tokens.push(&empty_token);
		}

		// Get the completions.
		let mut result = Answer::RestartCompletionProcess;
		let mut restart_count = 0;
		while matches!(result, Answer::RestartCompletionProcess) {
			if restart_count > MAX_RESTARTS {
				tracing::warn!("possible infinite loop detected in completion process");
				break;
			}

			let completion_context = Context {
				token_to_complete: completion_prefix,
				preceding_token:   preceding_token.map(|t| t.text),
				command_name:      adjusted_tokens.first().map(|token| token.text),
				input_line:        input,
				token_index:       completion_token_index,
				tokens:            adjusted_tokens.as_slice(),
				cursor_index:      position,
				trigger:           CompletionTrigger::InteractiveComplete,
			};

			result = self
				.get_completions_for_token(shell, completion_context)
				.await;

			restart_count += 1;
		}

		match result {
			Answer::Candidates(candidates, options) => Ok(Completions {
				insertion_index,
				delete_count: completion_prefix.len(),
				candidates,
				options,
			}),
			Answer::RestartCompletionProcess => Ok(Completions {
				insertion_index,
				delete_count: 0,
				candidates: Vec::new(),
				options: ProcessingOptions::default(),
			}),
		}
	}

	fn tokenize_input_for_completion<'a>(
		shell: &Shell<impl extensions::ShellExtensions>,
		input: &'a str,
	) -> Vec<CompletionToken<'a>> {
		const FALLBACK: &str = " \t\n\"\'@><=;|&(:";

		let delimiter_str = shell
			.env_str("COMP_WORDBREAKS")
			.unwrap_or_else(|| FALLBACK.into());

		let delimiters: Vec<_> = delimiter_str.chars().collect();

		simple_tokenize_by_delimiters(input, delimiters.as_slice())
	}

	async fn get_completions_for_token(
		&self,
		shell: &mut Shell<impl extensions::ShellExtensions>,
		context: Context<'_>,
	) -> Answer {
		// See if we can find a completion spec matching the current command.
		let mut found_spec: Option<&Spec> = None;

		if let Some(command_name) = context.command_name {
			if context.token_index == 0 {
				if let Some(spec) = &self.initial_word {
					found_spec = Some(spec);
				}
			} else {
				if let Some(spec) = shell.completion_config().commands.get(command_name) {
					found_spec = Some(spec);
				} else if let Some(file_name) = PathBuf::from(command_name).file_name() {
					if let Some(spec) = shell
						.completion_config()
						.commands
						.get(&file_name.to_string_lossy().to_string())
					{
						found_spec = Some(spec);
					}
				}

				if found_spec.is_none() {
					if let Some(spec) = &self.default {
						found_spec = Some(spec);
					}
				}
			}
		} else {
			if let Some(spec) = &self.empty_line {
				found_spec = Some(spec);
			}
		}

		// Try to generate completions.
		if let Some(spec) = found_spec {
			spec
				.to_owned()
				.get_completions(shell, &context)
				.await
				.unwrap_or_else(|_err| Answer::Candidates(Vec::new(), ProcessingOptions::default()))
		} else {
			// If we didn't find a spec, then fall back to basic completion.
			get_completions_using_basic_lookup(shell, &context).await
		}
	}
}

async fn get_file_completions(
	shell: &Shell<impl extensions::ShellExtensions>,
	token_to_complete: &str,
	must_be_dir: bool,
) -> Vec<String> {
	// Basic-expand the token-to-be-completed; it won't have been expanded to this
	// point.
	let mut throwaway_shell = shell.clone();
	let params = throwaway_shell.default_exec_params();
	let options =
		expansion::ExpanderOptions { execute_command_substitutions: false, ..Default::default() };
	let expanded_token = expansion::basic_expand_word_with_options(
		&mut throwaway_shell,
		&params,
		&unquote_str(token_to_complete),
		&options,
	)
	.await
	.unwrap_or_else(|_err| token_to_complete.to_owned());

	// Normalize path separators before building the glob pattern, because backslash
	// is the escape character in glob syntax and must not be confused with a
	// Windows path separator.
	let expanded_token = sys::fs::normalize_path_separators(&expanded_token).into_owned();

	let glob = std::format!("{expanded_token}*");

	let path_filter = |path: &Path| !must_be_dir || shell.absolute_path(path).is_dir();

	let pattern = patterns::Pattern::from(glob)
		.set_extended_globbing(shell.options().extended_globbing)
		.set_case_insensitive(shell.options().case_insensitive_pathname_expansion);

	let mut completions: Vec<String> = pattern
		.expand(
			shell.working_dir(),
			Some(&path_filter),
			&patterns::FilenameExpansionOptions::default(),
		)
		.unwrap_or_default()
		.into_paths()
		.into_iter()
		.map(|p| match sys::fs::normalize_path_separators(&p) {
			std::borrow::Cow::Borrowed(_) => p,
			std::borrow::Cow::Owned(normalized) => normalized,
		})
		.collect();

	match expanded_token.as_str() {
		"." => {
			completions.push(".".into());
			completions.push("..".into());
		},
		".." => {
			completions.push("..".into());
		},
		_ => {},
	}

	completions.sort();
	completions.dedup();
	completions
}

fn get_external_command_completions(
	shell: &Shell<impl extensions::ShellExtensions>,
	prefix: &str,
) -> Vec<String> {
	let mut candidates = Vec::new();

	// Look for external commands.
	for path in shell.find_executables_in_path_with_prefix(
		prefix,
		shell.options().case_insensitive_pathname_expansion,
	) {
		if let Some(file_name) = path.file_name() {
			candidates.push(file_name.to_string_lossy().to_string());
		}
	}

	candidates.into_iter().collect()
}

/// Attempts to complete a variable name from the given token.
/// Returns `Some(Answer)` if the token looks like a variable reference being
/// typed, or `None` if file/command completion should be used instead.
///
/// # Arguments
///
/// * `shell` - The shell instance to use for variable lookup.
/// * `token` - The token being completed. May be empty.
fn try_get_variable_completions(
	shell: &Shell<impl extensions::ShellExtensions>,
	token: &str,
) -> Option<Answer> {
	// Determine if this is a braced or unbraced variable reference
	let (var_prefix, use_braces) = if let Some(prefix) = token.strip_prefix("${") {
		// For braced: only complete if brace isn't closed yet
		if prefix.contains('}') {
			return None;
		}
		(prefix, true)
	} else if let Some(prefix) = token.strip_prefix('$') {
		(prefix, false)
	} else {
		return None;
	};

	// If there's a path separator, this is a path like $HOME/foo, not a variable to
	// complete
	if sys::fs::contains_path_separator(var_prefix) {
		return None;
	}

	// Find matching variables
	let mut candidates: Vec<String> = shell
		.env()
		.iter()
		.filter(|(key, _)| key.starts_with(var_prefix))
		.map(|(key, _)| {
			if use_braces {
				format!("${{{key}}}")
			} else {
				format!("${key}")
			}
		})
		.collect();
	candidates.sort();

	// Variable completions should not be treated as filenames (no escaping needed)
	let options = ProcessingOptions { treat_as_filenames: false, ..ProcessingOptions::default() };

	Some(Answer::Candidates(candidates, options))
}

/// Adds command-position completions to candidates.
/// This includes external commands, builtins, functions, aliases, and keywords.
fn add_command_completions(
	shell: &Shell<impl extensions::ShellExtensions>,
	prefix: &str,
	candidates: &mut Vec<String>,
) {
	// Add external commands.
	let mut command_completions = get_external_command_completions(shell, prefix);
	candidates.append(&mut command_completions);

	// Add built-in commands.
	for (name, registration) in shell.builtins() {
		if !registration.disabled && name.starts_with(prefix) {
			candidates.push(name.to_owned());
		}
	}

	// Add shell functions.
	for (name, _) in shell.funcs().iter() {
		if name.starts_with(prefix) {
			candidates.push(name.to_owned());
		}
	}

	// Add aliases.
	for name in shell.aliases().keys() {
		if name.starts_with(prefix) {
			candidates.push(name.to_owned());
		}
	}

	// Add keywords.
	for keyword in shell.get_keywords() {
		if keyword.starts_with(prefix) {
			candidates.push(keyword.to_string());
		}
	}
}

async fn get_completions_using_basic_lookup(
	shell: &Shell<impl extensions::ShellExtensions>,
	context: &Context<'_>,
) -> Answer {
	let token = context.token_to_complete;

	// Try variable completion first (e.g., $HO -> $HOME, ${HO -> ${HOME})
	if let Some(answer) = try_get_variable_completions(shell, token) {
		return answer;
	}

	// File completions
	let mut candidates = get_file_completions(shell, token, false).await;

	// If this appears to be the command token (and if there's *some* prefix without
	// a path separator) then also consider whether we should search the path for
	// completions too.
	// TODO(completions): Do a better job than just checking if index == 0.
	let is_command_position =
		context.token_index == 0 && !token.is_empty() && !sys::fs::contains_path_separator(token);

	if is_command_position {
		add_command_completions(shell, token, &mut candidates);
		candidates.sort();
	}

	Answer::Candidates(candidates, ProcessingOptions::default())
}

/// Tokenizes input by splitting on delimiter characters. Words (non-delimiter
/// sequences) are emitted as tokens. Consecutive non-whitespace delimiters are
/// grouped into a single token. Whitespace delimiters separate tokens but are
/// not emitted themselves.
#[allow(clippy::string_slice, reason = "used indices come from char_indices")]
fn simple_tokenize_by_delimiters<'a>(
	input: &'a str,
	delimiters: &[char],
) -> Vec<CompletionToken<'a>> {
	let mut tokens = vec![];
	let mut word_start = None;
	let mut word_is_delimiters = false;
	let mut quote_char: Option<char> = None;
	let mut escaped = false;

	for (i, c) in input.char_indices() {
		let mut is_active_delimiter = false;
		if escaped {
			escaped = false;
		} else if let Some(q) = quote_char {
			if c == '\\' && q == '"' {
				// an escape in double-quoted string works as an escape.
				escaped = true;
			} else if c == q {
				// end of quote.
				quote_char = None;
			}
		} else {
			if c == '\\' {
				escaped = true;
			} else if word_start.is_none() && (c == '\'' || c == '\"') {
				// start a new quote.
				quote_char = Some(c);
			} else {
				is_active_delimiter = delimiters.contains(&c);
			}
		}

		if is_active_delimiter {
			// If we were building a regular word and this is a delimiter, then finish it.
			// Similarly, if this is a whitespace delimiter, finish any delimiter sequence.
			if let Some(start) = word_start {
				if !word_is_delimiters || c.is_ascii_whitespace() {
					tokens.push(CompletionToken { text: &input[start..i], start });
					word_start = None;
					word_is_delimiters = false;
				}

				if !c.is_ascii_whitespace() {
					if word_start.is_none() {
						word_start = Some(i);
						word_is_delimiters = true;
					}
				}
			} else if !c.is_ascii_whitespace() {
				// Non-whitespace delimiter: start or continue delimiter sequence
				if word_start.is_none() {
					word_start = Some(i);
					word_is_delimiters = true;
				}
			}
		} else {
			// Regular character (not a delimiter). Finish any delimiter sequence.
			if word_is_delimiters {
				if let Some(start) = word_start {
					tokens.push(CompletionToken { text: &input[start..i], start });
					word_start = None;
					word_is_delimiters = false;
				}
			}

			// Start or continue a word
			if word_start.is_none() {
				word_start = Some(i);
			}
		}
	}

	// Add any remaining delimiter sequence
	if let Some(start) = word_start {
		tokens.push(CompletionToken { text: &input[start..], start });
	}

	tokens
}

fn completion_filter_pattern_matches(
	pattern: &str,
	candidate: &str,
	token_being_completed: &str,
	shell: &Shell<impl extensions::ShellExtensions>,
) -> Result<bool, error::Error> {
	let pattern = replace_unescaped_ampersands(pattern, token_being_completed);

	//
	// TODO(completions): Replace unescaped '&' with the word being completed.
	//

	let pattern = patterns::Pattern::from(pattern.as_ref())
		.set_extended_globbing(shell.options().extended_globbing)
		.set_case_insensitive(shell.options().case_insensitive_pathname_expansion);

	let matches = pattern.exactly_matches(candidate)?;

	Ok(matches)
}

fn replace_unescaped_ampersands<'a>(pattern: &'a str, replacement: &str) -> Cow<'a, str> {
	let mut in_escape = false;
	let mut insertion_points = vec![];

	for (i, c) in pattern.char_indices() {
		if !in_escape && c == '&' {
			insertion_points.push(i);
		}
		in_escape = !in_escape && c == '\\';
	}

	if insertion_points.is_empty() {
		return pattern.into();
	}

	let mut result = pattern.to_owned();
	for i in insertion_points.iter().rev() {
		result.replace_range(*i..=*i, replacement);
	}

	result.into()
}

#[cfg(test)]
mod tests {
	use pretty_assertions::assert_matches;

	use super::*;

	#[test]
	#[allow(clippy::too_many_lines)]
	fn completion_tokenization() {
		assert_matches!(simple_tokenize_by_delimiters("one two", &[' ']).as_slice(), [
			CompletionToken { text: "one", start: 0 },
			CompletionToken { text: "two", start: 4 }
		]);

		assert_matches!(simple_tokenize_by_delimiters("one \t two", &[' ', '\t']).as_slice(), [
			CompletionToken { text: "one", start: 0 },
			CompletionToken { text: "two", start: 6 }
		]);

		assert_matches!(simple_tokenize_by_delimiters("    ", &[' ']).as_slice(), []);

		assert_matches!(simple_tokenize_by_delimiters(":", &[':']).as_slice(), [CompletionToken {
			text:  ":",
			start: 0,
		}]);

		assert_matches!(simple_tokenize_by_delimiters("a:::b", &[':', ' ']).as_slice(), [
			CompletionToken { text: "a", start: 0 },
			CompletionToken { text: ":::", start: 1 },
			CompletionToken { text: "b", start: 4 }
		]);

		assert_matches!(simple_tokenize_by_delimiters("a: : :b", &[':', ' ']).as_slice(), [
			CompletionToken { text: "a", start: 0 },
			CompletionToken { text: ":", start: 1 },
			CompletionToken { text: ":", start: 3 },
			CompletionToken { text: ":", start: 5 },
			CompletionToken { text: "b", start: 6 }
		]);

		assert_matches!(simple_tokenize_by_delimiters("one two:three", &[':', ' ']).as_slice(), [
			CompletionToken { text: "one", start: 0 },
			CompletionToken { text: "two", start: 4 },
			CompletionToken { text: ":", start: 7 },
			CompletionToken { text: "three", start: 8 }
		]);

		assert_matches!(simple_tokenize_by_delimiters("one'two", &['\'']).as_slice(), [
			CompletionToken { text: "one", start: 0 },
			CompletionToken { text: "'", start: 3 },
			CompletionToken { text: "two", start: 4 },
		]);

		assert_matches!(simple_tokenize_by_delimiters("one 'two:three'", &[':', ' ']).as_slice(), [
			CompletionToken { text: "one", start: 0 },
			CompletionToken { text: "'two:three'", start: 4 },
		]);

		assert_matches!(
			simple_tokenize_by_delimiters("one \\'two \"two four\"", &[':', ' ']).as_slice(),
			[
				CompletionToken { text: "one", start: 0 },
				CompletionToken { text: "\\'two", start: 4 },
				CompletionToken { text: "\"two four\"", start: 10 },
			]
		);
	}
}
