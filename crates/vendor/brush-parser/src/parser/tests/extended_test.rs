//! Tests for extended test expression [[ ]] parsing.

use super::{ParseResult, test_with_snapshot};
use crate::assert_snapshot_redacted;
use anyhow::Result;

// File tests

#[test]
fn parse_extended_test_file_exists() -> Result<()> {
    let input = "[[ -f file ]]";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_extended_test_directory() -> Result<()> {
    let input = "[[ -d /path/to/dir ]]";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_extended_test_readable() -> Result<()> {
    let input = "[[ -r file ]]";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_extended_test_writable() -> Result<()> {
    let input = "[[ -w file ]]";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_extended_test_executable() -> Result<()> {
    let input = "[[ -x file ]]";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

// String tests

#[test]
fn parse_extended_test_string_zero_length() -> Result<()> {
    let input = r#"[[ -z "$var" ]]"#;
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_extended_test_string_non_zero() -> Result<()> {
    let input = r#"[[ -n "$var" ]]"#;
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_extended_test_string_equal() -> Result<()> {
    let input = r#"[[ "$a" == "$b" ]]"#;
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_extended_test_string_not_equal() -> Result<()> {
    let input = r#"[[ "$a" != "$b" ]]"#;
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_extended_test_string_pattern() -> Result<()> {
    let input = r#"[[ "$str" == *pattern* ]]"#;
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_extended_test_regex() -> Result<()> {
    let input = r#"[[ "$str" =~ ^[0-9]+$ ]]"#;
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_extended_test_regex_with_spaces() -> Result<()> {
    let input = r#"[[ "x" =~ (a| *) ]]"#;
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

// Logical operators

#[test]
fn parse_extended_test_and() -> Result<()> {
    let input = "[[ -f file && -r file ]]";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_extended_test_or() -> Result<()> {
    let input = "[[ -f file || -d file ]]";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_extended_test_not() -> Result<()> {
    let input = "[[ ! -f file ]]";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_extended_test_parenthesized() -> Result<()> {
    let input = "[[ ( -f file ) ]]";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_extended_test_complex() -> Result<()> {
    let input = "[[ ( -f file && -r file ) || -d file ]]";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

// Comparison operators

#[test]
fn parse_extended_test_less_than() -> Result<()> {
    let input = r#"[[ "$a" < "$b" ]]"#;
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_extended_test_greater_than() -> Result<()> {
    let input = r#"[[ "$a" > "$b" ]]"#;
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

// Arithmetic comparison

#[test]
fn parse_extended_test_arith_equal() -> Result<()> {
    let input = "[[ 5 -eq 5 ]]";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_extended_test_arith_not_equal() -> Result<()> {
    let input = "[[ 5 -ne 3 ]]";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_extended_test_arith_less_than() -> Result<()> {
    let input = "[[ 3 -lt 5 ]]";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_extended_test_arith_greater_than() -> Result<()> {
    let input = "[[ 5 -gt 3 ]]";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}
