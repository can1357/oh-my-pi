//! zsh grammar (`Features::ZSH`): token strings, the AST of every compound
//! form, node ids, zsh's error messages, aliases, the parse-affecting
//! options, `functions` text, and the 15 `Test/*.ztst` files the zsh
//! dialect targets as a corpus. Goldens come from zsh 5.9
//! (`tests/data/zsh_regen.py`).

use crate::bash::syntax::{
	zsh::{
		function_text, reindent_function,
		tok::{
			BAR, BNULL, COMMA, DASH, DNULL, EQUALS, INANG, INBRACE, INBRACK, INPAR, INPARMATH, OUTANG,
			OUTBRACE, OUTBRACK, OUTPAR, OUTPARMATH, POUND, QSTRING, SNULL, STAR, STRING,
		},
	},
	*,
};

/// zsh's defaults for the parse-affecting options of a non-interactive
/// shell: `shortloops`, `multifuncdef`, comments.
fn zf() -> Features {
	Features::ZSH
		| Features::ZSH_SHORT_LOOPS
		| Features::ZSH_MULTI_FUNC_DEF
		| Features::ZSH_INTERACTIVE_COMMENTS
}

fn parse(src: &[u8]) -> Program {
	parse_all(src, zf()).unwrap_or_else(|e| panic!("{:?}: {e}", String::from_utf8_lossy(src)))
}

fn first_cmd(src: &[u8]) -> Command {
	parse(src)
		.commands
		.remove(0)
		.list
		.items
		.remove(0)
		.and_or
		.first
		.stages
		.remove(0)
		.cmd
}

fn simple(src: &[u8]) -> Simple {
	match first_cmd(src).kind {
		CommandKind::Simple(s) => s,
		other => panic!("not simple: {other:?}"),
	}
}

fn zsh_bytes(w: &Word) -> &[u8] {
	match &w.parts[..] {
		[WordPart::Zsh(s)] => s,
		other => panic!("not one zsh part: {other:?}"),
	}
}

fn words(src: &[u8]) -> Vec<Vec<u8>> {
	simple(src)
		.words
		.iter()
		.map(|w| zsh_bytes(w).to_vec())
		.collect()
}

/// The first message zsh prints for a failed parse.
fn first_msg(e: &ParseError) -> Vec<u8> {
	e.detail().map_or_else(|| e.bash_msg(), |d| d.bash_msg)
}

// ---- token strings ----------------------------------------------------------

#[test]
fn quotes_become_null_tokens_and_qstring() {
	let w = words(b"echo 'a b' \"c $d\" e\\ f");
	assert_eq!(w[1], [SNULL, b'a', b' ', b'b', SNULL]);
	assert_eq!(w[2], [DNULL, b'c', b' ', QSTRING, b'd', DNULL]);
	assert_eq!(w[3], [b'e', BNULL, b' ', b'f']);
}

#[test]
fn parameter_flags_subscripts_and_math_keep_zsh_tokens() {
	let w = words(b"echo ${(f)x} $x[1] $((1+2))");
	assert_eq!(w[1], [STRING, INBRACE, INPAR, b'f', OUTPAR, b'x', OUTBRACE]);
	assert_eq!(w[2], [STRING, b'x', INBRACK, b'1', OUTBRACK]);
	assert_eq!(w[3], [STRING, INPARMATH, b'(', b'1', b'+', b'2', b')', OUTPARMATH]);
}

#[test]
fn glob_qualifiers_numeric_ranges_and_flags_are_part_of_the_word() {
	let w = words(b"echo *(.N) <1-5> (#i)a");
	assert_eq!(w[1], [STAR, INPAR, b'.', b'N', OUTPAR]);
	assert_eq!(w[2], [INANG, b'1', b'-', b'5', OUTANG]);
	assert_eq!(w[3], [INPAR, POUND, b'i', OUTPAR, b'a']);
}

#[test]
fn command_substitutions_keep_their_raw_text() {
	let w = words(b"echo =(cmd) \"$(echo a)\" $( b | c )");
	assert_eq!(w[1], [&[EQUALS, INPAR][..], &b"cmd"[..], &[OUTPAR][..]].concat());
	assert_eq!(w[2], [&[DNULL, QSTRING, INPAR][..], &b"echo a"[..], &[OUTPAR, DNULL][..]].concat());
	assert_eq!(w[3], [&[STRING, INPAR][..], &b" b | c "[..], &[OUTPAR][..]].concat());
}

#[test]
fn dash_and_equals_are_tokens_in_ordinary_words() {
	let w = words(b"echo -x a=b");
	assert_eq!(w[1], [DASH, b'x']);
	assert_eq!(w[2], [b'a', EQUALS, b'b']);
}

#[test]
fn bytes_zsh_treats_as_special_are_metafied() {
	let w = words("echo é‘x’".as_bytes());
	assert!(
		w[1]
			.iter()
			.all(|&c| !crate::bash::syntax::zsh::tok::is_tok(c))
	);
	let mut text = w[1].clone();
	crate::bash::syntax::zsh::tok::untokenize(&mut text);
	assert_eq!(crate::bash::syntax::zsh::tok::unmetafy(&text), "é‘x’".as_bytes());
}

