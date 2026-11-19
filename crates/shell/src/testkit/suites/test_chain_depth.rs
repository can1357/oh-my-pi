//! Long operator chains in the `test` and `[` builtins, in both dialects.
//!
//! A chain of one operator — `-a`, `-o` or a run of `!` — is a flat list of
//! terms, not nesting, so its length must be bounded only by the argument
//! list: Bash 5.2.21 and Bash 5.3.0 both answer a 100,000-term chain.
//! Parentheses are real nesting and keep the parser's
//! [`MAX_NESTING`](crate::bash::syntax::MAX_NESTING) policy: past the limit
//! the expression is reported as an error, never a crash.
//!
//! Every case runs inside a 2 MiB stack, the default the shells run on, so a
//! stack frame per operator overflows here instead of borrowing the test
//! runner's larger stack.

use crate::{
	bash::{ModeId, Script, ShellInit, syntax::MAX_NESTING},
	testkit::{FakeHost, Fault, Rig, fault::skeleton_init, run_script},
};

/// The length every "no limit but the argument list" case uses. The crash
/// this suite guards against arrived at about 37,240 terms.
const TERMS: usize = 100_000;

/// The parenthesis depth the builtins accept, `MAX_NESTING`.
const LIMIT: usize = MAX_NESTING as usize;

/// The stack the shells run on by default.
const STACK: usize = 2 << 20;

/// bash dialect: stdout, stderr, status.
fn bash(src: &str) -> (String, String, i32) {
	let out = run_script(FakeHost::new(), src.as_bytes(), &[], Fault::None);
	(
		String::from_utf8_lossy(&out.stdout).into_owned(),
		String::from_utf8_lossy(&out.stderr).into_owned(),
		out.status,
	)
}

/// zsh dialect: stdout, stderr, status.
fn zsh(src: &str) -> (String, String, i32) {
	let init = ShellInit { mode: ModeId::Zsh, argv0: "zsh".into(), ..skeleton_init(&[]) };
	let mut rig = Rig::new(FakeHost::new(), init);
	let status = rig.run(Script::command(src.as_bytes().to_vec()), Fault::None);
	(
		String::from_utf8_lossy(&rig.host.stdout.bytes()).into_owned(),
		String::from_utf8_lossy(&rig.host.stderr.bytes()).into_owned(),
		status,
	)
}

/// Run `f` on the stack the shells run on.
fn on_a_shell_stack(f: impl FnOnce() + Send + 'static) {
	std::thread::Builder::new()
		.stack_size(STACK)
		.spawn(f)
		.expect("spawn")
		.join()
		.expect("the shell must answer a long chain without overflowing its stack");
}

/// `term(i)` for truth pattern `p`: a non-empty word is true, `''` false.
fn term(p: usize, i: usize) -> &'static str {
	let truth = match p {
		0 => true,
		1 => false,
		2 => i != 0,
		3 => i % 2 == 0,
		_ => i % 3 != 0,
	};
	if truth { "x" } else { "''" }
}

/// What `term(p, i)` is worth.
fn truth(p: usize, i: usize) -> bool {
	term(p, i) == "x"
}

/// `[ t0 -a t1 … ]` and its value: bash folds the whole chain, so the
/// expression is true when every term is.
fn and_chain(p: usize, n: usize) -> (String, bool) {
	let terms: Vec<&str> = (0..n).map(|i| term(p, i)).collect();
	(format!("[ {} ]", terms.join(" -a ")), (0..n).all(|i| truth(p, i)))
}

/// `[ t0 -o t1 … ]` and its value.
fn or_chain(p: usize, n: usize) -> (String, bool) {
	let terms: Vec<&str> = (0..n).map(|i| term(p, i)).collect();
	(format!("[ {} ]", terms.join(" -o ")), (0..n).any(|i| truth(p, i)))
}

