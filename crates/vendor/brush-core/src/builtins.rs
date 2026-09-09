//! Facilities for implementing and managing builtins

use std::io::Write;

use clap::builder::styling;
pub use futures::future::BoxFuture;

use crate::{BuiltinError, CommandArg, commands, error, extensions, results};

/// Type of a function implementing a built-in command.
///
/// # Arguments
///
/// * The context in which the command is being executed.
/// * The arguments to the command.
#[allow(type_alias_bounds)]
pub type CommandExecuteFunc<SE: extensions::ShellExtensions> =
	fn(
		commands::ExecutionContext<'_, SE>,
		Vec<commands::CommandArg>,
	) -> BoxFuture<'_, Result<results::ExecutionResult, error::Error>>;

/// Type of a function to retrieve help content for a built-in command.
///
/// # Arguments
///
/// * `name` - The name of the command.
/// * `content_type` - The type of content to retrieve.
/// * `options` - Additional options for content retrieval.
pub type CommandContentFunc =
	fn(&str, ContentType, &ContentOptions) -> Result<String, error::Error>;

/// Trait implemented by built-in shell commands.
pub trait Command: clap::Parser {
	/// The error type returned by the command.
	type Error: BuiltinError + 'static;

	/// Instantiates the built-in command with the given arguments.
	///
	/// # Arguments
	///
	/// * `args` - The arguments to the command.
	fn new<I>(args: I) -> Result<Self, clap::Error>
	where
		I: IntoIterator<Item = String>,
	{
		if !Self::takes_plus_options() {
			Self::try_parse_from(args)
		} else {
			// N.B. clap doesn't support named options like '+x'. To work around this, we
			// establish a pattern of renaming them.
			let mut updated_args = vec![];
			for arg in args {
				if let Some(plus_options) = arg.strip_prefix("+") {
					for c in plus_options.chars() {
						updated_args.push(format!("--+{c}"));
					}
				} else {
					updated_args.push(arg);
				}
			}

			Self::try_parse_from(updated_args)
		}
	}

	/// Returns whether or not the command takes options with a leading '+' or
	/// '-' character.
	fn takes_plus_options() -> bool {
		false
	}

	/// Executes the built-in command in the provided context.
	///
	/// # Arguments
	///
	/// * `context` - The context in which the command is being executed.
	// NOTE: we use desugared async here because we need a Send marker
	fn execute<SE: extensions::ShellExtensions>(
		&self,
		context: commands::ExecutionContext<'_, SE>,
	) -> impl std::future::Future<Output = Result<results::ExecutionResult, Self::Error>>
	+ std::marker::Send;

	/// Returns the textual help content associated with the command.
	///
	/// # Arguments
	///
	/// * `name` - The name of the command.
	/// * `content_type` - The type of content to retrieve.
	/// * `options` - Additional options for content retrieval.
	fn get_content(
		name: &str,
		content_type: ContentType,
		options: &ContentOptions,
	) -> Result<String, error::Error> {
		let mut clap_command = Self::command()
			.styles(brush_help_styles())
			.next_line_help(false);
		clap_command.set_bin_name(name);

		let s = match content_type {
			ContentType::DetailedHelp => {
				let rendered = clap_command.render_help();
				if options.colorized {
					rendered.ansi().to_string()
				} else {
					rendered.to_string()
				}
			},
			ContentType::ShortUsage => get_builtin_short_usage(name, &clap_command),
			ContentType::ShortDescription => get_builtin_short_description(name, &clap_command),
			ContentType::ManPage => get_builtin_man_page(name, &clap_command)?,
		};

		Ok(s)
	}
}

/// Trait implemented by built-in shell commands that take specially handled
/// declarations as arguments.
pub trait DeclarationCommand: Command {
	/// Stores the declarations within the command instance.
	///
	/// # Arguments
	///
	/// * `declarations` - The declarations to store.
	fn set_declarations(&mut self, declarations: Vec<commands::CommandArg>);
}

/// Type of help content, typically associated with a built-in command.
pub enum ContentType {
	/// Detailed help content for the command.
	DetailedHelp,
	/// Short usage information for the command.
	ShortUsage,
	/// Short description for the command.
	ShortDescription,
	/// man-style help page.
	ManPage,
}

/// Options for retrieving built-in command content.
#[derive(Default)]
pub struct ContentOptions {
	/// Whether or not the content should be colorized.
	pub colorized: bool,
}