#[test]
fn here_documents_keep_the_raw_body() {
	let cmd = first_cmd(b"cat <<EOF <<-'E'\nhi $x\nEOF\n\t\ttab\n\tE\n");
	let docs: Vec<&HereDoc> = cmd
		.redirs
		.iter()
		.map(|r| match &r.target {
			RedirTarget::HereDoc(d) => d,
			RedirTarget::Word(_) => panic!("word"),
		})
		.collect();
	assert_eq!(docs[0].delim, b"EOF");
	assert!(!docs[0].quoted);
	assert_eq!(docs[0].text, b"hi $x\n");
	assert_eq!(docs[1].delim, b"E");
	assert_eq!(docs[1].delim_raw, b"'E'");
	assert!(docs[1].quoted);
	assert_eq!(docs[1].text, b"tab\n");
	assert_eq!(cmd.redirs[1].op, RedirOp::HereDoc { strip_tabs: true });
}

#[test]
fn unquoted_here_document_drops_backslash_newline_quoted_keeps_it() {
	let cmd = first_cmd(b"cat <<A <<'B'\na\\\nb\nA\nc\\\nd\nB\n");
	let text = |i: usize| match &cmd.redirs[i].target {
		RedirTarget::HereDoc(d) => d.text.clone(),
		RedirTarget::Word(_) => panic!("word"),
	};
	assert_eq!(text(0), b"ab\n");
	assert_eq!(text(1), b"c\\\nd\n");
}

// ---- assignments ------------------------------------------------------------

#[test]
fn assignments_split_name_subscript_append_and_key_value_elements() {
	let s = simple(b"a=1 b+=2 c[3]=x d=(1 [k]=v [j]+=w) cmd");
	assert_eq!(s.assigns[0].name, b"a");
	assert!(matches!(&s.assigns[0].value, AssignValue::Scalar(w) if zsh_bytes(w) == b"1"));
	assert!(s.assigns[1].append);
	assert_eq!(s.assigns[2].name, b"c");
	assert_eq!(zsh_bytes(s.assigns[2].index.as_ref().unwrap()), b"3");
	let AssignValue::Array(elems) = &s.assigns[3].value else {
		panic!()
	};
	assert!(elems[0].key.is_none());
	assert_eq!(zsh_bytes(elems[1].key.as_ref().unwrap()), b"k");
	assert_eq!(zsh_bytes(&elems[1].value), b"v");
	assert!(elems[2].append);
	assert_eq!(zsh_bytes(&s.words[0]), b"cmd");
}

#[test]
fn typeset_arguments_keep_assignments_with_a_literal_equals() {
	let s = simple(b"local x=1 y=(a b) z");
	assert_eq!(zsh_bytes(&s.words[0]), b"local");
	assert_eq!(zsh_bytes(&s.words[1]), b"x=1");
	match &s.words[2].parts[..] {
		[WordPart::Zsh(head), WordPart::Compound(elems)] => {
			assert_eq!(head, b"y=");
			assert_eq!(elems.len(), 2);
		},
		other => panic!("{other:?}"),
	}
	assert_eq!(zsh_bytes(&s.words[3]), b"z");
	// Not a reserved word: `=` is the Equals token, no compound.
	let w = words(b"builtin typeset x=1");
	assert_eq!(w[2], [b'x', EQUALS, b'1']);
}

// ---- compound commands
// --------------------------------------------------------

#[test]
fn repeat_long_and_short_forms() {
	let CommandKind::Repeat(r) = first_cmd(b"repeat 3 echo x").kind else {
		panic!()
	};
	assert_eq!(zsh_bytes(&r.count), b"3");
	assert_eq!(r.body.items.len(), 1);
	let CommandKind::Repeat(r) = first_cmd(b"repeat $n; do a; b; done").kind else {
		panic!()
	};
	assert_eq!(r.body.items.len(), 2);
}

#[test]
fn always_blocks_anonymous_functions_and_multiple_names() {
	let CommandKind::Try(t) = first_cmd(b"{ a } always { b; c }").kind else {
		panic!()
	};
	assert_eq!((t.body.items.len(), t.always.items.len()), (1, 2));
	let CommandKind::AnonFunc(a) = first_cmd(b"() { echo $1 } x y").kind else {
		panic!()
	};
	assert!(matches!(a.body.kind, CommandKind::Brace(_)));
	assert_eq!(a.args.len(), 2);
	let CommandKind::AnonFunc(a) = first_cmd(b"function { echo } z").kind else {
		panic!()
	};
	assert_eq!(a.args.len(), 1);
	let CommandKind::FuncDef(f) = first_cmd(b"f g () { a }").kind else {
		panic!()
	};
	assert_eq!((f.name.as_slice(), f.extra_names.len()), (&b"f"[..], 1));
	let CommandKind::FuncDef(f) = first_cmd(b"function -T h { x }").kind else {
		panic!()
	};
	assert!(f.keyword);
	assert_eq!(f.name, b"h");
}

