use std::{fs::File, io::Write, path::PathBuf};

use brush_core::{ExecutionExitCode, ExecutionResult, builtins, history};
use clap::Parser;

/// Query or manipulate the shell's command history.
// TODO(history): Evaluate which of the options conflict with each other.
#[derive(Parser)]
#[expect(clippy::option_option)]
pub(crate) struct HistoryCommand {
	/// Clears all history.
	#[arg(short = 'c')]
	clear_history: bool,

	/// Deletes the history entry at the given offset. Positive offsets are
	/// relative to the beginning of the history, while negative offsets are
	/// relative to the end of the history.
	#[arg(short = 'd', value_name = "OFFSET")]
	delete_offset: Option<i64>,

	/// Appends the history from the current session to the history file.
	#[arg(short = 'a', group = "anrw", num_args = 0..=1, value_name = "HIST_FILE")]
	append_session_to_file: Option<Option<String>>,

	/// Appends any remaining history from the history file to the current
	/// session.
	#[arg(short = 'n', group = "anrw", num_args = 0..=1, value_name = "HIST_FILE")]
	append_rest_of_file_to_session: Option<Option<String>>,

	/// Appends the history from the history file to the current session.
	#[arg(short = 'r', group = "anrw", num_args = 0..=1, value_name = "HIST_FILE")]
	append_file_to_session: Option<Option<String>>,

	/// Replaces the history file with the current session history.
	#[arg(short = 'w', group = "anrw", num_args = 0..=1, value_name = "HIST_FILE")]
	write_session_to_file: Option<Option<String>>,

	/// History-expands positional arguments and displays them.
	#[arg(short = 'p', num_args = 0.., value_name = "ARG")]
	expand_args: Option<Vec<String>>,

	/// Appends positional arguments as an entry in the current session.
	#[arg(short = 's', num_args = 0.., value_name = "ARG")]
	append_args_to_session: Option<Vec<String>>,

	/// Arguments.
	#[arg(trailing_var_arg = true, allow_hyphen_values = true)]
	args: Vec<String>,
}

struct HistoryConfig {
	default_history_file_path: Option<PathBuf>,
	time_format:               Option<String>,
}

impl builtins::Command for HistoryCommand {
	type Error = brush_core::Error;

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<ExecutionResult, Self::Error> {
		// Retrieve the shell's history config while we still can.
		let config = HistoryConfig {
			default_history_file_path: context.shell.history_file_path(),
			time_format:               context.shell.history_time_format(),
		};

		let stdout = context.stdout();
		let stderr = context.stderr();

		if let Some(history) = context.shell.history_mut() {
			self.execute_with_history(history, config, stdout, stderr)
		} else {
			Err(brush_core::ErrorKind::HistoryNotEnabled.into())
		}
	}
}

