use std::{collections::HashMap, io::Write};

use brush_core::{ExecutionResult, builtins, env};
use clap::Parser;

/// Parse command options.
#[derive(Parser)]
pub(crate) struct GetOptsCommand {
	/// Specification for options
	options_string: String,

	/// Name of variable to receive next option
	variable_name: String,

	/// Arguments to parse
	#[arg(trailing_var_arg = true, allow_hyphen_values = true)]
	args: Vec<String>,
}

// We track cross-call state in special variables. They are hidden from
// enumeration (e.g. `set`, `declare`) so they don't leak into scripts'
// environments.
const VAR_GETOPTS_NEXT_CHAR_INDEX: &str = "__GETOPTS_NEXT_CHAR";
const VAR_GETOPTS_LAST_OPTIND: &str = "__GETOPTS_LAST_OPTIND";

/// Where in the current word the next option character starts, as a **byte**
/// offset, not a character count.
///
/// The two agree on the first one, because the leading `-` is one byte, and
/// nothing outside this builtin reads `__GETOPTS_NEXT_CHAR`. The offset is
/// what makes resuming free: a character count has to be walked to, and a
/// word of combined flags is walked once for every flag in it, so a 64 MiB
/// word would be walked on each of millions of calls.
const DEFAULT_NEXT_CHAR_OFFSET: usize = 1;

/// The result of processing one option from the argument list.
struct GetOptsResult {
	/// The value to assign to the target variable (the option char, `?`, or
	/// `:`).
	variable_value: String,
	/// The value for OPTARG, if any (option's argument or, on error, the
	/// offending char).
	optarg:         Option<String>,
	/// The new value for OPTIND after this call.
	optind:         usize,
	/// Exit code: success (0) if an option was found, general error (1) when
	/// done.
	exit_code:      ExecutionResult,
}

/// Parsed representation of the optstring (e.g., `":a:bc"`).
struct OptionSpec {
	/// Maps each option character to whether it requires an argument.
	defs:          HashMap<char, bool>,
	/// True when the optstring has a leading `:`, suppressing error messages
	/// and reporting errors via `?`/`:` in the variable and OPTARG instead.
	silent_errors: bool,
}

/// Parses the optstring into an [`OptionSpec`]. A leading `:` enables silent
/// error mode. Each letter defines an option; a `:` immediately after a letter
/// means it takes an argument. Duplicate letters are ignored (first definition
/// wins).
fn parse_option_spec(spec: &str) -> OptionSpec {
	let mut defs = HashMap::<char, bool>::new();
	let mut silent_errors = false;

	let mut last_char = None;
	for c in spec.chars() {
		if c == ':' {
			if let Some(last_char) = last_char {
				defs.insert(last_char, true);
			} else if defs.is_empty() {
				// First character is ':' — request silent error reporting.
				silent_errors = true;
			}
			continue;
		}

		if let std::collections::hash_map::Entry::Vacant(e) = defs.entry(c) {
			e.insert(false);
			last_char = Some(c);
		} else {
			// Duplicate option char; first definition wins.
			// Clear last_char so a trailing colon doesn't modify the first definition.
			last_char = None;
		}
	}

	OptionSpec { defs, silent_errors }
}

impl builtins::Command for GetOptsCommand {
	type Error = brush_core::Error;

