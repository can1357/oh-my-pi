use std::{
	fs::{self, OpenOptions},
	io::Write,
	path::{Path, PathBuf},
};

use clap::Parser;

use crate::{ExecutionResult, builtins, error, history};

/// Process command history list.
#[derive(Parser)]
pub(crate) struct FcCommand {
	/// List commands instead of editing them.
	#[arg(short = 'l')]
	list: bool,

	/// Suppress line numbers when listing.
	#[arg(short = 'n', requires = "list")]
	no_line_numbers: bool,

	/// Reverse the order of commands.
	#[arg(short = 'r')]
	reverse: bool,

	/// Re-execute command after substitution (old=new format).
	#[arg(short = 's')]
	substitute: bool,

	/// Editor to use (only relevant when not listing or substituting).
	#[arg(short = 'e', value_name = "ENAME")]
	editor: Option<String>,

	/// First command in range (number or string prefix).
	#[arg(value_name = "FIRST", allow_hyphen_values = true)]
	first: Option<String>,

	/// Last command in range (number or string prefix).
	#[arg(value_name = "LAST", allow_hyphen_values = true)]
	last: Option<String>,
}

impl builtins::Command for FcCommand {
	type Error = crate::Error;

	async fn execute<SE: crate::ShellExtensions>(
		&self,
		context: crate::ExecutionContext<'_, SE>,
	) -> Result<ExecutionResult, Self::Error> {
		if self.substitute {
			return self.do_execute(context).await;
		}

		if self.list {
			return self.do_list(&context);
		}

		self.do_edit(context).await
	}
}

impl FcCommand {
	fn do_list(
		&self,
		context: &crate::ExecutionContext<'_, impl crate::ShellExtensions>,
	) -> Result<ExecutionResult, crate::Error> {
		let history = context
			.shell
			.history()
			.ok_or_else(|| crate::Error::from(crate::ErrorKind::HistoryNotEnabled))?;

		let (first_idx, last_idx, reverse) = self.resolve_range(history)?;

		// Determine the order of iteration
		let indices: Vec<usize> = if reverse {
			(first_idx..=last_idx).rev().collect()
		} else {
			(first_idx..=last_idx).collect()
		};

		for idx in indices {
			if let Some(item) = history.get(idx) {
				if self.no_line_numbers {
					// With -n, bash still outputs a tab before the command
					writeln!(context.stdout(), "\t {}", item.command_line)?;
				} else {
					// Match bash's fc format: number, tab, command
					writeln!(context.stdout(), "{}\t {}", idx + 1, item.command_line)?;
				}
			}
		}

		Ok(ExecutionResult::success())
	}

	async fn do_edit(
		&self,
		context: crate::ExecutionContext<'_, impl crate::ShellExtensions>,
	) -> Result<ExecutionResult, crate::Error> {
		let history = context
			.shell
			.history()
			.ok_or_else(|| crate::Error::from(crate::ErrorKind::HistoryNotEnabled))?;

		let (first_idx, last_idx, reverse) = self.resolve_range(history)?;
		let mut commands = String::new();
		let indices: Vec<usize> = if reverse {
			(first_idx..=last_idx).rev().collect()
		} else {
			(first_idx..=last_idx).collect()
		};

		for idx in indices {
			let item = history
				.get(idx)
				.ok_or_else(|| crate::Error::from(error::ErrorKind::HistoryItemNotFound))?;
			commands.push_str(&item.command_line);
			commands.push('\n');
		}

		let editor = self.editor_name(&context);
		if editor.as_deref() != Some("-") {
			let temp_file = FcTempFile::create(context.params.path_policy())?;
			fs::write(temp_file.path(), commands)?;

			let edit_cmd =
				format!("{} {}", editor.as_deref().unwrap_or("vi"), shell_quote_path(temp_file.path()));
			let source_info = crate::SourceInfo::from("(fc editor)");
			let edit_result = context
				.shell
				.run_string(edit_cmd, &source_info, &context.params)
				.await?;
			if !edit_result.is_success() {
				return Ok(edit_result);
			}

			commands = fs::read_to_string(temp_file.path())?;
		}

		let history_mut = context
			.shell
			.history_mut()
			.ok_or_else(|| crate::Error::from(crate::ErrorKind::HistoryNotEnabled))?;
		history_mut.remove_nth_item(history_mut.count().saturating_sub(1));

		if commands.trim().is_empty() {
			return Ok(ExecutionResult::success());
		}

		let source_info = crate::SourceInfo::from("(history)");
		let result = context
			.shell
			.run_string(commands.clone(), &source_info, &context.params)
			.await?;
		context.shell.add_to_history(commands.trim_end())?;

		Ok(result)
	}

	fn editor_name(
		&self,
		context: &crate::ExecutionContext<'_, impl crate::ShellExtensions>,
	) -> Option<String> {
		if let Some(editor) = self.editor.as_ref().filter(|value| !value.is_empty()) {
			return Some(editor.clone());
		}

		context
			.shell
			.env()
			.get_str("FCEDIT", context.shell)
			.filter(|value| !value.is_empty())
			.or_else(|| {
				context
					.shell
					.env()
					.get_str("EDITOR", context.shell)
					.filter(|value| !value.is_empty())
			})
			.map(|value| value.into_owned())
	}