impl HistoryCommand {
	#[expect(clippy::cast_possible_wrap)]
	#[expect(clippy::cast_possible_truncation)]
	#[expect(clippy::cast_sign_loss)]
	fn execute_with_history(
		&self,
		history: &mut history::History,
		config: HistoryConfig,
		stdout: impl Write,
		mut stderr: impl Write,
	) -> Result<ExecutionResult, brush_core::Error> {
		if self.clear_history {
			history.clear()?;
		}

		if let Some(offset) = self.delete_offset {
			if offset == 0 {
				writeln!(stderr, "cannot delete history item at offset 0")?;
				return Ok(ExecutionExitCode::InvalidUsage.into());
			}

			if offset > 0 {
				// Convert to 0-based index.
				let index = (offset - 1) as usize;
				if !history.remove_nth_item(index) {
					writeln!(stderr, "index past end of history")?;
					return Ok(ExecutionExitCode::InvalidUsage.into());
				}
			} else {
				let count = history.count() as i64;
				let index = count + offset;
				if index < 0 {
					writeln!(stderr, "index before beginning of history")?;
					return Ok(ExecutionExitCode::InvalidUsage.into());
				}

				let _ = history.remove_nth_item(index as usize);
			}

			return Ok(ExecutionResult::success());
		}

		if let Some(append_option) = &self.append_session_to_file {
			if let Some(file_path) = get_effective_history_file_path(
				config.default_history_file_path,
				append_option.as_ref(),
			) {
				history.flush(
					file_path,
					true,                         /* append? */
					true,                         /* unsaved items only */
					config.time_format.is_some(), /* write timestamps? */
				)?;
			}

			return Ok(ExecutionResult::success());
		}

		if let Some(read_option) = &self.append_rest_of_file_to_session {
			if let Some(file_path) =
				get_effective_history_file_path(config.default_history_file_path, read_option.as_ref())
			{
				append_history_file_to_session(history, file_path, HistoryReadMode::Unread)?;
			}

			return Ok(ExecutionResult::success());
		}

		if let Some(read_option) = &self.append_file_to_session {
			if let Some(file_path) =
				get_effective_history_file_path(config.default_history_file_path, read_option.as_ref())
			{
				append_history_file_to_session(history, file_path, HistoryReadMode::All)?;
			}

			return Ok(ExecutionResult::success());
		}

		if let Some(write_option) = &self.write_session_to_file {
			if let Some(file_path) =
				get_effective_history_file_path(config.default_history_file_path, write_option.as_ref())
			{
				history.flush(
					file_path,
					false,                        /* append? */
					false,                        /* unsaved items only? */
					config.time_format.is_some(), /* write timestamps? */
				)?;
			}

			return Ok(ExecutionResult::success());
		}

		if let Some(args) = &self.expand_args {
			return expand_history_args(history, args, stdout, stderr);
		}

		if let Some(args) = &self.append_args_to_session {
			history.add(history::Item::new(args.join(" ")))?;
			return Ok(ExecutionResult::success());
		}

		let max_entries: Option<usize> = if let Some(arg) = self.args.first() {
			Some(brush_core::int_utils::parse(arg.as_str(), 10)?)
		} else {
			None
		};

		display_history(history, &config, max_entries, stdout, stderr)?;

		Ok(ExecutionResult::success())
	}
}

fn expand_history_args(
	history: &history::History,
	args: &[String],
	mut stdout: impl Write,
	mut stderr: impl Write,
) -> Result<ExecutionResult, brush_core::Error> {
	let mut result = ExecutionResult::success();

	for arg in args {
		match expand_history_arg(history, arg) {
			Ok(expanded) => {
				writeln!(stdout, "{expanded}")?;
			},
			Err(()) => {
				writeln!(stderr, "history: {arg}: history expansion failed")?;
				result = ExecutionResult::general_error();
			},
		}
	}

	Ok(result)
}

fn expand_history_arg(history: &history::History, arg: &str) -> Result<String, ()> {
	let chars: Vec<char> = arg.chars().collect();
	let mut expanded = String::new();
	let mut i = 0;

	while i < chars.len() {
		if chars[i] != '!' {
			expanded.push(chars[i]);
			i += 1;
			continue;
		}

		i += 1;
		if i == chars.len() {
			expanded.push('!');
			break;
		}

		let event = match chars[i] {
			'!' => {
				i += 1;
				latest_history_event(history)?
			},
			'#' => {
				i += 1;
				let current_line = expanded.clone();
				expanded.push_str(&current_line);
				continue;
			},
			':' => latest_history_event(history)?,
			'$' | '^' | '*' => {
				let event = latest_history_event(history)?;
				let selected = select_history_words(&event, chars[i], None)?;
				i += 1;
				expanded.push_str(&selected);
				continue;
			},
			'-' => {
				i += 1;
				let (offset, next_i) = parse_history_number(&chars, i).ok_or(())?;
				i = next_i;
				relative_history_event(history, offset)?
			},
			'?' => {
				i += 1;
				let start = i;
				while i < chars.len() && chars[i] != '?' {
					i += 1;
				}
				let needle: String = chars[start..i].iter().collect();
				if i < chars.len() && chars[i] == '?' {
					i += 1;
				}
				find_history_event(history, &needle, HistorySearchMode::Contains)?
			},
			c if c.is_ascii_digit() => {
				let (number, next_i) = parse_history_number(&chars, i).ok_or(())?;
				i = next_i;
				numbered_history_event(history, number)?
			},
			c if is_history_event_char(c) => {
				let start = i;
				while i < chars.len() && is_history_event_char(chars[i]) {
					i += 1;
				}
				let prefix: String = chars[start..i].iter().collect();
				find_history_event(history, &prefix, HistorySearchMode::Prefix)?
			},
			_ => {
				expanded.push('!');
				continue;
			},
		};

		if i < chars.len() && chars[i] == ':' {
			i += 1;
			if i == chars.len() {
				return Err(());
			}
			let selector = chars[i];
			i += 1;
			let number = if selector.is_ascii_digit() {
				let (number, next_i) = parse_history_number_from_first(&chars, i - 1);
				i = next_i;
				Some(number)
			} else {
				None
			};
			let selected = select_history_words(&event, selector, number)?;
			expanded.push_str(&selected);
		} else {
			expanded.push_str(&event);
		}
	}

	Ok(expanded)
}