/// `[ t0 -a t1 -o t2 -a t3 … ]` and its value: `-a` binds tighter, so the
/// expression is the disjunction of the conjunction groups.
fn mixed_chain(p: usize, n: usize) -> (String, bool) {
	let mut src = String::from("[ ");
	let mut value = false;
	let mut group = true;
	for i in 0..n {
		if i > 0 {
			if i % 2 == 1 {
				src.push_str(" -a ");
			} else {
				src.push_str(" -o ");
				value |= group;
				group = true;
			}
		}
		src.push_str(term(p, i));
		group &= truth(p, i);
	}
	src.push_str(" ]");
	(src, value | group)
}

/// `[ ! ! … t ]` and its value: an even run of `!` cancels.
fn bang_chain(p: usize, n: usize) -> (String, bool) {
	(format!("[ {}{} ]", "! ".repeat(n), term(p, 0)), truth(p, 0) != (n % 2 == 1))
}

/// `[ ( ( … x -a x -a x … ) ) ]`: `depth` parentheses around a group the
/// POSIX argument-count rules do not shortcut, so each one is real nesting.
fn paren_group(depth: usize) -> String {
	format!("[ {}x -a x -a x{} ]", "'(' ".repeat(depth), " ')'".repeat(depth))
}

/// Every chain shape at [`TERMS`] terms, with the status it must report.
fn long_chains() -> Vec<(String, String, i32)> {
	let mut cases = Vec::new();
	for (shape, build) in [
		("-a chain", and_chain as fn(usize, usize) -> (String, bool)),
		("-o chain", or_chain),
		("-a/-o chain", mixed_chain),
		("! run", bang_chain),
	] {
		for p in [0, 2] {
			let (src, want) = build(p, TERMS);
			cases.push((format!("{shape}, pattern {p}"), src, i32::from(!want)));
		}
	}
	cases
}

#[test]
fn bash_test_chains_of_one_operator_are_bounded_only_by_the_argument_list() {
	on_a_shell_stack(|| {
		for (name, src, want) in long_chains() {
			let (_, err, status) = bash(&format!("{src}\n"));
			assert_eq!(err, "", "{name}");
			assert_eq!(status, want, "{name}");
		}
		// `test` is the same grammar without the closing bracket.
		let (src, _) = and_chain(0, TERMS);
		let src = src.replace("[ ", "test ").replace(" ]", "");
		let (_, err, status) = bash(&format!("{src}\n"));
		assert_eq!((err.as_str(), status), ("", 0), "test -a chain");
	});
}

#[test]
fn zsh_test_chains_of_one_operator_are_bounded_only_by_the_argument_list() {
	on_a_shell_stack(|| {
		for (name, src, want) in long_chains() {
			let (_, err, status) = zsh(&format!("{src}\n"));
			assert_eq!(err, "", "{name}");
			assert_eq!(status, want, "{name}");
		}
	});
}

#[test]
fn test_chains_are_exact_from_one_to_forty_terms_in_both_dialects() {
	on_a_shell_stack(|| {
		for n in 1..=40usize {
			for p in 0..5usize {
				for (shape, build) in [
					("-a chain", and_chain as fn(usize, usize) -> (String, bool)),
					("-o chain", or_chain),
					("-a/-o chain", mixed_chain),
					("! run", bang_chain),
				] {
					let (src, want) = build(p, n);
					let want = i32::from(!want);
					let (_, err, status) = bash(&format!("{src}\n"));
					assert_eq!((err.as_str(), status), ("", want), "bash {shape} n={n} p={p}");
					let (_, err, status) = zsh(&format!("{src}\n"));
					assert_eq!((err.as_str(), status), ("", want), "zsh {shape} n={n} p={p}");
				}
			}
		}
	});
}

