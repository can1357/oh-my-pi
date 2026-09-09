use std::{
	collections::HashMap,
	fs,
	io::Write,
	path::{Path, PathBuf},
	str::FromStr as _,
	sync::Arc,
};

use clap::{Parser, ValueEnum};
use itertools::Itertools as _;
use strum::IntoEnumIterator;
use tokio::sync::Mutex;

use crate::{
	ExecutionExitCode, ExecutionResult, builtins,
	interfaces::{self, InputFunction, KeyAction, KeySequence},
	sys, trace_categories,
};

/// Identifier for a keymap
#[derive(Clone, ValueEnum)]
enum BindKeyMap {
	#[clap(name = "emacs-standard", alias = "emacs")]
	EmacsStandard,
	#[clap(name = "emacs-meta")]
	EmacsMeta,
	#[clap(name = "emacs-ctlx")]
	EmacsCtlx,
	#[clap(name = "vi-command", aliases = &["vi", "vi-move"])]
	ViCommand,
	#[clap(name = "vi-insert")]
	ViInsert,
}

impl From<BindKeyMap> for interfaces::KeyMap {
	fn from(value: BindKeyMap) -> Self {
		match value {
			BindKeyMap::EmacsStandard => Self::EmacsStandard,
			BindKeyMap::EmacsMeta => Self::EmacsMeta,
			BindKeyMap::EmacsCtlx => Self::EmacsCtlx,
			BindKeyMap::ViCommand => Self::ViCommand,
			BindKeyMap::ViInsert => Self::ViInsert,
		}
	}
}