	/// Override the default [`builtins::Command::new`] function to handle clap's
	/// limitation related to `--`. See [`builtins::parse_known`] for more
	/// information TODO(command): we can safely remove this after the issue is
	/// resolved
	///
	/// An ordinary invocation is taken apart here rather than by clap. The
	/// grammar is `getopts optstring name [arg …]` and the three parts arrive
	/// as owned strings, so taking them apart moves them and copies nothing;
	/// clap's value parser copies every argument out of its matches, and an
	/// option argument on the command line can be any size. Anything that is
	/// not that shape — a `-` or `--` where the optstring or the variable
	/// name belongs, or fewer than two of them, so that clap's own diagnostic
	/// is the right answer — is handed back to clap unchanged.
	fn new<I>(args: I) -> Result<Self, clap::Error>
	where
		I: IntoIterator<Item = String>,
	{
		let mut args = args.into_iter();
		// The command name, the optstring and the variable name.
		let mut head: Vec<String> = args.by_ref().take(3).collect();
		if head.len() == 3 && !head[1].starts_with('-') && !head[2].starts_with('-') {
			// Exactly three, checked above, and both pops are moves.
			let variable_name = head.pop().unwrap_or_default();
			let options_string = head.pop().unwrap_or_default();
			return Ok(Self { options_string, variable_name, args: args.collect() });
		}

		let (mut this, rest_args) =
			brush_core::builtins::try_parse_known::<Self>(head.into_iter().chain(args))?;
		if let Some(args) = rest_args {
			this.args.extend(args);
		}
		Ok(this)
	}

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		mut context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<brush_core::ExecutionResult, Self::Error> {
		// Validate the target variable name.
		if !env::valid_variable_name(&self.variable_name) {
			writeln!(
				context.stderr(),
				"{}: `{}': not a valid identifier",
				context.command_name,
				self.variable_name
			)?;
			return Ok(ExecutionResult::new(1));
		}

		let spec = parse_option_spec(&self.options_string);

		// If unset or non-numeric, assume OPTIND is 1.
		let next_index_signed = context
			.shell
			.env_str("OPTIND")
			.and_then(|s| brush_core::int_utils::parse::<i32>(s.as_ref(), 10).ok())
			.unwrap_or(1);

		// Detect external OPTIND modifications (e.g., `OPTIND=1` to restart
		// parsing). If the current OPTIND differs from what we last set, clear
		// the internal char index so we don't resume mid-arg.
		let last_optind = context
			.shell
			.env_str(VAR_GETOPTS_LAST_OPTIND)
			.and_then(|s| s.parse::<i32>().ok());
		if last_optind != Some(next_index_signed) {
			context.shell.env_mut().unset(VAR_GETOPTS_NEXT_CHAR_INDEX)?;
		}

		#[allow(clippy::cast_sign_loss)] // .max(1) guarantees positive
		let next_index = next_index_signed.max(1) as usize;

		// Select the arguments to parse. If none were explicitly provided, we
		// default to using the shell's current positional parameters.
		// Clone positional params to avoid borrowing context immutably while we
		// also need it mutably in parse_next_option.
		// The copy is divided: a positional parameter is whatever the caller
		// passed, and copying the whole vector is the construction side of
		// the same write this builtin already divides.
		let owned_args;
		let args_to_parse = if self.args.is_empty() {
			let count = context.shell.current_shell_args().len();
			let mut copied = Vec::with_capacity(count);
			for index in 0..count {
				copied.push(
					brush_core::clone_in_strides(
						&context.params,
						&context.shell.current_shell_args()[index],
					)
					.await?,
				);
			}
			owned_args = copied;
			&owned_args
		} else {
			&self.args
		};

		let result = parse_next_option(&mut context, &spec, args_to_parse, next_index).await?;

		update_variables(&mut context, &self.variable_name, result).await
	}
}

