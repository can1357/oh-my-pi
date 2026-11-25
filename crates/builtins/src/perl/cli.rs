//! Perl startup, switch processing, and generated program text (perlrun).

use std::{
	borrow::Cow,
	collections::VecDeque,
	ffi::OsString,
	io::{self, Read as _, Write as _},
	path::PathBuf,
	rc::Rc,
};

use crate::host::{Host, Utility, os_bytes_lossy, strip_errno};

use super::{
	Perl,
	interp::{Flow, Interp, Setup, WarnSwitch},
	io::{RecordSep, ShellSpec, spawn_system_in, wait_cancellable},
	modules,
	value::{PStr, Value},
};

const HELP: &str = r"
Usage: perl [switches] [--] [programfile] [arguments]
  -0[octal/hexadecimal] specify record separator (\0, if no argument)
  -a                    autosplit mode with -n or -p (splits $_ into @F)
  -C[number/list]       enables the listed Unicode features
  -c                    check syntax only (runs BEGIN and CHECK blocks)
  -d[t][:MOD]           run program under debugger or module Devel::MOD
  -D[number/letters]    set debugging flags (argument is a bit mask or alphabets)
  -e commandline        one line of program (several -e's allowed, omit programfile)
  -E commandline        like -e, but enables all optional features
  -f                    don't do $sitelib/sitecustomize.pl at startup
  -F/pattern/           split() pattern for -a switch (//'s are optional)
  -i[extension]         edit <> files in place (makes backup if extension supplied)
  -Idirectory           specify @INC/#include directory (several -I's allowed)
  -l[octnum]            enable line ending processing, specifies line terminator
  -[mM][-]module        execute use/no module before executing program
  -n                    assume 'while (<>) { ... }' loop around program
  -p                    assume loop like -n but print line also, like sed
  -s                    enable rudimentary parsing for switches after programfile
  -S                    look for programfile using PATH environment variable
  -t                    select taint warning mode (compatibility only)
  -T                    select taint mode (compatibility only; no checks)
  -u                    dump core after parsing program
  -U                    allow unsafe operations
  -v                    print version, patchlevel and license
  -V[:configvar]        print configuration summary (or a single Config.pm variable)
  -w                    enable many useful warnings
  -W                    enable all warnings
  -x[directory]         ignore text before #!perl line (optionally cd to directory)
  -X                    disable all warnings

Run 'perldoc perl' for more help with Perl.

";

#[derive(Clone, Copy, PartialEq, Eq)]
enum Origin {
	Argv,
	Environment,
	Shebang,
}

#[derive(Clone, Copy)]
enum Display {
	Help,
	Version,
}

#[derive(Default)]
struct Options {
	inline: Option<Vec<u8>>,
	features: bool,
	loop_input: bool,
	print: bool,
	split: bool,
	pattern: Vec<u8>,
	chomp: bool,
	input_sep: Option<RecordSep>,
	output_sep: Option<PStr>,
	inplace: Option<Vec<u8>>,
	prelude: Vec<u8>,
	inc: VecDeque<PStr>,
	warn: WarnSwitch,
	taint: i64,
	unicode: u32,
	switches: bool,
	search: bool,
	extract: Option<Vec<u8>>,
	check: bool,
	dump: bool,
	/// A switch this builtin cannot honour (`-d`, `-D`, `-u`, `-U`) was seen.
	unsupported: bool,
	display: Option<Display>,
	config: Vec<Vec<u8>>,
}

impl Options {
	fn parse(&mut self, args: &[&[u8]], origin: Origin, stderr: &mut impl io::Write) -> Result<usize, String> {
		let mut next = 0;
		while let Some(&arg) = args.get(next) {
			if origin != Origin::Environment && arg == b"--" {
				return Ok(next + 1);
			}
			let mut flags = match arg.strip_prefix(b"-") {
				Some(b"") if origin == Origin::Argv => break,
				Some(flags) => flags,
				None if origin == Origin::Environment => arg,
				None if origin == Origin::Shebang => { next += 1; continue; },
				None => break,
			};
			next += 1;
			if origin == Origin::Argv && flags.starts_with(b"-") {
				self.display = Some(match flags {
					b"-help" => Display::Help,
					b"-version" => Display::Version,
					_ => return Err(unknown(flags)),
				});
				break;
			}
			if origin == Origin::Environment {
				let flag = flags.first().copied().unwrap_or(b'-');
				if !b"CDIMUWdmtw".contains(&flag) {
					return Err(format!("Illegal switch in PERL5OPT: -{}", char::from(flag)));
				}
			}
			while let Some((&flag, rest)) = flags.split_first() {
				flags = rest;
				if origin == Origin::Shebang {
					match flag {
						b'e' | b'E' | b'f' | b'S' | b'V' | b'x' => {
							return Err(format!("Can't emulate -{} on #! line", char::from(flag)));
						},
						b'm' | b'M' => return Err(format!("Too late for \"-{}{}\" option", char::from(flag), String::from_utf8_lossy(rest))),
						_ => {},
					}
				}
				match flag {
					b'0' => {
						let hex = rest.strip_prefix(b"x").filter(|s| !s.is_empty() && s.iter().all(u8::is_ascii_hexdigit));
						let sep = if let Some(digits) = hex {
							let value = number(digits, 16);
							if value == u32::MAX { return Err("Integer overflow in hexadecimal number".into()); }
							flags = b"";
							RecordSep::Text(PStr::from_codepoints([value]))
						} else {
							let (digits, tail) = octal(rest, 3);
							flags = tail;
							match number(digits, 8) {
								0 if !digits.is_empty() => RecordSep::Paragraph,
								value @ 0..=255 => RecordSep::Text(PStr::from_bytes(&[value as u8])),
								_ => RecordSep::Slurp,
							}
						};
						self.input_sep = Some(sep);
					},
					b'a' => { self.split = true; self.loop_input = true; },
					b'c' => self.check = true,
					b'C' => {
						let value = unicode(rest)?;
						if origin == Origin::Shebang && value != self.unicode {
							return Err(format!("Too late for \"-C{}\" option", String::from_utf8_lossy(rest)));
						}
						self.unicode = value;
						flags = b"";
					},
					b'd' => {
						self.unsupported = true;
						let debugger = rest.strip_prefix(b"t").unwrap_or(rest);
						if let Some(module) = debugger.strip_prefix(b":").filter(|s| !s.is_empty()) {
							let (prefix, module) = if let Some(name) = module.strip_prefix(b"-") { (b"-Devel::".as_slice(), name) } else { (b"Devel::".as_slice(), module) };
							let mut name = prefix.to_vec();
							name.extend_from_slice(module);
							self.module(b'M', &name)?;
							flags = b"";
						} else {
							return Err("Perl debugger is not available in the omp builtin".into());
						}
					},
					b'D' => {
						self.unsupported = true;
						let _ = writeln!(stderr, "Recompile perl with -DDEBUGGING to use -D switch (did you mean -d ?)");
						let n = if rest.first().is_some_and(u8::is_ascii_digit) {
							rest.iter().take_while(|b| b.is_ascii_digit()).count()
						} else {
							rest.iter().take_while(|b| b"psltocPmfrxuUXDSTRJvCAqMBLiy".contains(b)).count()
						};
						flags = &rest[n..];
					},
					b'e' | b'E' => {
						let code = if rest.is_empty() {
							let code = args.get(next).ok_or_else(|| format!("No code specified for -{}", char::from(flag)))?;
							next += 1;
							*code
						} else { rest };
						let source = self.inline.get_or_insert_with(Vec::new);
						source.extend_from_slice(code);
						source.push(b'\n');
						self.features |= flag == b'E';
						flags = b"";
					},
					b'F' => {
						self.split = true;
						self.loop_input = true;
						self.pattern = rest.to_vec();
						flags = b"";
					},
					b'f' => {}, // No sitecustomize in this build.
					b'U' => self.unsupported = true, // No unsafe mode; accepted when nothing can take over.
					b'i' => { self.inplace = Some(rest.to_vec()); flags = b""; },
					b'I' => {
						let mut dir = rest.trim_ascii_start();
						if dir.is_empty() {
							if origin == Origin::Environment { return Err("No directory specified for -I".into()); }
							dir = args.get(next).ok_or("No directory specified for -I")?;
							next += 1;
						}
						let mut dir = PStr::from_bytes(dir);
						if origin == Origin::Shebang {
							while let Some(&tail) = args.get(next).filter(|tail| !tail.starts_with(b"-")) {
								dir.bytes.push(b' ');
								dir.bytes.extend_from_slice(tail);
								next += 1;
							}
						}
						if origin == Origin::Argv { self.inc.push_back(dir); } else { self.inc.push_front(dir); }
						flags = b"";
					},
					b'l' => {
						let max = if rest.starts_with(b"0") { 4 } else { 3 };
						let (digits, tail) = octal(rest, max);
						flags = tail;
						self.chomp = true;
						self.output_sep = if digits.is_empty() {
							match self.input_sep.as_ref() {
								None => Some(PStr::from_bytes(b"\n")),
								Some(RecordSep::Text(s)) => Some(s.clone()),
								Some(RecordSep::Paragraph) => Some(PStr::from_bytes(b"\n\n")),
								_ => None,
							}
						} else { Some(PStr::from_bytes(&[number(digits, 8) as u8])) };
					},
					b'M' | b'm' => { self.module(flag, rest)?; flags = b""; },
					b'n' => self.loop_input = true,
					b'p' => { self.loop_input = true; self.print = true; },
					b's' => self.switches = true,
					b'S' => self.search = true,
					// Report the selected mode without implementing data taint or checks.
					b't' if self.taint == 0 => self.taint = -1,
					b't' => {},
					b'T' => self.taint = 1,
					b'u' => { self.dump = true; self.unsupported = true; },
					b'v' | b'h' => {
						self.display = Some(if flag == b'v' { Display::Version } else { Display::Help });
						return Ok(next);
					},
					b'V' => {
						if let Some(query) = rest.strip_prefix(b":") {
							self.config.push(query.to_vec());
							flags = b"";
						} else { self.config.push(Vec::new()); }
					},
					b'w' if self.warn == WarnSwitch::None => self.warn = WarnSwitch::W,
					b'w' => {},
					b'W' => self.warn = WarnSwitch::All,
					b'X' => self.warn = WarnSwitch::Off,
					b'x' => { self.extract = Some(rest.to_vec()); flags = b""; },
					_ => return Err(unknown(&[flag])),
				}
				// PERL5OPT only examines the first switch of each word.
				if origin == Origin::Environment { break; }
			}
		}
		Ok(next)
	}

	fn module(&mut self, flag: u8, spec: &[u8]) -> Result<(), String> {
		let (no, spec) = spec.strip_prefix(b"-").map_or((false, spec), |spec| (true, spec));
		let end = spec.iter().take_while(|&&b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b':' | b'\'') || !b.is_ascii()).count();
		if end == 0 { return Err(format!("Missing argument to -{}", char::from(flag))); }
		let (module, args) = spec.split_at(end);
		if flag == b'm' && !args.is_empty() && !args.starts_with(b"=") {
			return Err(format!("Can't use '{}' after -mname", char::from(args[0])));
		}
		self.prelude.extend_from_slice(if no { b"no " } else { b"use " });
		self.prelude.extend_from_slice(module);
		if let Some(values) = args.strip_prefix(b"=") {
			self.prelude.extend_from_slice(b" split(/,/, ");
			quote(&mut self.prelude, values);
			self.prelude.push(b')');
		} else if flag == b'm' {
			self.prelude.extend_from_slice(b" ()");
		} else {
			self.prelude.push(b' ');
			self.prelude.extend_from_slice(args);
		}
		self.prelude.extend_from_slice(b";\n");
		Ok(())
	}

	fn compose(&self, text: Vec<u8>) -> Vec<u8> {
		if !self.features && !self.loop_input && self.prelude.is_empty() { return text; }
		let mut src = Vec::with_capacity(text.len() + self.prelude.len() + self.pattern.len() + 160);
		if self.features { src.extend_from_slice(b"use feature ':5.34';\n"); }
		src.extend_from_slice(&self.prelude);
		if self.loop_input {
			src.extend_from_slice(b"LINE: while (defined($_ = <>)) {\n");
			if self.chomp { src.extend_from_slice(b"chomp;\n"); }
			if self.split {
				src.extend_from_slice(b"@F = split(");
				match self.pattern.as_slice() {
					b"" => src.extend_from_slice(b"' '"),
					[delimiter @ (b'/' | b'\'' | b'"'), .., end] if *delimiter == *end => src.extend_from_slice(&self.pattern),
					_ => quote(&mut src, &self.pattern),
				}
				src.extend_from_slice(b", $_);\n");
			}
		}
		src.extend_from_slice(b"#line 1\n");
		if !self.loop_input {
			src.extend_from_slice(&text);
			return src;
		}

		// The implicit loop ends at the end of the code, not after its DATA payload.
		let mut offset = 0;
		let end = text.split_inclusive(|&b| b == b'\n').find_map(|line| {
			let start = offset;
			offset += line.len();
			let marker = line.split(u8::is_ascii_whitespace).next().unwrap_or_default();
			matches!(marker, b"__DATA__" | b"__END__").then_some(start)
		}).unwrap_or(text.len());
		src.extend_from_slice(&text[..end]);
		if !src.ends_with(b"\n") { src.push(b'\n'); }
		if self.print {
			src.extend_from_slice(b"} continue { print $_ or die \"-p destination: $!\\n\"; }\n");
		} else { src.extend_from_slice(b"}\n"); }
		src.extend_from_slice(&text[end..]);
		src
	}
}

fn quote(out: &mut Vec<u8>, text: &[u8]) {
	out.push(b'\'');
	for &byte in text {
		if matches!(byte, b'\\' | b'\'') { out.push(b'\\'); }
		out.push(byte);
	}
	out.push(b'\'');
}

fn unknown(flag: &[u8]) -> String {
	format!("Unrecognized switch: -{}  (-h will show valid options)", String::from_utf8_lossy(flag))
}

fn octal(text: &[u8], max: usize) -> (&[u8], &[u8]) {
	let n = text.iter().take(max).take_while(|&&b| matches!(b, b'0'..=b'7')).count();
	text.split_at(n)
}

fn number(digits: &[u8], base: u32) -> u32 {
	digits.iter().fold(0u32, |acc, &b| acc.saturating_mul(base).saturating_add(char::from(b).to_digit(base).unwrap_or(0)))
}

fn unicode(arg: &[u8]) -> Result<u32, String> {
	if arg.is_empty() { return Ok(95); }
	let digits = arg.iter().take_while(|b| b.is_ascii_digit()).count();
	if digits > 1 && arg.starts_with(b"0") {
		return Err(format!("Invalid number '{}' for -C option", String::from_utf8_lossy(arg)));
	}
	if digits != 0 && digits != arg.len() {
		return Err(format!("Unknown Unicode option letter '{}'", char::from(arg[digits])));
	}
	let n = if digits != 0 { number(arg, 10) } else {
		let mut n = 0;
		for &flag in arg {
			n |= match flag {
				b'I' => 1, b'O' => 2, b'E' => 4, b'S' => 7,
				b'i' => 8, b'o' => 16, b'D' => 24, b'A' => 32, b'L' => 64,
				b'a' => 256,
				_ => return Err(format!("Unknown Unicode option letter '{}'", char::from(flag))),
			};
		}
		n
	};
	if n > 511 { Err(format!("Unknown Unicode option value {n}")) } else { Ok(n) }
}

fn path(bytes: &[u8]) -> PathBuf {
	#[cfg(unix)]
	{
		use std::{ffi::OsStr, os::unix::ffi::OsStrExt as _};
		PathBuf::from(OsStr::from_bytes(bytes))
	}
	#[cfg(not(unix))]
	PathBuf::from(String::from_utf8_lossy(bytes).as_ref())
}

fn words(bytes: &[u8]) -> impl Iterator<Item = &[u8]> {
	bytes.split(u8::is_ascii_whitespace).filter(|word| !word.is_empty())
}

fn shebang(line: &[u8]) -> Option<impl Iterator<Item = &[u8]>> {
	let mut parts = words(line.strip_prefix(b"#!")?);
	parts.find(|word| !word.starts_with(b"-") && word.windows(4).any(|part| part == b"perl"))?;
	Some(parts.skip_while(|word| !word.starts_with(b"-")))
}

fn load(host: &mut Host, script: &[u8], search: bool) -> Result<(Vec<u8>, Option<PathBuf>), (String, i32)> {
	let mut text = Vec::new();
	let mut selected = None;
	let name = String::from_utf8_lossy(script);
	let read = if script == b"-" {
		host.stdin.read_to_end(&mut text)
	} else {
		let script_path = path(script);
		let resolved = if search && script_path.file_name() == Some(script_path.as_os_str()) {
			let env_path = host.var("PATH").unwrap_or("");
			let mut denied = None;
			let mut dot = false;
			let mut found = None;
			for dir in std::env::split_paths(env_path) {
				if dir.as_os_str().is_empty() { continue; }
				dot |= dir.as_os_str() == ".";
				let candidate = dir.join(&script_path);
				let Ok(meta) = host.fs().metadata(host.resolve(&candidate)) else { continue; };
				if !meta.is_file() || cfg!(unix) && meta.mode() & 0o111 == 0 {
					denied.get_or_insert(candidate);
					continue;
				}
				found = Some(candidate);
				break;
			}
			let found = found.ok_or_else(|| (if let Some(denied) = denied {
				format!("Can't execute {}.", denied.display())
			} else if dot { format!("Can't find {name} on PATH.") }
			else { format!("Can't find {name} on PATH, '.' not in PATH.") }, if env_path.is_empty() { 255 } else { 2 }))?;
			let resolved = host.resolve(&found);
			selected = Some(found);
			resolved
		} else { host.resolve(script_path) };
		host.fs().open(resolved).and_then(|mut file| file.read_to_end(&mut text))
	};
	read.map_err(|err| {
		if host.is_cancelled() { return (String::new(), 130); }
		(format!("Can't open perl script \"{name}\": {}", strip_errno(&err)), err.raw_os_error().filter(|&n| (1..=255).contains(&n)).unwrap_or(2))
	})?;
	Ok((text, selected))
}

fn display_text(kind: Display) -> Cow<'static, str> {
	match kind {
		Display::Help => Cow::Borrowed(HELP),
		Display::Version => Cow::Owned(format!("\nThis is perl 5, version 34, subversion 1 (v5.34.1) built for {} (omp in-process builtin)\nSee perldoc perl for documentation.\n", modules::archname())),
	}
}

