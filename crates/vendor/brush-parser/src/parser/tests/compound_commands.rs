//! Tests for compound command parsing.

use super::{ParseResult, test_with_snapshot};
use crate::ast;
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

/// Returns the only command of a parsed `program`, counting every pipeline of every and-or list.
fn single_command(program: ast::Program, input: &str) -> Result<ast::Command> {
    let mut commands = program
        .complete_commands
        .into_iter()
        .flat_map(|list| list.0)
        .flat_map(|ast::CompoundListItem(and_or, _)| {
            std::iter::once(and_or.first).chain(and_or.additional.into_iter().map(|next| {
                match next {
                    ast::AndOr::And(pipeline) | ast::AndOr::Or(pipeline) => pipeline,
                }
            }))
        })
        .flat_map(|pipeline| pipeline.seq);
    let (Some(command), None) = (commands.next(), commands.next()) else {
        anyhow::bail!("expected exactly one command in {input:?}");
    };
    Ok(command)
}

#[test]
fn arithmetic_for_header_splits_at_every_semicolon() -> Result<()> {
    // Bash reads the header up to the `))` that closes its `((`, and splits that text at each `;`
    // whatever the depth of parentheses. The tokenizer reads `;;`, `;;&` and `;&` as single
    // operators, so each `;` inside them separates two expressions as well, and an `&` in them
    // starts the next expression. A header with other than three parts is a syntax error, and so is
    // one whose parentheses leave no `))` to close it.
    for (input, expected) in [
        ("for ((i = 0;;i++)); do :; done", Some(["i = 0", "", "i++"])),
        ("for ((;;)); do :; done", Some(["", "", ""])),
        ("for ((i=0;;&x)); do :; done", Some(["i=0", "", "&x"])),
        ("for ((i=0;&x;y)); do :; done", Some(["i=0", "&x", "y"])),
        ("for ((a;b;&c)); do :; done", Some(["a", "b", "&c"])),
        ("for (((i=0;j=1);)); do :; done", Some(["(i=0", "j=1)", ""])),
        ("for ((i=0*(;1);)); do :; done", Some(["i=0*(", "1)", ""])),
        ("for ((i=0; #c\n;i++)); do :; done", Some(["i=0", "#c\n", "i++"])),
        ("for (\\\n(i=0;;i++)); do :; done", Some(["i=0", "", "i++"])),
        ("for ((a;b)); do :; done", None),
        ("for ((;;;)); do :; done", None),
        ("for ((a;b;c;;)); do :; done", None),
        ("for (((i=0;j=1);;)); do :; done", None),
        ("for (((;;)); do :; done", None),
        ("for ((i=0;0;i+(;))); do :; done", None),
        ("for ((i=0;;i++)\\\n); do :; done", None),
    ] {
        let header = match test_with_snapshot(input) {
            Err(_) => None,
            Ok(program) => match single_command(program, input)? {
                ast::Command::Compound(ast::CompoundCommand::ArithmeticForClause(clause), _) => {
                    let text = |expr: Option<ast::UnexpandedArithmeticExpr>| {
                        expr.map(|expr| expr.value).unwrap_or_default()
                    };
                    Some([
                        text(clause.initializer),
                        text(clause.condition),
                        text(clause.updater),
                    ])
                }
                other => anyhow::bail!("{input:?} parsed as {other:?}"),
            },
        };
        anyhow::ensure!(
            header == expected.map(|parts| parts.map(String::from)),
            "{input:?}: got {header:?}, expected {expected:?}"
        );
    }
    Ok(())
}

#[test]
fn double_parentheses_bound_arithmetic_only_without_inner_space() -> Result<()> {
    // As in Bash, a `;` or `#` between `((` and `))` is part of the arithmetic text, and `( (` or
    // `) )` opens or closes nested subshells rather than arithmetic. A line continuation may join
    // the opening parentheses but not the closing ones.
    for (input, arithmetic) in [
        ("((1;2))", Some("1;2")),
        ("(( (1;2) ))", Some("(1;2)")),
        ("((x=1 #c\n))", Some("x=1 #c\n")),
        ("(\\\n(x=2))", Some("x=2")),
        ("( (1+2))", None),
        ("((1+2) )", None),
        ("((echo a;) )", None),
        ("((x=2)\\\n)", None),
    ] {
        match (single_command(test_with_snapshot(input)?, input)?, arithmetic) {
            (ast::Command::Compound(ast::CompoundCommand::Arithmetic(command), _), Some(expr))
                if command.expr.value == expr => {}
            (ast::Command::Compound(ast::CompoundCommand::Subshell(_), _), None) => {}
            (other, _) => anyhow::bail!("{input:?} parsed as {other:?}"),
        }
    }
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