	async fn do_execute(
		&self,
		context: crate::ExecutionContext<'_, impl crate::ShellExtensions>,
	) -> Result<ExecutionResult, crate::Error> {
		let history = context
			.shell
			.history()
			.ok_or_else(|| crate::Error::from(crate::ErrorKind::HistoryNotEnabled))?;

		// Parse the first argument for pattern=replacement
		let (pattern, replacement) = self
			.first
			.as_ref()
			.and_then(|s| s.split_once('='))
			.map_or((None, None), |(p, r)| (Some(p), Some(r)));

		// Determine which command to re-execute
		let cmd_spec = if pattern.is_some() {
			// If we have a pattern, the command spec is in 'last' if present
			self.last.as_deref()
		} else {
			// Otherwise, it's in 'first'
			self.first.as_deref()
		};

		// Find the command
		let cmd_line = if let Some(spec) = cmd_spec {
			Self::find_command_by_specifier(history, spec)?
		} else {
			// No spec means use the previous command (excluding the fc command itself)
			let effective_count = effective_history_count(history);
			history
				.get(effective_count.saturating_sub(1))
				.map(|item| item.command_line.clone())
				.ok_or_else(|| crate::Error::from(error::ErrorKind::HistoryItemNotFound))?
		};

		// Apply substitution if present
		let final_cmd = if let (Some(pat), Some(rep)) = (pattern, replacement) {
			cmd_line.replace(pat, rep)
		} else {
			cmd_line
		};

		// Echo the command to stderr.
		writeln!(context.stderr(), "{final_cmd}")?;

		// Remove the fc command from history before executing the substituted command
		// This matches bash behavior where the fc command is replaced by the executed
		// command
		let history_mut = context
			.shell
			.history_mut()
			.ok_or_else(|| crate::Error::from(crate::ErrorKind::HistoryNotEnabled))?;
		history_mut.remove_nth_item(history_mut.count().saturating_sub(1));

		let source_info = crate::SourceInfo::from("(history)");

		// Execute the command
		let result = context
			.shell
			.run_string(final_cmd.clone(), &source_info, &context.params)
			.await?;

		// Add the executed command to history.
		context.shell.add_to_history(&final_cmd)?;

		Ok(result)
	}

	fn resolve_range(
		&self,
		history: &history::History,
	) -> Result<(usize, usize, bool), crate::Error> {
		let effective_count = effective_history_count(history);
		let max_idx = effective_count.saturating_sub(1);

		// Resolve first index
		let first_idx = self
			.first
			.as_ref()
			.map(|s| Self::resolve_position(history, s))
			.transpose()?
			.unwrap_or_else(|| {
				if self.list {
					effective_count.saturating_sub(16) // Default for listing: -16
				} else {
					max_idx // Default for editing: previous command
				}
			});

		// Resolve last index (default depends on mode and first_idx)
		let default_last = if self.list { max_idx } else { first_idx };
		let last_idx = self
			.last
			.as_ref()
			.map(|s| Self::resolve_position(history, s))
			.transpose()?
			.unwrap_or(default_last);

		// If first > last, swap them and indicate reversal
		let (first_idx, last_idx, force_reverse) = if first_idx > last_idx {
			(last_idx, first_idx, true)
		} else {
			(first_idx, last_idx, false)
		};

		// Clamp both indices to valid range
		Ok((first_idx.min(max_idx), last_idx.min(max_idx), force_reverse || self.reverse))
	}

	/// Resolves a position specifier (number or string prefix) to a history
	/// index. NOTE: The returned index may still be out of range if the history
	/// is empty.
	///
	/// # Arguments
	///
	/// * `history` - The history to resolve against.
	/// * `spec` - The position specifier (number or string prefix).
	fn resolve_position(history: &history::History, spec: &str) -> Result<usize, crate::Error> {
		// Try to parse it as a number. If it's not parseable, then we need to assume
		// it's a string prefix we need to search for.
		let Ok(num) = spec.parse::<i64>() else {
			// Not a number, treat as string prefix
			return Self::find_command_by_prefix(history, spec);
		};

		let effective_count = effective_history_count(history);

		#[expect(clippy::cast_sign_loss)]
		#[expect(clippy::cast_possible_truncation)]
		let result = match num.cmp(&0) {
			std::cmp::Ordering::Equal => {
				// 0 means -1 for listing (relative to effective count)
				effective_count.saturating_sub(1)
			},
			std::cmp::Ordering::Greater => {
				// Positive: 1-based index
				let idx = (num - 1) as usize;
				if idx < effective_count {
					idx
				} else {
					// Out of range - use 0 (first item)
					0
				}
			},
			std::cmp::Ordering::Less => {
				// Negative: offset from end (relative to effective count)
				let offset = (-num) as usize;
				effective_count.saturating_sub(offset)
			},
		};

		Ok(result)
	}

