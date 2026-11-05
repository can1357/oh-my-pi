use super::*;

fn analyzed(script: &str) -> Analysis {
	let program = parse_all(script.as_bytes(), Features::NONE).expect("valid bash fixture");
	let mut walker = Walker::default();
	for (unit, command) in program.commands.iter().enumerate() {
		walker.unit = unit as u32;
		walker.list(&command.list, Context { restricted: false, background: false, order: 0 });
	}
	walker.finish()
}

#[test]
fn literal_source_slots_are_deterministic_disjoint_and_reset_per_unit() {
	use crate::bash::trace::syntax::UnitSyntax;
	let program = parse_all(b"sh -c 'echo one; echo two'\necho next\n", Features::NONE).unwrap();
	let roots: Vec<_> = program.commands.into_iter().map(UnitSyntax::list).collect();
	let mut walker = Walker::default();
	for (unit, root) in roots.iter().enumerate() {
		walker.unit = unit as u32;
		walker.root(root);
	}
	let analysis = walker.finish();
	for (unit, root) in roots.iter().enumerate() {
		let SyntaxTree::List(list) = &root.tree else {
			panic!("list fixture")
		};
		let CommandKind::Simple(simple) = &list.items[0].and_or.first.stages[0].cmd.kind else {
			panic!("simple fixture")
		};
		let mut slot = 1;
		for word in &simple.words {
			let body = literal(word).unwrap();
			assert_eq!(analysis.source_slots[&NodeKey::engine(unit as u32, word.id)], slot);
			slot += body.len() as u32 + 1;
		}
	}
}

#[test]
fn source_slot_exhaustion_never_wraps_or_reuses_a_namespace() {
	let program = parse_all(b"printf x\n", Features::NONE).unwrap();
	let CommandKind::Simple(simple) = &program.commands[0].list.items[0].and_or.first.stages[0]
		.cmd
		.kind
	else {
		panic!("simple fixture")
	};
	let mut walker = Walker { source_slot: Some(u32::MAX - 1), ..Walker::default() };
	let context = Context { restricted: false, background: false, order: 0 };
	let owner = NodeKey::engine(
		0,
		program.commands[0].list.items[0].and_or.first.stages[0]
			.cmd
			.id,
	);
	for word in &simple.words {
		walker.word(word, owner, context, "arg");
	}
	assert!(walker.result.source_slots.is_empty());
	assert!(walker.source_slot.is_none());
}

#[test]
fn static_program_analysis_keeps_its_own_constants_functions_and_source_keys() {
	let outer = analyzed("ROOT=/local\necho $ROOT\n");
	let parsed = parse_all(
		b"ROOT=/remote\nDEST=\"$ROOT/tree\"\nf() { echo $1 ${2:-none}; }\ncurl \"$DEST\"\n",
		Features::NONE,
	)
	.unwrap();
	let sources = [100, 200, 300, 400];
	let analysis = super::program(&parsed, 8, &sources);
	assert_eq!(outer.variables["ROOT"].value.as_deref(), Some("/local"));
	assert_eq!(analysis.variables["ROOT"].value.as_deref(), Some("/remote"));
	assert_eq!(analysis.variables["DEST"].value.as_deref(), Some("/remote/tree"));
	assert!(analysis.variables["DEST"].inline);
	assert_eq!(analysis.variables["DEST"].setter.unwrap().source, 200);
	assert_eq!(analysis.functions["f"], 2);
	assert!(outer.functions.is_empty());
	assert!(
		analysis
			.owners
			.keys()
			.all(|key| key.unit == 8 && sources.contains(&key.source))
	);
	let curl = &parsed.commands[3].list.items[0].and_or.first.stages[0].cmd;
	let key = NodeKey::nested(8, 400, curl.id);
	assert!(
		analysis.effects[&key]
			.iter()
			.any(|effect| effect.kind == EffectKind::Network)
	);
	assert!(analysis.leaves.contains(&key));
}

fn argument_literal(source: &str) -> Option<String> {
	let program = parse_all(source.as_bytes(), Features::NONE).expect("valid word fixture");
	let CommandKind::Simple(simple) = &program.commands[0].list.items[0].and_or.first.stages[0]
		.cmd
		.kind
	else {
		panic!("simple fixture")
	};
	literal(&simple.words[1])
}

