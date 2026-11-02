//! A long chain of one left-associative operator (`1 + 1 + …`, `a && a && …`,
//! `x -a x -a …`) runs like a short one. The parsers apply such an operator in
//! a loop, but the tree they build is as deep as the chain is long, and every
//! walk of that tree (the copy a parse cache hands out, evaluation, drop, and
//! display for `set -x` and `declare -f`) recursed once per operator: a few
//! thousand operators overflowed the stack and killed the whole process with no
//! message. Bash runs each of these scripts.
#![cfg(unix)]

use pi_shell::{Shell, ShellRunOptions, cancel::CancelToken};

/// Long enough that every chain below overflowed the test thread's stack
/// before, in debug and optimized builds.
const LONG: usize = 100_000;

/// `item` repeated `n` times, joined by `separator`.
fn chain(item: &str, separator: &str, n: usize) -> String {
	vec![item; n].join(separator)
}

/// Runs `script` through [`Shell::run`], the bash tool's entry point, and then
/// `echo alive` on the same shell, and checks that the first run ended with
/// `status` and that the shell still runs commands. Returns the first run's
/// output.
async fn run(script: String, status: i32) -> String {
	let shell = Shell::new(None);
	let mut outputs = Vec::new();
	for command in [script, "echo alive".to_owned()] {
		let (tx, rx) = flume::unbounded::<String>();
		let result = shell
			.run(
				ShellRunOptions { command, ..Default::default() },
				Some(tx),
				CancelToken::new(Some(120_000)),
			)
			.await
			.expect("shell run");
		outputs.push((result.exit_code, rx.drain().collect::<String>()));
	}
	let (_, probe) = outputs.pop().expect("probe run");
	let (code, output) = outputs.pop().expect("first run");
	let shown: String = output.chars().take(400).collect();
	assert_eq!(code, Some(status), "output: {shown}");
	assert_eq!(probe, "alive\n", "the shell did not run the next command");
	output
}

/// Defines one test per row, each checking a run's exact output and status.
///
/// The tests run the shell on a Tokio worker, as the bash tool does. (On a
/// single-threaded runtime, output larger than a pipe buffer never drains: the
/// shell blocks writing it, and the task that would read it cannot run.)
macro_rules! runs {
	($($name:ident: $script:expr => $output:expr, $status:literal;)*) => {
		$(
			#[tokio::test(flavor = "multi_thread")]
			async fn $name() {
				assert_eq!(run($script, $status).await, $output);
			}
		)*
	};
}

