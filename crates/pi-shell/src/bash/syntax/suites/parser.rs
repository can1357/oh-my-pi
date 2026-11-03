//! Parser and printer behaviour: bash 5.3 error messages, `NodeId` determinism,
//! incremental resume, and print → parse fixpoints.

use crate::bash::syntax::*;

fn first_cmd(src: &[u8]) -> Command {
	let prog = parse_all(src, Features::NONE).expect("parses");
	prog.commands[0].list.items[0].and_or.first.stages[0]
		.cmd
		.clone()
}

fn err(src: &[u8]) -> ParseError {
	parse_all(src, Features::NONE).expect_err("syntax error")
}

#[track_caller]
fn assert_err(src: &[u8], line: u32, msg: &str) {
	let e = err(src);
	assert_eq!(
		String::from_utf8_lossy(&e.bash_msg()),
		msg,
		"message for {:?}",
		String::from_utf8_lossy(src)
	);
	assert_eq!(e.line, line, "line for {:?}", String::from_utf8_lossy(src));
}

// Goldens below were produced by /opt/homebrew/bin/bash 5.3.20 with `bash -c`.
#[test]
fn syntax_errors_match_bash_messages_and_lines() {
	assert_err(b"echo a; fi", 1, "syntax error near unexpected token `fi'");
	assert_err(
		b"if true; then",
		2,
		"syntax error: unexpected end of file from `if' command on line 1",
	);
	assert_err(
		b"echo x\nfoo\nif\n",
		4,
		"syntax error: unexpected end of file from `if' command on line 3",
	);
	assert_err(b"while; do :; done", 1, "syntax error near unexpected token `;'");
	assert_err(b"echo a;;", 1, "syntax error near unexpected token `;;'");
	assert_err(b"if true; then fi", 1, "syntax error near unexpected token `fi'");
	assert_err(b"&& echo", 1, "syntax error near unexpected token `&&'");
	assert_err(b"echo a &&", 2, "syntax error: unexpected end of file");
	assert_err(b"echo \"abc", 1, "unexpected EOF while looking for matching `\"'");
	assert_err(b"echo 'abc", 1, "unexpected EOF while looking for matching `''");
	assert_err(b"echo x\necho \"a\nb\nc", 2, "unexpected EOF while looking for matching `\"'");
	assert_err(b"echo 'a\nb\nc\n\n", 1, "unexpected EOF while looking for matching `''");
	assert_err(b"echo a\nfor x in 1; echo; done", 2, "syntax error near unexpected token `echo'");
}

#[test]
fn token_errors_echo_the_line_but_eof_errors_do_not() {
	assert!(err(b"echo a; fi").echoes_line());
	assert!(!err(b"if true; then").echoes_line());
	assert!(!err(b"echo \"abc").echoes_line());
}

#[test]
fn former_p0_unsupported_constructs_now_parse() {
	for src in [&b"echo $(date)"[..], b"a | b", b"sleep 1 &", b"echo > f", b"( true )", b"echo `x`"]
	{
		assert!(parse_all(src, Features::NONE).is_ok(), "{:?}", String::from_utf8_lossy(src));
	}
}

#[test]
fn zsh_features_select_the_zsh_grammar() {
	let prog = parse_all(b"echo ${(f)x}", Features::ZSH).expect("zsh grammar");
	let CommandKind::Simple(s) = &prog.commands[0].list.items[0].and_or.first.stages[0]
		.cmd
		.kind
	else {
		panic!("a simple command");
	};
	assert!(matches!(&s.words[1].parts[..], [WordPart::Zsh(_)]));
}

#[test]
fn a_parse_error_ends_the_source() {
	let src = b"echo a\necho b; fi\necho c\n";
	let mut p = Parser::new(src, Features::NONE, &NoAliases);
	assert!(p.next_command().unwrap().is_ok());
	assert!(p.next_command().unwrap().is_err());
	assert!(p.next_command().is_none(), "bash abandons the script after a syntax error");
}

/// Ids in the documented preorder (crate docs, "Node ids").
fn collect_ids(list: &List, out: &mut Vec<u32>) {
	for item in &list.items {
		out.push(item.and_or.id.0);
		for p in std::iter::once(&item.and_or.first).chain(item.and_or.rest.iter().map(|(_, p)| p)) {
			out.push(p.id.0);
			for st in &p.stages {
				collect_cmd(&st.cmd, out);
			}
		}
	}
}

fn collect_cmd(cmd: &Command, out: &mut Vec<u32>) {
	out.push(cmd.id.0);
	match &cmd.kind {
		CommandKind::Simple(s) => {
			for a in &s.assigns {
				out.push(a.id.0);
				if let Some(i) = &a.index {
					collect_word(i, out);
				}
				match &a.value {
					AssignValue::Scalar(w) => collect_word(w, out),
					AssignValue::Array(elems) => collect_elems(elems, out),
				}
			}
			for w in &s.words {
				collect_word(w, out);
			}
		},
		CommandKind::If(i) => {
			for arm in &i.arms {
				collect_ids(&arm.cond, out);
				collect_ids(&arm.body, out);
			}
			if let Some(e) = &i.else_body {
				collect_ids(e, out);
			}
		},
		CommandKind::While(w) => {
			collect_ids(&w.cond, out);
			collect_ids(&w.body, out);
		},
		CommandKind::For(f) | CommandKind::Select(f) => {
			for w in f.words.iter().flatten() {
				collect_word(w, out);
			}
			collect_ids(&f.body, out);
		},
		CommandKind::ArithFor(f) => collect_ids(&f.body, out),
		CommandKind::Case(c) => {
			collect_word(&c.word, out);
			for arm in &c.arms {
				for p in &arm.patterns {
					collect_word(p, out);
				}
				collect_ids(&arm.body, out);
			}
		},
		CommandKind::Brace(l) | CommandKind::Subshell(l) => collect_ids(l, out),
		CommandKind::Arith(_) => {},
		CommandKind::Cond(e) => collect_cond(e, out),
		CommandKind::FuncDef(f) => collect_cmd(&f.body, out),
		CommandKind::Coproc(c) => collect_cmd(&c.body, out),
		CommandKind::Repeat(r) => {
			collect_word(&r.count, out);
			collect_ids(&r.body, out);
		},
		CommandKind::Try(t) => {
			collect_ids(&t.body, out);
			collect_ids(&t.always, out);
		},
		CommandKind::AnonFunc(a) => {
			collect_cmd(&a.body, out);
			for w in &a.args {
				collect_word(w, out);
			}
		},
	}
	for r in &cmd.redirs {
		if let RedirTarget::Word(w) = &r.target {
			collect_word(w, out);
		}
	}
}

fn collect_cond(e: &CondExpr, out: &mut Vec<u32>) {
	match e {
		CondExpr::Unary { arg, .. } => collect_word(arg, out),
		CondExpr::Binary { lhs, rhs, .. } => {
			collect_word(lhs, out);
			collect_word(rhs, out);
		},
		CondExpr::Word(w) => collect_word(w, out),
		CondExpr::Not(x) | CondExpr::Group(x) => collect_cond(x, out),
		CondExpr::And(a, b) | CondExpr::Or(a, b) => {
			collect_cond(a, out);
			collect_cond(b, out);
		},
	}
}

