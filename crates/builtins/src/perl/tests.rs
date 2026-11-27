//! Differential corpus for Perl 5.34 (see perlrun and perldiag).
//!
//! `tests/corpus/<area>.tsv` holds one case per line; lines starting with `#`
//! and blank lines are ignored. Fields are separated by tabs:
//!
//! 1. the case name, also the script's file name (`<name>.pl`) in diagnostics;
//! 2. the script, or empty when `-e`/`-E` arguments carry the program;
//! 3. the expected stdout;
//! 4. then any number of `key=value` fields: inputs `arg=` (one argv entry,
//!    repeatable, in order), `stdin=`, `file:PATH=` (seeded into the fresh cwd
//!    before the run), and expectations `stderr=` (checked only when present),
//!    `status=` (absent means 0), `after:PATH=` (the file's contents after the
//!    run).
//!
//! Every field is UTF-8 with control characters written as their Unicode
//! control pictures, so a case stays on one line: `␊` is a newline, `␉` a tab,
//! `␍` a carriage return, U+2400..=U+241F the other C0 controls and `␡` DEL.
//! The script field omits the file's final newline. Expectations come from
//! `/usr/bin/perl` 5.34 via `tests/corpus/regen.pl`; never edit them by hand.
//! `PERL_CORPUS` selects cases by substring of `area/name`.

use std::{fmt::Write as _, fs, path::Path};

use crate::host::run_extra_bytes;

/// One corpus line.
struct Case {
	name:   String,
	script: Option<Vec<u8>>,
	stdout: Vec<u8>,
	args:   Vec<String>,
	stdin:  Vec<u8>,
	files:  Vec<(String, Vec<u8>)>,
	stderr: Option<Vec<u8>>,
	status: i32,
	after:  Vec<(String, Vec<u8>)>,
}

/// Undoes the control-picture encoding of a field.
fn decode(field: &str) -> Vec<u8> {
	let mut out = Vec::with_capacity(field.len());
	for ch in field.chars() {
		match u32::from(ch) {
			// Both ranges are single bytes by construction.
			pic @ 0x2400..=0x241f => out.push((pic - 0x2400) as u8),
			0x2421 => out.push(0x7f),
			_ => out.extend_from_slice(ch.encode_utf8(&mut [0; char::MAX_LEN_UTF8]).as_bytes()),
		}
	}
	out
}

fn parse(line: &str) -> Result<Case, String> {
	let mut fields = line.split('\t');
	let (Some(name), Some(script), Some(stdout)) = (fields.next(), fields.next(), fields.next()) else {
		return Err("expected name, script and stdout fields".into());
	};
	let mut case = Case {
		name:   name.to_owned(),
		script: (!script.is_empty()).then(|| decode(script)),
		stdout: decode(stdout),
		args:   Vec::new(),
		stdin:  Vec::new(),
		files:  Vec::new(),
		stderr: None,
		status: 0,
		after:  Vec::new(),
	};
	for field in fields {
		let (key, value) = field.split_once('=').ok_or_else(|| format!("field without a key: {field:?}"))?;
		match key {
			"arg" => case.args.push(String::from_utf8(decode(value)).map_err(|err| err.to_string())?),
			"stdin" => case.stdin = decode(value),
			"stderr" => case.stderr = Some(decode(value)),
			"status" => case.status = value.parse().map_err(|_| format!("bad status {value:?}"))?,
			_ => match (key.strip_prefix("file:"), key.strip_prefix("after:")) {
				(Some(path), _) => case.files.push((path.to_owned(), decode(value))),
				(_, Some(path)) => case.after.push((path.to_owned(), decode(value))),
				_ => return Err(format!("unknown key {key:?}")),
			},
		}
	}
	Ok(case)
}

fn diff(label: &str, expected: &[u8], actual: &[u8], differences: &mut String) {
	if expected == actual {
		return;
	}
	let _ = writeln!(differences, "  {label}: expected {} bytes, got {}", expected.len(), actual.len());
	let mut expected = expected.split_inclusive(|&byte| byte == b'\n');
	let mut actual = actual.split_inclusive(|&byte| byte == b'\n');
	let mut shown = 0;
	for line in 1.. {
		let exp = expected.next();
		let got = actual.next();
		if exp.is_none() && got.is_none() {
			break;
		}
		if exp != got {
			let render = |bytes: Option<&[u8]>| match bytes {
				None => "<missing>".into(),
				Some(bytes) => format!(
					"{:?}{}",
					bytes[..bytes.len().min(160)].escape_ascii().to_string(),
					if bytes.len() > 160 { "…" } else { "" }
				),
			};
			let _ = writeln!(differences, "    line {line}: -{} +{}", render(exp), render(got));
			shown += 1;
			if shown == 10 {
				break;
			}
		}
	}
}