#[test]
fn function_redirections_move_onto_the_body() {
	let CommandKind::FuncDef(f) = first_cmd(b"f() { a } >out").kind else {
		panic!()
	};
	assert_eq!(f.body.redirs.len(), 1);
	let cmd = first_cmd(b"() { a } x >out");
	assert_eq!(cmd.redirs.len(), 1, "an anonymous function's redirections stay on the call");
}

#[test]
fn for_forms() {
	let CommandKind::For(f) = first_cmd(b"for a b (1 2 3 4) echo $a $b").kind else {
		panic!()
	};
	assert_eq!((f.var.as_slice(), f.extra_vars.clone()), (&b"a"[..], vec![b"b".to_vec()]));
	assert_eq!(f.words.as_ref().unwrap().len(), 4);
	let CommandKind::For(f) = first_cmd(b"foreach x (a b)\necho $x\nend").kind else {
		panic!()
	};
	assert_eq!(f.body.items.len(), 1);
	let CommandKind::For(f) = first_cmd(b"for x; do :; done").kind else {
		panic!()
	};
	assert!(f.words.is_none());
	let CommandKind::ArithFor(f) = first_cmd(b"for ((i=0; i<3; i++)) echo $i").kind else {
		panic!()
	};
	// zsh skips the blanks before each expression, not after.
	assert_eq!((f.init.src.as_slice(), f.step.src.as_slice()), (&b"i=0"[..], &b"i++"[..]));
	let CommandKind::Select(f) = first_cmd(b"select x in a b; do :; done").kind else {
		panic!()
	};
	assert_eq!(f.words.as_ref().unwrap().len(), 2);
}

#[test]
fn case_patterns_and_terminators() {
	let CommandKind::Case(c) = first_cmd(b"case x in (a|b) y;; c|d) z;& ( e | f ) w;| *) esac").kind
	else {
		panic!()
	};
	assert_eq!(zsh_bytes(&c.arms[0].patterns[0]), [b'a', BAR, b'b']);
	assert_eq!(c.arms[0].patterns.len(), 1);
	assert_eq!(c.arms[1].patterns.len(), 2);
	assert_eq!(zsh_bytes(&c.arms[2].patterns[0]), [b'e', BAR, b'f']);
	let terms: Vec<CaseTerm> = c.arms.iter().map(|a| a.term).collect();
	assert_eq!(terms, [CaseTerm::Break, CaseTerm::FallThrough, CaseTerm::Continue, CaseTerm::Break]);
	let CommandKind::Case(c) = first_cmd(b"case x { (a) b }").kind else {
		panic!()
	};
	assert_eq!(c.arms.len(), 1);
}

#[test]
fn if_while_and_their_brace_and_short_forms() {
	let CommandKind::If(i) = first_cmd(b"if [[ a ]] { b } else { c }").kind else {
		panic!()
	};
	assert!(i.else_body.is_some());
	let CommandKind::If(i) = first_cmd(b"if a; then b; elif c; then d; else e; fi").kind else {
		panic!()
	};
	assert_eq!(i.arms.len(), 2);
	let CommandKind::If(i) = first_cmd(b"if [[ a ]] b").kind else {
		panic!()
	};
	assert_eq!(i.arms[0].body.items.len(), 1);
	// The condition list takes every word: zsh rejects `if a b`.
	assert_eq!(parse_all(b"if a b", zf()).unwrap_err().bash_msg(), b"parse error near `b'");
	let CommandKind::While(w) = first_cmd(b"until [[ a ]] { b }").kind else {
		panic!()
	};
	assert!(w.until);
	let CommandKind::While(w) = first_cmd(b"while; do :; done").kind else {
		panic!()
	};
	assert!(w.cond.items.is_empty(), "zsh accepts an empty condition");
}

#[test]
fn conditions_arith_time_coproc_and_separators() {
	let CommandKind::Cond(cond) = first_cmd(b"[[ -o opt && $a == b* || ! -f x ]]").kind else {
		panic!()
	};
	let CondExpr::Or(lhs, rhs) = cond else {
		panic!()
	};
	assert!(matches!(*lhs, CondExpr::And(..)));
	assert!(matches!(*rhs, CondExpr::Not(_)));
	let CommandKind::Cond(CondExpr::Unary { op, .. }) = first_cmd(b"[[ a ]]").kind else {
		panic!()
	};
	assert_eq!(op, b"-n", "zsh reads a lone word as -n word");
	let CommandKind::Cond(CondExpr::Unary { op, arg }) = first_cmd(b"[[ -x a b ]]").kind else {
		panic!()
	};
	assert_eq!((op.as_slice(), arg.parts.len()), (&b"-x"[..], 2));
	let CommandKind::Arith(arith) = first_cmd(b"(( x++ ))").kind else {
		panic!()
	};
	assert_eq!(arith.src, b" x++ ");
	let prog = parse(b"time a | b");
	let pipe = &prog.commands[0].list.items[0].and_or.first;
	assert!(pipe.time.is_some() && pipe.stages.len() == 2);
	let cmd = first_cmd(b"coproc cat");
	assert!(matches!(cmd.kind, CommandKind::Coproc(_)));
	let items = &parse(b"a &| b &! c |& d").commands[0].list.items;
	assert_eq!((items[0].sep, items[1].sep), (Sep::Disown, Sep::Disown));
	assert!(items[2].and_or.first.stages[0].pipe_stderr);
}

