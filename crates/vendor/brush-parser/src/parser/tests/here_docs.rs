//! Tests for here-document parsing.

use super::{ParseResult, test_with_snapshot};
use crate::assert_snapshot_redacted;
use anyhow::Result;

#[test]
fn parse_here_doc_basic() -> Result<()> {
    let input = r"cat <<EOF
content line 1
content line 2
EOF
";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_here_doc_no_trailing_newline() -> Result<()> {
    let input = r"cat <<EOF
Something
EOF";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_here_doc_tab_removal() -> Result<()> {
    let input = "cat <<-EOF\n\tcontent with tab\nEOF\n";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_here_doc_quoted_delimiter() -> Result<()> {
    let input = r"cat <<'EOF'
$variable should not expand
EOF
";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_here_doc_double_quoted_delimiter() -> Result<()> {
    let input = r#"cat <<"EOF"
$variable should not expand
EOF
"#;
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_here_doc_with_expansion() -> Result<()> {
    let input = r"cat <<EOF
Hello $USER
Your home is $HOME
EOF
";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_here_doc_empty() -> Result<()> {
    let input = r"cat <<EOF
EOF
";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_here_doc_with_command_after() -> Result<()> {
    let input = r"cat <<EOF | grep hello
hello world
goodbye world
EOF
";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}

#[test]
fn parse_here_doc_with_fd() -> Result<()> {
    let input = r"command 3<<EOF
content for fd 3
EOF
";
    let result = test_with_snapshot(input)?;
    assert_snapshot_redacted!(ParseResult {
        input,
        result: &result
    });
    Ok(())
}