fn collect_elems(elems: &[ArrayElem], out: &mut Vec<u32>) {
	for e in elems {
		if let Some(k) = &e.key {
			collect_word(k, out);
		}
		collect_word(&e.value, out);
	}
}

fn collect_word(w: &Word, out: &mut Vec<u32>) {
	out.push(w.id.0);
	collect_parts(&w.parts, out);
}

fn collect_parts(parts: &[WordPart], out: &mut Vec<u32>) {
	for p in parts {
		match p {
			WordPart::DQuote(inner) | WordPart::Locale(inner) => collect_parts(inner, out),
			WordPart::Param(p) => {
				if let Some(Subscript::Expr(w)) = &p.index {
					collect_word(w, out);
				}
				match &p.op {
					ParamOp::Default { word, .. }
					| ParamOp::Assign { word, .. }
					| ParamOp::Alt { word, .. } => {
						collect_word(word, out);
					},
					ParamOp::Error { word: Some(w), .. } | ParamOp::Trim { pat: w, .. } => {
						collect_word(w, out);
					},
					ParamOp::Replace { pat, rep, .. } => {
						collect_word(pat, out);
						if let Some(r) = rep {
							collect_word(r, out);
						}
					},
					ParamOp::Case { pat: Some(w), .. } => collect_word(w, out),
					_ => {},
				}
			},
			WordPart::Comsub(c) => collect_ids(&c.body, out),
			WordPart::ProcSub(p) => collect_ids(&p.body, out),
			WordPart::Compound(elems) => collect_elems(elems, out),
			_ => {},
		}
	}
}

#[test]
fn node_ids_are_a_dense_preorder_per_unit() {
	let src = b"x=1 y=2 echo a b && { if true; then echo c; fi; }; for i in 1 2; do while false; do :; done; done\necho z\n\
		a[$i]=(1 [k]=${v:-$(w | x)}) cmd \"${y/p/r}\" <(z) >f 2>&1 <<E\nbody $q\nE\n\
		case $c in a|b) [[ -n $d && $e == f* ]];; esac; f() { (( n++ )); coproc g { h; }; }\n";
	let prog = parse_all(src, Features::NONE).unwrap();
	for unit in &prog.commands {
		let mut ids = Vec::new();
		collect_ids(&unit.list, &mut ids);
		let expected: Vec<u32> = (0..unit.node_count).collect();
		assert_eq!(ids, expected, "preorder visit order equals id order, ids restart per unit");
	}
}

#[test]
fn reparsing_unit_bytes_reproduces_ids_and_tree() {
	let src = b"# comment\n\n  for i in 1 2; do echo $i; done; echo \"q $x\"\nif a; then b; fi\n";
	let prog = parse_all(src, Features::NONE).unwrap();
	assert_eq!(prog.commands.len(), 2);
	for unit in &prog.commands {
		let bytes = unit.span.slice(src);
		let again = parse_all(bytes, Features::NONE).unwrap();
		assert_eq!(again.commands.len(), 1);
		assert_eq!(again.commands[0].node_count, unit.node_count);
		assert_eq!(
			print_list(&again.commands[0].list, PrintStyle::Compact),
			print_list(&unit.list, PrintStyle::Compact)
		);
	}
	assert_eq!(prog.commands[0].line, 3);
	assert_eq!(prog.commands[1].line, 4);
}

#[test]
fn resume_continues_with_the_next_top_level_command() {
	let src = b"echo a; echo b\n\nif x\nthen y\nfi\necho c";
	let mut p = Parser::new(src, Features::NONE, &NoAliases);
	let first = p.next_command().unwrap().unwrap();
	assert_eq!(first.list.items.len(), 2);
	let pos = p.pos();
	assert_eq!(pos.line, 2);
	let mut q = Parser::new(src, Features::NONE, &NoAliases).with_pos(pos);
	let second = q.next_command().unwrap().unwrap();
	assert_eq!(second.line, 3);
	assert_eq!(q.pos().line, 6);
	let third = q.next_command().unwrap().unwrap();
	assert_eq!(third.span.slice(src), b"echo c");
	assert!(q.next_command().is_none());
}

#[test]
fn words_keep_quoting_structure() {
	let cmd = first_cmd(b"a=1 b+=x echo \"p $v ${w} \\$\" 'q' \\r $1 ${10} $? x=y");
	let CommandKind::Simple(s) = cmd.kind else {
		panic!()
	};
	assert_eq!(s.assigns.len(), 2);
	assert!(s.assigns[1].append);
	assert_eq!(s.words.len(), 8, "x=y after the command word is an argument");
	assert_eq!(s.words[1].parts.len(), 1);
	let WordPart::DQuote(inner) = &s.words[1].parts[0] else {
		panic!()
	};
	assert_eq!(inner.len(), 6);
	assert!(
		matches!(&s.words[4].parts[0], WordPart::Param(p) if p.name == ParamName::Positional(1))
	);
	assert!(
		matches!(&s.words[5].parts[0], WordPart::Param(p) if p.name == ParamName::Positional(10))
	);
	assert!(
		matches!(&s.words[6].parts[0], WordPart::Param(p) if p.name == ParamName::Special(Special::Status))
	);
}

#[test]
fn reserved_words_only_in_command_position() {
	let cmd = first_cmd(b"echo if then fi done {");
	let CommandKind::Simple(s) = cmd.kind else {
		panic!()
	};
	assert_eq!(s.words.len(), 6);
	assert!(matches!(first_cmd(b"{ echo; }").kind, CommandKind::Brace(_)));
	assert!(matches!(first_cmd(b"{echo").kind, CommandKind::Simple(_)), "`{{echo` is a word");
	assert_eq!(err(b"{echo; }").bash_msg(), b"syntax error near unexpected token `}'");
}

#[test]
fn for_without_in_means_positional_parameters() {
	let CommandKind::For(f) = first_cmd(b"for j; do :; done").kind else {
		panic!()
	};
	assert!(f.words.is_none());
	let CommandKind::For(f) = first_cmd(b"for j\nin a b\ndo :; done").kind else {
		panic!()
	};
	assert_eq!(f.words.unwrap().len(), 2);
	let CommandKind::For(f) = first_cmd(b"for i in; do :; done").kind else {
		panic!()
	};
	assert_eq!(f.words.unwrap().len(), 0);
}

// Goldens: `declare -f f` from bash 5.3.20, with the function's indentation
// removed.
#[test]
fn declare_f_layout_of_loops_and_if() {
	let cases: [(&[u8], &str); 4] = [
		(
			b"if true; then echo a; elif false; then :; else echo b; fi",
			"if true; then\n    echo a;\nelse\n    if false; then\n        :;\n    else\n        \
			 echo b;\n    fi;\nfi",
		),
		(b"for i in 1 2; do echo $i; done", "for i in 1 2;\ndo\n    echo $i;\ndone"),
		(b"for j; do :; done", "for j in \"$@\";\ndo\n    :;\ndone"),
		(b"while false; do :; done", "while false; do\n    :;\ndone"),
	];
	for (src, want) in cases {
		assert_eq!(String::from_utf8(print(&first_cmd(src), PrintStyle::DeclareF)).unwrap(), want);
	}
	assert_eq!(
		String::from_utf8(print(&first_cmd(b"{ echo g; }"), PrintStyle::DeclareF)).unwrap(),
		"{ \n    echo g\n}"
	);
}