/// Inspect and modify key bindings and other input configuration.
#[derive(Parser)]
pub(crate) struct BindCommand {
	/// Name of key map to use.
	#[arg(short = 'm')]
	keymap: Option<BindKeyMap>,
	/// List functions.
	#[arg(short = 'l')]
	list_funcs: bool,
	/// List functions and bindings.
	#[arg(short = 'P')]
	list_funcs_and_bindings: bool,
	/// List functions and bindings in a format suitable for use as input.
	#[arg(short = 'p')]
	list_funcs_and_bindings_reusable: bool,
	/// List key sequences that invoke macros.
	#[arg(short = 'S')]
	list_key_seqs_that_invoke_macros: bool,
	/// List key sequences that invoke macros in a format suitable for use as
	/// input.
	#[arg(short = 's')]
	list_key_seqs_that_invoke_macros_reusable: bool,
	/// List variables.
	#[arg(short = 'V')]
	list_vars: bool,
	/// List variables in a format suitable for use as input.
	#[arg(short = 'v')]
	list_vars_reusable: bool,
	/// Find the keys bound to the given named function.
	#[arg(short = 'q', value_name = "FUNC_NAME")]
	query_func_bindings: Option<String>,
	/// Remove all bindings for the given named function.
	#[arg(short = 'u', value_name = "FUNC_NAME")]
	remove_func_bindings: Option<String>,
	/// Remove the binding for the given key sequence.
	#[arg(short = 'r', value_name = "KEY_SEQ")]
	remove_key_seq_binding: Option<String>,
	/// Import bindings from the given file.
	#[arg(short = 'f', value_name = "PATH")]
	bindings_file: Option<String>,
	/// Bind key sequence to command.
	#[arg(short = 'x', value_name = "BINDING")]
	key_seq_bindings: Vec<String>,
	/// List key sequence bindings.
	#[arg(short = 'X')]
	list_key_seq_bindings: bool,
	/// Key sequence binding to readline function or command.
	key_sequence: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum BindError {
	/// Unknown function specified.
	#[error("unknown function: {0}")]
	UnknownFunction(String),

	/// Unknown key binding function.
	#[error("unknown key binding function: {0}")]
	UnknownKeyBindingFunction(String),

	/// An I/O error occurred.
	#[error("I/O error occurred")]
	IoError(#[from] std::io::Error),

	/// A binding parse error occurred.
	#[error(transparent)]
	BindingParseError(#[from] crate::parser::BindingParseError),
}

impl crate::BuiltinError for BindError {}

impl From<&BindError> for crate::ExecutionExitCode {
	fn from(_err: &BindError) -> Self {
		Self::GeneralError
	}
}

impl builtins::Command for BindCommand {
	type Error = BindError;

	async fn execute<SE: crate::ShellExtensions>(
		&self,
		mut context: crate::ExecutionContext<'_, SE>,
	) -> Result<crate::ExecutionResult, Self::Error> {
		if let Some(key_bindings) = context.shell.key_bindings().cloned() {
			Ok(self.execute_impl(&key_bindings, &mut context).await?)
		} else {
			tracing::debug!(target: trace_categories::INPUT,
                 "bind: key bindings not supported in this config");

			// Silently succeed when key bindings are unavailable (e.g., in
			// non-interactive mode or with an input backend that doesn't
			// yet support them).
			Ok(ExecutionExitCode::Success.into())
		}
	}
}

impl BindCommand {
	#[allow(clippy::too_many_lines)]
	async fn execute_impl(
		&self,
		bindings: &Arc<Mutex<dyn interfaces::KeyBindings>>,
		context: &mut crate::ExecutionContext<'_, impl crate::ShellExtensions>,
	) -> Result<ExecutionResult, BindError> {
		let mut bindings = bindings.lock().await;
		if let Some(keymap) = self.keymap.clone() {
			bindings.select_keymap(keymap.into())?;
		}

		if self.list_funcs {
			for func in interfaces::InputFunction::iter() {
				writeln!(context.stdout(), "{func}")?;
			}
		}

		if self.list_funcs_and_bindings {
			display_funcs_and_bindings(&*bindings, context, false /* reusable? */)?;
		}

		if self.list_funcs_and_bindings_reusable {
			display_funcs_and_bindings(&*bindings, context, true /* reusable? */)?;
		}

		if self.list_key_seqs_that_invoke_macros {
			display_macros(&*bindings, context, false /* reusable? */)?;
		}

		if self.list_key_seqs_that_invoke_macros_reusable {
			display_macros(&*bindings, context, true /* reusable? */)?;
		}

		if self.list_vars {
			let options = &context.shell.completion_config().fallback_options;

			// For now we'll just display a few items and show defaults.
			writeln!(
				context.stdout(),
				"mark-directories is set to `{}'",
				to_onoff(options.mark_directories)
			)?;
			writeln!(
				context.stdout(),
				"mark-symlinked-directories is set to `{}'",
				to_onoff(options.mark_symlinked_directories)
			)?;
		}

		if self.list_vars_reusable {
			let options = &context.shell.completion_config().fallback_options;

			// For now we'll just display a few items and show defaults.
			writeln!(context.stdout(), "set mark-directories {}", to_onoff(options.mark_directories))?;
			writeln!(
				context.stdout(),
				"set mark-symlinked-directories {}",
				to_onoff(options.mark_symlinked_directories)
			)?;
		}

		if let Some(func_str) = &self.query_func_bindings {
			let seqs = find_key_seqs_bound_to_function(&*bindings, func_str)?;

			if !seqs.is_empty() {
				writeln!(
					context.stdout(),
					"{func_str} can be invoked via {}.",
					seqs.iter().map(|seq| std::format!("\"{seq}\"")).join(", ")
				)?;
			} else {
				writeln!(context.stdout(), "{func_str} is not bound to any keys.")?;
				return Ok(ExecutionResult::general_error());
			}
		}

		if let Some(func_str) = &self.remove_func_bindings {
			let found_seqs = find_key_seqs_bound_to_function(&*bindings, func_str)?;

			for seq in found_seqs {
				let _ = bindings.try_unbind(seq);
			}
		}

		if let Some(key_seq_str) = &self.remove_key_seq_binding {
			let key_seq = parse_key_sequence(key_seq_str)?;
			let _ = bindings.try_unbind(key_seq);
		}

		if let Some(bindings_file) = &self.bindings_file {
			let path = context.shell.absolute_path(Path::new(bindings_file));
			import_bindings_file(&mut *bindings, context, &path, 0)?;
		}

		if self.list_key_seq_bindings {
			for (seq, action) in &bindings.get_current() {
				let KeyAction::ShellCommand(cmd) = action else {
					continue;
				};

				writeln!(context.stdout(), "\"{seq}\" \"{cmd}\"")?;
			}
		}

		if !self.key_seq_bindings.is_empty() {
			for key_seq_and_command in &self.key_seq_bindings {
				let (key_seq, command) = parse_key_sequence_and_shell_command(key_seq_and_command)?;
				bind_key_sequence_to_shell_cmd(&mut *bindings, key_seq, command)?;
			}
		}

		if let Some(key_sequence) = &self.key_sequence {
			let (key_seq, target) = parse_key_sequence_and_readline_target(key_sequence.as_str())?;
			bind_key_sequence_to_readline_target(&mut *bindings, key_seq, target)?;
		}

		drop(bindings);

		Ok(ExecutionResult::success())
	}
}

fn import_bindings_file(
	bindings: &mut dyn interfaces::KeyBindings,
	context: &mut crate::ExecutionContext<'_, impl crate::ShellExtensions>,
	path: &Path,
	depth: usize,
) -> Result<(), BindError> {
	if depth >= 32 {
		return Err(std::io::Error::other("readline include nesting is too deep").into());
	}
	let contents = fs::read_to_string(path)?;
	for raw_line in contents.lines() {
		let line = raw_line.trim();
		if line.is_empty() || line.starts_with('#') || line.starts_with("$if ") || line == "$endif" {
			continue;
		}
		if let Some(include) = line.strip_prefix("$include ") {
			let include = PathBuf::from(include.trim());
			let include = if include.is_absolute() {
				include
			} else {
				path
					.parent()
					.unwrap_or_else(|| Path::new("."))
					.join(include)
			};
			import_bindings_file(bindings, context, &include, depth + 1)?;
			continue;
		}
		if let Some(setting) = line.strip_prefix("set ") {
			let (name, value) = setting
				.split_once(char::is_whitespace)
				.ok_or_else(|| std::io::Error::other("invalid readline setting"))?;
			let value = match value.trim() {
				"on" => true,
				"off" => false,
				_ => return Err(std::io::Error::other("readline setting expects on or off").into()),
			};
			let options = &mut context.shell.completion_config_mut().fallback_options;
			match name {
				"mark-directories" => options.mark_directories = value,
				"mark-symlinked-directories" => options.mark_symlinked_directories = value,
				_ => {
					return Err(
						std::io::Error::other(format!("unknown readline setting: {name}")).into(),
					);
				},
			}
			continue;
		}
		let (key_seq, target) = parse_key_sequence_and_readline_target(line)?;
		bind_key_sequence_to_readline_target(bindings, key_seq, target)?;
	}
	Ok(())
}

fn parse_key_sequence(input: &str) -> Result<interfaces::KeySequence, BindError> {
	// First trim any whitespace.
	let input = input.trim();

	let parsed = crate::parser::readline_binding::parse_key_sequence(input)?;
	let abstract_seq = key_sequence_to_abstract_strokes(&parsed)?;

	Ok(abstract_seq)
}

fn parse_key_sequence_and_shell_command(
	input: &str,
) -> Result<(interfaces::KeySequence, String), BindError> {
	// First trim any whitespace.
	let input = input.trim();

	// This should be something of the form:
	//     "KEY-SEQUENCE": SHELL-COMMAND
	let binding = crate::parser::readline_binding::parse_key_sequence_shell_cmd_binding(input)?;
	let abstract_seq = key_sequence_to_abstract_strokes(&binding.seq)?;

	Ok((abstract_seq, binding.shell_cmd))
}

#[derive(Debug)]
#[allow(dead_code, reason = "not all variants implemented yet")]
enum BindableReadlineTarget {
	Function(interfaces::InputFunction),
	Macro(interfaces::KeySequence),
}

fn parse_key_sequence_and_readline_target(
	input: &str,
) -> Result<(interfaces::KeySequence, BindableReadlineTarget), BindError> {
	// First trim any whitespace.
	let input = input.trim();

	// This should be of one of these forms:
	//     "KEY-SEQUENCE":function-name
	//     "KEY-SEQUENCE":readline-command
	let binding = crate::parser::readline_binding::parse_key_sequence_readline_binding(input)?;
	let abstract_seq = key_sequence_to_abstract_strokes(&binding.seq)?;

	match binding.target {
		crate::parser::readline_binding::ReadlineTarget::Function(func_name) => {
			let func = parse_readline_function(func_name.as_str())?;
			Ok((abstract_seq, BindableReadlineTarget::Function(func)))
		},
		crate::parser::readline_binding::ReadlineTarget::Macro(target_seq_str) => {
			let parsed_target = crate::parser::readline_binding::parse_key_sequence(&target_seq_str)?;
			let abstract_target = key_sequence_to_abstract_strokes(&parsed_target)?;
			Ok((abstract_seq, BindableReadlineTarget::Macro(abstract_target)))
		},
	}
}

fn bind_key_sequence_to_shell_cmd(
	bindings: &mut dyn interfaces::KeyBindings,
	key_sequence: interfaces::KeySequence,
	command: String,
) -> Result<(), BindError> {
	bindings.bind(key_sequence, interfaces::KeyAction::ShellCommand(command))?;

	Ok(())
}

fn bind_key_sequence_to_readline_target(
	bindings: &mut dyn interfaces::KeyBindings,
	key_sequence: interfaces::KeySequence,
	target: BindableReadlineTarget,
) -> Result<(), BindError> {
	match target {
		BindableReadlineTarget::Function(func) => {
			bindings.bind(key_sequence, interfaces::KeyAction::DoInputFunction(func))?;
			Ok(())
		},
		BindableReadlineTarget::Macro(cmd_macro) => {
			bindings.define_macro(key_sequence, cmd_macro)?;
			Ok(())
		},
	}
}

fn key_sequence_to_abstract_strokes(
	seq: &crate::parser::readline_binding::KeySequence,
) -> Result<interfaces::KeySequence, BindError> {
	let phys_strokes = crate::parser::readline_binding::key_sequence_to_strokes(seq)?;

	// Lift from key codes to abstract keys.
	let mut abstract_strokes = vec![];
	let mut key_code_bytes = vec![];
	let mut uninterpretable = false;
	for mut phys_stroke in phys_strokes {
		let mut key = sys::input::try_get_key_from_key_code(phys_stroke.key_code.as_slice());

		// If we couldn't interpret it directly but we see it starts with the escape
		// character, try to see if we can parse it as an Alt+<key> sequence.
		if key.is_none() && phys_stroke.key_code.len() > 1 && phys_stroke.key_code[0] == b'\x1b' {
			key = sys::input::try_get_key_from_key_code(&phys_stroke.key_code[1..]);
			if key.is_some() {
				phys_stroke.meta = true;
			}
		}

		// When storing as bytes, apply control modifier to the key code.
		let mut raw_bytes = phys_stroke.key_code.clone();
		if phys_stroke.control {
			for byte in &mut raw_bytes {
				// Control characters are computed by ANDing with 0x1F
				*byte &= 0x1f;
			}
		}
		key_code_bytes.push(raw_bytes);

		if let Some(key) = key {
			abstract_strokes.push(interfaces::KeyStroke {
				alt: phys_stroke.meta,
				control: phys_stroke.control,
				shift: false,
				key,
			});
		} else {
			uninterpretable = true;
		}
	}

	if uninterpretable {
		Ok(interfaces::KeySequence::Bytes(key_code_bytes))
	} else {
		Ok(interfaces::KeySequence::Strokes(abstract_strokes))
	}
}

fn parse_readline_function(func_name: &str) -> Result<interfaces::InputFunction, BindError> {
	interfaces::InputFunction::from_str(func_name)
		.map_err(|_err| BindError::UnknownKeyBindingFunction(func_name.to_owned()))
}

const fn to_onoff(value: bool) -> &'static str {
	if value { "on" } else { "off" }
}

fn display_funcs_and_bindings(
	bindings: &dyn interfaces::KeyBindings,
	context: &crate::ExecutionContext<'_, impl crate::ShellExtensions>,
	reusable: bool,
) -> Result<(), BindError> {
	let mut sequences_by_func: HashMap<InputFunction, Vec<KeySequence>> = HashMap::new();
	for (seq, action) in &bindings.get_current() {
		let KeyAction::DoInputFunction(func) = action else {
			continue;
		};

		sequences_by_func
			.entry(func.clone())
			.or_default()
			.push(seq.clone());
	}

	let sorted_funcs = interfaces::InputFunction::iter().sorted_by_key(|f| f.to_string());

	for func in sorted_funcs {
		if let Some(seqs) = sequences_by_func.get(&func) {
			if reusable {
				for seq in seqs {
					writeln!(context.stdout(), "\"{seq}\": {func}")?;
				}
			} else {
				writeln!(
					context.stdout(),
					"{func} can be found on {}.",
					seqs.iter().map(|seq| std::format!("\"{seq}\"")).join(", ")
				)?;
			}
		} else {
			if reusable {
				writeln!(context.stdout(), "# {func} (not bound)")?;
			} else {
				writeln!(context.stdout(), "{func} is not bound to any keys")?;
			}
		}
	}

	Ok(())
}

fn display_macros(
	bindings: &dyn interfaces::KeyBindings,
	context: &crate::ExecutionContext<'_, impl crate::ShellExtensions>,
	reusable: bool,
) -> Result<(), BindError> {
	for (left, right) in bindings.get_macros() {
		if reusable {
			writeln!(context.stdout(), "\"{left}\": \"{right}\"")?;
		} else {
			writeln!(context.stdout(), "{left} outputs {right}")?;
		}
	}

	Ok(())
}

fn find_key_seqs_bound_to_function(
	bindings: &dyn interfaces::KeyBindings,
	func_str: &str,
) -> Result<Vec<interfaces::KeySequence>, BindError> {
	let Ok(func_to_find) = InputFunction::from_str(func_str) else {
		return Err(BindError::UnknownFunction(func_str.to_owned()));
	};

	let mut found_seqs = vec![];

	for (seq, action) in &bindings.get_current() {
		if let KeyAction::DoInputFunction(func) = action
			&& *func == func_to_find
		{
			found_seqs.push(seq.clone());
		}
	}

	Ok(found_seqs)
}

#[cfg(test)]
mod tests {
	use pretty_assertions::{assert_eq, assert_matches};

	use super::*;
	use crate::builtins::Command as _;
	#[test]
	fn accepts_full_bind_flag_surface() {
		let command = BindCommand::new(
			[
				"bind",
				"-m",
				"emacs-standard",
				"-l",
				"-P",
				"-p",
				"-S",
				"-s",
				"-V",
				"-v",
				"-q",
				"beginning-of-line",
				"-u",
				"end-of-line",
				"-r",
				"\\C-a",
				"-f",
				"inputrc",
				"-x",
				r#""\\C-x": "echo x""#,
				"-X",
				r#""\\C-b": backward-char"#,
			]
			.map(str::to_owned),
		)
		.unwrap();
		assert!(matches!(command.keymap, Some(BindKeyMap::EmacsStandard)));
		assert_eq!(command.bindings_file.as_deref(), Some("inputrc"));
	}

	#[test]
	fn parse_example_key_sequence_and_readline_func() {
		let (key_seq, target) =
			parse_key_sequence_and_readline_target(r#""\C-a":beginning-of-line"#).unwrap();

		assert_eq!(
			key_seq,
			interfaces::KeySequence::Strokes(vec![interfaces::KeyStroke {
				alt:     false,
				control: true,
				shift:   false,
				key:     interfaces::Key::Character('a'),
			}])
		);

		assert_matches!(
			target,
			BindableReadlineTarget::Function(interfaces::InputFunction::BeginningOfLine)
		);
	}

	#[test]
	fn parse_escape_char_key_binding() {
		let (key_seq, target) =
			parse_key_sequence_and_readline_target(r#""\er":transpose-chars"#).unwrap();

		assert_eq!(
			key_seq,
			interfaces::KeySequence::Strokes(vec![interfaces::KeyStroke {
				alt:     true,
				control: false,
				shift:   false,
				key:     interfaces::Key::Character('r'),
			}])
		);

		assert_matches!(
			target,
			BindableReadlineTarget::Function(interfaces::InputFunction::TransposeChars)
		);
	}
}