#[test]
fn redirection_operators_and_fd_forms() {
	let cmd = first_cmd(b"cmd >>| f &>| g &>>| h >&| i 2>&1 <&- >&p {fd}>x <<< str 3<> rw");
	let ops: Vec<RedirOp> = cmd.redirs.iter().map(|r| r.op).collect();
	assert_eq!(ops, [
		RedirOp::AppendClobber,
		RedirOp::OutErrClobber,
		RedirOp::AppendErrClobber,
		RedirOp::OutErrClobber,
		RedirOp::DupOut,
		RedirOp::DupIn,
		RedirOp::DupOut,
		RedirOp::Out,
		RedirOp::HereString,
		RedirOp::ReadWrite,
	]);
	assert_eq!(cmd.redirs[4].fd, Some(RedirFd::Num(2)));
	assert_eq!(cmd.redirs[7].fd, Some(RedirFd::Var(b"fd".to_vec())));
	assert_eq!(cmd.redirs[9].fd, Some(RedirFd::Num(3)));
}

#[test]
fn one_command_per_line_and_constructs_span_lines() {
	let prog = parse(b"a; b\n\n# c\nif x\nthen y\nfi\nz\n");
	let lines: Vec<u32> = prog.commands.iter().map(|c| c.line).collect();
	assert_eq!(lines, [1, 4, 7]);
	assert_eq!(prog.commands[0].list.items.len(), 2);
}

// ---- node ids ---------------------------------------------------------------

fn ids_list(l: &List, out: &mut Vec<u32>) {
	for it in &l.items {
		out.push(it.and_or.id.0);
		for p in core::iter::once(&it.and_or.first).chain(it.and_or.rest.iter().map(|(_, p)| p)) {
			out.push(p.id.0);
			for st in &p.stages {
				ids_cmd(&st.cmd, out);
			}
		}
	}
}

fn ids_word(w: &Word, out: &mut Vec<u32>) {
	out.push(w.id.0);
	for p in &w.parts {
		if let WordPart::Compound(elems) = p {
			ids_elems(elems, out);
		}
	}
}

fn ids_elems(elems: &[ArrayElem], out: &mut Vec<u32>) {
	for e in elems {
		if let Some(k) = &e.key {
			ids_word(k, out);
		}
		ids_word(&e.value, out);
	}
}

fn ids_cmd(c: &Command, out: &mut Vec<u32>) {
	out.push(c.id.0);
	match &c.kind {
		CommandKind::Simple(s) => {
			for a in &s.assigns {
				out.push(a.id.0);
				if let Some(i) = &a.index {
					ids_word(i, out);
				}
				match &a.value {
					AssignValue::Scalar(w) => ids_word(w, out),
					AssignValue::Array(e) => ids_elems(e, out),
				}
			}
			for w in &s.words {
				ids_word(w, out);
			}
		},
		CommandKind::Brace(l) | CommandKind::Subshell(l) => ids_list(l, out),
		CommandKind::Repeat(r) => {
			ids_word(&r.count, out);
			ids_list(&r.body, out);
		},
		CommandKind::Try(t) => {
			ids_list(&t.body, out);
			ids_list(&t.always, out);
		},
		CommandKind::AnonFunc(a) => {
			ids_cmd(&a.body, out);
			for w in &a.args {
				ids_word(w, out);
			}
		},
		CommandKind::For(f) => {
			for w in f.words.iter().flatten() {
				ids_word(w, out);
			}
			ids_list(&f.body, out);
		},
		CommandKind::FuncDef(f) => ids_cmd(&f.body, out),
		other => panic!("not in this test: {other:?}"),
	}
	for r in &c.redirs {
		if let RedirTarget::Word(w) = &r.target {
			ids_word(w, out);
		}
	}
}

#[test]
fn node_ids_are_a_dense_preorder() {
	let src = b"x=1 y=(a [k]=v) local z=(1 2) >o; repeat 2 do { a } always { b }; done; () { c } d; for i (1) f() { g } >h\n";
	let prog = parse(src);
	let unit = &prog.commands[0];
	let mut ids = Vec::new();
	ids_list(&unit.list, &mut ids);
	assert_eq!(ids, (0..unit.node_count).collect::<Vec<_>>());
}

// ---- errors -----------------------------------------------------------------