/// Encapsulates a registration for a built-in command.
#[derive(Clone)]
pub struct Registration<SE: extensions::ShellExtensions> {
	/// Function to execute the builtin.
	pub execute_func: CommandExecuteFunc<SE>,

	/// Function to retrieve the builtin's content/help text.
	pub content_func: CommandContentFunc,

	/// Has this registration been disabled?
	pub disabled: bool,

	/// Is the builtin classified as "special" by specification?
	pub special_builtin: bool,

	/// Is this builtin one that takes specially handled declarations?
	pub declaration_builtin: bool,

	/// Can async background job spawning skip this builtin and launch its first
	/// word argument directly?
	pub transparent_background_wrapper: bool,
}

impl<SE: extensions::ShellExtensions> Registration<SE> {
	/// Updates the given registration to mark it for a special builtin.
	#[must_use]
	pub const fn special(self) -> Self {
		Self { special_builtin: true, ..self }
	}

	/// Marks this builtin as a transparent wrapper when used as an asynchronous
	/// background command. The first word argument becomes the launched command,
	/// and the wrapper itself is skipped so `$!` can refer to the real child PID.
	#[must_use]
	pub const fn transparent_background_wrapper(self) -> Self {
		Self { transparent_background_wrapper: true, ..self }
	}
}

fn get_builtin_man_page(name: &str, command: &clap::Command) -> Result<String, error::Error> {
	let mut man_page = String::new();

	append_man_section(&mut man_page, "NAME");
	let description = command
		.get_about()
		.map_or_else(String::new, std::string::ToString::to_string);
	if description.is_empty() {
		man_page.push_str(name);
		man_page.push('\n');
	} else {
		man_page.push_str(name);
		man_page.push_str(" - ");
		man_page.push_str(&description);
		man_page.push('\n');
	}

	append_man_section(&mut man_page, "SYNOPSIS");
	let mut usage_command = command.clone();
	let usage = usage_command.render_usage();
	man_page.push_str(&usage.to_string());
	man_page.push('\n');

	if let Some(about) = command.get_long_about().or_else(|| command.get_about()) {
		append_man_section(&mut man_page, "DESCRIPTION");
		man_page.push_str(&about.to_string());
		man_page.push('\n');
	}

	append_man_arguments_section(&mut man_page, command);
	append_man_options_section(&mut man_page, command);

	Ok(man_page)
}

fn append_man_section(buf: &mut String, title: &str) {
	if !buf.is_empty() {
		buf.push('\n');
	}

	buf.push_str(title);
	buf.push('\n');
}

fn append_man_arguments_section(buf: &mut String, command: &clap::Command) {
	let mut section_written = false;
	for arg in command.get_positionals() {
		if arg.is_hide_set() {
			continue;
		}

		if !section_written {
			append_man_section(buf, "ARGUMENTS");
			section_written = true;
		}

		write_man_arg_help(buf, &format_man_value_names(arg), arg);
	}
}

fn append_man_options_section(buf: &mut String, command: &clap::Command) {
	let mut section_written = false;
	for arg in command.get_opts() {
		if arg.is_hide_set() {
			continue;
		}

		if !section_written {
			append_man_section(buf, "OPTIONS");
			section_written = true;
		}

		write_man_arg_help(buf, &format_man_option(arg), arg);
	}
}

fn write_man_arg_help(buf: &mut String, label: &str, arg: &clap::Arg) {
	buf.push_str("  ");
	buf.push_str(label);
	buf.push('\n');
	if let Some(help) = arg.get_long_help().or_else(|| arg.get_help()) {
		buf.push_str("      ");
		buf.push_str(&help.to_string());
		buf.push('\n');
	}
}

fn format_man_option(arg: &clap::Arg) -> String {
	let mut option = String::new();
	if let Some(short) = arg.get_short() {
		option.push('-');
		option.push(short);
	}

	if let Some(long) = arg.get_long() {
		if !option.is_empty() {
			option.push_str(", ");
		}

		option.push_str("--");
		option.push_str(long);
	}

	let values = format_man_value_names(arg);
	if !values.is_empty() {
		if !option.is_empty() {
			option.push(' ');
		}

		option.push_str(&values);
	}

	option
}