#[test]
#[expect(
	clippy::literal_string_with_formatting_args,
	reason = "Bash parameter expansion is intentional fixture syntax, not Rust formatting."
)]
fn literal_uses_native_quote_removal_and_rejects_expansions() {
	assert_eq!(argument_literal("echo 'a b'\"c\"\\ d"), Some("a bc d".to_owned()));
	assert_eq!(argument_literal("echo $'a\\nb'"), Some("a\nb".to_owned()));
	assert_eq!(argument_literal("echo $'a\\0ignored'"), Some("a".to_owned()));
	assert_eq!(argument_literal("echo \"~/literal\""), Some("~/literal".to_owned()));
	for script in [
		"echo ~",
		"echo $HOME",
		"echo \"${HOME:-x}\"",
		"echo $(pwd)",
		"echo $((1+2))",
		"echo <(pwd)",
		"echo $\"translated\"",
	] {
		assert_eq!(argument_literal(script), None, "{script}");
	}
}

#[test]
fn constants_compose_across_announced_native_units() {
	let analysis = analyzed(
		"ROOT=/tmp\nDEST=\"${ROOT}/project\"\necho \"$DEST\"\nDYNAMIC=$UNKNOWN\necho \"$DYNAMIC\"\n",
	);
	assert_eq!(analysis.variables["ROOT"].value.as_deref(), Some("/tmp"));
	assert!(analysis.variables["ROOT"].inline);
	assert_eq!(analysis.variables["DEST"].value.as_deref(), Some("/tmp/project"));
	assert!(analysis.variables["DEST"].inline);
	assert_eq!(analysis.variables["DEST"].setter.unwrap().unit, 1);
	assert!(!analysis.variables["DYNAMIC"].inline);
	assert_eq!(analysis.variables["DYNAMIC"].value, None);
}

#[test]
#[expect(
	clippy::literal_string_with_formatting_args,
	reason = "Bash parameter expansion is intentional fixture syntax, not Rust formatting."
)]
fn unsafe_definitions_references_and_mutation_never_inline() {
	for script in [
		"X=$(date)\necho $X",
		"X=one\nX=two\necho $X",
		"if true; then X=a; fi\necho $X",
		"X=a\nf() { echo $X; }; f",
		"echo $X\nX=a",
		"X=a\nread X\necho $X",
		"X=a\n((X++))\necho $X",
		"X=a\ntrap 'X=b' DEBUG\necho $X",
		"X=a\necho ${X:-fallback}",
		"X=Y\necho ${!X}",
		"X=a\n(echo $X)",
		"X=a\necho $(echo $X)",
		"X=a\ncat <(echo $X)",
		"X=a\nif true; then echo $X; fi",
		"X=a\necho $((X))",
		"X=a\nprintf -v X b\necho $X",
		"X=a\nbuiltin read X\necho $X",
		"X=a\ncommand unset X\necho $X",
		"X=a\nX+=b\necho $X",
		"X=(a b)\necho $X",
		"X=a\nfor X in b; do :; done\necho $X",
		"X=a env\necho $X",
		"X=a &\necho $X",
		"X=a\necho ${OTHER:-$X}",
		"X=a\necho ${OTHER/$X/replacement}",
		"X=a\necho ${OTHER[$X]}",
		"X=a\ncat <<EOF\n$X\nEOF\n",
	] {
		let analysis = analyzed(script);
		assert!(!analysis.variables["X"].inline, "unsafe fold: {script}");
	}
}

#[test]
fn parameter_operator_contexts_restrict_only_their_own_references() {
	for operand in [
		"${OTHER:-$X}",
		"${OTHER:=$X}",
		"${OTHER:+$X}",
		"${OTHER:?$X}",
		"${OTHER#$X}",
		"${OTHER%%$X}",
		"${OTHER/$X/replacement}",
		"${OTHER/pattern/$X}",
		"${OTHER//$X/$X}",
		"${OTHER^$X}",
		"${OTHER,,$X}",
		"${OTHER:X}",
		"${OTHER:0:X}",
		"${OTHER#\"$X\"}",
		"${OTHER/pattern/\"$X\"}",
		"${OTHER/${NESTED#$X}/replacement}",
	] {
		let script = format!("X=a\nSAFE=/safe/path\necho \"$SAFE\" \"$X\" \"{operand}\"\n");
		let analysis = analyzed(&script);
		assert!(!analysis.variables["X"].inline, "unsafe operand: {operand}");
		assert!(analysis.variables["SAFE"].inline, "unrelated constant: {operand}");
		assert_eq!(analysis.variables["SAFE"].value.as_deref(), Some("/safe/path"));
	}
}