#[test]
fn zsh_parse_messages() {
	let data = include_str!("data/zsh_errors.txt");
	for rec in data.split('\x1e') {
		let (src, want) = rec.split_once('\x1f').expect("two fields");
		let got = parse_all(src.as_bytes(), zf());
		if want.is_empty() {
			assert!(got.is_ok(), "zsh accepts {src:?}: {:?}", got.err());
		} else {
			let e = got.expect_err(src);
			assert_eq!(String::from_utf8_lossy(&first_msg(&e)), want, "{src:?}");
		}
	}
}

#[test]
fn error_in_a_command_substitution_reports_both_messages() {
	let e = parse_all(b"echo $(fi)", zf()).unwrap_err();
	assert_eq!(e.detail().unwrap().bash_msg, b"parse error near `fi'");
	assert_eq!(e.bash_msg(), b"parse error near `$(fi)'");
}

#[test]
fn errors_at_the_end_of_input_point_at_the_end() {
	let src = b"if true; then";
	let e = parse_all(src, zf()).unwrap_err();
	assert_eq!(e.span.lo as usize, src.len());
	let e = parse_all(b"echo ) x", zf()).unwrap_err();
	assert_eq!(e.span, Span::new(5, 6));
}

#[test]
fn a_syntax_error_ends_the_parse() {
	let mut p = Parser::new(b"echo a\nfi\necho b\n", zf(), &NoAliases);
	assert!(p.next_command().unwrap().is_ok());
	assert!(p.next_command().unwrap().is_err());
	assert!(p.next_command().is_none());
}

// ---- cmdstack (PS2 `%_`)
// ------------------------------------------------------

/// The `%_` names of the constructs open where `src` runs out: the stack
/// of the first event that ran out inside a construct (a here-document
/// cut short still parses), else of the last one.
fn cmdstack(src: &str) -> Vec<&'static str> {
	let mut p = Parser::new(src.as_bytes(), zf(), &NoAliases);
	loop {
		let more = matches!(p.next_command(), Some(Ok(_)));
		let stack = p.zsh_cmdstack().expect("zsh grammar");
		if !more || !stack.is_empty() {
			return stack;
		}
	}
}

/// Expected stacks: the `PS2='%_> '` zsh 5.9 prints after each input is
/// typed into `zsh -f -i` on a pty.
#[test]
fn cmdstack_names_the_constructs_left_open() {
	let cases: &[(&str, &[&str])] = &[
		("if true\n", &["if"]),
		("if true; then\n", &["then"]),
		("if true; then :; else\n", &["else"]),
		("if true; then :; elif false\n", &["elif"]),
		("if true; then :; elif false; then\n", &["elif-then"]),
		("if true; then :; else if false\n", &["else", "if"]),
		("if true {\n", &["if"]),
		("if (\n", &["if", "subsh"]),
		("if [[ a\n", &["if", "cond"]),
		("if true; then echo \"\n", &["then", "dquote"]),
		("if true; then while true; do\n", &["then", "while"]),
		("echo \"\n", &["dquote"]),
		("echo '\n", &["quote"]),
		("echo $'\n", &["quote"]),
		("echo `\n", &["bquote"]),
		("echo \"`\n", &["dquote", "bquote"]),
		("cat <<E\n", &["heredoc"]),
		("cat <<-E\n", &["heredocd"]),
		("cat <<A <<B\nx\nA\n", &["heredoc"]),
		("a &&\n", &["cmdand"]),
		("a ||\n", &["cmdor"]),
		("a && b &&\n", &["cmdand", "cmdand"]),
		("a && b ||\n", &["cmdand", "cmdor"]),
		("if true; then :; fi &&\n", &["cmdand"]),
		("a |\n", &["pipe"]),
		("a | b |\n", &["pipe", "pipe"]),
		("! a |\n", &["pipe"]),
		("a |&\n", &["errpipe"]),
		("for i\n", &["for"]),
		("for i in 1; do echo \"$(\n", &["for", "dquote", "cmdsubst"]),
		("for ((i=0;\n", &["for", "math"]),
		("foreach x (a b)\n", &["foreach"]),
		("select x in a\n", &["select"]),
		("while true\n", &["while"]),
		("while true; do a=(\n", &["while", "array"]),
		("until false\n", &["until"]),
		("repeat 3\n", &["repeat"]),
		("case x in\n", &["case"]),
		("case x in a)\n", &["case"]),
		("f() {\n", &["function"]),
		("f() (\n", &["function", "subsh"]),
		("function f {\n", &["function"]),
		("(\n", &["subsh"]),
		("time (\n", &["subsh"]),
		("{\n", &["cursh"]),
		("coproc {\n", &["cursh"]),
		("{ a } always\n", &["cursh"]),
		("{ a } always {\n", &["always"]),
		("[[ a\n", &["cond"]),
		("((\n", &["math"]),
		("a=(\n", &["array"]),
		("typeset a=(\n", &["array"]),
		("echo $(\n", &["cmdsubst"]),
		("echo <(\n", &["cmdsubst"]),
		("echo $(if true\n", &["cmdsubst", "if"]),
		("echo $(echo \"\n", &["cmdsubst", "dquote"]),
		("x=$(cat <<E\n", &["cmdsubst", "heredoc"]),
		("echo $((\n", &["mathsubst"]),
		("echo \"$((\n", &["dquote", "mathsubst"]),
		("echo $[\n", &["mathsubst"]),
		("echo ${\n", &["braceparam"]),
		("echo ${a[\n", &["braceparam"]),
		("echo ${a:-\"\n", &["braceparam", "dquote"]),
		("echo ${a:-${\n", &["braceparam", "braceparam"]),
		("echo ${a:-{\n", &["braceparam", "brace"]),
		("echo \"${\n", &["dquote", "braceparam"]),
		("echo \"${a:-{\n", &["dquote", "braceparam"]),
		("echo hi\n", &[]),
		("if true; then :; fi\n", &[]),
	];
	for (src, want) in cases {
		assert_eq!(cmdstack(src), *want, "{src:?}");
	}
}

