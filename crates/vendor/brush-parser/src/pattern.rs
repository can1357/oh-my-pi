//! Implements parsing for shell glob and extglob patterns.

use crate::error;

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
    let translation = Translation::new(pattern, enable_extended_globbing);
    let parsed = pattern_to_regex_translator::pattern(pattern, &translation);
    if translation.nested_too_deep.get() {
        return Err(error::WordParseError::PatternNestedTooDeep(
            Translation::EXTENDED_GLOB_NESTING_LIMIT,
        ));
    }
    let regex_str = parsed.map_err(|e| error::WordParseError::Pattern(e.into()))?;
    Ok(regex_str)
}

/// One pattern the grammar reads: whether extended globbing is on, and which of
/// its bracket expressions and extended globs do not close, so that the
/// grammar does not try them.
///
/// The grammar reads a bracket expression from its `[` through its members to
/// a `]`, and an extended glob from its opener through its branches to a `)`.
/// A PEG remembers nothing between the positions it starts from, so one that
/// did not close was read to the end again from every `[` or opener before it.
/// 16 Ki `[` took 5.2 s to convert and 9.6 s to search, and no less with a
/// `\]` or a `[:alpha:]` at the end, whose `]` a member takes; 22 nested `@(`
/// took 0.6 s to convert, twice as long for each more.
///
/// Finding which do not close is one pass over the pattern, and on the patterns
/// a shell matches all day (`*.txt`, `[Yy][Ee][Ss]`) that pass cost 6 to 28%
/// of the conversion. So the pattern is indexed only once the grammar has
/// tried more than [`Self::TRIES_UNINDEXED`] of them: before that each try may
/// read to the end, which reads the pattern a bounded number of times more;
/// after it each one that does not close fails where it starts.
///
/// It also bounds how deep closed extended globs nest: see
/// [`Self::EXTENDED_GLOB_NESTING_LIMIT`].
pub(crate) struct Translation<'a> {
    pattern:                  &'a str,
    enable_extended_globbing: bool,
    /// How many bracket expressions and extended globs the grammar has tried.
    tries:                    std::cell::Cell<usize>,
    /// `None` inside where the pattern is too large to index.
    index:                    std::cell::OnceCell<Option<Index>>,
    /// How many extended globs the grammar is inside.
    depth:                    std::cell::Cell<usize>,
    /// Whether an extended glob that closes nests past the limit.
    nested_too_deep:          std::cell::Cell<bool>,
}

impl<'a> Translation<'a> {
    /// How many bracket expressions and extended globs the grammar may try on
    /// a pattern before it is indexed.
    const TRIES_UNINDEXED: usize = 8;

    /// How deep extended globs that close may nest.
    ///
    /// The grammar reads each level with a call of its own, so nesting past
    /// what the stack holds aborted the process. On a 2 MiB thread stack, which
    /// is what a Tokio worker has, a debug build held 768 levels and not 1,024,
    /// an optimised one 3,584 and not 4,096, and `[[ $x == $data ]]` could put
    /// them there. Past this limit the pattern is an error instead. It is a
    /// third of the deepest a debug build held, leaving the rest of the stack
    /// to whatever called the parser; no pattern written to match anything
    /// nests this deep.
    pub(crate) const EXTENDED_GLOB_NESTING_LIMIT: usize = 256;

    pub(crate) const fn new(pattern: &'a str, enable_extended_globbing: bool) -> Self {
        Self {
            pattern,
            enable_extended_globbing,
            tries: std::cell::Cell::new(0),
            index: std::cell::OnceCell::new(),
            depth: std::cell::Cell::new(0),
            nested_too_deep: std::cell::Cell::new(false),
        }
    }

    /// Whether extended globbing is on.
    const fn extended(&self) -> bool {
        self.enable_extended_globbing
    }

    /// Whether the bracket expression whose `[` is at `open` may close.
    fn bracket_may_close(&self, open: usize) -> bool {
        self.index().is_none_or(|index| index.brackets.binary_search(&open).is_err())
    }

