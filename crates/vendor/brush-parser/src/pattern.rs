//! Implements parsing for shell glob and extglob patterns.

// Each rule peg generates takes peg's four arguments, the grammar's two (extglob flag and
// nesting guard), and the rule's own, so a rule with two arguments of its own takes eight.
#![expect(
    clippy::too_many_arguments,
    reason = "peg-generated rule functions"
)]

use crate::error;
use crate::nesting::NestingGuard;

/// Represents the kind of an extended glob.
pub enum ExtendedGlobKind {
    /// The `+` extended glob; matches one or more occurrences of the inner pattern.
    Plus,
    /// The `@` extended glob; allows matching an alternation of inner patterns.
    At,
    /// The `!` extended glob; matches the negation of the inner pattern.
    Exclamation,
    /// The `?` extended glob; matches zero or one occurrence of the inner pattern.
    Question,
    /// The `*` extended glob; matches zero or more occurrences of the inner pattern.
    Star,
}

/// Converts a shell pattern to a regular expression string.
///
/// # Arguments
///
/// * `pattern` - The shell pattern to convert.
/// * `enable_extended_globbing` - Whether to enable extended globbing (extglob).
pub fn pattern_to_regex_str(
    pattern: &str,
    enable_extended_globbing: bool,
) -> Result<String, error::WordParseError> {
    let nesting = NestingGuard::default();
    let result =
        pattern_to_regex_translator::pattern(pattern, enable_extended_globbing, &nesting);
    if let Some((exceeded, _)) = nesting.exceeded() {
        return Err(exceeded.into());
    }
    result.map_err(|e| error::WordParseError::Pattern(e.into()))
}