fn latest_history_event(history: &history::History) -> Result<String, ()> {
	history
		.iter()
		.last()
		.map(|item| item.command_line.clone())
		.ok_or(())
}

fn numbered_history_event(history: &history::History, number: usize) -> Result<String, ()> {
	if number == 0 {
		return Err(());
	}

	history
		.get(number - 1)
		.map(|item| item.command_line.clone())
		.ok_or(())
}

fn relative_history_event(history: &history::History, offset: usize) -> Result<String, ()> {
	let count = history.count();
	if offset == 0 || offset > count {
		return Err(());
	}

	numbered_history_event(history, count - offset + 1)
}

enum HistorySearchMode {
	Prefix,
	Contains,
}

fn find_history_event(
	history: &history::History,
	needle: &str,
	mode: HistorySearchMode,
) -> Result<String, ()> {
	let mut match_result = None;
	for item in history.iter() {
		let matches = match mode {
			HistorySearchMode::Prefix => item.command_line.starts_with(needle),
			HistorySearchMode::Contains => item.command_line.contains(needle),
		};
		if matches {
			match_result = Some(item.command_line.clone());
		}
	}

	match_result.ok_or(())
}

fn select_history_words(
	event: &str,
	selector: char,
	number: Option<usize>,
) -> Result<String, ()> {
	let words: Vec<&str> = event.split_whitespace().collect();
	match selector {
		'0'..='9' => {
			let index = number.ok_or(())?;
			words.get(index).map(|word| (*word).to_owned()).ok_or(())
		},
		'^' => words.get(1).map(|word| (*word).to_owned()).ok_or(()),
		'$' => words.last().map(|word| (*word).to_owned()).ok_or(()),
		'*' => Ok(words.get(1..).unwrap_or_default().join(" ")),
		'p' => Ok(event.to_owned()),
		_ => Err(()),
	}
}

fn parse_history_number(chars: &[char], i: usize) -> Option<(usize, usize)> {
	if i == chars.len() || !chars[i].is_ascii_digit() {
		return None;
	}

	Some(parse_history_number_from_first(chars, i))
}

fn parse_history_number_from_first(chars: &[char], mut i: usize) -> (usize, usize) {
	let mut value = 0;
	while i < chars.len() && chars[i].is_ascii_digit() {
		value = value * 10 + chars[i].to_digit(10).unwrap_or_default() as usize;
		i += 1;
	}
	(value, i)
}

fn is_history_event_char(c: char) -> bool {
	c.is_alphanumeric() || matches!(c, '_' | '-' | '.' | '/')
}

fn display_history(
	history: &history::History,
	config: &HistoryConfig,
	max_entries: Option<usize>,
	mut stdout: impl Write,
	_stderr: impl Write,
) -> Result<(), brush_core::Error> {
	let item_count = history.count();
	let skip_count = item_count - max_entries.unwrap_or(item_count);

	for (i, item) in history.iter().skip(skip_count).enumerate() {
		let mut formatted_timestamp = String::new();

		if let Some(timestamp) = item.timestamp {
			let local_timestamp = timestamp.with_timezone(&chrono::Local);
			if let Some(time_format) = &config.time_format {
				let fmt_items = chrono::format::StrftimeItems::new(time_format);
				formatted_timestamp = local_timestamp.format_with_items(fmt_items).to_string();
			}
		}

		// Output format is something like:
		//     1  echo hello world
		std::writeln!(
			stdout,
			"{:>5}  {formatted_timestamp}{}",
			skip_count + i + 1,
			item.command_line
		)?;
	}

	Ok(())
}

