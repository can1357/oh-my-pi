//! Parser for shell prompt syntax (e.g., `PS1`).

use crate::error;

/// A piece of a prompt string.
#[derive(Clone, Debug)]
#[cfg_attr(
    any(test, feature = "serde"),
    derive(PartialEq, Eq, serde::Serialize, serde::Deserialize)
)]
pub enum PromptPiece {
    /// An ASCII character.
    AsciiCharacter(u32),
    /// A backslash character.
    Backslash,
    /// The bell character.
    BellCharacter,
    /// A carriage return character.
    CarriageReturn,
    /// The current command number.
    CurrentCommandNumber,
    /// The current history number.
    CurrentHistoryNumber,
    /// The name of the current user.
    CurrentUser,
    /// Path to the current working directory.
    CurrentWorkingDirectory {
        /// Whether or not to apply tilde-replacement before expanding.
        tilde_replaced: bool,
        /// Whether or not to only expand to the basename of the directory.
        basename: bool,
    },
    /// The current date, using the given format.
    Date(PromptDateFormat),
    /// The dollar or pound character.
    DollarOrPound,
    /// Special marker indicating the end of a non-printing sequence of characters.
    EndNonPrintingSequence,
    /// The escape character.
    EscapeCharacter,
    /// An escaped sequence not otherwise recognized.
    EscapedSequence(String),
    /// The hostname of the system.
    Hostname {
        /// Whether or not to include only up to the first dot of the name.
        only_up_to_first_dot: bool,
    },
    /// A literal string.
    Literal(String),
    /// A newline character.
    Newline,
    /// The number of actively managed jobs.
    NumberOfManagedJobs,
    /// The base name of the shell.
    ShellBaseName,
    /// The release of the shell.
    ShellRelease,
    /// The version of the shell.
    ShellVersion,
    /// Special marker indicating the start of a non-printing sequence of characters.
    StartNonPrintingSequence,
    /// The base name of the terminal device.
    TerminalDeviceBaseName,
    /// The current time, using the given format.
    Time(PromptTimeFormat),
}

/// Format for a date in a prompt.
#[derive(Clone, Debug)]
#[cfg_attr(
    any(test, feature = "serde"),
    derive(PartialEq, Eq, serde::Serialize, serde::Deserialize)
)]
pub enum PromptDateFormat {
    /// A format including weekday, month, and date.
    WeekdayMonthDate,
    /// A customer string format.
    Custom(String),
}

/// Format for a time in a prompt.
#[derive(Clone, Debug)]
#[cfg_attr(
    any(test, feature = "serde"),
    derive(PartialEq, Eq, serde::Serialize, serde::Deserialize)
)]
pub enum PromptTimeFormat {
    /// A twelve-hour time format with AM/PM.
    TwelveHourAM,
    /// A twelve-hour time format (HHMMSS).
    TwelveHourHHMMSS,
    /// A twenty-four-hour time format (HHMM).
    TwentyFourHourHHMM,
    /// A twenty-four-hour time format (HHMMSS).
    TwentyFourHourHHMMSS,
}