#[test]
fn compact_print_is_a_parse_fixpoint() {
	let srcs: [&[u8]; 5] = [
		b"a=1 echo \"x $y\" 'q' ${z} && ! true || false",
		b"if a; then b; elif c; then d; else e; fi",
		b"for i in 1 2; do echo $i; done",
		b"until x; do { y; z; }; done",
		b"echo \\$a\\ b",
	];
	for src in srcs {
		let once =
			print_list(&parse_all(src, Features::NONE).unwrap().commands[0].list, PrintStyle::Compact);
		let twice = print_list(
			&parse_all(&once, Features::NONE).unwrap().commands[0].list,
			PrintStyle::Compact,
		);
		assert_eq!(String::from_utf8_lossy(&once), String::from_utf8_lossy(&twice));
		assert_eq!(once, src, "compact form of canonical input is the input");
	}
}

fn simple(cmd: &Command) -> &Simple {
	match &cmd.kind {
		CommandKind::Simple(s) => s,
		other => panic!("not a simple command: {other:?}"),
	}
}

fn heredoc(cmd: &Command, i: usize) -> &HereDoc {
	match &cmd.redirs[i].target {
		RedirTarget::HereDoc(d) => d,
		other => panic!("not a here-document: {other:?}"),
	}
}

#[test]
fn here_documents_keep_bash_text() {
	let cmd = first_cmd(b"cat <<A <<-'B' <<\"C\"\nx $y \\\nz\nA\n\t\tb\n\tB\nc\nC\n");
	let a = heredoc(&cmd, 0);
	assert_eq!((&a.delim[..], a.quoted, &a.text[..]), (&b"A"[..], false, &b"x $y z\n"[..]));
	let b = heredoc(&cmd, 1);
	assert_eq!(
		(&b.delim[..], &b.delim_raw[..], b.quoted, &b.text[..]),
		(&b"B"[..], &b"'B'"[..], true, &b"b\n"[..])
	);
	let c = heredoc(&cmd, 2);
	assert_eq!((&c.delim[..], c.quoted, &c.text[..]), (&b"C"[..], true, &b"c\n"[..]));
}

#[test]
fn here_document_at_end_of_input_warns_like_bash() {
	// comsub-eof2.sub: `line 2: warning: here-document at line 1 delimited
	// by end-of-file (wanted `EOF')`.
	let prog = parse_all(b"cat <<EOF\nhi\n", Features::NONE).unwrap();
	let w = &prog.commands[0].warnings;
	assert_eq!(w.len(), 1);
	assert_eq!(w[0].line, 2);
	assert_eq!(
		w[0].bash_msg,
		b"warning: here-document at line 1 delimited by end-of-file (wanted `EOF')"
	);
}

#[test]
fn comsub_here_document_ends_at_the_closing_paren() {
	// comsub-eof0.sub
	let src = b"# x\nfoo=$(cat <<EOF\nhi\nEOF)\necho $foo\n";
	let prog = parse_all(src, Features::NONE).unwrap();
	assert_eq!(prog.commands.len(), 2);
	let w = &prog.commands[0].warnings;
	assert_eq!(w[0].line, 4);
	assert!(
		w[0]
			.bash_msg
			.starts_with(b"warning: here-document at line 2 ")
	);
	// comsub-eof3.sub: the document swallows `)`; the comsub never closes.
	let e = parse_all(b"foo=$(cat <<EOF\nhi\n)\necho $foo\n", Features::NONE).unwrap_err();
	assert_eq!(
		(e.line, &e.bash_msg()[..]),
		(5, &b"unexpected EOF while looking for matching `)'"[..])
	);
	assert_eq!(e.warnings[0].line, 4);
}

#[test]
fn unterminated_here_document_in_comsub_reads_the_following_lines() {
	// heredoc7.sub
	let src = b"echo $(cat << EOF)\nfoo\nbar\nEOF\nafter\n";
	let prog = parse_all(src, Features::NONE).unwrap();
	assert_eq!(prog.commands.len(), 2);
	let w = &prog.commands[0].warnings;
	assert_eq!(
		(w[0].line, &w[0].bash_msg[..]),
		(1, &b"warning: command substitution: 1 unterminated here-document"[..])
	);
	assert_eq!(prog.commands[1].line, 5);
	assert_eq!(
		simple(&prog.commands[1].list.items[0].and_or.first.stages[0].cmd)
			.words
			.len(),
		1
	);
}

#[test]
fn comsub_bodies_are_parsed_and_reprinted() {
	let cmd = first_cmd(b"echo $(case x in a) b;; esac) ${ a;} ${|b;} `c  d`");
	let s = simple(&cmd);
	let texts: Vec<Vec<u8>> = s.words[1..]
		.iter()
		.map(|w| match &w.parts[0] {
			WordPart::Comsub(c) => c.text.clone(),
			other => panic!("{other:?}"),
		})
		.collect();
	assert_eq!(texts[0], b"case x in a)\n        b\n    ;;\nesac");
	assert_eq!(texts[1], b" a; ");
	assert_eq!(texts[2], b"|b; ");
	assert_eq!(texts[3], b"c  d");
	let WordPart::Comsub(c) = &s.words[1].parts[0] else {
		unreachable!()
	};
	assert!(matches!(c.body.items[0].and_or.first.stages[0].cmd.kind, CommandKind::Case(_)));
}

#[test]
fn pipelines_bang_time_and_async_lists() {
	let prog = parse_all(b"! ! a | b |& c; time -p ! d & e", Features::NONE).unwrap();
	let items = &prog.commands[0].list.items;
	let p = &items[0].and_or.first;
	assert!(!p.bang, "`! !` cancels");
	assert_eq!(p.stages.len(), 3);
	assert!(p.stages[1].pipe_stderr && !p.stages[0].pipe_stderr);
	let q = &items[1].and_or.first;
	assert_eq!(q.time, Some(Time { posix: true }));
	assert!(q.bang);
	assert_eq!(items[1].sep, Sep::Amp);
}

#[test]
fn redirections_follow_bash_number_and_word_rules() {
	let cmd = first_cmd(b"cmd 2>f 3<&- {v}>&1 >&2 <&$x &>g 4<>h 12>>i a2>j");
	let r = &cmd.redirs;
	assert_eq!((r[0].fd.clone(), r[0].op), (Some(RedirFd::Num(2)), RedirOp::Out));
	assert_eq!((r[1].fd.clone(), r[1].op), (Some(RedirFd::Num(3)), RedirOp::DupIn));
	assert_eq!(r[2].fd, Some(RedirFd::Var(b"v".to_vec())));
	assert_eq!((r[3].fd.clone(), r[3].op), (None, RedirOp::DupOut));
	assert_eq!(r[5].op, RedirOp::OutErr);
	assert_eq!(r[6].op, RedirOp::ReadWrite);
	assert_eq!(r[7].fd, Some(RedirFd::Num(12)));
	// `a2>j`: `a2` is a word, not a file descriptor.
	assert_eq!(simple(&cmd).words.len(), 2);
	assert_eq!(r[8].fd, None);
}

