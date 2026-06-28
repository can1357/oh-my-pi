use std::path::Path;

use crate::{
	ExecutionParameters, error, expansion, extensions,
	shell::Shell,
	sys::{self, users},
};

const VERSION_MAJOR: &str = env!("CARGO_PKG_VERSION_MAJOR");
const VERSION_MINOR: &str = env!("CARGO_PKG_VERSION_MINOR");
const VERSION_PATCH: &str = env!("CARGO_PKG_VERSION_PATCH");

pub(crate) async fn expand_prompt(
	shell: &mut Shell<impl extensions::ShellExtensions>,
	params: &ExecutionParameters,
	spec: String,
) -> Result<String, error::Error> {
	// Parse the prompt spec into its pieces.
	let prompt_pieces = parse_prompt(spec)?;

	// Now, render each piece.
	let mut formatted_prompt = String::new();
	for piece in prompt_pieces {
		let needs_escaping = matches!(
			piece,
			brush_parser::prompt::PromptPiece::EscapedSequence(_)
				| brush_parser::prompt::PromptPiece::DollarOrPound
		);

		let formatted_piece = format_prompt_piece(shell, piece)?;

		if shell.options().expand_prompt_strings && needs_escaping {
			formatted_prompt.push('\\');
		}

		formatted_prompt.push_str(&formatted_piece);
	}

	if shell.options().expand_prompt_strings {
		// Now expand any remaining escape sequences, but without tilde-expansion.
		let options = expansion::ExpanderOptions { tilde_expand: false, ..Default::default() };
		formatted_prompt =
			expansion::basic_expand_word_with_options(shell, params, &formatted_prompt, &options)
				.await?;
	}

	Ok(formatted_prompt)
}

#[cached::proc_macro::cached(size = 64, result = true)]
fn parse_prompt(
	spec: String,
) -> Result<Vec<brush_parser::prompt::PromptPiece>, brush_parser::WordParseError> {
	brush_parser::prompt::parse(spec.as_str())
}

fn format_prompt_piece(
	shell: &Shell<impl extensions::ShellExtensions>,
	piece: brush_parser::prompt::PromptPiece,
) -> Result<String, error::Error> {
	let formatted = match piece {
		brush_parser::prompt::PromptPiece::EscapedSequence(s) => s,
		brush_parser::prompt::PromptPiece::Literal(l) => l,
		brush_parser::prompt::PromptPiece::AsciiCharacter(c) => {
			char::from_u32(c).map_or_else(String::new, |c| c.to_string())
		},
		brush_parser::prompt::PromptPiece::Backslash => "\\".to_owned(),
		brush_parser::prompt::PromptPiece::BellCharacter => "\x07".to_owned(),
		brush_parser::prompt::PromptPiece::CarriageReturn => "\r".to_owned(),
		brush_parser::prompt::PromptPiece::CurrentCommandNumber => {
			return error::unimp("prompt: current command number");
		},
		brush_parser::prompt::PromptPiece::CurrentHistoryNumber => {
			format_current_history_number(shell)
		},
		brush_parser::prompt::PromptPiece::CurrentUser => users::get_current_username()?,
		brush_parser::prompt::PromptPiece::CurrentWorkingDirectory { tilde_replaced, basename } => {
			format_current_working_directory(shell, tilde_replaced, basename)
		},
		brush_parser::prompt::PromptPiece::Date(format) => {
			format_date(&chrono::Local::now(), &format)
		},
		brush_parser::prompt::PromptPiece::DollarOrPound => {
			if users::is_root() {
				"#".to_owned()
			} else {
				"$".to_owned()
			}
		},
		// NOTE: We mimic bash and convert \[ into \001, a.k.a. RL_PROMPT_START_IGNORE.
		// It will need to get removed before it's actually displayed. While present it
		// also has the important (compatible) side effect of ensuring the text on either
		// side of it is not concatenated together, potentially resulting in incompatible
		// variable expansions. Also, we *only* do this if the shell is interactive.
		brush_parser::prompt::PromptPiece::EndNonPrintingSequence => {
			if shell.options().interactive {
				"\x02".to_owned()
			} else {
				String::new()
			}
		},
		brush_parser::prompt::PromptPiece::EscapeCharacter => "\x1b".to_owned(),
		brush_parser::prompt::PromptPiece::Hostname { only_up_to_first_dot } => {
			let hn = sys::network::get_hostname()
				.unwrap_or_default()
				.to_string_lossy()
				.to_string();
			if only_up_to_first_dot && let Some((first, _)) = hn.split_once('.') {
				return Ok(first.to_owned());
			}
			hn
		},
		brush_parser::prompt::PromptPiece::Newline => "\n".to_owned(),
		brush_parser::prompt::PromptPiece::NumberOfManagedJobs => shell.jobs().jobs.len().to_string(),
		brush_parser::prompt::PromptPiece::ShellBaseName => {
			if let Some(shell_name) = shell.current_shell_name() {
				Path::new(shell_name.as_ref())
					.file_name()
					.map(|name| name.to_string_lossy().to_string())
					.unwrap_or_default()
			} else {
				String::new()
			}
		},
		brush_parser::prompt::PromptPiece::ShellRelease => {
			std::format!("{VERSION_MAJOR}.{VERSION_MINOR}.{VERSION_PATCH}")
		},
		brush_parser::prompt::PromptPiece::ShellVersion => {
			std::format!("{VERSION_MAJOR}.{VERSION_MINOR}")
		},
		// NOTE: See above note for EndNonPrintingSequence
		brush_parser::prompt::PromptPiece::StartNonPrintingSequence => {
			if shell.options().interactive {
				"\x01".to_owned()
			} else {
				String::new()
			}
		},
		brush_parser::prompt::PromptPiece::TerminalDeviceBaseName => {
			sys::terminal::try_get_terminal_device_path()
				.and_then(|p| p.file_name().map(|s| s.to_string_lossy().to_string()))
				.unwrap_or_default()
		},
		brush_parser::prompt::PromptPiece::Time(time_fmt) => {
			format_time(&chrono::Local::now(), &time_fmt)
		},
	};

	Ok(formatted)
}