#[test]
fn canonical_command_roots_and_real_parent_provenance_are_respected() {
	use std::sync::Arc;

	use crate::bash::trace::syntax::SourceParent;
	let mut program = parse_all(b"X=constant; echo $X\n", Features::NONE).unwrap();
	let list = program.commands.remove(0).list;
	let mut syntax = UnitSyntax::new(0, SyntaxTree::List(Arc::new(list)));
	let mut walker = Walker::default();
	walker.root(&syntax);
	assert!(walker.finish().variables["X"].inline);
	syntax.parent = Some(SourceParent { unit: 9, node: 0, lo: 10, hi: 30 });
	let mut walker = Walker::default();
	walker.root(&syntax);
	assert!(!walker.finish().variables["X"].inline);

	let mut program = parse_all(b"echo ${VALUE:-$(date)}\n", Features::NONE).unwrap();
	let command = program
		.commands
		.remove(0)
		.list
		.items
		.remove(0)
		.and_or
		.first
		.stages
		.remove(0)
		.cmd;
	let root_id = command.id;
	let syntax = UnitSyntax::new(0, SyntaxTree::Command(Arc::new(command)));
	let mut walker = Walker::default();
	walker.root(&syntax);
	let analysis = walker.finish();
	assert!(analysis.leaves.contains(&NodeKey::engine(0, root_id)));
	assert!(analysis.spans.len() > 3);
}

#[test]
fn no_unannounced_future_assignment_is_assumed() {
	let before = analyzed("echo $LATER\n");
	assert!(!before.variables.contains_key("LATER"));
	let after = analyzed("echo $LATER\nLATER=value\n");
	assert!(!after.variables["LATER"].inline);
}

#[test]
fn branch_conditions_use_final_and_or_keys_in_arm_order() {
	let source = "if echo setup; false && echo no; then :; elif test x; then :; fi\nwhile echo \
	              setup; ! false || test x; do :; done\n";
	let program = parse_all(source.as_bytes(), Features::NONE).unwrap();
	let analysis = analyzed(source);
	let command = &program.commands[0].list.items[0].and_or.first.stages[0].cmd;
	let CommandKind::If(branch) = &command.kind else {
		panic!("if fixture")
	};
	let expected: Vec<_> = branch
		.arms
		.iter()
		.map(|arm| NodeKey::engine(0, arm.cond.items.last().unwrap().and_or.id))
		.collect();
	assert_eq!(analysis.branch_conditions[&NodeKey::engine(0, command.id)], expected);
	let false_command = &branch.arms[0]
		.cond
		.items
		.last()
		.unwrap()
		.and_or
		.first
		.stages[0]
		.cmd;
	assert!(
		analysis
			.guards
			.contains(&NodeKey::engine(0, false_command.id))
	);
	let ordinary = &branch.arms[0].cond.items.last().unwrap().and_or.rest[0]
		.1
		.stages[0]
		.cmd;
	assert!(!analysis.guards.contains(&NodeKey::engine(0, ordinary.id)));
	let command = &program.commands[1].list.items[0].and_or.first.stages[0].cmd;
	let CommandKind::While(loop_) = &command.kind else {
		panic!("while fixture")
	};
	let condition = &loop_.cond.items.last().unwrap().and_or;
	assert_eq!(analysis.branch_conditions[&NodeKey::engine(1, command.id)], vec![NodeKey::engine(
		1,
		condition.id
	)]);
	assert!(
		analysis
			.guards
			.contains(&NodeKey::engine(1, condition.first.stages[0].cmd.id))
	);
	assert!(
		analysis
			.guards
			.contains(&NodeKey::engine(1, condition.rest[0].1.stages[0].cmd.id))
	);
}