fn format_man_value_names(arg: &clap::Arg) -> String {
	let Some(value_names) = arg.get_value_names() else {
		return String::new();
	};

	let mut values = String::new();
	for name in value_names {
		if !values.is_empty() {
			values.push(' ');
		}

		values.push('<');
		values.push_str(name);
		values.push('>');
	}

	values
}

fn get_builtin_short_description(name: &str, command: &clap::Command) -> String {
	let about = command
		.get_about()
		.map_or_else(String::new, |s| s.to_string());

	std::format!("{name} - {about}\n")
}

fn get_builtin_short_usage(name: &str, command: &clap::Command) -> String {
	let mut usage = String::new();

	let mut needs_space = false;

	let mut optional_short_opts = vec![];
	let mut required_short_opts = vec![];
	for opt in command.get_opts() {
		if opt.is_hide_set() {
			continue;
		}

		if let Some(c) = opt.get_short() {
			if !opt.is_required_set() {
				optional_short_opts.push(c);
			} else {
				required_short_opts.push(c);
			}
		}
	}

	if !optional_short_opts.is_empty() {
		if needs_space {
			usage.push(' ');
		}

		usage.push('[');
		usage.push('-');
		for c in optional_short_opts {
			usage.push(c);
		}

		usage.push(']');
		needs_space = true;
	}

	if !required_short_opts.is_empty() {
		if needs_space {
			usage.push(' ');
		}

		usage.push('-');
		for c in required_short_opts {
			usage.push(c);
		}

		needs_space = true;
	}

	for pos in command.get_positionals() {
		if pos.is_hide_set() {
			continue;
		}

		if !pos.is_required_set() {
			if needs_space {
				usage.push(' ');
			}

			usage.push('[');
			needs_space = false;
		}

		if let Some(names) = pos.get_value_names() {
			for name in names {
				if needs_space {
					usage.push(' ');
				}

				usage.push_str(name);
				needs_space = true;
			}
		}

		if !pos.is_required_set() {
			usage.push(']');
			needs_space = true;
		}
	}

	std::format!("{name}: {name} {usage}\n")
}

fn brush_help_styles() -> clap::builder::Styles {
	styling::Styles::styled()
		.header(
			styling::AnsiColor::Yellow.on_default()
				| styling::Effects::BOLD
				| styling::Effects::UNDERLINE,
		)
		.usage(styling::AnsiColor::Green.on_default() | styling::Effects::BOLD)
		.literal(styling::AnsiColor::Magenta.on_default() | styling::Effects::BOLD)
		.placeholder(styling::AnsiColor::Cyan.on_default())
}

/// This function and the [`try_parse_known`] exists to deal with
/// the Clap's limitation of treating `--` like a regular value
/// `https://github.com/clap-rs/clap/issues/5055`
///
/// # Arguments
///
/// * `args` - An Iterator from [`std::env::args`]
///
/// # Returns
///
/// * a parsed struct T from [`clap::Parser::parse_from`]
/// * the remain iterator `args` with `--` and the rest arguments if they
///   present otherwise None
///
/// # Examples
/// ```
/// use clap::{Parser, builder::styling};
/// #[derive(Parser)]
/// struct CommandLineArgs {
/// 	#[clap(allow_hyphen_values = true, num_args=1..)]
/// 	script_args: Vec<String>,
/// }
///
/// let (mut parsed_args, raw_args) =
/// 	brush_core::builtins::parse_known::<CommandLineArgs, _>(std::env::args());
/// if raw_args.is_some() {
/// 	parsed_args.script_args = raw_args.unwrap().collect();
/// }
/// ```
pub fn parse_known<T: clap::Parser, S>(
	args: impl IntoIterator<Item = S>,
) -> (T, Option<impl Iterator<Item = S>>)
where
	S: Into<std::ffi::OsString> + Clone + PartialEq<&'static str>,
{
	let mut args = args.into_iter();
	// the best way to save `--` is to get it out with a side effect while `clap`
	// iterates over the args this way we can be 100% sure that we have '--' and
	// the remaining args and we will iterate only once
	let mut hyphen = None;
	let args_before_hyphen = args.by_ref().take_while(|a| {
		let is_hyphen = *a == "--";
		if is_hyphen {
			hyphen = Some(a.clone());
		}
		!is_hyphen
	});
	let parsed_args = T::parse_from(args_before_hyphen);
	let raw_args = hyphen.map(|hyphen| std::iter::once(hyphen).chain(args));
	(parsed_args, raw_args)
}