fn expand_inc(host: &Host, dirs: VecDeque<PStr>) -> Vec<PStr> {
	if dirs.is_empty() { return Vec::new(); }
	let arch = modules::archname();
	let version_arch = format!("5.34.1/{arch}");
	let suffixes = [version_arch.as_str(), "5.34.1", arch.as_str()];
	let mut inc = Vec::with_capacity(dirs.len());
	for dir in dirs {
		let base = path(&dir.bytes);
		for suffix in suffixes {
			let candidate = base.join(suffix);
			if host.fs().metadata(host.resolve(&candidate)).is_ok_and(|meta| meta.is_dir()) {
				inc.push(PStr::from_bytes(&os_bytes_lossy(candidate.as_os_str())));
			}
		}
		inc.push(dir);
	}
	inc
}

fn arguments<'a, 'b>(args: &'a [&'b [u8]], enabled: bool) -> (Vec<(PStr, PStr)>, &'a [&'b [u8]]) {
	let mut switches = Vec::new();
	let mut rest = args;
	if enabled {
		while let Some((&arg, tail)) = rest.split_first() {
			if arg == b"--" { rest = tail; break; }
			let Some(flag) = arg.strip_prefix(b"-").filter(|flag| !flag.is_empty()) else { break; };
			let (name, value) = flag.iter().position(|&b| b == b'=').map_or((flag, b"1".as_slice()), |at| (&flag[..at], &flag[at + 1..]));
			switches.push((PStr::from_bytes(name), PStr::from_bytes(value)));
			rest = tail;
		}
	}
	(switches, rest)
}