#[test]
fn assignments_arrays_and_declaration_arguments() {
	let cmd = first_cmd(b"a[i+1]+=x b=(1 [k]=v [j]+=w) declare -a c=(2 3) d=e");
	let s = simple(&cmd);
	assert_eq!(s.assigns.len(), 2);
	assert!(s.assigns[0].append && s.assigns[0].index.is_some());
	let AssignValue::Array(elems) = &s.assigns[1].value else {
		panic!()
	};
	assert_eq!(elems.len(), 3);
	assert!(elems[1].key.is_some() && !elems[1].append);
	assert!(elems[2].append);
	assert!(matches!(s.words[2].parts[..], [WordPart::Lit(_), WordPart::Compound(_)]));
	assert!(matches!(s.words[3].parts[..], [WordPart::Lit(_)]));
}

#[test]
fn reserved_words_in_case_patterns() {
	// posix2syntax.sub
	let CommandKind::Case(c) = first_cmd(b"case in in in) echo in; esac").kind else {
		panic!()
	};
	assert_eq!(c.arms.len(), 1);
	let CommandKind::Case(c) = first_cmd(b"case x in (esac) a;; esac").kind else {
		panic!()
	};
	assert_eq!(c.arms[0].patterns.len(), 1);
	assert_eq!(
		err(b"case x in esac) echo done; esac").bash_msg(),
		b"syntax error near unexpected token `)'"
	);
}

#[test]
fn functions_coprocs_and_conditionals() {
	let CommandKind::FuncDef(f) = first_cmd(b"function g { :; } >f").kind else {
		panic!()
	};
	assert!(f.keyword);
	assert_eq!(f.body.redirs.len(), 1);
	let CommandKind::Coproc(c) = first_cmd(b"coproc N { a; }").kind else {
		panic!()
	};
	assert_eq!(c.name.as_deref(), Some(&b"N"[..]));
	let CommandKind::Coproc(c) = first_cmd(b"coproc a b").kind else {
		panic!()
	};
	assert_eq!(c.name, None);
	let CommandKind::Cond(e) = first_cmd(b"[[ ! a == b* && ( -f x || $y =~ ^(a|b)$ ) ]]").kind
	else {
		panic!()
	};
	assert!(matches!(e, CondExpr::And(..)));
}

#[test]
fn extglob_groups_are_one_word_only_with_extglob() {
	let prog = parse_all(b"echo @(a|b) !(x)", Features::EXTGLOB).unwrap();
	let s = simple(&prog.commands[0].list.items[0].and_or.first.stages[0].cmd);
	assert_eq!(s.words.len(), 3);
	assert!(parse_all(b"echo @(a|b)", Features::NONE).is_err());
	// `[[ … == pat ]]` turns extglob on for the pattern.
	assert!(parse_all(b"[[ x == @(a|b) ]]", Features::NONE).is_ok());
}

#[test]
fn bad_substitutions_parse_and_keep_their_text() {
	let s = first_cmd(b"echo ${a b} ${x@}");
	let s = simple(&s);
	assert_eq!(s.words[1].parts, vec![WordPart::BadSubst(b"${a b}".to_vec())]);
	assert_eq!(s.words[2].parts, vec![WordPart::BadSubst(b"${x@}".to_vec())]);
}

#[test]
fn indirect_expansion_with_an_operator() {
	let s = first_cmd(b"echo ${!x:-d} ${!x} ${!a[@]} ${!p*}");
	let s = simple(&s);
	let p = |i: usize| match &s.words[i].parts[0] {
		WordPart::Param(p) => p.clone(),
		other => panic!("{other:?}"),
	};
	assert!(p(1).indirect && matches!(p(1).op, ParamOp::Default { colon: true, .. }));
	assert!(!p(2).indirect && p(2).op == ParamOp::Indirect);
	assert_eq!(p(3).index, Some(Subscript::At));
	assert_eq!(p(4).op, ParamOp::PrefixNames { star: true });
}

struct One(&'static [u8], &'static [u8]);

impl AliasLookup for One {
	fn alias(&self, name: &[u8]) -> Option<&[u8]> {
		(name == self.0).then_some(self.1)
	}
}

#[test]
fn alias_text_after_a_newline_resumes_in_a_new_parser() {
	// alias6.sub: `alias a='unalias -a<NL>v=2'; eval a` runs `unalias -a`
	// before `v=2` is parsed.
	let src = b"a\necho end\n";
	let table = One(b"a", b"unalias -a\nv=2");
	let mut p = Parser::new(src, Features::NONE, &table);
	let first = p.next_command().unwrap().unwrap();
	assert_eq!(first.aliases.len(), 1);
	let resume = p.resume();
	assert_eq!(resume.pending, b"v=2 ");
	let mut q = Parser::new(src, Features::NONE, &NoAliases).with_resume(&resume);
	let second = q.next_command().unwrap().unwrap();
	assert_eq!(print_list(&second.list, PrintStyle::Compact), b"v=2");
	let third = q.next_command().unwrap().unwrap();
	assert_eq!(print_list(&third.list, PrintStyle::Compact), b"echo end");
}

#[test]
fn recursive_aliases_stop_at_the_alias_being_expanded() {
	let table = One(b"ls", b"ls -l");
	let mut p = Parser::new(b"ls x\n", Features::NONE, &table);
	let cc = p.next_command().unwrap().unwrap();
	assert_eq!(print_list(&cc.list, PrintStyle::Compact), b"ls -l x");
}

#[test]
fn parse_text_reads_expansions_in_each_mode() {
	let w = parse_text(b"a $b \"c\" $((1+2)) \\$", Features::NONE, TextMode::DoubleQuote).unwrap();
	assert_eq!(w.id, NodeId(0));
	assert!(w.parts.iter().any(|p| matches!(p, WordPart::Param(_))));
	assert!(w.parts.iter().any(|p| matches!(p, WordPart::Arith(_))));
	assert!(w.parts.contains(&WordPart::Escaped(b"$".to_vec())));
	let h = parse_text(b"x \\\" $(y)\n", Features::NONE, TextMode::HereDoc).unwrap();
	assert!(!h.parts.iter().any(|p| matches!(p, WordPart::Escaped(_))), "`\\\"` stays literal");
	let a = parse_text(b"\"1\" + $x", Features::NONE, TextMode::Arith).unwrap();
	assert!(!a.parts.iter().any(|p| matches!(p, WordPart::DQuote(_))));
	// comsub-eof6.sub: the error surfaces when the document is expanded.
	let e = parse_text(b"$(seq 10\n", Features::NONE, TextMode::HereDoc).unwrap_err();
	assert_eq!(e.bash_msg(), b"unexpected EOF while looking for matching `)'");
	assert_eq!(e.line, 2);
}

#[test]
fn arithmetic_for_with_two_clauses_is_an_error_after_the_body() {
	let e = err(b"for ((a;b)) do :; done");
	assert_eq!(e.bash_msg(), b"syntax error: `((a;b))'");
	assert_eq!(e.detail().unwrap().bash_msg, b"syntax error: arithmetic expression required");
}

