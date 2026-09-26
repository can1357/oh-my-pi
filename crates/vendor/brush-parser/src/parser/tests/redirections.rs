//! Tests for redirection parsing.

use super::{ParseResult, test_with_snapshot};
use crate::assert_snapshot_redacted;
use anyhow::Result;

// File redirections

#[test]
fn parse_redirect_output() -> Result<()> {
    let input = "echo hello > file.txt";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_redirect_input() -> Result<()> {
    let input = "cat < input.txt";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_redirect_append() -> Result<()> {
    let input = "echo hello >> file.txt";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_redirect_clobber() -> Result<()> {
    let input = "echo hello >| file.txt";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_redirect_read_write() -> Result<()> {
    let input = "cat <> file.txt";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

// FD operations

#[test]
fn parse_redirect_stderr_to_stdout() -> Result<()> {
    let input = "command 2>&1";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_redirect_stdout_to_stderr() -> Result<()> {
    let input = "command 1>&2";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_redirect_fd_close() -> Result<()> {
    let input = "command 2>&-";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_redirect_stdin_dup() -> Result<()> {
    let input = "command <&3";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

// Combined redirections

#[test]
fn parse_redirect_output_and_error() -> Result<()> {
    let input = "command &> file.txt";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_redirect_output_and_error_append() -> Result<()> {
    let input = "command &>> file.txt";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_redirect_multiple() -> Result<()> {
    let input = "command < input.txt > output.txt 2>&1";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

// Process substitution

#[test]
fn parse_process_substitution_read() -> Result<()> {
    let input = "diff <(sort file1) <(sort file2)";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_process_substitution_write() -> Result<()> {
    let input = "tee >(grep error > errors.txt)";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

// Here string

#[test]
fn parse_here_string() -> Result<()> {
    let input = "cat <<< 'hello world'";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_here_string_with_variable() -> Result<()> {
    let input = "cat <<< $variable";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}