/// Run the program on the `perl` found on the shell's `PATH` instead of this
/// builtin, which cannot run it. Callers ensure the program has had no effect
/// yet: no input consumed, nothing written. Tried at most once; `None` when
/// disabled (`OMP_PERL_FALLBACK=0`), when no `perl` is on `PATH`, or when it
/// cannot be started, leaving this builtin to report its own diagnostics.
fn defer(host: &mut Host, argv: &[OsString], deferrable: &mut bool) -> Option<i32> {
	if !std::mem::take(deferrable) || host.var("OMP_PERL_FALLBACK") == Some("0") || host.is_cancelled() { return None; }
	let name = if cfg!(windows) { "perl.exe" } else { "perl" };
	let program = std::env::split_paths(host.var("PATH")?)
		.filter(|dir| !dir.as_os_str().is_empty())
		.map(|dir| host.resolve(dir.join(name)))
		.find(|candidate| host.fs().metadata(candidate).is_ok_and(|meta| meta.is_file() && (cfg!(not(unix)) || meta.mode() & 0o111 != 0)))?;
	// An absolute argv[0] makes the shell run the external program, not this builtin.
	let mut command = Vec::with_capacity(argv.len() + 1);
	command.push(os_bytes_lossy(program.as_os_str()).into_owned());
	command.extend(argv.iter().map(|arg| os_bytes_lossy(arg).into_owned()));
	let status = match spawn_system_in(host, ShellSpec::Argv(&command), None) {
		Ok(Ok(child)) => wait_cancellable(child, &host.cancel_flag()),
		Ok(Err(_)) => return None,
		Err(err) => Err(err),
	};
	match status {
		Ok(status) => Some(status.code()),
		Err(_) if host.is_cancelled() => Some(130),
		Err(_) => None,
	}
}