#[test]
fn conditional_errors_carry_bash_detail_lines() {
	let e = err(b"[[ a b ]]");
	assert_eq!(e.bash_msg(), b"syntax error near `b'");
	assert_eq!(
		e.detail().unwrap().bash_msg,
		b"unexpected token `b', conditional binary operator expected"
	);
}

/// Parse `src` one command per parser, as the engine does, resuming each
/// parser where the previous one stopped (alias text included).
fn commands_one_parser_each(src: &[u8], aliases: &dyn AliasLookup) -> Vec<CompleteCommand> {
	let mut resume = Resume::default();
	let mut out = Vec::new();
	loop {
		let mut p = Parser::new(src, Features::NONE, aliases).with_resume(&resume);
		let Some(cc) = p.next_command() else { break };
		out.push(cc.expect("parses"));
		let next = p.resume();
		drop(p);
		resume = next;
	}
	out
}

#[test]
fn multi_line_alias_text_advances_across_parsers() {
	// alias2.sub / alias5.sub
	let table = One(b"foo2", b"echo one\nsource two\nsource three\necho four");
	let units = commands_one_parser_each(b"foo2\necho end\n", &table);
	let printed: Vec<Vec<u8>> = units
		.iter()
		.map(|cc| print_list(&cc.list, PrintStyle::Compact))
		.collect();
	assert_eq!(printed, [
		&b"echo one"[..],
		b"source two",
		b"source three",
		b"echo four",
		b"echo end"
	]);
	// alias4.sub: an assignment read from the resumed text is an assignment.
	let table = One(b"a", b"unalias -a\nv=2");
	let units = commands_one_parser_each(b"a\n", &table);
	assert_eq!(units.len(), 2);
	let CommandKind::Simple(s) = &units[1].list.items[0].and_or.first.stages[0].cmd.kind else {
		panic!()
	};
	assert_eq!((s.assigns.len(), s.words.len()), (1, 0));
}

#[test]
fn here_documents_read_through_alias_text_without_the_end_space() {
	// heredoc10.sub: the alias holds the whole document …
	let table = One(b"heredoc", b"cat <<EOF\nhello\nworld\nEOF");
	let prog = commands_one_parser_each(b"heredoc\necho after\n", &table);
	assert_eq!(
		heredoc(&prog[0].list.items[0].and_or.first.stages[0].cmd, 0).text,
		b"hello\nworld\n"
	);
	assert_eq!(print_list(&prog[1].list, PrintStyle::Compact), b"echo after");
	// … or starts it, and the body continues in the source.
	let table = One(b"headplus", b"cat <<EOF\nhello");
	let prog = commands_one_parser_each(b"headplus\nworld\nEOF\necho after\n", &table);
	assert_eq!(
		heredoc(&prog[0].list.items[0].and_or.first.stages[0].cmd, 0).text,
		b"hello\nworld\n"
	);
	assert_eq!(print_list(&prog[1].list, PrintStyle::Compact), b"echo after");
	// … or ends with the operator, and the body is in the source.
	let table = One(b"head", b"cat <<END");
	let prog = commands_one_parser_each(b"head\nline 1\nEND\n", &table);
	assert_eq!(heredoc(&prog[0].list.items[0].and_or.first.stages[0].cmd, 0).text, b"line 1\n");
}

fn param_word(src: &[u8], feat: Features) -> Word {
	let prog = parse_all(src, feat).expect("parses");
	let CommandKind::Simple(s) = &prog.commands[0].list.items[0].and_or.first.stages[0]
		.cmd
		.kind
	else {
		panic!()
	};
	s.words[1].clone()
}

fn first_param(w: &Word) -> Param {
	let WordPart::DQuote(inner) = &w.parts[0] else {
		panic!("{w:?}")
	};
	inner
		.iter()
		.find_map(|p| match p {
			WordPart::Param(p) => Some((**p).clone()),
			_ => None,
		})
		.expect("a parameter")
}

#[test]
fn single_quotes_in_double_quoted_non_pattern_operators_are_literal() {
	// rhs-exp / quote1: `"${foo+'$foo'}"` expands $foo between literal quotes.
	let w = param_word(b"echo \"${foo+'$foo'}\"\n", Features::NONE);
	let ParamOp::Alt { word, .. } = first_param(&w).op else {
		panic!()
	};
	assert_eq!(word.parts.len(), 3, "{:?}", word.parts);
	assert_eq!(word.parts[0], WordPart::Lit(b"'".to_vec()));
	assert!(matches!(word.parts[1], WordPart::Param(_)));
	// Outside posix mode the quotes still pair: `}` inside them is literal.
	let w = param_word(b"echo \"${x-'}'}\"\n", Features::NONE);
	let ParamOp::Default { word, .. } = first_param(&w).op else {
		panic!()
	};
	assert_eq!(word.parts, vec![WordPart::Lit(b"'}'".to_vec())]);
	assert!(parse_all(b"echo \"foo ${IFS+'bar} baz\"\n", Features::NONE).is_err());
	// In posix mode a lone `'` needs no partner.
	let w = param_word(b"echo \"foo ${IFS+'bar} baz\"\n", Features::POSIX);
	let ParamOp::Alt { word, .. } = first_param(&w).op else {
		panic!()
	};
	assert_eq!(word.parts, vec![WordPart::Lit(b"'bar".to_vec())]);
	// Pattern operators keep `'` as a quote.
	let w = param_word(b"echo \"${x#'a'}\"\n", Features::NONE);
	let ParamOp::Trim { pat, .. } = first_param(&w).op else {
		panic!()
	};
	assert_eq!(pat.parts, vec![WordPart::SQuote(b"a".to_vec())]);
	// braces.tests: a backslash before `'` in a double-quoted pattern.
	let w = param_word(b"echo \"${a#'$('\\'}\"\n", Features::NONE);
	let ParamOp::Trim { pat, .. } = first_param(&w).op else {
		panic!()
	};
	assert_eq!(pat.parts, vec![WordPart::SQuote(b"$(".to_vec()), WordPart::Escaped(b"'".to_vec())]);
}

#[test]
fn backquotes_in_double_quotes_unescape_double_quotes() {
	// exp-tests: "`echo \"Hello world!\"`"
	let w = param_word(b"echo \"`echo \\\"Hello world!\\\"`\"\n", Features::NONE);
	let WordPart::DQuote(inner) = &w.parts[0] else {
		panic!()
	};
	let WordPart::Comsub(c) = &inner[0] else {
		panic!()
	};
	let CommandKind::Simple(s) = &c.body.items[0].and_or.first.stages[0].cmd.kind else {
		panic!()
	};
	assert!(matches!(&s.words[1].parts[..], [WordPart::DQuote(_)]), "{:?}", s.words[1]);
}