#[test]
fn test_parenthesis_nesting_is_reported_past_the_limit_in_both_dialects() {
	on_a_shell_stack(|| {
		for (dialect, run) in [("bash", bash as fn(&str) -> (String, String, i32)), ("zsh", zsh)] {
			let (_, err, status) = run(&format!("{}\n", paren_group(LIMIT)));
			assert_eq!((err.as_str(), status), ("", 0), "{dialect} at the limit");
			for depth in [LIMIT + 1, TERMS] {
				let (_, err, status) = run(&format!("{}\n", paren_group(depth)));
				assert_eq!(status, 2, "{dialect} at {depth}: {err}");
				assert!(err.contains("maximum nesting level exceeded"), "{dialect} at {depth}: {err}");
			}
		}
	});
}

/// Build a `[` expression from an explicit argument list.
fn bracket(args: &[&str]) -> String {
	format!("[ {} ]\n", args.join(" "))
}

/// zsh short-circuits `-a` (stops at the first non-zero status) and `-o`
/// (stops at the first status that is not 1 or 3).  bash evaluates every
/// term.  An error in a later term (`1 -eq abc`) is the oracle: if
/// short-circuit is correct, the error is never reached and the status
/// comes from the short-circuiting term alone.
///
/// These three rows, plus a long-chain variant, are the exactness guard
/// for the `break` in `evalcond`'s `And`/`Or` arms.
#[test]
fn test_zsh_short_circuit_skips_errors_and_bash_does_not() {
	on_a_shell_stack(|| {
		// Row 1: `[ '' -a 1 -eq abc ]`
		// zsh: `''` is false (status 1), -a stops → rc=1, no stderr.
		// bash: evaluates `1 -eq abc` → rc=2, stderr.
		let src = bracket(&["''", "-a", "1", "-eq", "abc"]);
		let (_, err, rc) = zsh(&src);
		assert_eq!((rc, err.as_str()), (1, ""), "zsh: '' -a 1 -eq abc");
		let (_, err, rc) = bash(&src);
		assert_eq!(rc, 2, "bash: '' -a 1 -eq abc");
		assert!(err.contains("integer"), "bash stderr: {err}");

		// Row 2: `[ x -o 1 -eq abc ]`
		// zsh: `x` is true (status 0), -o stops → rc=0, no stderr.
		// bash: evaluates `1 -eq abc` → rc=2, stderr.
		let src = bracket(&["x", "-o", "1", "-eq", "abc"]);
		let (_, err, rc) = zsh(&src);
		assert_eq!((rc, err.as_str()), (0, ""), "zsh: x -o 1 -eq abc");
		let (_, err, rc) = bash(&src);
		assert_eq!(rc, 2, "bash: x -o 1 -eq abc");
		assert!(err.contains("integer"), "bash stderr: {err}");

		// Row 3: `[ x -a 1 -eq abc ]`
		// Both: `x` is true, -a continues, `1 -eq abc` errors → rc=2.
		let src = bracket(&["x", "-a", "1", "-eq", "abc"]);
		let (_, err, rc) = zsh(&src);
		assert_eq!(rc, 2, "zsh: x -a 1 -eq abc");
		assert!(err.contains("integer"), "zsh stderr: {err}");
		let (_, err, rc) = bash(&src);
		assert_eq!(rc, 2, "bash: x -a 1 -eq abc");
		assert!(err.contains("integer"), "bash stderr: {err}");

		// Long-chain variant: 100,000 terms of '' then -a 1 -eq abc.
		// zsh: first '' short-circuits the whole chain → rc=1, no stderr.
		let mut args: Vec<&str> = Vec::with_capacity(TERMS * 2 + 3);
		args.push("''");
		for _ in 1..TERMS {
			args.push("-a");
			args.push("''");
		}
		args.push("-a");
		args.push("1");
		args.push("-eq");
		args.push("abc");
		// Trailing `]` is added by bracket().
		let src = bracket(&args);
		let (_, err, rc) = zsh(&src);
		assert_eq!((rc, err.as_str()), (1, ""), "zsh: 100k '' -a ... 1 -eq abc");
	});
}
