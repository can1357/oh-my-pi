//! Tests for assignment parsing.

use super::{ParseResult, test_with_snapshot};
use crate::assert_snapshot_redacted;
use anyhow::Result;

// Scalar assignments

#[test]
fn parse_assignment_simple() -> Result<()> {
    let input = "x=value";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_assignment_empty() -> Result<()> {
    let input = "x=";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_assignment_quoted() -> Result<()> {
    let input = r#"x="hello world""#;
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_assignment_single_quoted() -> Result<()> {
    let input = "x='hello world'";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_assignment_with_expansion() -> Result<()> {
    let input = "x=$HOME/bin";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_assignment_with_command_substitution() -> Result<()> {
    let input = "x=$(pwd)";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

// Append assignments

#[test]
fn parse_assignment_append() -> Result<()> {
    let input = "x+=more";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_assignment_append_quoted() -> Result<()> {
    let input = r#"x+=" more text""#;
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

// Array assignments

#[test]
fn parse_assignment_array() -> Result<()> {
    let input = "arr=(a b c)";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_assignment_array_empty() -> Result<()> {
    let input = "arr=()";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_assignment_array_with_indices() -> Result<()> {
    let input = "arr=([0]=a [1]=b [2]=c)";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_assignment_array_mixed() -> Result<()> {
    let input = "arr=(a [5]=b c)";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_assignment_array_quoted_elements() -> Result<()> {
    let input = r#"arr=("hello world" "foo bar")"#;
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

// Array element assignment

#[test]
fn parse_assignment_array_element() -> Result<()> {
    let input = "arr[0]=value";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_assignment_array_element_expression() -> Result<()> {
    let input = "arr[i+1]=value";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

// Multiple assignments

#[test]
fn parse_multiple_assignments() -> Result<()> {
    let input = "x=1 y=2 z=3";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_assignment_with_command() -> Result<()> {
    let input = "VAR=value command arg1 arg2";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_multiple_assignments_with_command() -> Result<()> {
    let input = "A=1 B=2 command";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

// Export/local with assignment

#[test]
fn parse_export_assignment() -> Result<()> {
    let input = "export VAR=value";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_local_assignment() -> Result<()> {
    let input = "local x=5";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_declare_assignment() -> Result<()> {
    let input = "declare -i x=5";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}