#[test]
fn dollar_bang_and_dollar_hash_with_operators() {
	// more-exp: `${!-posparams}` is `$!` with a default.
	let w = param_word(b"echo ${!-posparams}\n", Features::NONE);
	let WordPart::Param(p) = &w.parts[0] else {
		panic!("{w:?}")
	};
	assert_eq!(p.name, ParamName::Special(Special::LastBg));
	assert!(matches!(p.op, ParamOp::Default { colon: false, .. }));
	for bad in [&b"${#:}"[..], b"${#/}", b"${#%}", b"${#=}", b"${#+}"] {
		let mut src = b"echo ".to_vec();
		src.extend_from_slice(bad);
		let w = param_word(&src, Features::NONE);
		assert_eq!(w.parts, vec![WordPart::BadSubst(bad.to_vec())]);
	}
	// Still valid: lengths of special parameters and `$#` with a word.
	let w = param_word(b"echo ${##}\n", Features::NONE);
	assert!(matches!(&w.parts[0], WordPart::Param(p) if p.op == ParamOp::Length));
	let w = param_word(b"echo ${#:-x}\n", Features::NONE);
	assert!(matches!(&w.parts[0], WordPart::Param(_)));
}

#[test]
fn arithmetic_for_splits_only_at_its_own_semicolons() {
	// arith-for.tests:145-146
	let CommandKind::ArithFor(f) =
		first_cmd(b"for (( $(case x in x) esac);; )); do break; done").kind
	else {
		panic!()
	};
	assert!(f.init.src.starts_with(b"$(case x in x)"), "{:?}", String::from_utf8_lossy(&f.init.src));
	assert!(f.cond.src.is_empty());
	assert!(matches!(
		first_cmd(b"for (( ${ case x in x) esac; };; )); do break; done").kind,
		CommandKind::ArithFor(_)
	));
	// arith-for.right: quoted `;` and extra clauses.
	let e = err(b"for (( i=0; \"i < 3\" ))\ndo\necho $i\ndone");
	assert_eq!(e.detail().unwrap().bash_msg, b"syntax error: arithmetic expression required");
	assert_eq!(e.bash_msg(), b"syntax error: `(( i=0; \"i < 3\" ))'");
	let e = err(b"for (( i=0; i < 3; i++; 7 ))\ndo\necho $i\ndone");
	assert_eq!(e.detail().unwrap().bash_msg, b"syntax error: `;' unexpected");
	assert_eq!(e.bash_msg(), b"syntax error: `(( i=0; i < 3; i++; 7 ))'");
	assert!(!e.echoes_line());
}

#[test]
fn moving_redirections_always_print_the_fd() {
	// `declare -f` prints `exec 0<&5-` whether or not the 0 was written.
	let printed = |src: &[u8]| {
		let prog = parse_all(src, Features::NONE).expect("parses");
		String::from_utf8(print_list(&prog.commands[0].list, PrintStyle::Compact)).unwrap()
	};
	assert_eq!(printed(b"exec <&5-"), "exec 0<&5-");
	assert_eq!(printed(b"exec 0<&5-"), "exec 0<&5-");
	assert_eq!(printed(b"exec >&$x-"), "exec 1>&$x-");
	assert_eq!(printed(b"exec <&a-"), "exec 0<&a-");
	// Not a move: the `-` is quoted, and the default fd stays implicit.
	assert_eq!(printed(b"exec <&5\"-\""), "exec <&5\"-\"");
	assert_eq!(printed(b"exec >&2"), "exec 1>&2");
	assert_eq!(printed(b"exec <&$x"), "exec <&$x");
}

#[test]
fn here_document_parameter_words_quote_like_bash() {
	// heredoc6.sub: `$'…'` is ANSI-C quoting in a pattern word …
	let w =
		parse_text(b"1: ${x#$'no\\t'} ${x#n$'o\\t'}\n", Features::NONE, TextMode::HereDoc).unwrap();
	let pats: Vec<Word> = w
		.parts
		.iter()
		.filter_map(|p| match p {
			WordPart::Param(p) => match &p.op {
				ParamOp::Trim { pat, .. } => Some(pat.clone()),
				_ => None,
			},
			_ => None,
		})
		.collect();
	assert_eq!(pats[0].parts, vec![WordPart::AnsiC(b"no\\t".to_vec())]);
	assert_eq!(pats[1].parts, vec![WordPart::Lit(b"n".to_vec()), WordPart::AnsiC(b"o\\t".to_vec())]);
	// … but literal text in a non-pattern word (`"${u:-$'a'}"` outside a
	// document is ANSI-C quoting).
	let w = parse_text(b"${u:-$'a\\tb'}\n", Features::NONE, TextMode::HereDoc).unwrap();
	let WordPart::Param(p) = &w.parts[0] else {
		panic!("{w:?}")
	};
	let ParamOp::Default { word, .. } = &p.op else {
		panic!()
	};
	assert_eq!(word.parts, vec![WordPart::Lit(b"$'a\\tb'".to_vec())]);
	let w = param_word(b"echo \"${u:-$'a'}\"\n", Features::NONE);
	let ParamOp::Default { word, .. } = first_param(&w).op else {
		panic!()
	};
	assert_eq!(word.parts, vec![WordPart::AnsiC(b"a".to_vec())]);
}

#[test]
fn double_quotes_in_double_quoted_parameter_words_escape_everything() {
	// rhs-exp: `"${v:+x="\p"}"` is `x=p`, `"${v:+x="\'$v\'"}"` is `x='val'`.
	let w = param_word(b"echo \"${v:+x=\"\\p\"}\"\n", Features::NONE);
	let ParamOp::Alt { word, .. } = first_param(&w).op else {
		panic!()
	};
	assert_eq!(word.parts, vec![
		WordPart::Lit(b"x=".to_vec()),
		WordPart::DQuote(vec![WordPart::Escaped(b"p".to_vec())]),
	]);
	let w = param_word(b"echo \"${v:+x=\"\\'$v\\'\"}\"\n", Features::NONE);
	let ParamOp::Alt { word, .. } = first_param(&w).op else {
		panic!()
	};
	let WordPart::DQuote(inner) = &word.parts[1] else {
		panic!("{word:?}")
	};
	assert_eq!(inner[0], WordPart::Escaped(b"'".to_vec()));
	assert_eq!(inner[2], WordPart::Escaped(b"'".to_vec()));
	// Without the inner quotes the backslash stays.
	let w = param_word(b"echo \"${v:+x=\\'$v\\'}\"\n", Features::NONE);
	let ParamOp::Alt { word, .. } = first_param(&w).op else {
		panic!()
	};
	assert_eq!(word.parts[0], WordPart::Lit(b"x=\\'".to_vec()));
	// Pattern words and unquoted expansions keep the "…" rules.
	let w = param_word(b"echo ${v:+\"\\p\"}\n", Features::NONE);
	let WordPart::Param(p) = &w.parts[0] else {
		panic!()
	};
	let ParamOp::Alt { word, .. } = &p.op else {
		panic!()
	};
	assert_eq!(word.parts, vec![WordPart::DQuote(vec![WordPart::Lit(b"\\p".to_vec())])]);
}