enum HistoryReadMode {
	All,
	Unread,
}

fn append_history_file_to_session(
	history: &mut history::History,
	file_path: PathBuf,
	mode: HistoryReadMode,
) -> Result<(), brush_core::Error> {
	let file = File::open(file_path)?;
	let imported_history = history::History::import(file)?;
	let already_read_count = match mode {
		HistoryReadMode::All => 0,
		HistoryReadMode::Unread => history.iter().filter(|item| !item.dirty).count(),
	};

	for item in imported_history.iter().skip(already_read_count) {
		history.add(item.clone())?;
	}

	Ok(())
}

fn get_effective_history_file_path(
	default_history_file_path: Option<PathBuf>,
	option: Option<&String>,
) -> Option<PathBuf> {
	option.map_or_else(|| default_history_file_path, |file_path| Some(PathBuf::from(file_path)))
}

#[cfg(test)]
mod tests {
	use std::{
		fs,
		path::PathBuf,
		time::{SystemTime, UNIX_EPOCH},
	};

	use anyhow::Result;
	use pretty_assertions::{assert_eq, assert_matches};

	use super::*;

	#[test]
	fn test_parse_dash_a() -> Result<()> {
		let cmd = HistoryCommand::try_parse_from(["history", "5"])?;
		assert_matches!(cmd.append_session_to_file, None);

		let cmd = HistoryCommand::try_parse_from(["history", "-a"])?;
		assert_matches!(cmd.append_session_to_file, Some(None));

		let cmd = HistoryCommand::try_parse_from(["history", "-a", "token"])?;
		assert_eq!(cmd.append_session_to_file, Some(Some(String::from("token"))));

		Ok(())
	}

	#[test]
	fn test_append_history_file_to_session_reads_all_entries() -> Result<()> {
		let file_path = write_temp_history("history-r", "one\ntwo\n")?;
		let mut history = history::History::default();
		history.add(history::Item::new("local"))?;

		append_history_file_to_session(&mut history, file_path.clone(), HistoryReadMode::All)?;

		assert_eq!(history.count(), 3);
		assert_eq!(history.get(0).map(|item| item.command_line.as_str()), Some("local"));
		assert_eq!(history.get(1).map(|item| item.command_line.as_str()), Some("one"));
		assert_eq!(history.get(2).map(|item| item.command_line.as_str()), Some("two"));
		assert_eq!(history.get(1).map(|item| item.dirty), Some(false));
		fs::remove_file(file_path)?;

		Ok(())
	}

	#[test]
	fn test_append_history_file_to_session_reads_unread_entries_after_clean_history() -> Result<()> {
		let initial_file_path = write_temp_history("history-n-initial", "one\ntwo\n")?;
		let mut history = history::History::import(fs::File::open(&initial_file_path)?)?;
		history.add(history::Item::new("local"))?;

		let updated_file_path = write_temp_history("history-n-updated", "one\ntwo\nthree\n")?;
		append_history_file_to_session(&mut history, updated_file_path.clone(), HistoryReadMode::Unread)?;

		assert_eq!(history.count(), 4);
		assert_eq!(history.get(2).map(|item| item.command_line.as_str()), Some("local"));
		assert_eq!(history.get(3).map(|item| item.command_line.as_str()), Some("three"));
		assert_eq!(history.get(3).map(|item| item.dirty), Some(false));
		fs::remove_file(initial_file_path)?;
		fs::remove_file(updated_file_path)?;

		Ok(())
	}

	fn write_temp_history(name: &str, contents: &str) -> Result<PathBuf> {
		let mut path = std::env::temp_dir();
		let nanos = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
		path.push(format!("brush-{name}-{nanos}.history"));
		fs::write(&path, contents)?;
		Ok(path)
	}
}