peg::parser! {
    grammar pattern_to_regex_translator(enable_extended_globbing: bool, nesting: &NestingGuard) for str {
        pub(crate) rule pattern() -> String =
            pieces:(pattern_piece()*) {
                pieces.join("")
            }

        rule pattern_piece() -> String =
            escape_sequence() /
            bracket_expression() /
            extglob_enabled() s:extended_glob_pattern() { s } /
            wildcard() /
            [c if regex_char_needs_escaping(c)] {
                let mut s = '\\'.to_string();
                s.push(c);
                s
            } /
            [c] { c.to_string() }

        rule escape_sequence() -> String =
            sequence:$(['\\'] [c if regex_char_needs_escaping(c)]) { sequence.to_owned() } /
            ['\\'] [c] { c.to_string() }

        rule bracket_expression() -> String =
            "[" invert:(invert_char()?) members:bracket_member()+ "]" {
                let mut members = members.into_iter().flatten().collect::<Vec<_>>();

                // If we completed the parse but ended up with no valid members
                // of the bracket expression, then return a regex that matches nothing.
                // (Or in the inverted case, matches everything.)
                if members.is_empty() {
                    if invert.is_some() {
                        String::from(".")
                    } else {
                        String::from("(?!)")
                    }
                } else {
                    if invert.is_some() {
                        members.insert(0, String::from("^"));
                    }

                    std::format!("[{}]", members.join(""))
                }
            }

        rule invert_char() -> bool =
            ['!' | '^'] { true }

        rule bracket_member() -> Option<String> =
            e:char_class_expression() { Some(e) } /
            r:char_range() { r } /
            m:single_char_bracket_member() {
                let (char_str, _) = m;
                Some(char_str)
            }

        rule char_class_expression() -> String =
            e:$("[:" char_class() ":]") { e.to_owned() }

        rule char_class() =
            "alnum" / "alpha" / "blank" / "cntrl" / "digit" / "graph" / "lower" / "print" / "punct" / "space" / "upper"/ "xdigit"

        rule char_range() -> Option<String> =
            from:single_char_bracket_member() "-" to:single_char_bracket_member() {
                let (from_str, from_c) = from;
                let (to_str, to_c) = to;

                // Evaluate if the range is valid.
                if from_c <= to_c {
                    Some(std::format!("{from_str}-{to_str}"))
                } else {
                    None
                }
            }

        rule single_char_bracket_member() -> (String, char) =
            // Preserve escaped characters as-is.
            ['\\'] [c] { (std::format!("\\{c}"), c) } /
            // Escape opening bracket.
            ['['] { (String::from(r"\["), '[') } /
            // Any other character except closing bracket gets added as-is.
            [c if c != ']'] { (c.to_string(), c) }

        rule wildcard() -> String =
            "?" { String::from(".") } /
            "*" { String::from(".*") }

        rule extglob_enabled() -> () =
            &[_] {? if enable_extended_globbing { Ok(()) } else { Err("extglob disabled") } }

        pub(crate) rule extended_glob_pattern() -> String =
            kind:extended_glob_prefix() "(" branches:nested("(", <extended_glob_body()>) ")" {
                let mut s = String::new();

                // fancy_regex uses ?! to indicate a negative lookahead.
                if matches!(kind, ExtendedGlobKind::Exclamation) {
                    if !branches.is_empty() {
                        s.push_str("(?:(?!");
                        s.push_str(&branches.join("|"));
                        s.push_str(").*|(?>");
                        s.push_str(&branches.join("|"));
                        s.push_str(").+?|)");
                    } else {
                        s.push_str("(?:.+)");
                    }
                } else {
                    s.push('(');
                    s.push_str(&branches.join("|"));
                    s.push(')');

                    match kind {
                        ExtendedGlobKind::Plus => s.push('+'),
                        ExtendedGlobKind::Question => s.push('?'),
                        ExtendedGlobKind::Star => s.push('*'),
                        ExtendedGlobKind::At | ExtendedGlobKind::Exclamation => (),
                    }
                }

                s
            }

        rule extended_glob_prefix() -> ExtendedGlobKind =
            "+" { ExtendedGlobKind::Plus } /
            "@" { ExtendedGlobKind::At } /
            "!" { ExtendedGlobKind::Exclamation } /
            "?" { ExtendedGlobKind::Question } /
            "*" { ExtendedGlobKind::Star }

        pub(crate) rule extended_glob_body() -> Vec<String> =
            // Cover case with *no* branches.
            &[')'] { vec![] } /
            // Otherwise, look for branches separated by '|'.
            extended_glob_branch() ** "|"

        rule extended_glob_branch() -> String =
            // Cover case of empty branch.
            &['|' | ')'] { String::new() } /
            pieces:(!['|' | ')'] piece:pattern_piece() { piece })+ {
                pieces.join("")
            }

        // A glob metacharacter construct: wildcard, bracket expression, or extglob.
        rule glob_piece() =
            bracket_expression() /
            extglob_enabled() extended_glob_pattern() /
            wildcard()

        // A non-glob piece: an escape sequence or any character not starting a glob.
        rule non_glob_piece() =
            escape_sequence() /
            !glob_piece() [_]

        // Succeeds (returning true) if the pattern contains at least one glob
        // metacharacter. The same bracket_expression, wildcard, and
        // extended_glob_pattern rules used for regex conversion are reused here
        // via negative lookaheads, keeping a single source of truth.
        pub(crate) rule has_glob_metacharacters() -> bool =
            non_glob_piece()* glob_piece() [_]* { true }

        // Parses `r` one nesting level deeper, as the body of `construct`. Fails, without trying
        // `r`, once that would go past the nesting limit.
        rule nested<T>(construct: &'static str, r: rule<T>) -> T =
            enter(construct) v:r()? leave() {? v.ok_or("nested pattern") }

        rule enter(construct: &'static str) = #{|_input, pos| {
            if nesting.enter(construct, pos) {
                peg::RuleResult::Matched(pos, ())
            } else {
                peg::RuleResult::Failed
            }
        }}

        rule leave() = #{|_input, pos| {
            nesting.leave();
            peg::RuleResult::Matched(pos, ())
        }}
    }
}

/// Returns whether a pattern string contains any glob metacharacters.
///
/// Uses the same PEG grammar rules that `pattern_to_regex_str` uses, keeping
/// a single source of truth for what constitutes a glob metacharacter.
///
/// # Arguments
///
/// * `pattern` - The shell pattern to check.
/// * `enable_extended_globbing` - Whether to enable extended globbing (extglob).
pub fn pattern_has_glob_metacharacters(pattern: &str, enable_extended_globbing: bool) -> bool {
    let nesting = NestingGuard::default();
    let result = pattern_to_regex_translator::has_glob_metacharacters(
        pattern,
        enable_extended_globbing,
        &nesting,
    );
    // A pattern nested past the limit is treated as a pattern, so that converting it reports the
    // limit instead of the word being taken as literal text.
    nesting.exceeded().is_some() || result.unwrap_or(false)
}

/// Returns whether or not a given character needs to be escaped in a regular expression.
///
/// # Arguments
///
/// * `c` - The character to check.
pub const fn regex_char_needs_escaping(c: char) -> bool {
    matches!(
        c,
        '[' | ']' | '(' | ')' | '{' | '}' | '*' | '?' | '.' | '+' | '^' | '$' | '|' | '\\' | '-'
    )
}

#[cfg(test)]
#[expect(clippy::panic_in_result_fn)]
mod tests {
    use super::*;
    use anyhow::Result;

