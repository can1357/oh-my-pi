use std::path::Path;

use crate::{
	ExecutionParameters, error, expansion, extensions, interp,
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
	// A prompt is expanded before every command, so the ordinary spec takes the
	// path it always took. The test is made on the spec, before it is parsed,
	// because the parse is the longest step here: a test made on the rendered
	// prompt would divide the write and leave the construction.
	let spec_len = spec.len();
	let divide = spec_len > interp::DIVIDE_COPY_ABOVE_BYTES;

	// Parse the prompt spec into its pieces.
	let prompt_pieces = if divide {
		parse_prompt_in_strides(params, spec.as_str()).await?
	} else {
		parse_prompt(spec)?
	};

	// Now, render each piece. Growing the prompt from nothing reallocates and
	// copies everything already written on each doubling, which for a spec of
	// 16 MiB is a further 16 MiB copied in one step; the spec is the right size
	// to ask for, since all but the escape sequences pass through unchanged.
	let mut formatted_prompt =
		if divide { String::with_capacity(spec_len) } else { String::new() };
	let mut budget = interp::ElementBudget::new();
	for piece in prompt_pieces {
		let needs_escaping = matches!(
			piece,
			brush_parser::prompt::PromptPiece::EscapedSequence(_)
				| brush_parser::prompt::PromptPiece::DollarOrPound
		);

		let formatted_piece = format_prompt_piece(shell, piece)?;

		// The pieces are as many as the spec has escape sequences, and one of
		// them can be as long as the spec itself.
		let due = budget.charge(formatted_piece.len());
		if due > 0 {
			interp::loop_checkpoints(params, due).await?;
		}

		if shell.options().expand_prompt_strings && needs_escaping {
			formatted_prompt.push('\\');
		}

		if formatted_piece.len() > interp::DIVIDE_COPY_ABOVE_BYTES {
			interp::push_str_in_strides(params, &mut formatted_prompt, formatted_piece.as_str())
				.await?;
		} else {
			formatted_prompt.push_str(&formatted_piece);
		}
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

/// Parses a prompt spec a stride at a time, spending a checkpoint before each
/// stride.
///
/// A spec this long is not a prompt anybody typed; it is a variable that grew.
/// The parser is a PEG that tries each of its escape sequences at every
/// character of a literal, and 16 MiB of literal text held the worker for
/// 719.780 ms in one call. Finding the boundaries between pieces did not
/// divide that: a literal is one piece, so a spec with no backslash in it was
/// still parsed whole, for 659 ms. [`brush_parser::prompt::parse_stride`]
/// copies literal text out without the grammar and cuts it at the stride; the
/// literal pieces that come out of one literal render to the same text.
///
/// The cache above is left to the ordinary spec on purpose. Its key is the
/// whole spec, so a spec of this size would be hashed on every prompt and its
/// pieces cloned out of the cache on every hit, and sixty-four of them would
/// stay resident.
async fn parse_prompt_in_strides(
	params: &ExecutionParameters,
	spec: &str,
) -> Result<Vec<brush_parser::prompt::PromptPiece>, error::Error> {
	let mut pieces = Vec::new();
	let mut at = 0;
	while at < spec.len() {
		interp::stride_checkpoint(params).await?;
		let (stride, end) =
			brush_parser::prompt::parse_stride(spec, at, interp::BYTE_CHECKPOINT_STRIDE)?;
		pieces.extend(stride);
		at = end;
	}
	Ok(pieces)
}

/// Removes the markers that stand for the start and end of a non-printing
/// sequence, which readline drops and nothing downstream should see.
///
/// The plain path is the in-place `retain` this has always been. Above the
/// threshold that is a hold of its own: `retain` walks a 16 MiB prompt one
/// character at a time, so it is done here in strides instead, and only the
/// strides that hold a marker are rewritten.
pub(crate) async fn strip_non_printing_markers(
	params: &ExecutionParameters,
	mut text: String,
) -> Result<String, error::Error> {
	if text.len() <= interp::DIVIDE_COPY_ABOVE_BYTES {
		text.retain(is_printing);
		return Ok(text);
	}

	let mut stripped = String::with_capacity(text.len());
	let mut rest = text.as_str();
	while !rest.is_empty() {
		interp::stride_checkpoint(params).await?;
		let mut end = rest.len().min(interp::BYTE_CHECKPOINT_STRIDE);
		// A stride lands mid-character at most three bytes in.
		while !rest.is_char_boundary(end) {
			end -= 1;
		}
		let (piece, remaining) = rest.split_at(end);
		// Both markers are ASCII, so no continuation byte can be mistaken for
		// one and the search can run over the bytes.
		if piece.bytes().any(|b| matches!(b, 0x01 | 0x02)) {
			stripped.extend(piece.chars().filter(|c| is_printing(*c)));
		} else {
			stripped.push_str(piece);
		}
		rest = remaining;
	}
	Ok(stripped)
}

/// Whether `c` is a character readline would print, rather than one of the two
/// markers bracketing a non-printing sequence.
const fn is_printing(c: char) -> bool {
	c != '\x01' && c != '\x02'
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

	/// A spec long enough to take the divided path has to see the run's
	/// cancellation, rather than hold the worker through the parse and the
	/// render.
	#[tokio::test]
	async fn a_long_prompt_sees_the_run_cancellation() -> anyhow::Result<()> {
		let mut shell = crate::shell::Shell::builder().build().await?;
		let mut params = shell.default_exec_params();
		let cancel = tokio_util::sync::CancellationToken::new();
		params.set_cancel_token(cancel.clone());
		cancel.cancel();

		let spec = "x".repeat(interp::DIVIDE_COPY_ABOVE_BYTES + 1024);
		let err = expand_prompt(&mut shell, &params, spec)
			.await
			.expect_err("the prompt ignored the cancellation");
		assert!(matches!(err.kind(), error::ErrorKind::Interrupted), "unexpected error: {err}");

		Ok(())
	}

	/// Parsing a spec a stride at a time renders the prompt the whole parse
	/// renders: the pieces either side of a run boundary never merge, so the
	/// text that comes out is the text that went in.
	#[tokio::test]
	async fn a_long_prompt_renders_to_the_same_text() -> anyhow::Result<()> {
		let mut shell = crate::shell::Shell::builder().build().await?;
		let params = shell.default_exec_params();

		let literal = "x".repeat(interp::DIVIDE_COPY_ABOVE_BYTES + 1024);
		let spec = std::format!("{literal}\\n{literal}");
		let expanded = expand_prompt(&mut shell, &params, spec).await?;

		assert_eq!(expanded, std::format!("{literal}\n{literal}"));

		Ok(())
	}

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
