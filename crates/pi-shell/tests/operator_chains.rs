//! Flat operator chains run through the bash tool's `Shell::run` entry point,
//! including error cleanup, short circuiting, tracing and function display.
//! Conditional chains and runs of `!` must not build a tree as deep as the
//! chain: parsing, copying, lowering, printing and dropping it must all
//! survive 100,000 terms.
#![cfg(unix)]

use pi_shell::{Shell, ShellRunOptions, cancel::CancelToken};

/// Long enough to overflow the old conditional parser and `test` evaluator.
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
	let (probe_code, probe) = outputs.pop().expect("probe run");
	let (code, output) = outputs.pop().expect("first run");
	let shown: String = output.chars().take(400).collect();
	assert_eq!(code, Some(status), "output: {shown}");
	assert_eq!(probe_code, Some(0), "the next command failed");
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
	arithmetic_division_by_zero: format!("echo $(( {}+1/0 ))", chain("1", "+", LONG))
		=> format!("bash: line 1: {}+1/0 : division by 0 (error token is \"0 \")\n", chain("1", "+", LONG)), 1;
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
		=> format!("+ ((  {}  ))\n+ set +x\n", chain("1", "+", LONG)), 0;
	conditional_in_declared_function: format!("f() {{ [[ {} ]]; }}; declare -f f", chain("a", " && ", LONG))
		=> format!("f () \n{{ \n    [[ {} ]]\n}}\n", chain("-n a", " && ", LONG)), 0;
	// A chain that ends without its last operand is a syntax error, and the
	// tree built up to that point is dropped.
	arithmetic_unfinished: format!("echo $(( {} + ))", chain("1", "+", LONG))
		=> format!("bash: line 1: {} + : arithmetic syntax error: operand expected (error token is \"+ \")\n", chain("1", "+", LONG)), 1;
	conditional_unfinished: format!("[[ {} && ]]", chain("a", " && ", LONG))
		=> format!("bash: -c: line 1: syntax error near `]]'\nbash: -c: line 1: `[[ {} && ]]'\n", chain("a", " && ", LONG)), 2;
	test_unfinished: format!("[ {} -a ]", chain("x", " -a ", LONG)) => "bash: line 1: [: argument expected\n".to_owned(), 2;
	// A run of `!`s in `[[ ]]`: an even number leaves the operand's result,
	// an odd one inverts it. `set -x` and `declare -f` show one `!` for an odd
	// run and none for an even one, as Bash 5.3 does.
	conditional_bang_run_even: format!("[[ {}a ]]; echo $?", "! ".repeat(LONG)) => "0\n".to_owned(), 0;
	conditional_bang_run_odd: format!("[[ {}a ]]; echo $?", "! ".repeat(LONG + 1)) => "1\n".to_owned(), 0;
	conditional_bang_run_not_run: format!("false && [[ {}a ]]; echo yes", "! ".repeat(LONG)) => "yes\n".to_owned(), 0;
	conditional_bang_run_traced: format!("set -x; [[ {}a ]]; set +x", "! ".repeat(LONG + 1))
		=> "+ [[ ! -n a ]]\n+ set +x\n".to_owned(), 0;
	conditional_bang_run_in_declared_function: format!(
		"f() {{ [[ {}a && {}-z b ]]; }}; declare -f f",
		"! ".repeat(LONG + 1),
		"! ".repeat(LONG),
	) => "f () \n{ \n    [[ ! -n a && -z b ]]\n}\n".to_owned(), 0;
}

/// Every length from 1 to 40 operators, with a final operand that changes the
/// result on alternate lengths. The arithmetic row also fixes associativity.
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