/// Similar to [`parse_known`] but with [`clap::Parser::try_parse_from`]
/// This function is used to parse arguments in builtins such as
/// `crate::echo::EchoCommand`
pub fn try_parse_known<T: clap::Parser>(
	args: impl IntoIterator<Item = String>,
) -> Result<(T, Option<impl Iterator<Item = String>>), clap::Error> {
	let mut args = args.into_iter();
	let mut hyphen = None;
	let args_before_hyphen = args.by_ref().take_while(|a| {
		let is_hyphen = a == "--";
		if is_hyphen {
			hyphen = Some(a.clone());
		}
		!is_hyphen
	});
	let parsed_args = T::try_parse_from(args_before_hyphen)?;

	let raw_args = hyphen.map(|hyphen| std::iter::once(hyphen).chain(args));
	Ok((parsed_args, raw_args))
}

/// A simple command that can be registered as a built-in.
pub trait SimpleCommand {
	/// Returns the content of the built-in command.
	fn get_content(
		name: &str,
		content_type: ContentType,
		options: &ContentOptions,
	) -> Result<String, error::Error>;

	/// Executes the built-in command.
	fn execute<SE: extensions::ShellExtensions, I: Iterator<Item = S>, S: AsRef<str>>(
		context: commands::ExecutionContext<'_, SE>,
		args: I,
	) -> Result<results::ExecutionResult, error::Error>;
}

/// Returns a built-in command registration, given an implementation of the
/// `SimpleCommand` trait.
pub fn simple_builtin<B: SimpleCommand + Send + Sync, SE: extensions::ShellExtensions>()
-> Registration<SE> {
	Registration {
		execute_func:        exec_simple_builtin::<B, SE>,
		content_func:        B::get_content,
		disabled:            false,
		special_builtin:     false,
		declaration_builtin: false,
		transparent_background_wrapper: false,
	}
}

/// Returns a built-in command registration, given an implementation of the
/// `Command` trait.
pub fn builtin<B: Command + Send + Sync, SE: extensions::ShellExtensions>() -> Registration<SE> {
	Registration {
		execute_func:        exec_builtin::<B, SE>,
		content_func:        get_builtin_content::<B>,
		disabled:            false,
		special_builtin:     false,
		declaration_builtin: false,
		transparent_background_wrapper: false,
	}
}

/// Returns a built-in command registration, given an implementation of the
/// `DeclarationCommand` trait. Used for select commands that can take parsed
/// declarations as arguments.
pub fn decl_builtin<B: DeclarationCommand + Send + Sync, SE: extensions::ShellExtensions>()
-> Registration<SE> {
	Registration {
		execute_func:        exec_declaration_builtin::<B, SE>,
		content_func:        get_builtin_content::<B>,
		disabled:            false,
		special_builtin:     false,
		declaration_builtin: true,
		transparent_background_wrapper: false,
	}
}

#[allow(clippy::too_long_first_doc_paragraph)]
/// Returns a built-in command registration, given an implementation of the
/// `DeclarationCommand` trait that can be default-constructed. The command
/// implementation is expected to implement clap's `Parser` trait solely
/// for help/usage information. Arguments are passed directly to the command
/// via `set_declarations`. This is primarily only expected to be used with
/// select builtin commands that wrap other builtins (e.g., "builtin").
pub fn raw_arg_builtin<
	B: DeclarationCommand + Default + Send + Sync,
	SE: extensions::ShellExtensions,
>() -> Registration<SE> {
	Registration {
		execute_func:        exec_raw_arg_builtin::<B, SE>,
		content_func:        get_builtin_content::<B>,
		disabled:            false,
		special_builtin:     false,
		declaration_builtin: true,
		transparent_background_wrapper: false,
	}
}

fn get_builtin_content<T: Command + Send + Sync>(
	name: &str,
	content_type: ContentType,
	options: &ContentOptions,
) -> Result<String, error::Error> {
	T::get_content(name, content_type, options)
}

fn exec_simple_builtin<T: SimpleCommand + Send + Sync, SE: extensions::ShellExtensions>(
	context: commands::ExecutionContext<'_, SE>,
	args: Vec<CommandArg>,
) -> BoxFuture<'_, Result<results::ExecutionResult, error::Error>> {
	Box::pin(async move { exec_simple_builtin_impl::<T, SE>(context, args).await })
}