/// Extracts the next option from `args_to_parse` starting at 1-based position
/// `next_index`. Handles combined flags (e.g., `-abc`), option arguments (both
/// `-pVALUE` and `-p VALUE` forms), and error reporting for unknown options or
/// missing arguments. Tracks position within combined flags via the
/// `__GETOPTS_NEXT_CHAR` shell variable.
async fn parse_next_option<SE: brush_core::ShellExtensions>(
	context: &mut brush_core::ExecutionContext<'_, SE>,
	spec: &OptionSpec,
	args_to_parse: &[String],
	mut next_index: usize,
) -> Result<GetOptsResult, brush_core::Error> {
	// See if there are any args left to parse.
	if next_index > args_to_parse.len() {
		return Ok(GetOptsResult {
			variable_value: String::from("?"),
			optarg:         None,
			// Normalize OPTIND to one past the last argument.
			optind:         args_to_parse.len() + 1,
			exit_code:      ExecutionResult::general_error(),
		});
	}

	let arg = args_to_parse[next_index - 1].as_str();

	// See if this is an option.
	if !arg.starts_with('-') || arg == "--" || arg == "-" {
		// Not an option. If it was "--", skip past it.
		return Ok(GetOptsResult {
			variable_value: String::from("?"),
			optarg:         None,
			optind:         if arg == "--" {
				next_index + 1
			} else {
				next_index
			},
			exit_code:      ExecutionResult::general_error(),
		});
	}

	// Figure out how far into this option we are.
	let mut next_char_offset = context
		.shell
		.env_str(VAR_GETOPTS_NEXT_CHAR_INDEX)
		.map_or(DEFAULT_NEXT_CHAR_OFFSET, |s| s.parse().unwrap_or(DEFAULT_NEXT_CHAR_OFFSET));

	// Find the char. If the offset is stale — past the end of this word, or
	// inside one of its characters — reset to the default, mirroring bash's
	// behaviour on a stale index. The default is always a boundary: the word
	// starts with `-` and is longer than one byte, both checked above.
	//
	// Reading the character at a byte offset is a slice and a decode. The
	// character *count* this used to be written in is neither: deciding
	// whether one character was the last read the whole word with
	// `chars().count()`, and reaching the character read it again, so a
	// 64 MiB word was read twice over on every one of its options.
	if next_char_offset >= arg.len() || !arg.is_char_boundary(next_char_offset) {
		next_char_offset = DEFAULT_NEXT_CHAR_OFFSET;
	}
	let Some(c) = arg[next_char_offset..].chars().next() else {
		// Arg is too short even at the default offset.
		return Ok(GetOptsResult {
			variable_value: String::from("?"),
			optarg:         None,
			optind:         next_index,
			exit_code:      ExecutionResult::general_error(),
		});
	};

	// Where this option character ends, which is where an attached argument
	// or the next combined flag begins.
	let after_option_char = next_char_offset + c.len_utf8();
	let mut is_last_char_in_option = after_option_char == arg.len();

	let mut variable_value;
	let optarg;

	// Look up the char in the option spec.
	if let Some(takes_arg) = spec.defs.get(&c) {
		variable_value = String::from(c);

		if *takes_arg {
			(variable_value, optarg, is_last_char_in_option, next_index) = resolve_option_argument(
				context,
				spec,
				c,
				arg,
				args_to_parse,
				after_option_char,
				is_last_char_in_option,
				next_index,
			)
			.await?;
		} else {
			optarg = None;
		}
	} else {
		(variable_value, optarg) = report_unknown_option(context, spec, c)?;
	}

	let optind = if is_last_char_in_option {
		// We're done with this argument, so unset the internal char index variable
		// and request an update to OPTIND.
		context.shell.env_mut().unset(VAR_GETOPTS_NEXT_CHAR_INDEX)?;
		next_index + 1
	} else {
		// We have more to go in this argument, so update the internal char index
		// and request that OPTIND not be updated.
		context.shell.env_mut().update_or_add_scalar(
			VAR_GETOPTS_NEXT_CHAR_INDEX,
			after_option_char.to_string(),
			|v| {
				v.hide_from_enumeration();
				Ok(())
			},
			brush_core::env::EnvironmentLookup::Anywhere,
			brush_core::env::EnvironmentScope::Global,
		)?;
		next_index
	};

	Ok(GetOptsResult { variable_value, optarg, optind, exit_code: ExecutionResult::success() })
}

