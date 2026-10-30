//! Tests for compound command parsing.

use super::{ParseResult, test_with_snapshot};
use crate::assert_snapshot_redacted;
use anyhow::Result;

// Arithmetic commands

#[test]
fn parse_arithmetic_simple() -> Result<()> {
    let input = "(( 1 + 2 ))";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_arithmetic_increment() -> Result<()> {
    let input = "(( x++ ))";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_arithmetic_complex() -> Result<()> {
    let input = "(( x = 5 + 3 * 2 ))";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

// Arithmetic for clause

#[test]
fn parse_arithmetic_for() -> Result<()> {
    let input = "for (( i = 0; i < 10; i++ )); do echo $i; done";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_arithmetic_for_empty_parts() -> Result<()> {
    let input = "for (( ; ; )); do echo loop; done";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

// Brace group

#[test]
fn parse_brace_group() -> Result<()> {
    let input = "{ echo hello; }";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_brace_group_multiline() -> Result<()> {
    let input = r"{
    echo hello
    echo world
}";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

// Subshell

#[test]
fn parse_subshell() -> Result<()> {
    let input = "( echo hello )";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_subshell_multiple_commands() -> Result<()> {
    let input = "( echo hello; echo world )";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_nested_subshell() -> Result<()> {
    let input = "( ( echo nested ) )";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

// For clause

#[test]
fn parse_for_in() -> Result<()> {
    let input = "for x in a b c; do echo $x; done";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_for_in_multiline() -> Result<()> {
    let input = r"for x in a b c
do
    echo $x
done";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_for_no_in() -> Result<()> {
    let input = "for x; do echo $x; done";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

// Case clause

#[test]
fn parse_case_simple() -> Result<()> {
    let input = "case x in a) echo a;; esac";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_case_multiple_patterns() -> Result<()> {
    let input = r"case x in
    a|b) echo ab;;
    c) echo c;;
    *) echo default;;
esac";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_case_fallthrough() -> Result<()> {
    let input = "case x in a) echo a;& b) echo b;; esac";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_case_continue() -> Result<()> {
    let input = "case x in a) echo a;;& b) echo b;; esac";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

// If clause

#[test]
fn parse_if_simple() -> Result<()> {
    let input = "if true; then echo yes; fi";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_if_else() -> Result<()> {
    let input = "if true; then echo yes; else echo no; fi";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_if_elif() -> Result<()> {
    let input = "if false; then echo one; elif true; then echo two; else echo three; fi";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_if_multiline() -> Result<()> {
    let input = r"if true
then
    echo yes
else
    echo no
fi";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

// While/Until

#[test]
fn parse_while() -> Result<()> {
    let input = "while true; do echo loop; done";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_until() -> Result<()> {
    let input = "until false; do echo loop; done";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_while_multiline() -> Result<()> {
    let input = r"while true
do
    echo loop
    break
done";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

// Mixed/nested

#[test]
fn parse_arith_and_non_arith_parens() -> Result<()> {
    let input = "( : && ( (( 0 )) || : ) )";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}
