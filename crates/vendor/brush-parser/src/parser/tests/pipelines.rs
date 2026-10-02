//! Tests for pipeline parsing.

use super::{ParseResult, test_with_snapshot};
use crate::assert_snapshot_redacted;
use anyhow::Result;

#[test]
fn parse_simple_pipe() -> Result<()> {
    let input = "echo hello | grep world";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_multi_stage_pipe() -> Result<()> {
    let input = "cat file | grep pattern | wc -l";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_pipe_with_stderr() -> Result<()> {
    let input = "echo |& wc";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_timed_pipeline() -> Result<()> {
    let input = "time echo hello";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_timed_pipeline_posix() -> Result<()> {
    let input = "time -p echo hello";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_negated_pipeline() -> Result<()> {
    let input = "! echo hello";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_negated_timed_pipeline() -> Result<()> {
    let input = "time ! echo hello";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_pipe_with_multiple_commands() -> Result<()> {
    let input = "ls -la | head -10 | tail -5";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}