#[test]
fn cmdnames_are_zshs() {
	assert_eq!(zsh::cmdname(zsh::CS_FOR), "for");
	assert_eq!(zsh::cmdname(zsh::CS_ELIFTHEN), "elif-then");
	assert_eq!(zsh::cmdname(zsh::CS_BRACEPAR), "braceparam");
	assert_eq!(zsh::cmdname(zsh::CS_ALWAYS), "always");
	assert_eq!(zsh::cmdname(zsh::CS_COUNT - 1), "always");
	assert!(
		Parser::new(b"if\n", Features::NONE, &NoAliases)
			.zsh_cmdstack()
			.is_none()
	);
}

// ---- aliases ----------------------------------------------------------------

#[derive(Default)]
struct Table {
	reg:      Vec<(&'static [u8], &'static [u8])>,
	global:   Vec<(&'static [u8], &'static [u8])>,
	suffix:   Vec<(&'static [u8], &'static [u8])>,
	disabled: Vec<&'static [u8]>,
}

fn find<'a>(t: &'a [(&'static [u8], &'static [u8])], k: &[u8]) -> Option<&'a [u8]> {
	t.iter().find(|(n, _)| *n == k).map(|(_, v)| *v)
}

impl AliasLookup for Table {
	fn alias(&self, name: &[u8]) -> Option<&[u8]> {
		find(&self.reg, name)
	}

	fn global_alias(&self, name: &[u8]) -> Option<&[u8]> {
		find(&self.global, name)
	}

	fn suffix_alias(&self, suffix: &[u8]) -> Option<&[u8]> {
		find(&self.suffix, suffix)
	}

	fn reserved_disabled(&self, word: &[u8]) -> bool {
		self.disabled.contains(&word)
	}
}

fn alias_words(t: &Table, feat: Features, src: &[u8]) -> Result<Vec<Vec<u8>>, ParseError> {
	let cc = Parser::new(src, feat, t)
		.next_command()
		.expect("a command")?;
	let p = &cc.list.items[0].and_or.first;
	Ok(p
		.stages
		.iter()
		.flat_map(|st| match &st.cmd.kind {
			CommandKind::Simple(s) => s.words.iter().map(|w| zsh_bytes(w).to_vec()).collect(),
			_ => Vec::new(),
		})
		.collect())
}

#[test]
fn regular_global_and_suffix_aliases() {
	let t = Table {
		reg: vec![(b"ll", b"echo -l"), (b"ls", b"ls -F"), (b"a", b"b "), (b"b", b"c")],
		global: vec![(b"G", b"| wc")],
		suffix: vec![(b"txt", b"vim")],
		..Table::default()
	};
	assert_eq!(alias_words(&t, zf(), b"ll x").unwrap(), [
		b"echo".to_vec(),
		vec![DASH, b'l'],
		b"x".to_vec()
	]);
	assert_eq!(
		alias_words(&t, zf(), b"ls").unwrap(),
		[b"ls".to_vec(), vec![DASH, b'F']],
		"no recursion"
	);
	assert_eq!(
		alias_words(&t, zf(), b"a b").unwrap(),
		[b"c".to_vec(), b"c".to_vec()],
		"trailing blank"
	);
	assert_eq!(alias_words(&t, zf(), b"echo a G").unwrap(), [
		b"echo".to_vec(),
		b"a".to_vec(),
		b"wc".to_vec()
	]);
	assert_eq!(alias_words(&t, zf(), b"foo.txt").unwrap(), [b"vim".to_vec(), b"foo.txt".to_vec()]);
	assert_eq!(alias_words(&t, zf(), b"echo ll").unwrap(), [b"echo".to_vec(), b"ll".to_vec()]);
	let cc = Parser::new(b"ll x\n", zf(), &t)
		.next_command()
		.unwrap()
		.unwrap();
	assert_eq!(cc.aliases, [AliasUse { name: b"ll".to_vec(), value: b"echo -l".to_vec() }]);
}