#[test]
fn guards_are_only_the_final_direct_condition_not_nested_pipeline_leaves() {
	let source = "if echo before; test \"$(false)\"; then :; elif false | true; then :; fi\nwhile \
	              echo before; [[ x == y ]]; do :; done\n";
	let program = parse_all(source.as_bytes(), Features::NONE).unwrap();
	let analysis = analyzed(source);
	let root = &program.commands[0].list.items[0].and_or.first.stages[0].cmd;
	let CommandKind::If(branch) = &root.kind else {
		panic!("if fixture")
	};
	let tested = &branch.arms[0].cond.items[1].and_or.first.stages[0].cmd;
	assert!(analysis.guards.contains(&NodeKey::engine(0, tested.id)));
	let before = &branch.arms[0].cond.items[0].and_or.first.stages[0].cmd;
	assert!(!analysis.guards.contains(&NodeKey::engine(0, before.id)));
	let CommandKind::Simple(simple) = &tested.kind else {
		panic!("test fixture")
	};
	let WordPart::DQuote(parts) = &simple.words[1].parts[0] else {
		panic!("quote fixture")
	};
	let WordPart::Comsub(sub) = &parts[0] else {
		panic!("substitution fixture")
	};
	let nested = &sub.body.items[0].and_or.first.stages[0].cmd;
	assert!(!analysis.guards.contains(&NodeKey::engine(0, nested.id)));
	for stage in &branch.arms[1].cond.items[0].and_or.first.stages {
		assert!(!analysis.guards.contains(&NodeKey::engine(0, stage.cmd.id)));
	}
	assert_eq!(analysis.guards.len(), 2);
}

#[test]
fn ownership_and_spans_use_canonical_ids_including_nested_words() {
	let source = "X=$(printf '%s' \"${Y:-$(date)}\") >\"$OUT\"\n";
	let program = parse_all(source.as_bytes(), Features::NONE).unwrap();
	let mut walker = Walker::default();
	walker.list(&program.commands[0].list, Context {
		restricted: false,
		background: false,
		order:      0,
	});
	let analysis = walker.finish();
	let root = &program.commands[0].list.items[0].and_or.first.stages[0].cmd;
	let key = NodeKey::engine(0, root.id);
	let CommandKind::Simple(simple) = &root.kind else {
		panic!("assignment fixture")
	};
	let assignment = &simple.assigns[0];
	assert_eq!(analysis.owners[&NodeKey::engine(0, assignment.id)], key);
	let AssignValue::Scalar(word) = &assignment.value else {
		panic!("scalar fixture")
	};
	assert_eq!(analysis.owners[&NodeKey::engine(0, word.id)], key);
	let WordPart::Comsub(sub) = &word.parts[0] else {
		panic!("substitution fixture")
	};
	let nested = &sub.body.items[0].and_or.first.stages[0].cmd;
	let CommandKind::Simple(simple) = &nested.kind else {
		panic!("printf fixture")
	};
	assert_eq!(
		analysis.owners[&NodeKey::engine(0, simple.words[1].id)],
		NodeKey::engine(0, nested.id)
	);
	assert_eq!(analysis.spans[&key], root.span);
	assert!(analysis.leaves.contains(&key));
	assert!(
		!analysis
			.owners
			.contains_key(&NodeKey::engine(0, program.commands[0].list.items[0].and_or.id))
	);
}

#[test]
fn command_parents_follow_actual_compound_and_substitution_ancestry() {
	let source = "if true; then echo \"$(printf '%s' \"$(date)\")\"; fi\necho sibling\n";
	let program = parse_all(source.as_bytes(), Features::NONE).unwrap();
	let analysis = analyzed(source);
	let root = &program.commands[0].list.items[0].and_or.first.stages[0].cmd;
	let root_key = NodeKey::engine(0, root.id);
	assert!(!analysis.parents.contains_key(&root_key));
	let CommandKind::If(branch) = &root.kind else {
		panic!("if fixture")
	};
	let predicate = &branch.arms[0].cond.items[0].and_or.first.stages[0].cmd;
	assert_eq!(analysis.parents[&NodeKey::engine(0, predicate.id)], root_key);
	let echo = &branch.arms[0].body.items[0].and_or.first.stages[0].cmd;
	let echo_key = NodeKey::engine(0, echo.id);
	assert_eq!(analysis.parents[&echo_key], root_key);
	let CommandKind::Simple(simple) = &echo.kind else {
		panic!("echo fixture")
	};
	let WordPart::DQuote(parts) = &simple.words[1].parts[0] else {
		panic!("quote fixture")
	};
	let WordPart::Comsub(sub) = &parts[0] else {
		panic!("substitution fixture")
	};
	let printf = &sub.body.items[0].and_or.first.stages[0].cmd;
	let printf_key = NodeKey::engine(0, printf.id);
	assert_eq!(analysis.parents[&printf_key], echo_key);
	let CommandKind::Simple(simple) = &printf.kind else {
		panic!("printf fixture")
	};
	let WordPart::DQuote(parts) = &simple.words[2].parts[0] else {
		panic!("quote fixture")
	};
	let WordPart::Comsub(sub) = &parts[0] else {
		panic!("nested substitution fixture")
	};
	let date = &sub.body.items[0].and_or.first.stages[0].cmd;
	assert_eq!(analysis.parents[&NodeKey::engine(0, date.id)], printf_key);
	let sibling = &program.commands[1].list.items[0].and_or.first.stages[0].cmd;
	assert!(
		!analysis
			.parents
			.contains_key(&NodeKey::engine(1, sibling.id))
	);
}

