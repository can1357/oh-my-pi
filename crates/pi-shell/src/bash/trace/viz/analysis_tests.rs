use super::*;
use crate::bash::syntax::{
	Features, parse_all,
	tree::{Comsub, If, IfArm},
};

/// Each complete command of `src`: its tree and `List` root.
fn trees(src: &[u8]) -> Vec<(Tree, u32)> {
	parse_all(src, Features::NONE)
		.expect("valid bash fixture")
		.commands
		.into_iter()
		.map(|cc| (cc.tree, cc.root.index()))
		.collect()
}

/// The first stage of item `i` of `list`.
fn item(list: List<'_>, i: usize) -> Command<'_> {
	list
		.items()
		.get(i)
		.unwrap()
		.and_or()
		.first()
		.stages()
		.first()
		.unwrap()
}

/// The first command of a complete command's tree.
fn root((tree, list): &(Tree, u32)) -> Command<'_> {
	item(List::at(tree, *list), 0)
}

fn simple(command: Command<'_>) -> Simple<'_> {
	let CommandKind::Simple(simple) = command.kind() else {
		panic!("simple fixture")
	};
	simple
}

fn arm(branch: If<'_>, k: usize) -> IfArm<'_> {
	branch.arms().nth(k).unwrap()
}

/// The command substitution a word holds, directly or as the first part of
/// a double-quoted string.
fn comsub(word: Word<'_>) -> Comsub<'_> {
	let first = word.parts().first().unwrap();
	let part = match first.get() {
		Part::DQuote(parts) => parts.first().unwrap().get(),
		other => other,
	};
	let Part::Comsub(sub) = part else {
		panic!("substitution fixture")
	};
	sub
}

fn analyzed(script: &str) -> Analysis {
	let commands = trees(script.as_bytes());
	let mut walker = Walker::default();
	for (unit, (tree, list)) in commands.iter().enumerate() {
		walker.unit = unit as u32;
		walker.list(List::at(tree, *list), Context {
			restricted: false,
			background: false,
			order:      0,
		});
	}
	walker.finish()
}

#[test]
fn literal_source_slots_are_deterministic_disjoint_and_reset_per_unit() {
	let program = parse_all(b"sh -c 'echo one; echo two'\necho next\n", Features::NONE).unwrap();
	let roots: Vec<_> = program.commands.into_iter().map(UnitSyntax::list).collect();
	let mut walker = Walker::default();
	for (unit, root) in roots.iter().enumerate() {
		walker.unit = unit as u32;
		walker.root(root);
	}
	let analysis = walker.finish();
	for (unit, root) in roots.iter().enumerate() {
		let Root::List(list) = root.tree.view() else {
			panic!("list fixture")
		};
		let mut slot = 1;
		for word in simple(item(list, 0)).words() {
			let body = literal(word).unwrap();
			assert_eq!(analysis.source_slots[&NodeKey::engine(unit as u32, word.id())], slot);
			slot += body.len() as u32 + 1;
		}
	}
}

#[test]
fn source_slot_exhaustion_never_wraps_or_reuses_a_namespace() {
	let commands = trees(b"printf x\n");
	let command = root(&commands[0]);
	let mut walker = Walker { source_slot: Some(u32::MAX - 1), ..Walker::default() };
	let context = Context { restricted: false, background: false, order: 0 };
	let owner = NodeKey::engine(0, command.id());
	for word in simple(command).words() {
		walker.word(word, owner, context, "arg");
	}
	assert!(walker.result.source_slots.is_empty());
	assert!(walker.source_slot.is_none());
}

#[test]
fn static_program_analysis_keeps_its_own_constants_functions_and_source_keys() {
	let outer = analyzed("ROOT=/local\necho $ROOT\n");
	let parsed =
		trees(b"ROOT=/remote\nDEST=\"$ROOT/tree\"\nf() { echo $1 ${2:-none}; }\ncurl \"$DEST\"\n");
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
	let curl = root(&parsed[3]);
	let key = NodeKey::nested(8, 400, curl.id());
	assert!(
		analysis.effects[&key]
			.iter()
			.any(|effect| effect.kind == EffectKind::Network)
	);
	assert!(analysis.leaves.contains(&key));
}

fn argument_literal(source: &str) -> Option<String> {
	let commands = trees(source.as_bytes());
	literal(simple(root(&commands[0])).words().get(1).unwrap())
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
	use crate::bash::trace::syntax::{RootKind, SourceParent, SyntaxTree};
	let (tree, list) = trees(b"X=constant; echo $X\n").remove(0);
	let mut syntax = UnitSyntax::new(0, SyntaxTree::new(tree, list, RootKind::List));
	let mut walker = Walker::default();
	walker.root(&syntax);
	assert!(walker.finish().variables["X"].inline);
	syntax.parent = Some(SourceParent { unit: 9, node: 0, lo: 10, hi: 30 });
	let mut walker = Walker::default();
	walker.root(&syntax);
	assert!(!walker.finish().variables["X"].inline);

	let parsed = trees(b"echo ${VALUE:-$(date)}\n").remove(0);
	let command = root(&parsed);
	let (root_id, node) = (command.id(), command.node());
	let syntax = UnitSyntax::new(0, SyntaxTree::new(parsed.0, node, RootKind::Command));
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
	let program = trees(source.as_bytes());
	let analysis = analyzed(source);
	let command = root(&program[0]);
	let CommandKind::If(branch) = command.kind() else {
		panic!("if fixture")
	};
	let expected: Vec<_> = branch
		.arms()
		.map(|arm| NodeKey::engine(0, arm.cond.items().last().unwrap().and_or().id()))
		.collect();
	assert_eq!(analysis.branch_conditions[&NodeKey::engine(0, command.id())], expected);
	let last = arm(branch, 0).cond.items().last().unwrap().and_or();
	let false_command = last.first().stages().first().unwrap();
	assert!(
		analysis
			.guards
			.contains(&NodeKey::engine(0, false_command.id()))
	);
	let ordinary = last.rest().next().unwrap().1.stages().first().unwrap();
	assert!(!analysis.guards.contains(&NodeKey::engine(0, ordinary.id())));
	let command = root(&program[1]);
	let CommandKind::While(loop_) = command.kind() else {
		panic!("while fixture")
	};
	let condition = loop_.cond().items().last().unwrap().and_or();
	assert_eq!(analysis.branch_conditions[&NodeKey::engine(1, command.id())], vec![
		NodeKey::engine(1, condition.id())
	]);
	let first = condition.first().stages().first().unwrap();
	assert!(analysis.guards.contains(&NodeKey::engine(1, first.id())));
	let next = condition.rest().next().unwrap().1.stages().first().unwrap();
	assert!(analysis.guards.contains(&NodeKey::engine(1, next.id())));
}

#[test]
fn guards_are_only_the_final_direct_condition_not_nested_pipeline_leaves() {
	let source = "if echo before; test \"$(false)\"; then :; elif false | true; then :; fi\nwhile \
	              echo before; [[ x == y ]]; do :; done\n";
	let program = trees(source.as_bytes());
	let analysis = analyzed(source);
	let CommandKind::If(branch) = root(&program[0]).kind() else {
		panic!("if fixture")
	};
	let tested = item(arm(branch, 0).cond, 1);
	assert!(analysis.guards.contains(&NodeKey::engine(0, tested.id())));
	let before = item(arm(branch, 0).cond, 0);
	assert!(!analysis.guards.contains(&NodeKey::engine(0, before.id())));
	let sub = comsub(simple(tested).words().get(1).unwrap());
	let nested = item(sub.body(), 0);
	assert!(!analysis.guards.contains(&NodeKey::engine(0, nested.id())));
	let pipeline = arm(branch, 1)
		.cond
		.items()
		.first()
		.unwrap()
		.and_or()
		.first();
	for stage in pipeline.stages() {
		assert!(!analysis.guards.contains(&NodeKey::engine(0, stage.id())));
	}
	assert_eq!(analysis.guards.len(), 2);
}

#[test]
fn ownership_and_spans_use_canonical_ids_including_nested_words() {
	let source = "X=$(printf '%s' \"${Y:-$(date)}\") >\"$OUT\"\n";
	let program = trees(source.as_bytes());
	let (tree, list) = &program[0];
	let mut walker = Walker::default();
	walker.list(List::at(tree, *list), Context {
		restricted: false,
		background: false,
		order:      0,
	});
	let analysis = walker.finish();
	let command = root(&program[0]);
	let key = NodeKey::engine(0, command.id());
	let assignment = simple(command).assigns().first().unwrap();
	assert_eq!(analysis.owners[&NodeKey::engine(0, assignment.id())], key);
	let AssignValue::Scalar(word) = assignment.value() else {
		panic!("scalar fixture")
	};
	assert_eq!(analysis.owners[&NodeKey::engine(0, word.id())], key);
	let nested = item(comsub(word).body(), 0);
	assert_eq!(
		analysis.owners[&NodeKey::engine(0, simple(nested).words().get(1).unwrap().id())],
		NodeKey::engine(0, nested.id())
	);
	assert_eq!(analysis.spans[&key], command.span());
	assert!(analysis.leaves.contains(&key));
	let and_or = List::at(tree, *list).items().first().unwrap().and_or();
	assert!(
		!analysis
			.owners
			.contains_key(&NodeKey::engine(0, and_or.id()))
	);
}

#[test]
fn command_parents_follow_actual_compound_and_substitution_ancestry() {
	let source = "if true; then echo \"$(printf '%s' \"$(date)\")\"; fi\necho sibling\n";
	let program = trees(source.as_bytes());
	let analysis = analyzed(source);
	let command = root(&program[0]);
	let root_key = NodeKey::engine(0, command.id());
	assert!(!analysis.parents.contains_key(&root_key));
	let CommandKind::If(branch) = command.kind() else {
		panic!("if fixture")
	};
	let predicate = item(arm(branch, 0).cond, 0);
	assert_eq!(analysis.parents[&NodeKey::engine(0, predicate.id())], root_key);
	let echo = item(arm(branch, 0).body, 0);
	let echo_key = NodeKey::engine(0, echo.id());
	assert_eq!(analysis.parents[&echo_key], root_key);
	let printf = item(comsub(simple(echo).words().get(1).unwrap()).body(), 0);
	let printf_key = NodeKey::engine(0, printf.id());
	assert_eq!(analysis.parents[&printf_key], echo_key);
	let date = item(comsub(simple(printf).words().get(2).unwrap()).body(), 0);
	assert_eq!(analysis.parents[&NodeKey::engine(0, date.id())], printf_key);
	let sibling = root(&program[1]);
	assert!(
		!analysis
			.parents
			.contains_key(&NodeKey::engine(1, sibling.id()))
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
fn sd_is_a_write_only_when_it_edits_files_in_place() {
	for (script, writes) in [
		("sd foo bar file\n", true),
		// A file operand that expands at run time still names a file.
		("sd -f i foo bar \"$file\"\n", true),
		// After `--`, `-p` is FIND, not the preview flag.
		("sd -- -p bar file\n", true),
		("sd foo bar\n", false),
		// `-n` and `--flags` consume their values, leaving no file operand.
		("sd -n 1 foo bar\n", false),
		("sd --flags i foo bar\n", false),
		("sd -pF foo bar file\n", false),
		("sd foo bar file --preview\n", false),
	] {
		let analysis = analyzed(script);
		let wrote = analysis
			.effects
			.values()
			.flatten()
			.any(|effect| effect.kind == EffectKind::Write);
		assert_eq!(wrote, writes, "{script:?}");
	}
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
	let program = trees(b"if true; then echo yes; fi\n");
	let analysis = analyzed("if true; then echo yes; fi\n");
	let command = root(&program[0]);
	assert!(!analysis.leaves.contains(&NodeKey::engine(0, command.id())));
	assert_eq!(analysis.leaves.len(), 2);
}