/// Write switch diagnostics held back while deciding whether to defer; once
/// anything is written, the system perl can no longer take over.
fn emit_notes(host: &mut Host, notes: &mut Vec<u8>, deferrable: &mut bool) {
	if notes.is_empty() { return; }
	let _ = host.stderr.write_all(notes);
	notes.clear();
	*deferrable = false;
}

fn startup(invocation: &[OsString], args: &[&[u8]], host: &mut Host) -> Result<i32, (String, i32)> {
	let usage = |msg: String| (format!("{msg}."), i32::from(Perl::USAGE_ERROR));
	let mut options = Options::default();
	if let Some(value) = host.var("PERL_UNICODE") { options.unicode = unicode(value.as_bytes()).map_err(usage)?; }
	let mut deferrable = true;
	let mut notes = Vec::new();
	let parsed = options.parse(args, Origin::Argv, &mut notes);
	if options.unsupported && let Some(status) = defer(host, invocation, &mut deferrable) { return Ok(status); }
	emit_notes(host, &mut notes, &mut deferrable);
	let consumed = parsed.map_err(usage)?;
	if let Some(kind) = options.display {
		let _ = host.stdout.write_all(display_text(kind).as_bytes());
		return Ok(0);
	}
	if options.taint == 0 {
		let env = host.var("PERL5OPT").unwrap_or_default().to_owned();
		if env.trim_ascii_start().starts_with("-T") {
			options.taint = 1;
		} else {
			let parsed = options.parse(&words(env.as_bytes()).collect::<Vec<_>>(), Origin::Environment, &mut notes);
			if options.unsupported && let Some(status) = defer(host, invocation, &mut deferrable) { return Ok(status); }
			emit_notes(host, &mut notes, &mut deferrable);
			parsed.map_err(usage)?;
		}
	}
	let args = &args[consumed..];
	let inline = options.inline.take();
	let config_only = inline.is_none() && !options.config.is_empty();
	let (script, args) = if inline.is_some() {
		(b"-e".as_slice(), args)
	} else if config_only {
		(if cfg!(windows) { b"NUL".as_slice() } else { b"/dev/null".as_slice() }, args)
	} else {
		args.split_first().map_or((b"-".as_slice(), args), |(&file, rest)| (file, rest))
	};
	if options.extract.is_some() && (inline.is_some() || config_only) {
		return Err(("No Perl script found in input".into(), 255));
	}
	let from_file = inline.is_none() && !config_only;
	let (mut source, found) = match inline {
		Some(text) => (text, None),
		None if config_only => (Vec::new(), None),
		None => load(host, script, options.search)?,
	};
	// A program read from stdin is consumed; the system perl could not reread it.
	if from_file && script == b"-" { deferrable = false; }
	let selected = found.as_ref().map(|path| os_bytes_lossy(path.as_os_str()));
	let script = selected.as_deref().unwrap_or(script);
	let file = String::from_utf8_lossy(script);
	let mut cwd = None;
	if from_file {
		if let Some(dir) = &options.extract {
			let mut offset = 0;
			let start = source.split_inclusive(|&b| b == b'\n').find_map(|line| {
				let start = offset;
				offset += line.len();
				shebang(line).is_some().then_some(start)
			}).ok_or_else(|| ("No Perl script found in input".into(), 255))?;
			source.drain(..start);
			if !dir.is_empty() {
				let dir_path = host.resolve(path(dir));
				if !host.fs().metadata(&dir_path).is_ok_and(|meta| meta.is_dir()) {
					return Err((format!("Can't chdir to {}.", String::from_utf8_lossy(dir)), 2));
				}
				cwd = Some(dir_path);
			}
		}
		let line = source.split(|&b| b == b'\n').next().unwrap_or_default();
		if let Some(flags) = shebang(line) {
			let parsed = options.parse(&flags.collect::<Vec<_>>(), Origin::Shebang, &mut notes);
			if options.unsupported && let Some(status) = defer(host, invocation, &mut deferrable) { return Ok(status); }
			emit_notes(host, &mut notes, &mut deferrable);
			parsed.map_err(|msg| (format!("{msg} at {file} line 1."), 255))?;
			if let Some(kind) = options.display {
				let _ = host.stdout.write_all(display_text(kind).as_bytes());
				return Ok(0);
			}
		}
	}
	if options.taint == 0 && let Some(lib) = host.var("PERL5LIB").or_else(|| host.var("PERLLIB")) {
		let sep = if cfg!(windows) { b';' } else { b':' };
		options.inc.extend(lib.as_bytes().split(|&b| b == sep).filter(|dir| !dir.is_empty()).map(PStr::from_bytes));
	}
	let source = options.compose(source);
	let (switches, args) = arguments(args, options.switches);
	let argv = args.iter().map(|arg| PStr::from_bytes(arg)).collect();
	if options.inplace.is_some() && args.is_empty() {
		let _ = writeln!(host.stderr, "-i used with no filenames on the command line, reading from STDIN.");
		deferrable = false;
	}
	let setup = Setup {
		script: PStr::from_bytes(script), argv, inc: expand_inc(host, options.inc),
		warn: options.warn, inplace: options.inplace,
		input_sep: options.input_sep, output_sep: options.output_sep, unicode: options.unicode, switches,
	};
	let mut interp = Interp::new(host, setup);
	if let Some(dir) = cwd { interp.set_cwd(dir); }
	if options.check {
		interp.sv("main::^C").set(Value::Int(1));
	}
	if options.taint != 0 {
		interp.sv("main::^TAINT").set(Value::Int(options.taint));
	}
	// Standard stream positions before compilation, to tell whether BEGIN
	// blocks or compile-time warnings read or wrote anything.
	let marks: Vec<_> = if deferrable {
		["main::STDIN", "main::STDOUT", "main::STDERR"].into_iter()
			.filter_map(|name| interp.handle(name, false))
			.map(|io| {
				let at = io.try_borrow_mut().map_or(-2, |mut handle| handle.tell());
				(Rc::downgrade(&io), at)
			})
			.collect()
	} else { Vec::new() };
	let program = match interp.compile(&source, &file) {
		Ok(program) => program,
		Err(error) => {
			interp.flush_outputs();
			let untouched = marks.iter().all(|(io, at)| {
				io.upgrade().is_some_and(|io| io.try_borrow_mut().is_ok_and(|mut handle| handle.tell() == *at))
			});
			if !error.is_empty() && untouched && let Some(status) = defer(interp.host(), invocation, &mut deferrable) {
				return Ok(status);
			}
			if !error.is_empty() {
				let _ = interp.host().stderr.write_all(&error.bytes);
			}
			return Ok(interp.compile_status());
		},
	};
	if options.dump { return Err(("Core dumps are not available in the omp builtin.".into(), 134)); }
	if options.check {
		interp.flush_outputs();
		let _ = writeln!(interp.host().stderr, "{file} syntax OK");
		return Ok(0);
	}
	if !options.config.is_empty() {
		if let Err(flow) = modules::show_config(&mut interp, &options.config) {
			interp.flush_outputs();
			if let Flow::Die(error) = flow { let _ = interp.host().stderr.write_all(&error.to_pstr().bytes); }
			return Ok(255);
		}
	}
	Ok(interp.run_main(&program))
}