runs! {
	// Arithmetic: the parse cache hands out a copy, which is evaluated and dropped.
	arithmetic_sum: format!("echo $(( {} ))", chain("1", "+", LONG)) => format!("{LONG}\n"), 0;
	arithmetic_mixed_operators: format!("echo $(( {} ))", chain("2*3-1", "+", LONG)) => format!("{}\n", 5 * LONG), 0;
	arithmetic_in_a_variable: format!("x='{}'; echo $(( x ))", chain("1", "+", LONG)) => format!("{LONG}\n"), 0;
	arithmetic_assignment: format!("z=1; (( z += {} )); echo $z", chain("1", "+", LONG)) => format!("{}\n", LONG + 1), 0;
	// `&&` and `||` evaluate their right operand only when the left one does
	// not decide the result, all along the chain.
	arithmetic_short_circuit: format!(
		"y=0; echo $(( {}&&0&&(y=1) ))-$(( {}||1||(y=2) ))-$y",
		chain("1", "&&", LONG),
		chain("0", "||", LONG),
	) => "0-1-0\n".to_owned(), 0;
	// An error in the expression drops the tree the parser or evaluation built.
	arithmetic_division_by_zero: format!("echo $(( {}+1/0 ))", chain("1", "+", LONG)) => "error: arithmetic evaluation error: division by zero\n".to_owned(), 1;
	// `[[ ]]`: the program the parse cache hands out is a copy.
	conditional_and: format!("[[ {} ]] && echo yes", chain("a", " && ", LONG)) => "yes\n".to_owned(), 0;
	conditional_or: format!("[[ {} || a ]] && echo yes", chain("''", " || ", LONG)) => "yes\n".to_owned(), 0;
	conditional_short_circuit: format!(
		"y=0; [[ {} && '' && $((y=1)) -eq 1 ]]; echo $? $y",
		chain("a", " && ", LONG),
	) => "1 0\n".to_owned(), 0;
	// Parsed, copied and dropped, never evaluated.
	conditional_not_run: format!("false && [[ {} ]]; echo yes", chain("a", " && ", LONG)) => "yes\n".to_owned(), 0;
	// `test` and `[`.
	test_and: format!("[ {} ] && echo yes", chain("x", " -a ", LONG)) => "yes\n".to_owned(), 0;
	test_or: format!("test {} -o x && echo yes", chain("''", " -o ", LONG)) => "yes\n".to_owned(), 0;
	// `set -x` and `declare -f` write the expression back out.
	arithmetic_command_traced: format!("set -x; (( {} )); set +x", chain("1", "+", LONG))
		=> format!("+ (( {} ))\n+ set +x\n", chain("1", " + ", LONG)), 0;
	conditional_in_declared_function: format!("f() {{ [[ {} ]]; }}; declare -f f", chain("a", " && ", LONG))
		=> format!("f () \n{{ \n    [[ {} ]]\n}}\n", chain("-n a", " && ", LONG)), 0;
	// A chain that ends without its last operand is a syntax error, and the
	// tree built up to that point is dropped.
	arithmetic_unfinished: format!("echo $(( {} + ))", chain("1", "+", LONG))
		=> format!("error: arithmetic evaluation error: failed to parse expression:  {} + \n", chain("1", "+", LONG)), 1;
	conditional_unfinished: format!("[[ {} && ]]", chain("a", " && ", LONG))
		=> "error: pi-natives:command: syntax error at end of input\n".to_owned(), 2;
	test_unfinished: format!("[ {} -a ]", chain("x", " -a ", LONG)) => "error: [: invalid test command\n".to_owned(), 2;
}

/// Chains of every length from 1 to 40 operators, which crosses the lengths at
/// which evaluation stops recursing and the operands spill from the stack into
/// a list. Bash 5.2 prints the same output for this script.
#[tokio::test(flavor = "multi_thread")]
async fn chains_of_every_length_around_the_limits() {
	let mut script = String::new();
	let mut expected = String::new();
	for n in 1..=40_usize {
		// `5 - 1 + 3 - 7 - 1 …`: grouped from the right, it sums to
		// another value.
		let mut text = "5".to_owned();
		let mut value: i64 = 5;
		for i in 0..n {
			let operand = [1, 3, 7][i % 3];
			if i % 3 == 1 {
				text.push_str(&format!(" + {operand}"));
				value += operand;
			} else {
				text.push_str(&format!(" - {operand}"));
				value -= operand;
			}
		}
		script.push_str(&format!("echo $(( {text} ))\n"));
		expected.push_str(&format!("{value}\n"));

		// `[[ ]]` and `[ ]`: `&&` of true operands and `||` of false
		// ones. On even lengths the last operand flips the result, so
		// it must be evaluated.
		let flip = n % 2 == 0;
		for is_and in [true, false] {
			let (cond_op, test_op) = if is_and { ("&&", "-a") } else { ("||", "-o") };
			let operand = |i: usize| {
				if is_and != (flip && i == n) {
					("a", "x")
				} else {
					("''", "''")
				}
			};
			let (mut cond, mut test) = (operand(0).0.to_owned(), operand(0).1.to_owned());
			for i in 1..=n {
				let (cond_operand, test_operand) = operand(i);
				cond.push_str(&format!(" {cond_op} {cond_operand}"));
				test.push_str(&format!(" {test_op} {test_operand}"));
			}
			let status = u8::from(is_and == flip);
			script.push_str(&format!("[[ {cond} ]]; echo $?\n[ {test} ]; echo $?\n"));
			expected.push_str(&format!("{status}\n{status}\n"));
		}
	}
	assert_eq!(run(script, 0).await, expected);
}