    /// Whether the extended glob whose opener begins at `open` may be read:
    /// whether it may close, and if it does, whether it nests within the limit.
    /// Past the limit it is recorded and refused, so the parse goes no deeper
    /// and its caller reports the error. Reading it goes one level deeper,
    /// until [`Self::close_extended_glob`].
    fn open_extended_glob(&self, open: usize) -> bool {
        let may_close =
            self.index().is_none_or(|index| index.extended_globs.binary_search(&open).is_err());
        if !may_close {
            return false;
        }
        let depth = self.depth.get();
        if depth >= Self::EXTENDED_GLOB_NESTING_LIMIT {
            self.nested_too_deep.set(true);
            return false;
        }
        self.depth.set(depth + 1);
        true
    }

    /// The body of an extended glob [`Self::open_extended_glob`] let the
    /// grammar read has been read. The body cannot fail, so this always
    /// follows the open.
    fn close_extended_glob(&self) {
        self.depth.set(self.depth.get() - 1);
    }

    /// Counts a try, and returns the index once there have been enough.
    fn index(&self) -> Option<&Index> {
        let tries = self.tries.get();
        if tries < Self::TRIES_UNINDEXED {
            self.tries.set(tries + 1);
            return None;
        }
        self.built_index()
    }

    /// Builds the index the first time. Out of line: it runs at most once a
    /// pattern, and the rules that ask recurse once per nested extended glob.
    #[cold]
    #[inline(never)]
    fn built_index(&self) -> Option<&Index> {
        self.index
            .get_or_init(|| Index::new(self.pattern, self.enable_extended_globbing))
            .as_ref()
    }
}

/// Where in a pattern the bracket expressions and extended globs that do not
/// close begin.
struct Index {
    /// Offsets of every `[` whose bracket expression does not close, ascending.
    brackets:       Vec<usize>,
    /// Offsets of the extended glob openers that do not close, ascending.
    extended_globs: Vec<usize>,
}

impl Index {
    /// `None` where offsets do not fit a `u32`, leaving the grammar unguarded.
    fn new(pattern: &str, enable_extended_globbing: bool) -> Option<Self> {
        let bytes = pattern.as_bytes();
        let ends = BracketEnds::new(pattern)?;
        let brackets = (0..bytes.len())
            .filter(|&at| bytes[at] == b'[' && ends.end(bytes, at).is_none())
            .collect();
        let extended_globs =
            if enable_extended_globbing { unclosed_openers(bytes, &ends) } else { Vec::new() };
        Some(Self { brackets, extended_globs })
    }
}

/// For each offset in a pattern that a bracket expression's members can be read
/// from, the offset of the `]` that ends them. Read from the end backwards, each
/// offset's answer is its first member's end's, so each is found once.
struct BracketEnds(Vec<u32>);

impl BracketEnds {
    /// No `]` ends the members read from here. Also the entry for an offset
    /// inside a character, which no member starts at and nothing reads.
    const NEVER: u32 = u32::MAX;

    fn new(pattern: &str) -> Option<Self> {
        let bytes = pattern.as_bytes();
        if u32::try_from(bytes.len()).ok()? == Self::NEVER {
            return None;
        }
        let mut stops = vec![Self::NEVER; bytes.len() + 1];
        for at in (0..bytes.len()).rev() {
            if !pattern.is_char_boundary(at) {
                continue;
            }
            stops[at] = if bytes[at] == b']' {
                u32::try_from(at).ok()?
            } else {
                // The member ends on a character boundary after `at`, which
                // this loop has already been through.
                stops[bracket_member_end(bytes, at)]
            };
        }
        Some(Self(stops))
    }

    /// Where the bracket expression whose `[` is at `at` ends, or `None` if it
    /// does not close.
    fn end(&self, bytes: &[u8], at: usize) -> Option<usize> {
        // An optional `!` or `^` inverts it; then at least one member, then `]`.
        // What precedes `first` is ASCII, so it is a character boundary.
        let mut first = at + 1;
        if matches!(bytes.get(first), Some(b'!' | b'^')) {
            first += 1;
        }
        if matches!(bytes.get(first), None | Some(b']')) {
            return None;
        }
        match self.0[first] {
            Self::NEVER => None,
            stop => Some(stop as usize + 1),
        }
    }
}