async fn run_case(case: &Case) -> Result<String, Box<dyn std::error::Error>> {
	let cwd = tempfile::tempdir()?;
	for (path, contents) in &case.files {
		let path = cwd.path().join(path);
		fs::create_dir_all(path.parent().unwrap_or(cwd.path()))?;
		fs::write(path, contents)?;
	}
	let script_name = format!("{}.pl", case.name);
	let mut argv = vec!["perl"];
	argv.extend(case.args.iter().map(String::as_str));
	if let Some(script) = &case.script {
		let mut source = script.clone();
		source.push(b'\n');
		fs::write(cwd.path().join(&script_name), source)?;
		argv.push(&script_name);
	}
	// The corpus measures this builtin's own behaviour, never the system perl's.
	let (status, stdout, stderr) =
		run_extra_bytes(&argv, &case.stdin, cwd.path(), &[("OMP_PERL_FALLBACK", "0")]).await;
	let mut differences = String::new();
	if status != case.status {
		let _ = writeln!(differences, "  status: expected {}, got {status}", case.status);
	}
	diff("stdout", &case.stdout, &stdout, &mut differences);
	match &case.stderr {
		Some(expected) => diff("stderr", expected, &stderr, &mut differences),
		None if status != case.status && !stderr.is_empty() => {
			diff("stderr (context)", b"", &stderr, &mut differences);
		},
		None => {},
	}
	for (path, expected) in &case.after {
		match fs::read(cwd.path().join(path)) {
			Ok(actual) => diff(&format!("after {path}"), expected, &actual, &mut differences),
			Err(err) => {
				let _ = writeln!(differences, "  after {path}: {err}");
			},
		}
	}
	Ok(differences)
}

/// A signal's default action ends the program where it stands, as the
/// kernel kills perl: status 128 + the signal, and no END block, destructor
/// or buffered output. SIGPIPE stops a print loop into a pipe nobody reads
/// (it used to spin forever), and output still buffered at exit, after END.
/// The corpus cannot hold these cases: its oracle dies of the signal itself.
#[tokio::test]
async fn signal_default_action_ends_the_program() {
	const LEFTOVERS: &str = "END { print STDERR 'END' } sub DESTROY { print STDERR 'DESTROY' } my $o = bless {}; \
	                         open F, '>', 'out' or die; print F 'buffered';";
	let cwd = tempfile::tempdir().unwrap();
	let run = async |script: &str| {
		let (status, _, stderr) =
			run_extra_bytes(&["perl", "-e", script], b"", cwd.path(), &[("OMP_PERL_FALLBACK", "0")]).await;
		(status, String::from_utf8_lossy_owned(stderr))
	};
	for (death, status) in [
		("pipe(R, W) or die; close R; select W; $| = 1; print 1 while 1;", 141),
		("kill 'TERM', $$; print STDERR 'survived';", 143),
	] {
		assert_eq!(run(&format!("{LEFTOVERS} {death}")).await, (status, String::new()), "{death}");
		assert_eq!(fs::read(cwd.path().join("out")).unwrap(), b"", "{death}");
	}
	let at_exit = "END { print STDERR 'END' } pipe(R, W) or die; close R; print W 'buffered';";
	assert_eq!(run(at_exit).await, (141, "END".into()));
}

#[tokio::test]
async fn corpus() {
	let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/perl/tests/corpus");
	let filter = std::env::var("PERL_CORPUS").unwrap_or_default();
	let mut areas: Vec<_> = fs::read_dir(&root)
		.unwrap()
		.map(|entry| entry.unwrap().path())
		.filter(|path| path.extension().is_some_and(|ext| ext == "tsv"))
		.collect();
	areas.sort_unstable();
	let (mut selected, mut failed) = (0, 0);
	for area in areas {
		let area_name = area.file_stem().unwrap().to_string_lossy().into_owned();
		let text = fs::read_to_string(&area).unwrap();
		let (mut total, mut passed) = (0, 0);
		for (number, line) in text.lines().enumerate() {
			if line.is_empty() || line.starts_with('#') {
				continue;
			}
			let case = parse(line).unwrap_or_else(|err| panic!("{area_name}.tsv:{}: {err}", number + 1));
			let id = format!("{area_name}/{}", case.name);
			if !id.contains(&filter) {
				continue;
			}
			total += 1;
			match run_case(&case).await {
				Ok(diff) if diff.is_empty() => passed += 1,
				Ok(diff) => eprintln!("{id}:\n{diff}"),
				Err(err) => eprintln!("{id}: fixture error: {err}"),
			}
		}
		if total != 0 {
			eprintln!("{area_name}: {passed}/{total} passed");
		}
		selected += total;
		failed += total - passed;
	}
	assert!(selected > 0, "no Perl corpus cases matched {filter:?}");
	assert_eq!(failed, 0, "{failed}/{selected} Perl corpus cases failed");
}