fn format_current_working_directory(
	shell: &Shell<impl extensions::ShellExtensions>,
	tilde_replaced: bool,
	basename: bool,
) -> String {
	let mut working_dir_str = shell.working_dir().to_string_lossy().to_string();

	if tilde_replaced {
		working_dir_str = shell.tilde_shorten(working_dir_str);
	}

	if basename && let Some(filename) = Path::new(&working_dir_str).file_name() {
		working_dir_str = filename.to_string_lossy().to_string();
	}

	if cfg!(windows) {
		working_dir_str = working_dir_str.replace('\\', "/");
	}

	working_dir_str
}

fn format_current_history_number(shell: &Shell<impl extensions::ShellExtensions>) -> String {
	// Bash renders \! as the history number that will be assigned to the next
	// interactive command. When command history is disabled, bash keeps this at
	// 1 rather than rendering 0.
	shell.history().map_or(1, |history| history.count() + 1).to_string()
}

fn format_time<Tz: chrono::TimeZone>(
	datetime: &chrono::DateTime<Tz>,
	format: &brush_parser::prompt::PromptTimeFormat,
) -> String
where
	Tz::Offset: std::fmt::Display,
{
	let formatted = match format {
		brush_parser::prompt::PromptTimeFormat::TwelveHourAM => datetime.format("%I:%M %p"),
		brush_parser::prompt::PromptTimeFormat::TwelveHourHHMMSS => datetime.format("%I:%M:%S"),
		brush_parser::prompt::PromptTimeFormat::TwentyFourHourHHMM => datetime.format("%H:%M"),
		brush_parser::prompt::PromptTimeFormat::TwentyFourHourHHMMSS => datetime.format("%H:%M:%S"),
	};

	formatted.to_string()
}

fn format_date<Tz: chrono::TimeZone>(
	datetime: &chrono::DateTime<Tz>,
	format: &brush_parser::prompt::PromptDateFormat,
) -> String
where
	Tz::Offset: std::fmt::Display,
{
	match format {
		brush_parser::prompt::PromptDateFormat::WeekdayMonthDate => {
			datetime.format("%a %b %d").to_string()
		},
		brush_parser::prompt::PromptDateFormat::Custom(fmt) => {
			let fmt_items = chrono::format::StrftimeItems::new(fmt);
			datetime.format_with_items(fmt_items).to_string()
		},
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn test_format_time() {
		// Create a well-known test date/time.
		let dt = chrono::DateTime::parse_from_rfc3339("2024-12-25T13:34:56.789Z").unwrap();

		assert_eq!(
			format_time(&dt, &brush_parser::prompt::PromptTimeFormat::TwelveHourAM),
			"01:34 PM"
		);

		assert_eq!(
			format_time(&dt, &brush_parser::prompt::PromptTimeFormat::TwentyFourHourHHMMSS),
			"13:34:56"
		);

		assert_eq!(
			format_time(&dt, &brush_parser::prompt::PromptTimeFormat::TwelveHourHHMMSS),
			"01:34:56"
		);
	}

	#[test]
	fn test_format_date() {
		// Create a well-known test date/time.
		let dt = chrono::DateTime::parse_from_rfc3339("2024-12-25T12:34:56.789Z").unwrap();

		assert_eq!(
			format_date(&dt, &brush_parser::prompt::PromptDateFormat::WeekdayMonthDate),
			"Wed Dec 25"
		);

		assert_eq!(
			format_date(
				&dt,
				&brush_parser::prompt::PromptDateFormat::Custom(String::from("%Y-%m-%d"))
			),
			"2024-12-25"
		);

		assert_eq!(
			format_date(
				&dt,
				&brush_parser::prompt::PromptDateFormat::Custom(String::from("%Y-%m-%d %H:%M:%S.%f"))
			),
			"2024-12-25 12:34:56.789000000"
		);
	}
}
