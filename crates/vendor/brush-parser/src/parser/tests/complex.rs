//! Complex and integration tests that combine multiple parser features.

use super::{ParseResult, test_with_snapshot};
use crate::assert_snapshot_redacted;
use anyhow::Result;

#[test]
fn parse_shebang_and_program() -> Result<()> {
    let input = r#"#!/usr/bin/env bash

for f in A B C; do

    # sdfsdf
    echo "${f@L}" >&2

   done
"#;
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_case_with_newlines() -> Result<()> {
    let input = r"case x in
x)
    echo y;;
esac";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_case_no_semicolon() -> Result<()> {
    let input = r"case x in
x)
    echo y
esac";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_nested_if_while() -> Result<()> {
    let input = r#"if true; then
    while read line; do
        echo "$line"
    done < file.txt
fi"#;
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_function_with_if() -> Result<()> {
    let input = r#"myfunc() {
    if [[ -z "$1" ]]; then
        echo "No argument"
        return 1
    fi
    echo "Got: $1"
}"#;
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_pipeline_with_redirections() -> Result<()> {
    let input = "cat < input.txt | grep pattern | tee output.txt > /dev/null 2>&1";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_command_substitution_nested() -> Result<()> {
    let input = "echo \"$(echo $(pwd))\"";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_for_with_command_substitution() -> Result<()> {
    let input = "for f in $(ls *.txt); do cat \"$f\"; done";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_arithmetic_in_condition() -> Result<()> {
    let input = "if (( x > 5 )); then echo big; else echo small; fi";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_brace_expansion_context() -> Result<()> {
    let input = "echo {a,b,c}";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
#[allow(clippy::literal_string_with_formatting_args)]
fn parse_parameter_expansion_complex() -> Result<()> {
    let input = r#"echo "${var:-default}" "${var:+alt}" "${var:=assign}""#;
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_subshell_with_assignments() -> Result<()> {
    let input = "( x=1; y=2; echo $((x + y)) )";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_coprocess() -> Result<()> {
    let input = "coproc cat";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_multiple_here_docs() -> Result<()> {
    let input = r"cmd <<EOF1 <<EOF2
first
EOF1
second
EOF2
";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_backgrounded_commands() -> Result<()> {
    let input = "cmd1 & cmd2 & cmd3";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_mixed_sequences() -> Result<()> {
    let input = "cmd1; cmd2 && cmd3 || cmd4; cmd5";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_complex_array_operations() -> Result<()> {
    let input = r#"arr=($(seq 1 10)); echo "${arr[@]}"; echo "${#arr[@]}""#;
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_glob_patterns() -> Result<()> {
    let input = "ls *.txt **/foo.* file?.txt";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_extglob_patterns() -> Result<()> {
    let input = "ls !(*.txt) +(foo|bar) ?(a|b)";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_tilde_expansion() -> Result<()> {
    let input = "cd ~/projects; ls ~user/home";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}