    #[test]
    fn test_bracket_exprs() -> Result<()> {
        assert_eq!(pattern_to_regex_str("[a-z]", true)?, "[a-z]");
        assert_eq!(pattern_to_regex_str("[z-a]", true)?, "(?!)");
        assert_eq!(pattern_to_regex_str("[+-/]", true)?, "[+-/]");
        assert_eq!(pattern_to_regex_str(r"[\*-/]", true)?, r"[\*-/]");
        assert_eq!(pattern_to_regex_str("[abc]", true)?, "[abc]");
        assert_eq!(pattern_to_regex_str(r"[\(]", true)?, r"[\(]");
        assert_eq!(pattern_to_regex_str(r"[(]", true)?, "[(]");
        assert_eq!(pattern_to_regex_str("[[:digit:]]", true)?, "[[:digit:]]");
        assert_eq!(pattern_to_regex_str(r"[-(),!]*", true)?, r"[-(),!].*");
        assert_eq!(pattern_to_regex_str(r"[-\(\),\!]*", true)?, r"[-\(\),\!].*");
        assert_eq!(pattern_to_regex_str(r"[a\-b]", true)?, r"[a\-b]");
        assert_eq!(pattern_to_regex_str(r"[a\-\*]", true)?, r"[a\-\*]");
        Ok(())
    }

    #[test]
    fn test_extended_glob() -> Result<()> {
        let nesting = NestingGuard::default();

        assert_eq!(
            pattern_to_regex_translator::extended_glob_pattern("@(a|b)", true, &nesting)?,
            "(a|b)"
        );

        assert_eq!(
            pattern_to_regex_translator::extended_glob_pattern("@(|a)", true, &nesting)?,
            "(|a)"
        );

        assert_eq!(
            pattern_to_regex_translator::extended_glob_pattern("@(|)", true, &nesting)?,
            "(|)"
        );

        assert_eq!(
            pattern_to_regex_translator::extended_glob_body("ab|ac", true, &nesting)?,
            vec!["ab", "ac"],
        );

        assert_eq!(
            pattern_to_regex_translator::extended_glob_pattern("*(ab|ac)", true, &nesting)?,
            "(ab|ac)*"
        );

        assert_eq!(
            pattern_to_regex_translator::extended_glob_body("", true, &nesting)?,
            Vec::<String>::new(),
        );

        Ok(())
    }

    #[test]
    fn test_has_glob_metacharacters() {
        // Basic metacharacters.
        assert!(pattern_has_glob_metacharacters("*", false));
        assert!(pattern_has_glob_metacharacters("?", false));
        assert!(pattern_has_glob_metacharacters("a*b", false));
        assert!(pattern_has_glob_metacharacters("a?b", false));

        // Valid bracket expressions.
        assert!(pattern_has_glob_metacharacters("[abc]", false));
        assert!(pattern_has_glob_metacharacters("[a-z]", false));
        assert!(pattern_has_glob_metacharacters("[!a]", false));

        // Lone `]` is NOT a glob metacharacter.
        assert!(!pattern_has_glob_metacharacters("]", false));
        assert!(!pattern_has_glob_metacharacters("foo]", false));
        assert!(!pattern_has_glob_metacharacters("a]b", false));

        // Lone `[` without matching `]` is NOT a glob metacharacter.
        assert!(!pattern_has_glob_metacharacters("[", false));
        assert!(!pattern_has_glob_metacharacters("[abc", false));
        assert!(!pattern_has_glob_metacharacters("a[b", false));

        // Plain text — no glob chars.
        assert!(!pattern_has_glob_metacharacters("hello", false));
        assert!(!pattern_has_glob_metacharacters("", false));

        // Backslash-escaped metacharacters are not globs.
        assert!(!pattern_has_glob_metacharacters(r"\*", false));
        assert!(!pattern_has_glob_metacharacters(r"\?", false));
        assert!(!pattern_has_glob_metacharacters(r"\[abc]", false));

        // Extglob patterns — not detected without extended globbing.
        assert!(!pattern_has_glob_metacharacters("@(a)", false));
        assert!(!pattern_has_glob_metacharacters("!(a)", false));
        assert!(!pattern_has_glob_metacharacters("+(a)", false));

        // Extglob patterns — detected with extended globbing.
        assert!(pattern_has_glob_metacharacters("@(a)", true));
        assert!(pattern_has_glob_metacharacters("!(a)", true));
        assert!(pattern_has_glob_metacharacters("+(a)", true));

        // *( and ?( are already caught by * and ? checks.
        assert!(pattern_has_glob_metacharacters("*(a)", false));
        assert!(pattern_has_glob_metacharacters("?(a)", false));
    }
}