#[test]
fn conditional_errors_inside_parentheses_match_bash() {
	// cond-error1.sub
	let e = err(b"[[ ( -n xx");
	assert_eq!(e.detail().unwrap().bash_msg, b"unexpected token `EOF', expected `)'");
	assert_eq!(e.bash_msg(), b"syntax error: unexpected end of file from `[[' command on line 1");
	assert_eq!(e.line, 2);
	let e = err(b"[[ (");
	assert_eq!(e.warnings.len(), 1);
	assert_eq!(e.warnings[0].bash_msg, b"unexpected token `EOF' in conditional command");
	assert_eq!(e.warnings[0].line, 2);
	assert_eq!(e.detail().unwrap().bash_msg, b"expected `)'");
	assert_eq!(e.detail().unwrap().line, 1);
	assert_eq!(e.line, 2);
	let e = err(b"[[ ( -n");
	assert_eq!(
		e.warnings[0].bash_msg,
		b"unexpected argument `newline' to conditional unary operator"
	);
	assert_eq!(e.detail().unwrap().bash_msg, b"expected `)'");
	assert_eq!(e.bash_msg(), b"syntax error near `-n'");
}

#[test]
fn dollar_single_quoted_parameter_names_inside_double_quotes() {
	// posixexp7.sub: "${x#${$'x1'%'t'}}" names `x1`; unquoted it stays bad.
	let w = param_word(b"echo \"${$'x1'%'t'}\"\n", Features::POSIX);
	let p = first_param(&w);
	assert_eq!(p.name, ParamName::Var(b"x1".to_vec()));
	assert!(matches!(p.op, ParamOp::Trim { suffix: true, .. }));
	let w = param_word(b"echo \"${'x1'%'t'}\"\n", Features::NONE);
	let WordPart::DQuote(inner) = &w.parts[0] else {
		panic!()
	};
	assert!(matches!(inner[0], WordPart::BadSubst(_)));
	let w = param_word(b"echo ${$'x1'}\n", Features::NONE);
	assert!(matches!(w.parts[0], WordPart::BadSubst(_)));
}

#[test]
fn end_of_file_after_a_trailing_backslash_counts_two_lines() {
	// exportfunc.tests:42 `eval 'X() { (a)>\'` reports line 44.
	for src in [&b"X() { (a)>\\"[..], b"X() { echo a\\", b"X() { echo a; \\"] {
		let e = err(src);
		assert_eq!(e.line, 3, "{:?}", String::from_utf8_lossy(src));
		assert_eq!(e.bash_msg(), b"syntax error: unexpected end of file from `{' command on line 1");
	}
	assert_eq!(err(b"X() { # c\\").line, 2);
	assert_eq!(err(b"X() { echo a\\\\").line, 2);
	assert_eq!(err(b"X() { echo a").line, 2);
}

#[test]
fn seventeen_pending_here_documents_are_fatal() {
	// exportfunc1.sub
	let mut src = b"cat".to_vec();
	for _ in 0..17 {
		src.extend_from_slice(b" <<EOF");
	}
	src.push(b'\n');
	let e = err(&src);
	assert_eq!(e.bash_msg(), b"maximum here-document count exceeded");
	assert_eq!(e.line, 1);
	assert!(!e.echoes_line());
	let mut ok = b"cat".to_vec();
	for _ in 0..16 {
		ok.extend_from_slice(b" <<EOF");
	}
	ok.push(b'\n');
	for _ in 0..16 {
		ok.extend_from_slice(b"EOF\n");
	}
	assert!(parse_all(&ok, Features::NONE).is_ok());
}

#[test]
fn failed_expansions_between_literal_quotes_fail_at_expansion_time() {
	// braces.tests:55-60: bash parses the `$(` only when it expands the word,
	// over the text up to the end of the word, and reports
	// `command substitution: line 59` for line 57.
	let prog = parse_all(
		b"echo \"${a-'$('\\'}\"\necho \"${a#aaaa'$(aaaa'aaa)aaa\\'}\"\necho after\n",
		Features::NONE,
	)
	.expect("parses");
	assert_eq!(prog.commands.len(), 3);
	let CommandKind::Simple(s) = &prog.commands[0].list.items[0].and_or.first.stages[0]
		.cmd
		.kind
	else {
		panic!()
	};
	let ParamOp::Default { word, .. } = first_param(&s.words[1]).op else {
		panic!()
	};
	let [WordPart::Lit(q), WordPart::BadComsub(b)] = &word.parts[..] else {
		panic!("{word:?}")
	};
	assert_eq!(q, b"'");
	assert_eq!(b.text, b"$('\\'");
	assert_eq!((b.line, &b.msg[..]), (2, &b"unexpected EOF while looking for matching `)'"[..]));
	assert_eq!(print_list(&prog.commands[0].list, PrintStyle::Compact), b"echo \"${a-'$('\\'}\"");
	// EOF inside a quote of the text: one line.
	let w = param_word(b"echo \"${a+'$(echo x'}\"\n", Features::NONE);
	let ParamOp::Alt { word, .. } = first_param(&w).op else {
		panic!()
	};
	let WordPart::BadComsub(b) = &word.parts[1] else {
		panic!("{word:?}")
	};
	assert_eq!((b.line, &b.msg[..]), (1, &b"unexpected EOF while looking for matching `''"[..]));
	// A valid substitution there still parses.
	let w = param_word(b"echo \"${a+'$(echo x)'}\"\n", Features::NONE);
	let ParamOp::Alt { word, .. } = first_param(&w).op else {
		panic!()
	};
	assert!(word.parts.iter().any(|p| matches!(p, WordPart::Comsub(_))));
}

#[test]
fn substring_offsets_keep_conditional_operators() {
	// new-exp.tests:154,160
	for (src, off, len) in [
		(&b"echo ${s:j?1:0:j}"[..], &b"j?1:0"[..], &b"j"[..]),
		(b"echo ${s:j?(x?1:0):0:j}", b"j?(x?1:0):0", b"j"),
		(b"echo ${s:(j?1:0):j}", b"(j?1:0)", b"j"),
	] {
		let s = first_cmd(src);
		let WordPart::Param(p) = &simple(&s).words[1].parts[0] else {
			panic!()
		};
		let ParamOp::Substr { offset, len: Some(l) } = &p.op else {
			panic!("{:?}", p.op)
		};
		assert_eq!((&offset.src[..], &l.src[..]), (off, len));
	}
}

#[test]
fn conditional_command_spans_run_through_the_closing_brackets() {
	// `$BASH_COMMAND` is the source text of the command's span.
	let src = b"[[ -n $unset ]] && x\n";
	let prog = parse_all(src, Features::NONE).expect("parses");
	let cmd = &prog.commands[0].list.items[0].and_or.first.stages[0].cmd;
	assert_eq!(&src[cmd.span.lo as usize..cmd.span.hi as usize], b"[[ -n $unset ]]");
	let src = b"[[ a == b ||\n  -z c ]]\n";
	let prog = parse_all(src, Features::NONE).expect("parses");
	let cmd = &prog.commands[0].list.items[0].and_or.first.stages[0].cmd;
	assert_eq!(&src[cmd.span.lo as usize..cmd.span.hi as usize], &src[..src.len() - 1]);
}