	/// Finds the command matching the given specifier (number or string prefix).
	/// Returns the command line. Returns an error if no such command can be
	/// found in the history.
	///
	/// # Arguments
	///
	/// * `history` - The history to search.
	/// * `spec` - The position spec
	fn find_command_by_specifier(
		history: &history::History,
		spec: &str,
	) -> Result<String, crate::Error> {
		let idx = Self::resolve_position(history, spec)?;
		history
			.get(idx)
			.map(|item| item.command_line.clone())
			.ok_or_else(|| crate::Error::from(error::ErrorKind::HistoryItemNotFound))
	}

	/// Finds the most recent command starting with the given prefix. Returns
	/// the index of the command in the history. Returns an error if no such
	/// command can be found in the history.
	///
	/// # Arguments
	///
	/// * `history` - The history to search.
	/// * `prefix` - The command prefix to search for.
	fn find_command_by_prefix(
		history: &history::History,
		prefix: &str,
	) -> Result<usize, crate::Error> {
		// Search backwards for a command starting with the prefix (excluding fc command
		// itself)
		let effective_count = effective_history_count(history);

		for idx in (0..effective_count).rev() {
			if let Some(item) = history.get(idx) {
				if item.command_line.starts_with(prefix) {
					return Ok(idx);
				}
			}
		}

		Err(crate::Error::from(error::ErrorKind::HistoryItemNotFound))
	}
}

struct FcTempFile {
	path: PathBuf,
}

impl FcTempFile {
	fn create(
		path_policy: Option<&std::sync::Arc<dyn crate::PathPolicy>>,
	) -> Result<Self, crate::Error> {
		let temp_dir = std::env::temp_dir();
		let process_id = std::process::id();

		for attempt in 0_u32..100 {
			let path = temp_dir.join(format!("brush-fc-{process_id}-{attempt}.sh"));
			if let Some(policy) = path_policy {
				policy.check_write(&path)?;
			}
			match OpenOptions::new().write(true).create_new(true).open(&path) {
				Ok(_) => return Ok(Self { path }),
				Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {},
				Err(err) => return Err(err.into()),
			}
		}

		Err(
			std::io::Error::new(
				std::io::ErrorKind::AlreadyExists,
				"failed to create a unique fc temporary file",
			)
			.into(),
		)
	}

	fn path(&self) -> &Path {
		&self.path
	}
}

impl Drop for FcTempFile {
	fn drop(&mut self) {
		let _ = fs::remove_file(&self.path);
	}
}

fn shell_quote_path(path: &Path) -> String {
	let mut quoted = String::from("'");
	for ch in path.to_string_lossy().chars() {
		if ch == '\'' {
			quoted.push_str("'\\''");
		} else {
			quoted.push(ch);
		}
	}
	quoted.push('\'');
	quoted
}

/// Returns the effective history count (excluding the fc command itself).
fn effective_history_count(history: &history::History) -> usize {
	history.count().saturating_sub(1)
}
#[cfg(test)]
mod tests {
	use super::*;

	struct DenyWrites;

	impl crate::PathPolicy for DenyWrites {
		fn check_read(&self, path: &Path) -> Result<(), crate::PathDenied> {
			Err(crate::PathDenied { path: path.to_path_buf(), access: crate::PathAccess::Read })
		}

		fn check_write(&self, path: &Path) -> Result<(), crate::PathDenied> {
			Err(crate::PathDenied { path: path.to_path_buf(), access: crate::PathAccess::Write })
		}

		fn open(
			&self,
			path: &Path,
			request: crate::OpenRequest,
		) -> Result<std::fs::File, crate::PathDenied> {
			Err(crate::PathDenied { path: path.to_path_buf(), access: request.access })
		}
	}

	fn sample_history() -> history::History {
		let mut history = history::History::default();
		for command in ["echo one", "pwd", "echo two", "fc -l"] {
			history.add(history::Item::new(command)).unwrap();
		}
		history
	}

	#[test]
	fn resolves_numeric_relative_and_prefix_history_positions() {
		let history = sample_history();
		assert_eq!(FcCommand::resolve_position(&history, "1").unwrap(), 0);
		assert_eq!(FcCommand::resolve_position(&history, "-1").unwrap(), 2);
		assert_eq!(FcCommand::resolve_position(&history, "echo").unwrap(), 2);
		assert_eq!(FcCommand::find_command_by_specifier(&history, "pwd").unwrap(), "pwd");
	}

	#[test]
	fn quotes_editor_paths_containing_single_quotes() {
		assert_eq!(shell_quote_path(Path::new("a'b")), "'a'\\''b'");
	}
	#[test]
	fn temp_script_creation_obeys_path_policy() {
		let policy: std::sync::Arc<dyn crate::PathPolicy> = std::sync::Arc::new(DenyWrites);
		assert!(FcTempFile::create(Some(&policy)).is_err());
	}
}