/// Where the bracket expression member at `at` ends, as the grammar reads it:
/// a class (`[:alpha:]`), else a range (`a-z`), else one character, where a
/// backslash and the character after it are one. `bytes[at]` is not `]`.
fn bracket_member_end(bytes: &[u8], at: usize) -> usize {
    const CLASSES: [&[u8]; 12] = [
        b"alnum", b"alpha", b"blank", b"cntrl", b"digit", b"graph", b"lower", b"print",
        b"punct", b"space", b"upper", b"xdigit",
    ];
    if let Some(rest) = bytes[at..].strip_prefix(b"[:") {
        // No class name is a prefix of another, so at most one can fit.
        if let Some(class) = CLASSES
            .iter()
            .find(|class| rest.strip_prefix(**class).is_some_and(|tail| tail.starts_with(b":]")))
        {
            return at + 2 + class.len() + 2;
        }
    }
    let single = single_bracket_member_end(bytes, at).unwrap_or(at + 1);
    if bytes.get(single) == Some(&b'-') {
        if let Some(range_end) = single_bracket_member_end(bytes, single + 1) {
            return range_end;
        }
    }
    single
}

/// Where a one-character bracket expression member at `at` ends, or `None`
/// where `bytes[at]` is `]` or past the end.
fn single_bracket_member_end(bytes: &[u8], at: usize) -> Option<usize> {
    match *bytes.get(at)? {
        b']' => None,
        b'\\' if at + 1 < bytes.len() => Some(at + 1 + char_width(bytes[at + 1])),
        byte => Some(at + char_width(byte)),
    }
}

/// The extended glob openers (`+(`, `@(`, `!(`, `?(`, `*(`) that do not close.
///
/// Read front to back as the grammar reads a pattern — a backslash and the
/// character after it as one, a bracket expression that closes as one — an
/// opener closes at the first `)` that no opener after it took. One that does
/// not close leaves every opener before it open too, since from its `(` on they
/// read the same characters.
fn unclosed_openers(bytes: &[u8], ends: &BracketEnds) -> Vec<usize> {
    let mut open = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        match bytes[at] {
            b'\\' if at + 1 < bytes.len() => at += 1 + char_width(bytes[at + 1]),
            b'[' => at = ends.end(bytes, at).unwrap_or(at + 1),
            b'+' | b'@' | b'!' | b'?' | b'*' if bytes.get(at + 1) == Some(&b'(') => {
                open.push(at);
                at += 2;
            }
            b')' => {
                open.pop();
                at += 1;
            }
            byte => at += char_width(byte),
        }
    }
    open
}

/// How many bytes the UTF-8 character `byte` begins is.
const fn char_width(byte: u8) -> usize {
    match byte {
        0xF0..=0xFF => 4,
        0xE0..=0xEF => 3,
        0xC0..=0xDF => 2,
        _ => 1,
    }
}