peg::parser! {
    grammar prompt_parser() for str {
        pub(crate) rule prompt() -> Vec<PromptPiece> =
            pieces:prompt_piece()*

        rule prompt_piece() -> PromptPiece =
            special_sequence() /
            literal_sequence()

        //
        // Reference: https://www.gnu.org/software/bash/manual/bash.html#Controlling-the-Prompt
        //
        rule special_sequence() -> PromptPiece =
            "\\a" { PromptPiece::BellCharacter } /
            "\\A" { PromptPiece::Time(PromptTimeFormat::TwentyFourHourHHMM) } /
            "\\d" { PromptPiece::Date(PromptDateFormat::WeekdayMonthDate) } /
            "\\D{" f:date_format() "}" { PromptPiece::Date(PromptDateFormat::Custom(f)) } /
            "\\e" { PromptPiece::EscapeCharacter } /
            "\\h" { PromptPiece::Hostname { only_up_to_first_dot: true } } /
            "\\H" { PromptPiece::Hostname { only_up_to_first_dot: false } } /
            "\\j" { PromptPiece::NumberOfManagedJobs } /
            "\\l" { PromptPiece::TerminalDeviceBaseName } /
            "\\n" { PromptPiece::Newline } /
            "\\r" { PromptPiece::CarriageReturn } /
            "\\s" { PromptPiece::ShellBaseName } /
            "\\t" { PromptPiece::Time(PromptTimeFormat::TwentyFourHourHHMMSS ) } /
            "\\T" { PromptPiece::Time(PromptTimeFormat::TwelveHourHHMMSS ) } /
            "\\@" { PromptPiece::Time(PromptTimeFormat::TwelveHourAM ) } /
            "\\u" { PromptPiece::CurrentUser } /
            "\\v" { PromptPiece::ShellVersion } /
            "\\V" { PromptPiece::ShellRelease } /
            "\\w" { PromptPiece::CurrentWorkingDirectory { tilde_replaced: true, basename: false, } } /
            "\\W" { PromptPiece::CurrentWorkingDirectory { tilde_replaced: true, basename: true, } } /
            "\\!" { PromptPiece::CurrentHistoryNumber } /
            "\\#" { PromptPiece::CurrentCommandNumber } /
            "\\$" { PromptPiece::DollarOrPound } /
            "\\" n:octal_number() { PromptPiece::AsciiCharacter(n) } /
            "\\\\" { PromptPiece::Backslash } /
            "\\[" { PromptPiece::StartNonPrintingSequence } /
            "\\]" { PromptPiece::EndNonPrintingSequence } /
            s:$("\\" [_]) { PromptPiece::EscapedSequence(s.to_owned()) }

        rule literal_sequence() -> PromptPiece =
            s:$((!special_sequence() [c])+) { PromptPiece::Literal(s.to_owned()) }

        rule date_format() -> String =
            s:$([c if c != '}']*) { s.to_owned() }

        rule octal_number() -> u32 =
            s:$(['0'..='7']*<1,3>) {? u32::from_str_radix(s, 8).or(Err("invalid octal number")) }
    }
}

/// Parses a shell prompt string.
///
/// # Arguments
///
/// * `s` - The prompt string to parse.
pub fn parse(s: &str) -> Result<Vec<PromptPiece>, error::WordParseError> {
    let result = prompt_parser::prompt(s).map_err(|e| error::WordParseError::Prompt(e.into()))?;
    Ok(result)
}

/// Finds where a run of whole prompt pieces that begins at `from` ends,
/// covering at least `stride` bytes of `s` unless the spec ends first.
///
/// `from` has to begin a piece: zero, or a boundary an earlier call returned.
/// Parsing `s[from..end]` on its own then yields exactly the pieces that
/// parsing the whole of `s` yields over that span. A run can only end where a
/// literal run ends, and a literal run only ends where an escape sequence
/// starts, so the pieces on either side of a boundary never merge.
///
/// This is here so that a caller which must not hold its thread can parse a
/// prompt spec a stride at a time. The grammar above is a PEG that tries every
/// escape sequence at every character of a literal, which for a spec of 16 MiB
/// is most of a second in one call; the scan below is a search for the next
/// backslash.
///
/// # Arguments
///
/// * `s` - The prompt string being parsed.
/// * `from` - The byte offset the run starts at, which has to begin a piece.
/// * `stride` - How many bytes the run should cover, at the least.
pub fn next_piece_boundary(s: &str, from: usize, stride: usize) -> usize {
    let target = from.saturating_add(stride).min(s.len());
    let mut at = from.min(s.len());
    while at < target {
        at = piece_end(s, at);
    }
    at
}

/// Finds where the piece that starts at `at` ends. Mirrors `prompt_piece`.
fn piece_end(s: &str, at: usize) -> usize {
    if s.as_bytes()[at] != b'\\' {
        // A literal runs until an escape sequence starts. Every escape sequence
        // is a backslash and at least one character after it, so a backslash at
        // the very end of the spec is literal text and the run takes it.
        return match s.as_bytes()[at..].iter().position(|byte| *byte == b'\\') {
            Some(offset) if at + offset + 1 < s.len() => at + offset,
            _ => s.len(),
        };
    }
    escape_end(s, at)
}

