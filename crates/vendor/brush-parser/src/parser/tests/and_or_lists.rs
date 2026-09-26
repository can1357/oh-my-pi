//! Tests for and/or list parsing.

use super::{ParseResult, test_with_snapshot};
use crate::assert_snapshot_redacted;
use anyhow::Result;

#[test]
fn parse_simple_and() -> Result<()> {
    let input = "true && echo yes";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_simple_or() -> Result<()> {
    let input = "false || echo no";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_chained_and() -> Result<()> {
    let input = "cmd1 && cmd2 && cmd3";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_chained_or() -> Result<()> {
    let input = "cmd1 || cmd2 || cmd3";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_mixed_and_or() -> Result<()> {
    let input = "cmd1 && cmd2 || cmd3";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_and_or_with_pipes() -> Result<()> {
    let input = "cmd1 | cmd2 && cmd3 | cmd4";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_and_or_in_sequence() -> Result<()> {
    let input = "cmd1 && cmd2; cmd3 || cmd4";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}
