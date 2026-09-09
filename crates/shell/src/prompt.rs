use std::path::Path;

use jiff::{Zoned, fmt::strtime};

use crate::{
	ExecutionParameters, error, expansion, extensions,
	parser::{
		WordParseError,
		prompt::{PromptDateFormat, PromptPiece, PromptTimeFormat, parse},
	},
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
			crate::parser::prompt::PromptPiece::EscapedSequence(_)
				| crate::parser::prompt::PromptPiece::DollarOrPound
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

#[omp_macros::cached(size = 64, result = true)]
fn parse_prompt(spec: String) -> Result<Vec<PromptPiece>, WordParseError> {
	parse(spec.as_str())
}

fn format_prompt_piece(
	shell: &Shell<impl extensions::ShellExtensions>,
	piece: PromptPiece,
) -> Result<String, error::Error> {
	let formatted = match piece {
		PromptPiece::EscapedSequence(s) => s,
		PromptPiece::Literal(l) => l,
		PromptPiece::AsciiCharacter(c) => {
			char::from_u32(c).map_or_else(String::new, |c| c.to_string())
		},
		PromptPiece::Backslash => "\\".to_owned(),
		PromptPiece::BellCharacter => "\x07".to_owned(),
		PromptPiece::CarriageReturn => "\r".to_owned(),
		PromptPiece::CurrentCommandNumber => {
			return error::unimp("prompt: current command number");
		},
		PromptPiece::CurrentHistoryNumber => String::new(),
		PromptPiece::CurrentUser => users::get_current_username()?,
		PromptPiece::CurrentWorkingDirectory { tilde_replaced, basename } => {
			format_current_working_directory(shell, tilde_replaced, basename)
		},
		PromptPiece::Date(format) => format_date(&Zoned::now(), &format),
		PromptPiece::DollarOrPound => {
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
		PromptPiece::EndNonPrintingSequence => {
			if shell.options().interactive {
				"\x02".to_owned()
			} else {
				String::new()
			}
		},
		PromptPiece::EscapeCharacter => "\x1b".to_owned(),
		PromptPiece::Hostname { only_up_to_first_dot } => {
			let hn = sys::network::get_hostname()
				.unwrap_or_default()
				.to_string_lossy()
				.to_string();
			if only_up_to_first_dot && let Some((first, _)) = hn.split_once('.') {
				return Ok(first.to_owned());
			}
			hn
		},
		PromptPiece::Newline => "\n".to_owned(),
		PromptPiece::NumberOfManagedJobs => shell.jobs().jobs.len().to_string(),
		PromptPiece::ShellBaseName => {
			if let Some(shell_name) = shell.current_shell_name() {
				Path::new(shell_name.as_ref())
					.file_name()
					.map(|name| name.to_string_lossy().to_string())
					.unwrap_or_default()
			} else {
				String::new()
			}
		},
		PromptPiece::ShellRelease => {
			std::format!("{VERSION_MAJOR}.{VERSION_MINOR}.{VERSION_PATCH}")
		},
		PromptPiece::ShellVersion => {
			std::format!("{VERSION_MAJOR}.{VERSION_MINOR}")
		},
		// NOTE: See above note for EndNonPrintingSequence
		PromptPiece::StartNonPrintingSequence => {
			if shell.options().interactive {
				"\x01".to_owned()
			} else {
				String::new()
			}
		},
		PromptPiece::TerminalDeviceBaseName => sys::terminal::try_get_terminal_device_path()
			.and_then(|p| p.file_name().map(|s| s.to_string_lossy().to_string()))
			.unwrap_or_default(),
		PromptPiece::Time(time_fmt) => format_time(&Zoned::now(), &time_fmt),
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

fn format_time(datetime: &Zoned, format: &PromptTimeFormat) -> String {
	let format = match format {
		PromptTimeFormat::TwelveHourAM => "%I:%M %p",
		PromptTimeFormat::TwelveHourHHMMSS => "%I:%M:%S",
		PromptTimeFormat::TwentyFourHourHHMM => "%H:%M",
		PromptTimeFormat::TwentyFourHourHHMMSS => "%H:%M:%S",
	};

	strtime::format(format, datetime).unwrap_or_default()
}

fn format_date(datetime: &Zoned, format: &PromptDateFormat) -> String {
	match format {
		PromptDateFormat::WeekdayMonthDate => {
			strtime::format("%a %b %d", datetime).unwrap_or_default()
		},
		PromptDateFormat::Custom(format) => {
			// Chrono's bare `%f` always emitted nine digits, while jiff trims
			// trailing zeroes. Preserve the prompt escape's established output.
			let chrono_compatible = format.replace("%f", "%9f");
			strtime::format(&chrono_compatible, datetime).unwrap_or_default()
		},
	}
}

#[cfg(test)]
mod tests {
	use jiff::tz::TimeZone;

	use super::*;

	#[test]
	fn test_format_time() {
		// Create a well-known test date/time.
		let dt = "2024-12-25T13:34:56.789Z"
			.parse::<jiff::Timestamp>()
			.unwrap()
			.to_zoned(TimeZone::UTC);

		assert_eq!(
			format_time(&dt, &crate::parser::prompt::PromptTimeFormat::TwelveHourAM),
			"01:34 PM"
		);

		assert_eq!(
			format_time(&dt, &crate::parser::prompt::PromptTimeFormat::TwentyFourHourHHMMSS),
			"13:34:56"
		);

		assert_eq!(
			format_time(&dt, &crate::parser::prompt::PromptTimeFormat::TwelveHourHHMMSS),
			"01:34:56"
		);
	}

	#[test]
	fn test_format_date() {
		// Create a well-known test date/time.
		let dt = "2024-12-25T12:34:56.789Z"
			.parse::<jiff::Timestamp>()
			.unwrap()
			.to_zoned(TimeZone::UTC);

		assert_eq!(
			format_date(&dt, &crate::parser::prompt::PromptDateFormat::WeekdayMonthDate),
			"Wed Dec 25"
		);

		assert_eq!(
			format_date(
				&dt,
				&crate::parser::prompt::PromptDateFormat::Custom(String::from("%Y-%m-%d"))
			),
			"2024-12-25"
		);

		assert_eq!(
			format_date(
				&dt,
				&crate::parser::prompt::PromptDateFormat::Custom(String::from("%Y-%m-%d %H:%M:%S.%f"))
			),
			"2024-12-25 12:34:56.789000000"
		);
	}
}