/// Finds where the escape sequence that starts at the backslash at `at` ends.
/// Mirrors `special_sequence`.
fn escape_end(s: &str, at: usize) -> usize {
    let bytes = s.as_bytes();
    let Some(&next) = bytes.get(at + 1) else {
        // A trailing backslash matches no escape sequence at all.
        return s.len();
    };

    // `\D{...}` runs to the first closing brace. With no brace to close it the
    // `\D` falls through to the catch-all below, and the rest is literal text.
    if next == b'D'
        && bytes.get(at + 2) == Some(&b'{')
        && let Some(offset) = bytes[at + 3..].iter().position(|byte| *byte == b'}')
    {
        return at + 3 + offset + 1;
    }

    // `\nnn` takes up to three octal digits.
    if matches!(next, b'0'..=b'7') {
        let mut end = at + 1;
        while end < s.len() && end < at + 4 && matches!(bytes[end], b'0'..=b'7') {
            end += 1;
        }
        return end;
    }

    // Every other sequence is a backslash and one character: the ones the
    // grammar names are ASCII, and the catch-all takes whatever follows. Its
    // length comes from the lead byte rather than from slicing, which cannot
    // be done safely at a byte offset the caller supplied.
    at + 1 + utf8_length(next)
}

/// How many bytes the character beginning with `lead` occupies.
const fn utf8_length(lead: u8) -> usize {
    match lead {
        0x00..=0x7f => 1,
        0xc0..=0xdf => 2,
        0xe0..=0xef => 3,
        // A continuation byte is not a lead byte, but a spec is valid UTF-8,
        // so this arm is only reached for a four-byte character.
        _ => 4,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::Result;
    use pretty_assertions::assert_eq;

    #[test]
    fn basic_prompt() -> Result<()> {
        assert_eq!(
            parse(r"\u@\h:\w$ ")?,
            &[
                PromptPiece::CurrentUser,
                PromptPiece::Literal("@".to_owned()),
                PromptPiece::Hostname {
                    only_up_to_first_dot: true
                },
                PromptPiece::Literal(":".to_owned()),
                PromptPiece::CurrentWorkingDirectory {
                    tilde_replaced: true,
                    basename: false
                },
                PromptPiece::Literal("$ ".to_owned()),
            ]
        );

        Ok(())
    }

    #[test]
    fn brackets_and_vars() -> Result<()> {
        assert_eq!(
            parse(r"\[$foo\]\u > ")?,
            &[
                PromptPiece::StartNonPrintingSequence,
                PromptPiece::Literal("$foo".to_owned()),
                PromptPiece::EndNonPrintingSequence,
                PromptPiece::CurrentUser,
                PromptPiece::Literal(" > ".to_owned()),
            ]
        );

        Ok(())
    }

    #[test]
    fn parsing_a_stride_at_a_time_gives_the_same_pieces() -> Result<()> {
        // Every shape a boundary can land near: escapes the grammar names, an
        // octal run longer than three digits, a date format holding a brace
        // and a backslash, a date format with nothing to close it, a
        // multi-byte character after a backslash, and a trailing backslash.
        let spec = "abc\\u@\\h \\D{%a %b\\}x\\\\\\[y\\]\\1012\\8 \\D{unclosed \\é tail\\";

        let whole = parse(spec)?;
        for stride in 1..=spec.len() {
            let mut strided = Vec::new();
            let mut at = 0;
            while at < spec.len() {
                let end = next_piece_boundary(spec, at, stride);
                // A boundary that split a character, or made no progress,
                // would be a scanner defect rather than a parse failure.
                let piece = spec
                    .get(at..end)
                    .filter(|piece| !piece.is_empty())
                    .ok_or_else(|| anyhow::anyhow!("stride {stride} stalled or split at {at}"))?;
                strided.extend(parse(piece)?);
                at = end;
            }
            assert_eq!(strided, whole, "stride {stride}");
        }

        Ok(())
    }
}