/// Parse the invocation and run the Perl compilation unit.
pub(super) fn run(argv: &[OsString], host: &mut Host) -> i32 {
	let bytes: Vec<Cow<'_, [u8]>> = argv.iter().map(|arg| os_bytes_lossy(arg)).collect();
	let args: Vec<&[u8]> = bytes.iter().map(Cow::as_ref).collect();
	match startup(argv, &args, host) {
		Ok(status) => status,
		Err((message, status)) => {
			if !message.is_empty() { let _ = writeln!(host.stderr, "{message}"); }
			status
		},
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn bundled_switches_preserve_separator_order_and_stop_at_double_dash() {
		let args: &[&[u8]] = &[b"-lp0e", b"print", b"-e", b"END {}", b"--", b"-first"];
		let mut opts = Options::default();
		assert_eq!(opts.parse(args, Origin::Argv, &mut io::sink()), Ok(5));
		assert_eq!(opts.output_sep, Some(PStr::from_bytes(b"\n")));
		assert_eq!(opts.input_sep, Some(RecordSep::Text(PStr::from_bytes(b"\0"))));
		assert_eq!(opts.inline.as_deref(), Some(b"print\nEND {}\n".as_slice()));
		assert!(opts.print && opts.chomp);
	}

	#[test]
	fn environment_include_paths_prepend_in_reverse_order() {
		let mut opts = Options::default();
		let mut sink = io::sink();
		opts.parse(&[b"-Ia", b"-I", b"b"], Origin::Argv, &mut sink).unwrap();
		opts.parse(&[b"-Ic", b"-Id"], Origin::Environment, &mut sink).unwrap();
		assert_eq!(opts.inc.into_iter().map(|dir| dir.bytes).collect::<Vec<_>>(), [b"d", b"c", b"a", b"b"].map(|s| s.to_vec()));
	}

	#[test]
	fn generated_loop_retains_source_line_and_data() {
		let mut opts = Options::default();
		opts.parse(&[b"-lpa", b"-F:", b"-mPOSIX"], Origin::Argv, &mut io::sink()).unwrap();
		let text = opts.compose(b"print $F[1];\n__DATA__\ntail\n".to_vec());
		assert_eq!(text, b"use POSIX ();\nLINE: while (defined($_ = <>)) {\nchomp;\n@F = split(':', $_);\n#line 1\nprint $F[1];\n} continue { print $_ or die \"-p destination: $!\\n\"; }\n__DATA__\ntail\n");
	}

	#[test]
	fn debugger_and_unsafe_switches_are_unsupported() {
		for switch in [b"-d".as_slice(), b"-d:Trace", b"-Dx", b"-u", b"-U"] {
			let mut opts = Options::default();
			let _ = opts.parse(&[switch], Origin::Argv, &mut io::sink());
			assert!(opts.unsupported, "{}", String::from_utf8_lossy(switch));
		}
		let mut opts = Options::default();
		opts.parse(&[b"-wle", b"1"], Origin::Argv, &mut io::sink()).unwrap();
		assert!(!opts.unsupported);
	}

	#[test]
	fn taint_modes_are_accepted_in_argv_and_shebangs() {
		let mut opts = Options::default();
		let mut sink = io::sink();
		opts.parse(&[b"-tw"], Origin::Argv, &mut sink).unwrap();
		assert_eq!(opts.taint, -1);
		opts.parse(&[b"-Tt"], Origin::Shebang, &mut sink).unwrap();
		assert_eq!(opts.taint, 1);

		let mut shebang_only = Options::default();
		shebang_only.parse(&[b"-T"], Origin::Shebang, &mut sink).unwrap();
		assert_eq!(shebang_only.taint, 1);
	}
}