#[test]
fn posix_aliases_leave_reserved_words_alone() {
	let t = Table { reg: vec![(b"if", b"echo")], ..Table::default() };
	assert_eq!(alias_words(&t, zf(), b"if a").unwrap(), [b"echo".to_vec(), b"a".to_vec()]);
	let e = alias_words(&t, zf() | Features::ZSH_POSIX_ALIASES, b"if a").unwrap_err();
	assert_eq!(e.bash_msg(), b"parse error near `a'");
	assert!(alias_words(&t, zf() | Features::ZSH_NO_ALIASES, b"if a").is_err());
}

#[test]
fn function_named_by_an_alias_needs_aliasfuncdef() {
	let t = Table { reg: vec![(b"foo", b"bar")], ..Table::default() };
	let e = Parser::new(b"foo () { x }", zf(), &t)
		.next_command()
		.unwrap()
		.unwrap_err();
	assert_eq!(e.detail().unwrap().bash_msg, b"defining function based on alias `foo'");
	assert_eq!(e.bash_msg(), b"parse error near `()'");
	let cc = Parser::new(b"foo () { x }", zf() | Features::ZSH_ALIAS_FUNC_DEF, &t)
		.next_command()
		.unwrap()
		.unwrap();
	let CommandKind::FuncDef(f) = &cc.list.items[0].and_or.first.stages[0].cmd.kind else {
		panic!()
	};
	assert_eq!(f.name, b"bar");
}

#[test]
fn disabled_reserved_words_are_plain_words() {
	let t = Table { disabled: vec![b"repeat"], ..Table::default() };
	assert_eq!(alias_words(&t, zf(), b"repeat 3 x").unwrap().len(), 3);
}

#[test]
fn alias_text_after_a_newline_resumes_in_a_new_parser() {
	let t = Table { reg: vec![(b"two", b"a\nb ")], ..Table::default() };
	let src = b"two x\n";
	let mut p = Parser::new(src, zf(), &t);
	let first = p.next_command().unwrap().unwrap();
	assert_eq!(first.list.items.len(), 1);
	let resume = p.resume();
	assert_eq!(resume.pending, b"b ");
	let mut q = Parser::new(src, zf(), &t).with_resume(&resume);
	let second = q.next_command().unwrap().unwrap();
	let CommandKind::Simple(s) = &second.list.items[0].and_or.first.stages[0].cmd.kind else {
		panic!()
	};
	assert_eq!(s.words.len(), 2, "b x");
}

// ---- options
// ------------------------------------------------------------------

#[test]
fn short_loops_and_short_repeat() {
	let off = Features::ZSH | Features::ZSH_INTERACTIVE_COMMENTS;
	let e = parse_all(b"for x (a) echo $x", off).unwrap_err();
	assert_eq!(e.bash_msg(), b"parse error near `echo'");
	assert!(parse_all(b"for x (a) echo $x", zf()).is_ok());
	assert!(parse_all(b"repeat 3 echo", off).is_err());
	assert!(parse_all(b"repeat 3 echo", off | Features::ZSH_SHORT_REPEAT).is_ok());
	assert!(parse_all(b"if [[ a ]] b", off).is_err());
	assert!(parse_all(b"if [[ a ]] b", zf()).is_ok());
}

#[test]
fn sh_glob_and_ksh_glob_change_parentheses() {
	assert_eq!(words(b"echo (a|b)")[1], [INPAR, b'a', BAR, b'b', OUTPAR]);
	let e = parse_all(b"echo (a|b)", zf() | Features::ZSH_SH_GLOB).unwrap_err();
	assert_eq!(e.bash_msg(), b"parse error near `('");
	let ksh = zf() | Features::ZSH_SH_GLOB | Features::ZSH_KSH_GLOB;
	let cc = &parse_all(b"echo @(a|b)", ksh).unwrap().commands[0];
	let CommandKind::Simple(s) = &cc.list.items[0].and_or.first.stages[0].cmd.kind else {
		panic!()
	};
	assert_eq!(zsh_bytes(&s.words[1]), [b'@', INPAR, b'a', BAR, b'b', OUTPAR]);
}

#[test]
fn ignore_braces_and_ignore_close_braces() {
	assert_eq!(words(b"echo {a,b}")[1], [INBRACE, b'a', COMMA, b'b', OUTBRACE]);
	let prog = parse_all(b"echo {a,b}", zf() | Features::ZSH_IGNORE_BRACES).unwrap();
	let CommandKind::Simple(s) = &prog.commands[0].list.items[0].and_or.first.stages[0]
		.cmd
		.kind
	else {
		panic!()
	};
	assert_eq!(zsh_bytes(&s.words[1]), b"{a,b}");
	assert!(parse_all(b"{ echo a }", zf()).is_ok());
	let e = parse_all(b"{ echo a }", zf() | Features::ZSH_IGNORE_CLOSE_BRACES).unwrap_err();
	assert!(e.span.lo >= 10);
}