#[test]
fn compound_assignment_errors_drop_the_line_and_parsing_goes_on() {
	// array.tests:34 `test=(first & second)`: bash reports the error, sets
	// `$?` to 1 and continues with the next line.
	let src = b"x=(a & b); echo dropped\necho $?\nif true; then\n  x=(1 & 2) ; echo same\n  echo in\nfi\necho out\n";
	let mut p = Parser::new(src, Features::NONE, &NoAliases);
	let mut seen = Vec::new();
	while let Some(res) = p.next_command() {
		seen.push(match res {
			Ok(cc) => String::from_utf8(print_list(&cc.list, PrintStyle::Compact)).unwrap(),
			Err(e) => format!("{}:{}:{}", e.line, e.recovered, String::from_utf8_lossy(&e.bash_msg())),
		});
	}
	assert_eq!(seen, [
		"1:true:syntax error near unexpected token `&'",
		"echo $?",
		"4:true:syntax error near unexpected token `&'",
		"echo in",
		"6:false:syntax error near unexpected token `fi'",
	]);
}

#[test]
fn doubled_bang_is_a_null_command_without_inversion() {
	// posixpipe.tests:20 `! !` then `echo $?` prints 0.
	let prog = parse_all(b"! !\n! !; ! ! !\n", Features::NONE).expect("parses");
	let pipes: Vec<(bool, usize)> = prog
		.commands
		.iter()
		.flat_map(|cc| cc.list.items.iter())
		.map(|it| {
			let p = &it.and_or.first;
			let CommandKind::Simple(s) = &p.stages[0].cmd.kind else {
				panic!()
			};
			(p.bang, s.words.len())
		})
		.collect();
	assert_eq!(pipes, [(false, 0), (false, 0), (true, 0)]);
}

#[test]
fn double_quotes_between_literal_quotes_are_dropped_at_expansion() {
	// array6.sub:26-27: "${dbg-'"'hey}" is `''hey`, "${dbg-'"hey'}" is `'hey'`.
	let src = b"echo \"${dbg-'\"'hey}\" \"${dbg-'\"hey'}\"\n";
	let prog = parse_all(src, Features::NONE).expect("parses");
	let CommandKind::Simple(s) = &prog.commands[0].list.items[0].and_or.first.stages[0]
		.cmd
		.kind
	else {
		panic!()
	};
	let ParamOp::Default { word, .. } = first_param(&s.words[1]).op else {
		panic!()
	};
	assert_eq!(word.parts, vec![
		WordPart::Lit(b"'".to_vec()),
		WordPart::DroppedQuote,
		WordPart::Lit(b"'hey".to_vec()),
	]);
	let ParamOp::Default { word, .. } = first_param(&s.words[2]).op else {
		panic!()
	};
	assert_eq!(word.parts, vec![
		WordPart::Lit(b"'".to_vec()),
		WordPart::DroppedQuote,
		WordPart::Lit(b"hey'".to_vec()),
	]);
	// The printed text keeps the quote.
	assert_eq!(print_list(&prog.commands[0].list, PrintStyle::Compact), &src[..src.len() - 1]);
}

#[test]
fn backslashes_in_double_quoted_pattern_words_quote_any_character() {
	// nquote2.sub / quote1.sub: "${v/\'/\'}" replaces `'` with `'`, and
	// "${v/a/\q}" with `q`; a non-pattern word keeps the backslash.
	let w = param_word(b"echo \"${v/\\'/\\'}\"\n", Features::NONE);
	let ParamOp::Replace { pat, rep: Some(rep), .. } = first_param(&w).op else {
		panic!()
	};
	assert_eq!(pat.parts, vec![WordPart::Escaped(b"'".to_vec())]);
	assert_eq!(rep.parts, vec![WordPart::Escaped(b"'".to_vec())]);
	let w = param_word(b"echo \"${v/a/\\q}\"\n", Features::NONE);
	let ParamOp::Replace { rep: Some(rep), .. } = first_param(&w).op else {
		panic!()
	};
	assert_eq!(rep.parts, vec![WordPart::Escaped(b"q".to_vec())]);
	let w = param_word(b"echo \"${u-\\'}\"\n", Features::NONE);
	let ParamOp::Default { word, .. } = first_param(&w).op else {
		panic!()
	};
	assert_eq!(word.parts, vec![WordPart::Lit(b"\\'".to_vec())]);
}

#[test]
fn double_byte_charsets_read_whole_characters() {
	// glob-test: in zh_TW.big5, U+03B1 is 0xA3 0x5C; the 0x5C is not `\`.
	let src = b"[[ \xa3\x5c = \xa3\x5c ]] && echo \"\xa3\x5c\" `echo \xa3\x60` $(echo \xa3\x5c)\n";
	let prog = parse_all(src, Features::DOUBLE_BYTE).expect("parses");
	let and_or = &prog.commands[0].list.items[0].and_or;
	let CommandKind::Cond(CondExpr::Binary { lhs, rhs, .. }) = &and_or.first.stages[0].cmd.kind
	else {
		panic!()
	};
	assert_eq!(lhs.parts, vec![WordPart::Lit(b"\xa3\x5c".to_vec())]);
	assert_eq!(rhs.parts, lhs.parts);
	let CommandKind::Simple(s) = &and_or.rest[0].1.stages[0].cmd.kind else {
		panic!()
	};
	assert_eq!(s.words[1].parts, vec![WordPart::DQuote(vec![WordPart::Lit(b"\xa3\x5c".to_vec())])]);
	assert_eq!(s.words.len(), 4);
	assert_eq!(print_list(&prog.commands[0].list, PrintStyle::Compact), &src[..src.len() - 1]);
	// Without the flag the same bytes are a backslash.
	assert!(parse_all(b"echo \xa3\x5c\n", Features::NONE).is_ok());
	assert_eq!(Features::GB18030.char_len(0x81, b'0'), 4);
	assert_eq!(Features::SHIFT_JIS.char_len(0xa1, 0x5c), 1);
	assert_eq!(Features::SHIFT_JIS.char_len(0x83, 0x5c), 2);
}

/// Source, pattern text, replacement text.
type ReplaceCase = (&'static [u8], &'static [u8], Option<&'static [u8]>);

#[test]
fn global_replacement_patterns_may_start_with_a_slash() {
	// new-exp.tests:647 `"/${a///a/}"`: the pattern is `/a`, the replacement
	// empty.
	let cases: [ReplaceCase; 4] = [
		(b"echo ${a///a/}", b"/a", Some(b"")),
		(b"echo ${a///}", b"/", None),
		(b"echo ${a////x}", b"/", Some(b"x")),
		(b"echo ${a/#/x}", b"", Some(b"x")),
	];
	for (src, pat, rep) in cases {
		let s = first_cmd(src);
		let WordPart::Param(p) = &simple(&s).words[1].parts[0] else {
			panic!()
		};
		let ParamOp::Replace { pat: pw, rep: rw, .. } = &p.op else {
			panic!("{:?}", p.op)
		};
		let text = |w: &Word| -> Vec<u8> {
			w.parts
				.iter()
				.flat_map(|p| match p {
					WordPart::Lit(b) => b.clone(),
					other => panic!("{other:?}"),
				})
				.collect()
		};
		assert_eq!(text(pw), pat, "{:?}", String::from_utf8_lossy(src));
		assert_eq!(rw.as_ref().map(text).as_deref(), rep);
		assert_eq!(
			print_list(&parse_all(src, Features::NONE).unwrap().commands[0].list, PrintStyle::Compact),
			src
		);
	}
}