#[test]
fn keychain_and_environment_secrets_propagate_through_aliases() {
	let analysis = analyzed("TOKEN=$(security find-generic-password -w -s service)\nALIAS=$TOKEN\ncurl -H \"Authorization: $ALIAS\" https://example.test\nset -a\n. .env\nset +a\nNEXT=$API_KEY\ncurl -d \"$NEXT\" https://example.test\n");
	for name in ["TOKEN", "ALIAS", "API_KEY", "NEXT"] {
		assert!(analysis.tainted.contains(name), "{name}");
	}
	let effects: Vec<_> = analysis.effects.values().flatten().collect();
	assert!(effects.iter().any(
		|effect| effect.kind == EffectKind::Secret && effect.why.contains("ALIAS sent to network")
	));
	assert!(effects.iter().any(
		|effect| effect.kind == EffectKind::Secret && effect.why.contains("NEXT sent to network")
	));
	assert!(
		effects
			.iter()
			.all(|effect| effect.why.contains("heuristic"))
	);
}

#[test]
fn declaration_aliases_remain_dynamic_but_propagate_secret_taint() {
	let analysis = analyzed("TOKEN=$(security find-generic-password -w)\nexport ALIAS=$TOKEN\nreadonly NEXT=$ALIAS\ncurl -d \"$NEXT\" https://example.test\n");
	assert!(analysis.tainted.contains("ALIAS"));
	assert!(analysis.tainted.contains("NEXT"));
	assert!(!analysis.variables["ALIAS"].inline);
	assert!(!analysis.variables["NEXT"].inline);
	assert!(
		analysis
			.effects
			.values()
			.flatten()
			.any(|effect| effect.why.contains("NEXT sent to network"))
	);
}

#[test]
fn effects_cover_writes_destruction_privilege_background_and_packages() {
	let analysis =
		analyzed("npm install package\nrm -rf build\nsudo true\nprintf value >artifact\nsleep 1 &\n");
	for kind in [
		EffectKind::Network,
		EffectKind::Write,
		EffectKind::Destructive,
		EffectKind::Privilege,
		EffectKind::Background,
	] {
		assert!(
			analysis
				.effects
				.values()
				.flatten()
				.any(|effect| effect.kind == kind),
			"{kind:?}"
		);
	}
	assert!(
		analysis
			.effects
			.values()
			.flatten()
			.any(|effect| effect.why.contains("writes artifact"))
	);
}

#[test]
#[expect(
	clippy::literal_string_with_formatting_args,
	reason = "Bash parameter expansion is intentional fixture syntax, not Rust formatting."
)]
fn function_metadata_and_leaf_identity_follow_typed_structure() {
	let analysis = analyzed("f() { echo $1 ${3:-none}; g() { echo $9; }; }\n");
	assert_eq!(analysis.functions["f"], 3);
	assert_eq!(analysis.functions["g"], 9);
	let program = parse_all(b"if true; then echo yes; fi\n", Features::NONE).unwrap();
	let analysis = analyzed("if true; then echo yes; fi\n");
	let command = &program.commands[0].list.items[0].and_or.first.stages[0].cmd;
	assert!(!analysis.leaves.contains(&NodeKey::engine(0, command.id)));
	assert_eq!(analysis.leaves.len(), 2);
}