/// Resolves the argument for an option that takes a value. Returns the updated
/// `(variable_value, optarg, is_last_char, next_index)` tuple.
///
/// `optarg_offset` is where the attached form's value starts, in bytes.
///
/// Both forms of the value are whatever the caller put on the command line,
/// so both copies of it are divided. The separate form copied the next word
/// with `clone`; the attached form collected the rest of this word character
/// by character, which reads it again and grows the string as it goes. An
/// attached argument measured dearer than a separate one for exactly that
/// reason.
#[allow(clippy::too_many_arguments)]
async fn resolve_option_argument<SE: brush_core::ShellExtensions>(
	context: &brush_core::ExecutionContext<'_, SE>,
	spec: &OptionSpec,
	c: char,
	arg: &str,
	args_to_parse: &[String],
	optarg_offset: usize,
	is_last_char_in_option: bool,
	mut next_index: usize,
) -> Result<(String, Option<String>, bool, usize), brush_core::Error> {
	// If this is the last character in the token, the argument value comes from
	// the next token. Otherwise, the remainder of the current token is the value.
	if is_last_char_in_option {
		if next_index >= args_to_parse.len() {
			// Missing required argument.
			let (variable_value, optarg) = if spec.silent_errors {
				(String::from(":"), Some(String::from(c)))
			} else {
				if is_opterr_enabled(context) {
					writeln!(context.stderr(), "getopts: option requires an argument -- {c}")?;
				}
				(String::from("?"), None)
			};
			Ok((variable_value, optarg, true, next_index))
		} else {
			next_index += 1;
			let optarg =
				brush_core::clone_in_strides(&context.params, &args_to_parse[next_index - 1])
					.await?;
			Ok((String::from(c), Some(optarg), true, next_index))
		}
	} else {
		let optarg =
			brush_core::clone_in_strides(&context.params, &arg[optarg_offset..]).await?;
		Ok((String::from(c), Some(optarg), true, next_index))
	}
}

/// Handles an unknown option character, reporting an error if appropriate.
fn report_unknown_option<SE: brush_core::ShellExtensions>(
	context: &brush_core::ExecutionContext<'_, SE>,
	spec: &OptionSpec,
	c: char,
) -> Result<(String, Option<String>), brush_core::Error> {
	if !spec.silent_errors && is_opterr_enabled(context) {
		writeln!(context.stderr(), "getopts: illegal option -- {c}")?;
	}

	let optarg = if spec.silent_errors {
		Some(String::from(c))
	} else {
		None
	};

	Ok((String::from("?"), optarg))
}

/// Writes the parsing result back into shell variables: the target variable,
/// OPTARG, OPTIND, and the internal `__GETOPTS_LAST_OPTIND` tracker.
///
/// Only `OPTARG` takes the divided route. The option character, the indices
/// and the tracker are a character and two decimal integers; an option
/// *argument* is whatever was on the command line and can be any size.
async fn update_variables<SE: brush_core::ShellExtensions>(
	context: &mut brush_core::ExecutionContext<'_, SE>,
	variable_name: &str,
	result: GetOptsResult,
) -> Result<ExecutionResult, brush_core::Error> {
	// Update variable value.
	context.shell.env_mut().update_or_add_scalar(
		variable_name,
		result.variable_value,
		|_| Ok(()),
		brush_core::env::EnvironmentLookup::Anywhere,
		brush_core::env::EnvironmentScope::Global,
	)?;

	// Update OPTARG
	if let Some(optarg) = result.optarg {
		context
			.shell
			.env_mut()
			.update_or_add(
				"OPTARG",
				brush_core::variables::ShellValueLiteral::Scalar(optarg),
				|_| Ok(()),
				brush_core::env::EnvironmentLookup::Anywhere,
				brush_core::env::EnvironmentScope::Global,
				&context.params,
			)
			.await?;
	} else {
		context.shell.env_mut().unset("OPTARG")?;
	}

	// Update OPTIND and record it so we can detect external modifications.
	let optind_str = result.optind.to_string();
	context.shell.env_mut().update_or_add_scalar(
		"OPTIND",
		optind_str.clone(),
		|_| Ok(()),
		brush_core::env::EnvironmentLookup::Anywhere,
		brush_core::env::EnvironmentScope::Global,
	)?;
	context.shell.env_mut().update_or_add_scalar(
		VAR_GETOPTS_LAST_OPTIND,
		optind_str,
		|v| {
			v.hide_from_enumeration();
			Ok(())
		},
		brush_core::env::EnvironmentLookup::Anywhere,
		brush_core::env::EnvironmentScope::Global,
	)?;

	Ok(result.exit_code)
}

/// Returns whether OPTERR is enabled (i.e., getopts should print error
/// messages). OPTERR defaults to 1; any nonzero value means errors are enabled.
fn is_opterr_enabled<SE: brush_core::ShellExtensions>(
	context: &brush_core::ExecutionContext<'_, SE>,
) -> bool {
	context
		.shell
		.env_str("OPTERR")
		.is_none_or(|s| s.parse::<i64>().unwrap_or(1) != 0)
}