#[expect(clippy::unused_async)]
async fn exec_simple_builtin_impl<
	T: SimpleCommand + Send + Sync,
	SE: extensions::ShellExtensions,
>(
	context: commands::ExecutionContext<'_, SE>,
	args: Vec<CommandArg>,
) -> Result<results::ExecutionResult, error::Error> {
	let plain_args = args.into_iter().map(|arg| match arg {
		CommandArg::String(s) => s,
		CommandArg::Assignment(a) => a.to_string(),
	});

	T::execute(context, plain_args)
}

fn exec_builtin<T: Command + Send + Sync, SE: extensions::ShellExtensions>(
	context: commands::ExecutionContext<'_, SE>,
	args: Vec<CommandArg>,
) -> BoxFuture<'_, Result<results::ExecutionResult, error::Error>> {
	Box::pin(async move { exec_builtin_impl::<T, SE>(context, args).await })
}

async fn exec_builtin_impl<T: Command + Send + Sync, SE: extensions::ShellExtensions>(
	context: commands::ExecutionContext<'_, SE>,
	args: Vec<CommandArg>,
) -> Result<results::ExecutionResult, error::Error> {
	let plain_args = args.into_iter().map(|arg| match arg {
		CommandArg::String(s) => s,
		CommandArg::Assignment(a) => a.to_string(),
	});

	let result = T::new(plain_args);
	let command = match result {
		Ok(command) => command,
		Err(e) => {
			let _ = writeln!(context.stderr(), "{e}");
			return Ok(results::ExecutionExitCode::InvalidUsage.into());
		},
	};

	call_builtin(command, context).await
}

fn exec_declaration_builtin<
	T: DeclarationCommand + Send + Sync,
	SE: extensions::ShellExtensions,
>(
	context: commands::ExecutionContext<'_, SE>,
	args: Vec<CommandArg>,
) -> BoxFuture<'_, Result<results::ExecutionResult, error::Error>> {
	Box::pin(async move { exec_declaration_builtin_impl::<T, SE>(context, args).await })
}

async fn exec_declaration_builtin_impl<
	T: DeclarationCommand + Send + Sync,
	SE: extensions::ShellExtensions,
>(
	context: commands::ExecutionContext<'_, SE>,
	args: Vec<CommandArg>,
) -> Result<results::ExecutionResult, error::Error> {
	let mut options = vec![];
	let mut declarations = vec![];

	for (i, arg) in args.into_iter().enumerate() {
		match arg {
			CommandArg::String(s)
				if i == 0 || (s.len() > 1 && (s.starts_with('-') || s.starts_with('+'))) =>
			{
				options.push(s);
			},
			_ => declarations.push(arg),
		}
	}

	let result = T::new(options);
	let mut command = match result {
		Ok(command) => command,
		Err(e) => {
			let _ = writeln!(context.stderr(), "{e}");
			return Ok(results::ExecutionExitCode::InvalidUsage.into());
		},
	};

	command.set_declarations(declarations);

	call_builtin(command, context).await
}

fn exec_raw_arg_builtin<
	T: DeclarationCommand + Default + Send + Sync,
	SE: extensions::ShellExtensions,
>(
	context: commands::ExecutionContext<'_, SE>,
	args: Vec<CommandArg>,
) -> BoxFuture<'_, Result<results::ExecutionResult, error::Error>> {
	Box::pin(async move { exec_raw_arg_builtin_impl::<T, SE>(context, args).await })
}

async fn exec_raw_arg_builtin_impl<
	T: DeclarationCommand + Default + Send + Sync,
	SE: extensions::ShellExtensions,
>(
	context: commands::ExecutionContext<'_, SE>,
	args: Vec<CommandArg>,
) -> Result<results::ExecutionResult, error::Error> {
	let mut command = T::default();
	command.set_declarations(args);

	call_builtin(command, context).await
}

async fn call_builtin(
	command: impl Command,
	context: commands::ExecutionContext<'_, impl extensions::ShellExtensions>,
) -> Result<results::ExecutionResult, error::Error> {
	let builtin_name = context.command_name.clone();
	let result = command
		.execute(context)
		.await
		.map_err(|e| error::ErrorKind::BuiltinError(Box::new(e), builtin_name))?;

	Ok(result)
}