peg::parser! {
    grammar pattern_to_regex_translator<'a>(translation: &'a Translation<'a>) for str {
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

        // See `Translation`. Asked after the `[`, so only a `[` asks.
        rule bracket_may_close() =
            at:position!() {?
                if translation.bracket_may_close(at - 1) { Ok(()) } else { Err("a closing bracket") }
            }

        rule bracket_expression() -> String =
            "[" bracket_may_close() invert:(invert_char()?) members:bracket_member()+ "]" {
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
            &[_] {? if translation.extended() { Ok(()) } else { Err("extglob disabled") } }

        // See `Translation`. Asked after the opener's `(`, two bytes from its
        // start; when it lets the body be read, `extended_glob_close` follows.
        rule extended_glob_open() =
            at:position!() {?
                if translation.open_extended_glob(at - 2) {
                    Ok(())
                } else {
                    Err("a closing parenthesis, within the nesting limit")
                }
            }

        rule extended_glob_close() =
            position!() {? translation.close_extended_glob(); Ok(()) }

        pub(crate) rule extended_glob_pattern() -> String =
            kind:extended_glob_prefix() "(" extended_glob_open() branches:extended_glob_body() extended_glob_close() ")" {
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

        // Cannot fail, which `extended_glob_close` relies on: zero branches
        // match, and a branch stops at a `|`, a `)` or the end.
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
    }
}

/// Returns whether a pattern string contains any glob metacharacters.
///
/// Uses the same PEG grammar rules that `pattern_to_regex_str` uses, keeping
/// a single source of truth for what constitutes a glob metacharacter. A
/// pattern whose extended globs nest past the limit counts as one, so that
/// converting it reports the error.
///
/// # Arguments
///
/// * `pattern` - The shell pattern to check.
/// * `enable_extended_globbing` - Whether to enable extended globbing (extglob).
pub fn pattern_has_glob_metacharacters(pattern: &str, enable_extended_globbing: bool) -> bool {
    let translation = Translation::new(pattern, enable_extended_globbing);
    let found =
        pattern_to_regex_translator::has_glob_metacharacters(pattern, &translation).unwrap_or(false);
    found || translation.nested_too_deep.get()
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

    /// `extended_glob_pattern` on `input` alone, with extended globbing on.
    fn extended_glob(input: &str) -> Result<String> {
        let translation = Translation::new(input, true);
        Ok(pattern_to_regex_translator::extended_glob_pattern(input, &translation)?)
    }

    /// `extended_glob_body` on `input` alone, with extended globbing on.
    fn extended_glob_body(input: &str) -> Result<Vec<String>> {
        let translation = Translation::new(input, true);
        Ok(pattern_to_regex_translator::extended_glob_body(input, &translation)?)
    }

    #[test]
    fn test_extended_glob() -> Result<()> {
        assert_eq!(extended_glob("@(a|b)")?, "(a|b)");
        assert_eq!(extended_glob("@(|a)")?, "(|a)");
        assert_eq!(extended_glob("@(|)")?, "(|)");
        assert_eq!(extended_glob_body("ab|ac")?, vec!["ab", "ac"]);
        assert_eq!(extended_glob("*(ab|ac)")?, "(ab|ac)*");
        assert_eq!(extended_glob_body("")?, Vec::<String>::new());
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

    /// Indexing a pattern costs more than converting one a shell matches all
    /// day, so only a pattern that tries more than a few constructs is indexed.
    #[test]
    fn ordinary_patterns_are_not_indexed() {
        let indexed = |pattern: &str| {
            let translation = Translation::new(pattern, true);
            let _ = pattern_to_regex_translator::pattern(pattern, &translation);
            translation.index.get().is_some()
        };
        for pattern in ["*.txt", "[abc]", "[Yy][Ee][Ss]", "*.@(jpg|png|gif)", "[[:digit:]]*"] {
            assert!(!indexed(pattern), "{pattern} is not indexed");
        }
        assert!(indexed(&"[".repeat(Translation::TRIES_UNINDEXED + 1)), "a run of `[` is");
    }

    /// Every extended glob the grammar opens it closes again, whether it then
    /// matches its `)` or not, so the depth the limit reads is the nesting.
    #[test]
    fn extended_glob_depth_returns_to_zero() {
        for pattern in ["@(a|b)", "@(a|@(b|c)|d)x", "@(a", "@(a|", "!(a)@(", "+(a|*(b|c)"] {
            let translation = Translation::new(pattern, true);
            let _ = pattern_to_regex_translator::pattern(pattern, &translation);
            let _ = pattern_to_regex_translator::has_glob_metacharacters(pattern, &translation);
            assert_eq!(translation.depth.get(), 0, "{pattern}");
        }
    }

    /// Runs `parse` on a thread of its own and returns what it returned,
    /// failing if it has not within 30 s. A parse with nothing to stop it would
    /// otherwise hold the test run for as long as it takes.
    #[expect(clippy::expect_used, reason = "a test helper: a timeout here is the failure")]
    fn within_30_s<T: Send + 'static>(parse: impl FnOnce() -> T + Send + 'static) -> T {
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = done_tx.send(parse());
        });
        done_rx.recv_timeout(std::time::Duration::from_secs(30)).expect("the parse finished")
    }

    /// A `[` whose bracket expression does not close was read to the end again
    /// from every `[` before it: 16 Ki took 5.2 s to convert and 9.6 s to
    /// search, with no `]` or with one at the end that a member takes. These
    /// are eight times as many, which would take over five minutes each.
    #[test]
    fn unclosed_brackets_are_read_once() {
        let results = within_30_s(|| {
            let run = "[".repeat(1 << 17);
            ["", r"\]", "[:alpha:]"].map(|tail| {
                let shape = format!("{run}{tail}");
                let converts = pattern_to_regex_str(&format!("{shape}*"), false).is_ok();
                (converts, pattern_has_glob_metacharacters(&shape, false))
            })
        });
        // Only the last `[` of `[:alpha:]` closes: on `]`, after `:alpha:`.
        assert_eq!(results, [(true, false), (true, false), (true, true)]);
    }

    /// An extended glob that does not close was read to the end again from
    /// every opener around it, so 22 nested `@(` took 0.6 s to convert, each
    /// more doubling it; parsing each opener once left it quadratic, 68 ms for
    /// 1,024. Unguarded, the grammar also goes one call deeper for each opener
    /// it tries, and these 32 Ki overflowed the stack.
    #[test]
    fn unclosed_extended_globs_are_read_once() {
        let results = within_30_s(|| {
            let openers = "@(".repeat(1 << 15);
            let converts = pattern_to_regex_str(&format!("{openers}x)"), true).is_ok();
            let unclosed = pattern_has_glob_metacharacters(&format!("{openers}x"), true);
            let innermost = pattern_has_glob_metacharacters(&format!("{openers}x)"), true);
            (converts, unclosed, innermost)
        });
        // Only the innermost opener closes, and only where there is a `)`.
        assert_eq!(results, (true, false, true));
    }

    /// Converts and searches `depth` closed extended globs, each inside the
    /// last, on a thread with the 2 MiB stack a Tokio worker has.
    #[expect(clippy::expect_used, reason = "a test helper: a stack overflow here is the failure")]
    fn nested(depth: usize) -> (Result<String, String>, bool) {
        std::thread::Builder::new()
            .stack_size(2 << 20)
            .spawn(move || {
                let pattern = format!("{}x{}", "@(".repeat(depth), ")".repeat(depth));
                let converted = pattern_to_regex_str(&pattern, true).map_err(|e| e.to_string());
                (converted, pattern_has_glob_metacharacters(&pattern, true))
            })
            .expect("spawned")
            .join()
            .expect("the parse returned")
    }

    /// The grammar reads each level of a closed extended glob with a call of
    /// its own, and on this stack 1,024 levels aborted a debug build and 4,096
    /// an optimised one. Past the limit the pattern is an error instead.
    #[test]
    fn deeply_nested_extended_globs_are_an_error() {
        let (converted, has_glob) = nested(1 << 14);
        assert_eq!(
            converted,
            Err(String::from("failed to parse pattern: extended globs nest more than 256 deep"))
        );
        assert!(has_glob, "it counts as a glob, so converting it reports the error");
    }

    /// Up to the limit, nesting converts as before; one more is refused.
    #[test]
    fn nesting_to_the_limit_still_parses() {
        let limit = Translation::EXTENDED_GLOB_NESTING_LIMIT;
        let (converted, has_glob) = nested(limit);
        assert!(converted.is_ok() && has_glob, "{limit} levels convert");
        assert!(nested(limit + 1).0.is_err(), "{} levels do not", limit + 1);
        assert_eq!(pattern_to_regex_str("+(a|@(b|*(c|!(d))))", true).ok().as_deref(), Some(
            "(a|(b|(c|(?:(?!d).*|(?>d).+?|))*))+"
        ));
    }
}