#[test]
fn rc_quotes_and_csh_junkie_quotes() {
	assert_eq!(words(b"echo 'it''s'")[1], [SNULL, b'i', b't', SNULL, SNULL, b's', SNULL]);
	let prog = parse_all(b"echo 'it''s'", zf() | Features::ZSH_RC_QUOTES).unwrap();
	let CommandKind::Simple(s) = &prog.commands[0].list.items[0].and_or.first.stages[0]
		.cmd
		.kind
	else {
		panic!()
	};
	assert_eq!(zsh_bytes(&s.words[1]), [SNULL, b'i', b't', b'\'', b's', SNULL]);
	assert!(parse_all(b"echo 'a\nb'", zf()).is_ok());
	let e = parse_all(b"echo 'a\nb'", zf() | Features::ZSH_CSH_JUNKIE_QUOTES).unwrap_err();
	assert_eq!(e.bash_msg(), b"unmatched '");
}

#[test]
fn csh_junkie_loops_multifuncdef_and_comments() {
	assert!(parse_all(b"while false; echo; end", zf()).is_err());
	assert!(parse_all(b"while false; echo; end", zf() | Features::ZSH_CSH_JUNKIE_LOOPS).is_ok());
	let no_multi = Features::ZSH | Features::ZSH_SHORT_LOOPS;
	let e = parse_all(b"f g () { a }", no_multi).unwrap_err();
	assert_eq!(e.bash_msg(), b"parse error near `()'");
	assert_eq!(words(b"echo a # b").len(), 2);
	let prog = parse_all(b"echo a # b", Features::ZSH).unwrap();
	let CommandKind::Simple(s) = &prog.commands[0].list.items[0].and_or.first.stages[0]
		.cmd
		.kind
	else {
		panic!()
	};
	assert_eq!(s.words.len(), 4, "`#` is a word without interactivecomments");
}

// ---- functions text ---------------------------------------------------------

fn funcdef(src: &[u8]) -> FuncDef {
	match first_cmd(src).kind {
		CommandKind::FuncDef(f) => f,
		other => panic!("not a function: {other:?}"),
	}
}

#[test]
fn functions_text_matches_zsh_and_is_a_fixpoint() {
	let data = include_str!("data/zsh_text.txt");
	for rec in data.split('\x1e') {
		let (src, want) = rec.split_once('\x1f').expect("two fields");
		let f = funcdef(src.as_bytes());
		let got = function_text(b"f", &f);
		assert_eq!(String::from_utf8_lossy(&got), want, "{src:?}");
		// zsh prints case alternatives `d|e)` as `(d | e)`, which parses
		// back as one pattern `(d|e)`: the text is stable from the second
		// print on, with the same meaning.
		let again = function_text(b"f", &funcdef(&got));
		if !got.windows(3).any(|w| w == b" | ") || !src.contains("case") {
			assert_eq!(again, got, "fixpoint of {src:?}");
		}
		let third = function_text(b"f", &funcdef(&again));
		assert_eq!(third, again, "fixpoint of {src:?}");
	}
}

#[test]
fn reindented_function_text_expands_only_zsh_indentation() {
	let src = "f () {\n\tif a\n\tthen\n\t\techo 'x\n\ty'\n\tfi\n}";
	let got = reindent_function(b"g", src.as_bytes(), 2).expect("a function");
	assert_eq!(String::from_utf8_lossy(&got), "g () {\n  if a\n  then\n    echo 'x\n\ty'\n  fi\n}");
	let flat = reindent_function(b"g", src.as_bytes(), -1).expect("a function");
	assert_eq!(String::from_utf8_lossy(&flat), "g () {\nif a\nthen\necho 'x\n\ty'\nfi\n}");
	assert_eq!(reindent_function(b"g", b"echo a", 2), None);
}

#[test]
fn function_names_with_specials_are_quoted() {
	let f = funcdef(b"f() { a }");
	assert!(function_text(b"a b", &f).starts_with(b"'a b' () {"));
	assert!(function_text(b"it's", &f).starts_with(b"'it'\\''s' () {"));
}

// ---- corpus -----------------------------------------------------------------

#[test]
fn every_ztst_chunk_parses_as_zsh_parses_it() {
	let data = include_bytes!("data/zsh_corpus.txt");
	let mut bad = Vec::new();
	for rec in data.split(|&c| c == 0x1e) {
		let f: Vec<&[u8]> = rec.splitn(5, |&c| c == 0x1f).collect();
		let [file, line, verdict, msg, code] = f[..] else {
			panic!("five fields")
		};
		let rejects = verdict == b"1";
		match parse_all(code, zf()) {
			Ok(_) if rejects => bad.push(format!(
				"{}:{} zsh rejects ({}), we accept",
				String::from_utf8_lossy(file),
				String::from_utf8_lossy(line),
				String::from_utf8_lossy(msg)
			)),
			Err(e) if !rejects => bad.push(format!(
				"{}:{} zsh accepts, we reject: {e}",
				String::from_utf8_lossy(file),
				String::from_utf8_lossy(line)
			)),
			_ => {},
		}
	}
	assert!(bad.is_empty(), "{} chunks differ:\n{}", bad.len(), bad.join("\n"));
}
