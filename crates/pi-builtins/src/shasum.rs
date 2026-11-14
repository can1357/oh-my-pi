//! `shasum` builtin: print or check SHA checksums.
//!
//! Matches the behavior of the `shasum` script from Perl's Digest::SHA 6.02
//! (the one macOS and most Linux distributions ship): `-a/--algorithm
//! 1|224|256|384|512|512224|512256`, `-b/--binary`, `-t/--text`,
//! `-U/--UNIVERSAL`, `-0/--01`, `--tag`, `-c/--check` with `--ignore-missing`,
//! `-q/--quiet`, `-s/--status`, `--strict` and `-w/--warn`, and `-v/--version`.
//! `-` or no operand reads standard input.
//!
//! Check mode infers each line's algorithm from its digest length (or its
//! BSD tag), as shasum does, so `-a` only matters there to claim the 56- and
//! 64-digit lengths for SHA-512/224 and SHA-512/256. BITS mode (`-0`, and `^`
//! check lines) digests whole bytes only: input whose count of `0`/`1`
//! characters is not a multiple of 8 fails to read. SHA-512/224 and
//! SHA-512/256 need the `sha2` crate, so wasm builds report them unsupported.

use std::{
	borrow::Cow,
	ffi::{OsStr, OsString},
	fmt::Display,
	io::{self, Read, Write},
};

use clap::Parser;
use uucore::{
	checksum::{ShaLength, SizedAlgoKind},
	sum::Digest,
};

use crate::{
	cksum,
	host::{Host, Utility, os_bytes_lossy, strip_errno},
};

/// Version reported by `-v`, that of the Digest::SHA script it mirrors.
const VERSION: &str = "6.02";

/// Leading bytes Perl's `-T` test inspects on a buffered handle.
const TEXT_SAMPLE: usize = 8192;

/// Parsed `shasum` invocation.
#[derive(Parser)]
#[command(
	name = "shasum",
	about = "Print or check SHA checksums.",
	override_usage = "shasum [OPTION]... [FILE]...",
	after_help = "With no FILE, or when FILE is -, read standard input.",
	disable_version_flag = true,
	args_override_self = true,
	infer_long_args = true
)]
pub(crate) struct Shasum {
	/// Digest algorithm: 1 (default), 224, 256, 384, 512, 512224, 512256
	#[arg(short = 'a', long = "algorithm", value_name = "ALG", allow_hyphen_values = true)]
	algorithm:      Option<String>,
	/// Read input in binary mode
	#[arg(short = 'b', long = "binary")]
	binary:         bool,
	/// Verify the checksums listed in the FILEs
	#[arg(short = 'c', long = "check")]
	check:          bool,
	/// Print BSD-style checksum lines
	#[arg(long = "tag")]
	tag:            bool,
	/// Read input in text mode (default)
	#[arg(short = 't', long = "text")]
	text:           bool,
	/// Read text input with CR and CRLF line ends normalized to LF
	#[arg(short = 'U', long = "UNIVERSAL")]
	universal:      bool,
	/// Read input as ASCII '0'/'1' bits, ignoring every other character
	#[arg(short = '0', long = "01")]
	bits:           bool,
	/// With --check, skip listed files that do not exist
	#[arg(long = "ignore-missing")]
	ignore_missing: bool,
	/// With --check, print nothing for files that verify
	#[arg(short = 'q', long = "quiet")]
	quiet:          bool,
	/// With --check, print nothing; the exit status tells the result
	#[arg(short = 's', long = "status")]
	status:         bool,
	/// With --check, fail on improperly formatted lines
	#[arg(long = "strict")]
	strict:         bool,
	/// With --check, report improperly formatted lines
	#[arg(short = 'w', long = "warn")]
	warn:           bool,
	/// Print the version and exit
	#[arg(short = 'v', long = "version")]
	version:        bool,
	#[arg(value_name = "FILE")]
	files:          Vec<OsString>,
}

impl Utility for Shasum {
	const NAME: &'static str = "shasum";

	fn run(self, host: &mut Host) -> i32 {
		if let Some(value) = &self.algorithm
			&& !is_integer(value)
		{
			return usage(host, format!("Value \"{value}\" invalid for option a (number expected)"));
		}
		if let Some(problem) = self.misuse() {
			return usage(host, format!("shasum: {problem}"));
		}
		let chosen = match self.algorithm.as_deref() {
			None => Algorithm::Sha1,
			Some(value) => match Algorithm::from_number(value.as_bytes()) {
				Some(algorithm) => algorithm,
				None => return usage(host, "shasum: Unrecognized algorithm"),
			},
		};
		if self.version {
			let _ = writeln!(host.stdout, "{VERSION}");
			return 0;
		}

		let mode = if self.binary {
			Mode::Binary
		} else if self.universal {
			Mode::Universal
		} else if self.bits {
			Mode::Bits
		} else {
			Mode::Text
		};
		let check = CheckOptions {
			chosen,
			ignore_missing: self.ignore_missing,
			quiet: self.quiet,
			status: self.status,
			strict: self.strict,
			warn: self.warn,
		};
		let stdin = [OsString::from("-")];
		let files = if self.files.is_empty() { &stdin[..] } else { &self.files[..] };
		let mut status = 0;
		for file in files {
			if host.is_cancelled() {
				break;
			}
			if self.check {
				match verify(host, file, &check) {
					Ok(true) => {},
					Ok(false) => status = 1,
					Err(code) => return code,
				}
				continue;
			}
			match sum_file(host, file, chosen, mode) {
				Ok(digest) => print_sum(host, file, &digest, chosen, self.tag, mode),
				Err(message) => {
					warn(host, format_args!("{}: {message}", file.to_string_lossy()));
					status = 1;
				},
			}
		}
		status
	}
}

impl Shasum {
	/// The first option combination shasum rejects before doing any work.
	fn misuse(&self) -> Option<&'static str> {
		let modes = [self.binary, self.text, self.bits, self.universal];
		Some(if modes.into_iter().filter(|&set| set).count() > 1 {
			"Ambiguous file mode"
		} else if self.warn && !self.check {
			"--warn option used only when verifying checksums"
		} else if self.status && !self.check {
			"--status option used only when verifying checksums"
		} else if self.quiet && !self.check {
			"--quiet option used only when verifying checksums"
		} else if self.ignore_missing && !self.check {
			"--ignore-missing option used only when verifying checksums"
		} else if self.strict && !self.check {
			"--strict option used only when verifying checksums"
		} else if self.tag && self.text {
			"--tag does not support --text mode"
		} else if self.tag && self.universal {
			"--tag does not support Universal Newlines mode"
		} else if self.tag && self.bits {
			"--tag does not support BITS mode"
		} else {
			return None;
		})
	}
}

/// Reports a usage error the way shasum does and returns its status, 1.
fn usage(host: &mut Host, message: impl Display) -> i32 {
	let _ = writeln!(host.stderr, "{message}\nType shasum -h for help");
	1
}

/// Writes `shasum: <message>` to stderr without touching the exit status.
fn warn(host: &mut Host, message: impl Display) {
	let _ = writeln!(host.stderr, "{}: {message}", Shasum::NAME);
}

/// Whether `value` is an integer as Getopt::Long's `=i` accepts it.
fn is_integer(value: &str) -> bool {
	let digits = value.strip_prefix(['-', '+']).unwrap_or(value);
	!digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())
}

/// A SHA variant shasum computes.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Algorithm {
	Sha1,
	Sha224,
	Sha256,
	Sha384,
	Sha512,
	Sha512_224,
	Sha512_256,
}

impl Algorithm {
	/// Parses shasum's algorithm number (`1`, `256`, `512224`, …).
	fn from_number(number: &[u8]) -> Option<Self> {
		Some(match number {
			b"1" => Self::Sha1,
			b"224" => Self::Sha224,
			b"256" => Self::Sha256,
			b"384" => Self::Sha384,
			b"512" => Self::Sha512,
			b"512224" => Self::Sha512_224,
			b"512256" => Self::Sha512_256,
			_ => return None,
		})
	}

	/// The algorithm a check line's digest length implies; `chosen` is the
	/// `-a` selection, which claims the SHA-224 and SHA-256 lengths for
	/// SHA-512/224 and SHA-512/256.
	fn from_hex_len(len: usize, chosen: Self) -> Option<Self> {
		Some(match len {
			40 => Self::Sha1,
			56 if chosen == Self::Sha512_224 => Self::Sha512_224,
			56 => Self::Sha224,
			64 if chosen == Self::Sha512_256 => Self::Sha512_256,
			64 => Self::Sha256,
			96 => Self::Sha384,
			128 => Self::Sha512,
			_ => return None,
		})
	}

	/// The BSD-style tag (`SHA256`, `SHA512/224`).
	const fn tag(self) -> &'static str {
		match self {
			Self::Sha1 => "SHA1",
			Self::Sha224 => "SHA224",
			Self::Sha256 => "SHA256",
			Self::Sha384 => "SHA384",
			Self::Sha512 => "SHA512",
			Self::Sha512_224 => "SHA512/224",
			Self::Sha512_256 => "SHA512/256",
		}
	}

	/// A fresh digest, or why this build cannot compute the algorithm.
	fn digest(self) -> Result<Box<dyn Digest>, String> {
		let kind = match self {
			Self::Sha1 => SizedAlgoKind::Sha1,
			Self::Sha224 => SizedAlgoKind::Sha2(ShaLength::Len224),
			Self::Sha256 => SizedAlgoKind::Sha2(ShaLength::Len256),
			Self::Sha384 => SizedAlgoKind::Sha2(ShaLength::Len384),
			Self::Sha512 => SizedAlgoKind::Sha2(ShaLength::Len512),
			#[cfg(any(unix, windows))]
			Self::Sha512_224 => {
				return Ok(Box::new(Sha512Truncated(<sha2::Sha512_224 as sha2::Digest>::new())));
			},
			#[cfg(any(unix, windows))]
			Self::Sha512_256 => {
				return Ok(Box::new(Sha512Truncated(<sha2::Sha512_256 as sha2::Digest>::new())));
			},
			#[cfg(not(any(unix, windows)))]
			Self::Sha512_224 | Self::Sha512_256 => {
				return Err(format!("{} is not supported on this platform", self.tag()));
			},
		};
		Ok(kind.create_digest())
	}
}

/// uucore digest adapter for the truncated SHA-512 variants uucore lacks.
#[cfg(any(unix, windows))]
struct Sha512Truncated<D>(D);

#[cfg(any(unix, windows))]
impl<D: sha2::Digest> Digest for Sha512Truncated<D> {
	fn hash_update(&mut self, input: &[u8]) {
		sha2::Digest::update(&mut self.0, input);
	}

	fn hash_finalize(&mut self, out: &mut [u8]) {
		let state = std::mem::replace(&mut self.0, D::new());
		out.copy_from_slice(&sha2::Digest::finalize(state));
	}

	fn reset(&mut self) {
		self.0 = D::new();
	}

	fn output_bits(&self) -> usize {
		<D as sha2::Digest>::output_size() * 8
	}
}

/// How input bytes reach the digest, named by shasum's mode symbols.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Mode {
	Text,
	Binary,
	Universal,
	Bits,
}

impl Mode {
	/// The symbol between digest and name in untagged lines.
	const fn symbol(self) -> u8 {
		match self {
			Self::Text => b' ',
			Self::Binary => b'*',
			Self::Universal => b'U',
			Self::Bits => b'^',
		}
	}

	fn from_symbol(symbol: u8) -> Option<Self> {
		Some(match symbol {
			b' ' => Self::Text,
			b'*' => Self::Binary,
			b'U' => Self::Universal,
			b'^' => Self::Bits,
			_ => return None,
		})
	}
}

/// Streams input into a digest the way Digest::SHA's `addfile` reads it in
/// one mode.
struct Feeder {
	digest: Box<dyn Digest>,
	state:  FeedState,
}

enum FeedState {
	/// Bytes go in unchanged.
	Raw,
	/// Universal mode before Perl's `-T` test: the leading bytes so far.
	Sampling(Vec<u8>),
	/// Universal mode on text input: CR and CRLF become LF.
	Universal { pending_cr: bool, scratch: Vec<u8> },
	/// BITS mode: the partial byte and how many bits it holds.
	Bits { byte: u8, count: u8 },
}

impl Feeder {
	fn new(digest: Box<dyn Digest>, mode: Mode) -> Self {
		let state = match mode {
			Mode::Text | Mode::Binary => FeedState::Raw,
			Mode::Universal => FeedState::Sampling(Vec::new()),
			Mode::Bits => FeedState::Bits { byte: 0, count: 0 },
		};
		Self { digest, state }
	}

	fn update(&mut self, chunk: &[u8]) {
		match &mut self.state {
			FeedState::Raw => self.digest.hash_update(chunk),
			FeedState::Sampling(sample) => {
				sample.extend_from_slice(chunk);
				if sample.len() >= TEXT_SAMPLE {
					self.end_sampling();
				}
			},
			FeedState::Universal { pending_cr, scratch } => {
				normalize_newlines(&mut *self.digest, pending_cr, scratch, chunk);
			},
			FeedState::Bits { byte, count } => {
				for &symbol in chunk {
					if !matches!(symbol, b'0' | b'1') {
						continue;
					}
					*byte = (*byte << 1) | (symbol - b'0');
					*count += 1;
					if *count == 8 {
						self.digest.hash_update(&[*byte]);
						(*byte, *count) = (0, 0);
					}
				}
			},
		}
	}

	/// Decides universal mode's text test on the sample and digests it.
	fn end_sampling(&mut self) {
		let FeedState::Sampling(sample) = &mut self.state else {
			return;
		};
		let sample = std::mem::take(sample);
		if looks_like_text(&sample[..sample.len().min(TEXT_SAMPLE)]) {
			let mut pending_cr = false;
			let mut scratch = Vec::with_capacity(sample.len() + 1);
			normalize_newlines(&mut *self.digest, &mut pending_cr, &mut scratch, &sample);
			self.state = FeedState::Universal { pending_cr, scratch };
		} else {
			self.digest.hash_update(&sample);
			self.state = FeedState::Raw;
		}
	}

	/// The hex digest, or why the input could not be digested.
	fn finish(mut self) -> Result<String, String> {
		self.end_sampling();
		match self.state {
			FeedState::Universal { pending_cr: true, .. } => self.digest.hash_update(b"\n"),
			FeedState::Bits { count, .. } if count != 0 => {
				return Err("BITS mode input length is not a multiple of 8".to_owned());
			},
			_ => {},
		}
		Ok(cksum::finish_hex(&mut *self.digest))
	}
}

/// Digests `chunk` with every CR and CRLF turned into LF, carrying a CR that
/// ends the chunk in `pending_cr`.
fn normalize_newlines(digest: &mut dyn Digest, pending_cr: &mut bool, scratch: &mut Vec<u8>, chunk: &[u8]) {
	scratch.clear();
	for &byte in chunk {
		if *pending_cr {
			scratch.push(b'\n');
			match byte {
				b'\n' => *pending_cr = false,
				b'\r' => {},
				_ => {
					*pending_cr = false;
					scratch.push(byte);
				},
			}
		} else if byte == b'\r' {
			*pending_cr = true;
		} else {
			scratch.push(byte);
		}
	}
	digest.hash_update(scratch);
}

/// Perl's `-T` heuristic: empty or valid UTF-8 (a cut-off final character
/// allowed) is text; a NUL byte, or more than a third of bytes outside
/// printable ASCII and common whitespace, is binary.
fn looks_like_text(sample: &[u8]) -> bool {
	if sample.is_empty() {
		return true;
	}
	if !sample.is_ascii() && std::str::from_utf8(sample).map_or_else(|error| error.error_len().is_none(), |_| true) {
		return true;
	}
	if sample.contains(&0) {
		return false;
	}
	let odd = sample
		.iter()
		.filter(|&&byte| !matches!(byte, 0x20..=0x7e | b'\t' | b'\n' | b'\r' | 0x0c | 0x08 | 0x1b))
		.count();
	odd * 3 <= sample.len()
}

/// Digests operand `name` (`-` is standard input) in `mode`, returning the
/// hex digest or the text of the error.
fn sum_file(host: &mut Host, name: &OsStr, algorithm: Algorithm, mode: Mode) -> Result<String, String> {
	let mut feeder = Feeder::new(algorithm.digest()?, mode);
	let cancel = host.cancel_flag();
	let read = if name == "-" {
		cksum::read_chunks(&mut host.stdin, &cancel, |chunk| feeder.update(chunk))
	} else {
		let path = host.resolve(name);
		if host.fs().is_dir(&path) {
			return Err("Is a directory".to_owned());
		}
		let mut file = host.fs().open(&path).map_err(|error| strip_errno(&error))?;
		cksum::read_chunks(&mut file, &cancel, |chunk| feeder.update(chunk))
	};
	read.map_err(|error| strip_errno(&error))?;
	feeder.finish()
}

/// Prints one computed checksum line, escaping a name that holds a newline
/// or backslash and marking the line with a leading backslash.
fn print_sum(host: &mut Host, name: &OsStr, digest: &str, algorithm: Algorithm, tag: bool, mode: Mode) {
	let name = os_bytes_lossy(name);
	let mut line = Vec::with_capacity(name.len() + digest.len() + 16);
	let escape = name.iter().any(|&byte| matches!(byte, b'\n' | b'\\'));
	if escape {
		line.push(b'\\');
	}
	let push_name = |line: &mut Vec<u8>| {
		for &byte in name.iter() {
			match byte {
				b'\\' if escape => line.extend_from_slice(b"\\\\"),
				b'\n' if escape => line.extend_from_slice(b"\\n"),
				_ => line.push(byte),
			}
		}
	};
	if tag {
		line.extend_from_slice(algorithm.tag().as_bytes());
		line.extend_from_slice(b" (");
		push_name(&mut line);
		line.extend_from_slice(b") = ");
		line.extend_from_slice(digest.as_bytes());
	} else {
		line.extend_from_slice(digest.as_bytes());
		line.push(b' ');
		line.push(mode.symbol());
		push_name(&mut line);
	}
	line.push(b'\n');
	let _ = host.stdout.write_all(&line);
}

/// Check-mode settings shared by every checklist.
struct CheckOptions {
	/// The `-a` selection, which decides SHA-512/t length inference.
	chosen:         Algorithm,
	ignore_missing: bool,
	quiet:          bool,
	status:         bool,
	strict:         bool,
	warn:           bool,
}

/// One well-formed checklist line.
struct CheckLine<'a> {
	algorithm: Algorithm,
	sum:       &'a [u8],
	mode:      Mode,
	name:      Cow<'a, [u8]>,
}

/// Verifies the checksums listed in `checkfile` (`-` is standard input).
///
/// `Ok` tells whether everything verified; `Err` is the exit status after a
/// checklist that could not be opened, which ends shasum like Perl's `die`.
fn verify(host: &mut Host, checkfile: &OsStr, options: &CheckOptions) -> Result<bool, i32> {
	let (label, content) = if checkfile == "-" {
		let mut content = Vec::new();
		if let Err(error) = host.stdin.read_to_end(&mut content) {
			warn(host, format_args!("-: {}", strip_errno(&error)));
			return Err(die_status(&error));
		}
		(Cow::Borrowed("standard input"), content)
	} else {
		let label = checkfile.to_string_lossy();
		let path = host.resolve(checkfile);
		let content = if host.fs().is_dir(&path) {
			Vec::new()
		} else {
			match host.fs().read(&path) {
				Ok(content) => content,
				Err(error) => {
					warn(host, format_args!("{label}: {}", strip_errno(&error)));
					return Err(die_status(&error));
				},
			}
		};
		(label, content)
	};

	let (mut failed, mut format_errors, mut read_errors, mut mismatches) = (false, 0_usize, 0_usize, 0_usize);
	let (mut well_formed, mut verified) = (0_usize, 0_usize);
	for (index, line) in content.split_inclusive(|&byte| byte == b'\n').enumerate() {
		if host.is_cancelled() {
			break;
		}
		let line = line.strip_suffix(b"\n").unwrap_or(line);
		if line.starts_with(b"#") {
			continue;
		}
		let Some(entry) = parse_check_line(line, options.chosen) else {
			if options.warn {
				warn(host, format_args!("{label}: {}: improperly formatted SHA checksum line", index + 1));
			}
			format_errors += 1;
			failed |= options.strict;
			continue;
		};
		well_formed += 1;
		let name = bytes_to_os(&entry.name);
		if options.ignore_missing && !host.fs().exists(host.resolve(&name)) {
			continue;
		}
		let mut ok = false;
		let verdict: &[u8] = match sum_file(host, &name, entry.algorithm, entry.mode) {
			Err(message) => {
				warn(host, format_args!("{}: {message}", name.to_string_lossy()));
				read_errors += 1;
				failed = true;
				b"FAILED open or read\n"
			},
			Ok(digest) if entry.sum.eq_ignore_ascii_case(digest.as_bytes()) => {
				verified += 1;
				ok = true;
				b"OK\n"
			},
			Ok(_) => {
				mismatches += 1;
				failed = true;
				b"FAILED\n"
			},
		};
		if !(options.status || (options.quiet && ok)) {
			let _ = host.stdout.write_all(&[&entry.name[..], &b": "[..], verdict].concat());
		}
	}

	if well_formed == 0 {
		warn(host, format_args!("{label}: no properly formatted SHA checksum lines found"));
		failed = true;
	} else if !options.status {
		if format_errors > 0 {
			let lines = if format_errors > 1 { "lines are" } else { "line is" };
			warn(host, format_args!("WARNING: {format_errors} {lines} improperly formatted"));
		}
		if read_errors > 0 {
			let files = if read_errors > 1 { "files" } else { "file" };
			warn(host, format_args!("WARNING: {read_errors} listed {files} could not be read"));
		}
		if mismatches > 0 {
			let sums = if mismatches > 1 { "checksums" } else { "checksum" };
			warn(host, format_args!("WARNING: {mismatches} computed {sums} did NOT match"));
		}
	}
	if options.ignore_missing && verified == 0 && well_formed > 0 {
		if !options.status {
			warn(host, format_args!("{label}: no file was verified"));
		}
		failed = true;
	}
	Ok(!failed)
}

/// Parses a checklist line (without its newline) the way shasum's two line
/// patterns match it; `None` is an improperly formatted line.
fn parse_check_line(line: &[u8], chosen: Algorithm) -> Option<CheckLine<'_>> {
	let rest = &line[line.iter().take_while(|&&byte| matches!(byte, b' ' | b'\t')).count()..];
	let (escaped, rest) = match rest.strip_prefix(b"\\") {
		Some(rest) => (true, rest),
		None => (false, rest),
	};
	let (algorithm, sum, mode, name) = match rest.strip_prefix(b"SHA") {
		Some(rest) => parse_tagged(rest)?,
		None => parse_untagged(rest, chosen)?,
	};
	let name = if escaped { Cow::Owned(unescape(name)) } else { Cow::Borrowed(name) };
	Some(CheckLine { algorithm, sum, mode, name })
}

/// Parses what follows `SHA` in a BSD-style line: `<alg> (<name>) = <hex>`,
/// where the name runs to the last `) = ` that a hex digit follows.
fn parse_tagged(rest: &[u8]) -> Option<(Algorithm, &[u8], Mode, &[u8])> {
	let number_len = rest.iter().position(|&byte| byte.is_ascii_whitespace() || byte == 0x0b).unwrap_or(rest.len());
	if number_len == 0 {
		return None;
	}
	let (number, rest) = rest.split_at(number_len);
	let rest = rest.strip_prefix(b" (")?;
	let split = (1..rest.len())
		.rev()
		.find(|&at| rest[at..].starts_with(b") = ") && rest.get(at + 4).is_some_and(u8::is_ascii_hexdigit))?;
	let digits = &rest[split + 4..];
	let sum = &digits[..digits.iter().take_while(|byte| byte.is_ascii_hexdigit()).count()];
	let number: Vec<u8> = number.iter().copied().filter(|&byte| byte != b'/').collect();
	Some((Algorithm::from_number(&number)?, sum, Mode::Binary, &rest[..split]))
}

/// Parses an untagged line: `<hex>`, a blank, a mode symbol, then the name.
fn parse_untagged(rest: &[u8], chosen: Algorithm) -> Option<(Algorithm, &[u8], Mode, &[u8])> {
	let (sum, rest) = rest.split_at(rest.iter().take_while(|byte| byte.is_ascii_hexdigit()).count());
	let [b' ' | b'\t', symbol, name @ ..] = rest else {
		return None;
	};
	if sum.is_empty() || name.is_empty() {
		return None;
	}
	Some((Algorithm::from_hex_len(sum.len(), chosen)?, sum, Mode::from_symbol(*symbol)?, name))
}

/// Undoes shasum's name escaping: `\\` is a backslash and `\n` a newline.
fn unescape(name: &[u8]) -> Vec<u8> {
	let mut plain = Vec::with_capacity(name.len());
	let mut bytes = name.iter();
	while let Some(&byte) = bytes.next() {
		if byte == b'\\' {
			match bytes.as_slice().first() {
				Some(b'\\') => {
					bytes.next();
					plain.push(b'\\');
					continue;
				},
				Some(b'n') => {
					bytes.next();
					plain.push(b'\n');
					continue;
				},
				_ => {},
			}
		}
		plain.push(byte);
	}
	plain
}

/// A checklist name as an operand, lossily where the platform cannot hold it.
fn bytes_to_os(bytes: &[u8]) -> OsString {
	match uucore::os_str_from_bytes(bytes) {
		Ok(value) => value.into_owned(),
		Err(_) => OsString::from(String::from_utf8_lossy(bytes).into_owned()),
	}
}

/// Exit status of Perl's `die` after a failed open: the errno, else 255.
fn die_status(error: &io::Error) -> i32 {
	if cfg!(unix)
		&& let Some(code) = error.raw_os_error()
		&& (1..=255).contains(&code)
	{
		return code;
	}
	match error.kind() {
		io::ErrorKind::NotFound => 2,
		io::ErrorKind::PermissionDenied => 13,
		_ => 255,
	}
}

#[cfg(test)]
mod tests {
	use std::fs;

	use super::Shasum;
	use crate::host::run_util;

	const ABC_SHA1: &str = "a9993e364706816aba3e25717850c26c9cd0d89d";
	const ABC_SHA256: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

	fn tree_with_abc() -> tempfile::TempDir {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("data"), b"abc").unwrap();
		dir
	}

	#[test]
	fn defaults_to_sha1_of_stdin() {
		let (code, capture) = run_util::<Shasum>(&[], "abc", "/");
		assert_eq!(code, 0);
		assert_eq!(capture.out(), format!("{ABC_SHA1}  -\n"));
	}

	#[test]
	fn algorithm_256_digests_a_file_relative_to_cwd() {
		let dir = tree_with_abc();
		let (code, capture) = run_util::<Shasum>(&["-a", "256", "data"], "", dir.path());
		assert_eq!(code, 0);
		assert_eq!(capture.out(), format!("{ABC_SHA256}  data\n"));
	}

	#[test]
	fn binary_marks_the_name_with_a_star() {
		let dir = tree_with_abc();
		let (code, capture) = run_util::<Shasum>(&["-b", "data"], "", dir.path());
		assert_eq!(code, 0);
		assert_eq!(capture.out(), format!("{ABC_SHA1} *data\n"));
	}

	#[test]
	fn tag_prints_bsd_lines() {
		let dir = tree_with_abc();
		let (code, capture) = run_util::<Shasum>(&["--tag", "-a256", "data"], "", dir.path());
		assert_eq!(code, 0);
		assert_eq!(capture.out(), format!("SHA256 (data) = {ABC_SHA256}\n"));
	}

	#[cfg(any(unix, windows))]
	#[test]
	fn computes_truncated_sha512_variants() {
		let dir = tree_with_abc();
		let (code, capture) = run_util::<Shasum>(&["-a", "512224", "--tag", "data"], "", dir.path());
		assert_eq!(code, 0);
		assert_eq!(capture.out(), "SHA512/224 (data) = 4634270f707b6a54daae7530460842e20e37ed265ceee9a43e8924aa\n");

		let (code, capture) = run_util::<Shasum>(&["-a", "512256", "data"], "", dir.path());
		assert_eq!(code, 0);
		assert_eq!(capture.out(), "53048e2681941ef99b2e29b76b4c7dabe4c2d0c634fc6d46e0e2f13107e7af23  data\n");
	}

	#[test]
	fn universal_mode_normalizes_line_ends_of_text_only() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("crlf"), b"x\r\ny\rz\n").unwrap();
		fs::write(dir.path().join("bin"), b"a\r\n\0").unwrap();

		let (code, capture) = run_util::<Shasum>(&["-U", "crlf", "bin"], "", dir.path());
		assert_eq!(code, 0);
		assert_eq!(
			capture.out(),
			"83305e292107a8d1955ac0c0047912ff62c5d6dc Ucrlf\nec10eb2066372b1d30bc48d541334372c06f2e5c Ubin\n"
		);
	}

	#[test]
	fn bits_mode_reads_ascii_bits() {
		let (code, capture) = run_util::<Shasum>(&["-0"], "0110 0001\n", "/");
		assert_eq!(code, 0);
		assert_eq!(capture.out(), "86f7e437faa5a7fce15d1ddcb9eaeaea377667b8 ^-\n");

		let (code, capture) = run_util::<Shasum>(&["-0"], "0110000", "/");
		assert_eq!(code, 1);
		assert_eq!(capture.out(), "");
		assert_eq!(capture.err(), "shasum: -: BITS mode input length is not a multiple of 8\n");
	}

	#[test]
	fn missing_operand_is_reported_and_the_rest_still_digested() {
		let dir = tree_with_abc();
		let (code, capture) = run_util::<Shasum>(&["nope", "data"], "", dir.path());
		assert_eq!(code, 1);
		assert_eq!(capture.out(), format!("{ABC_SHA1}  data\n"));
		assert_eq!(capture.err(), "shasum: nope: No such file or directory\n");
	}

	#[cfg(unix)]
	#[test]
	fn escapes_backslash_names_and_checks_them_back() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("x\\y"), b"").unwrap();

		let (code, capture) = run_util::<Shasum>(&["x\\y"], "", dir.path());
		assert_eq!(code, 0);
		let listing = capture.out();
		assert_eq!(listing, "\\da39a3ee5e6b4b0d3255bfef95601890afd80709  x\\\\y\n");

		let (code, capture) = run_util::<Shasum>(&["-c"], &listing, dir.path());
		assert_eq!(code, 0);
		assert_eq!(capture.out(), "x\\y: OK\n");
	}

	#[test]
	fn check_reports_ok_and_failed() {
		let dir = tree_with_abc();
		fs::write(dir.path().join("other"), b"abd").unwrap();
		let checklist = format!("{ABC_SHA1}  data\n{ABC_SHA1}  other\n");

		let (code, capture) = run_util::<Shasum>(&["-c"], &checklist, dir.path());
		assert_eq!(code, 1);
		assert_eq!(capture.out(), "data: OK\nother: FAILED\n");
		assert_eq!(capture.err(), "shasum: WARNING: 1 computed checksum did NOT match\n");

		let (code, capture) = run_util::<Shasum>(&["-c"], &format!("{ABC_SHA1}  data\n"), dir.path());
		assert_eq!(code, 0);
		assert_eq!(capture.out(), "data: OK\n");
		assert_eq!(capture.err(), "");
	}

	#[test]
	fn check_infers_the_algorithm_per_line() {
		let dir = tree_with_abc();
		let checklist = format!(
			"{ABC_SHA256} *data\nSHA1 (data) = {ABC_SHA1}\n# comment\nSHA384 (data) = \
			 cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7\n"
		);

		let (code, capture) = run_util::<Shasum>(&["-c", "-"], &checklist, dir.path());
		assert_eq!(code, 0);
		assert_eq!(capture.out(), "data: OK\ndata: OK\ndata: OK\n");
		assert_eq!(capture.err(), "");
	}

	#[test]
	fn check_counts_unreadable_files() {
		let dir = tree_with_abc();
		let checklist = format!("{ABC_SHA1}  data\n{ABC_SHA1}  gone\n");

		let (code, capture) = run_util::<Shasum>(&["-c"], &checklist, dir.path());
		assert_eq!(code, 1);
		assert_eq!(capture.out(), "data: OK\ngone: FAILED open or read\n");
		assert_eq!(
			capture.err(),
			"shasum: gone: No such file or directory\nshasum: WARNING: 1 listed file could not be read\n"
		);
	}

	#[test]
	fn ignore_missing_skips_absent_files() {
		let dir = tree_with_abc();
		let checklist = format!("{ABC_SHA1}  data\n{ABC_SHA1}  gone\n");
		let (code, capture) = run_util::<Shasum>(&["-c", "--ignore-missing"], &checklist, dir.path());
		assert_eq!(code, 0);
		assert_eq!(capture.out(), "data: OK\n");
		assert_eq!(capture.err(), "");

		let checklist = format!("{ABC_SHA1}  gone\n");
		let (code, capture) = run_util::<Shasum>(&["-c", "--ignore-missing"], &checklist, dir.path());
		assert_eq!(code, 1);
		assert_eq!(capture.out(), "");
		assert_eq!(capture.err(), "shasum: standard input: no file was verified\n");
	}

	#[test]
	fn check_flags_shape_reporting() {
		let dir = tree_with_abc();
		let checklist = format!("{ABC_SHA1}  data\n\nnot a line\n");

		let (code, capture) = run_util::<Shasum>(&["-c", "-w"], &checklist, dir.path());
		assert_eq!(code, 0);
		assert_eq!(capture.out(), "data: OK\n");
		assert_eq!(
			capture.err(),
			"shasum: standard input: 2: improperly formatted SHA checksum line\nshasum: standard input: 3: \
			 improperly formatted SHA checksum line\nshasum: WARNING: 2 lines are improperly formatted\n"
		);

		let (code, capture) = run_util::<Shasum>(&["-c", "--strict", "-q"], &checklist, dir.path());
		assert_eq!(code, 1);
		assert_eq!(capture.out(), "");
		assert_eq!(capture.err(), "shasum: WARNING: 2 lines are improperly formatted\n");

		let mismatch = "0000000000000000000000000000000000000000  data\n";
		let (code, capture) = run_util::<Shasum>(&["-c", "-s"], mismatch, dir.path());
		assert_eq!(code, 1);
		assert_eq!(capture.out(), "");
		assert_eq!(capture.err(), "");
	}

	#[test]
	fn check_without_well_formed_lines_fails() {
		let (code, capture) = run_util::<Shasum>(&["-c", "-s"], "junk\n", "/");
		assert_eq!(code, 1);
		assert_eq!(capture.err(), "shasum: standard input: no properly formatted SHA checksum lines found\n");
	}

	#[test]
	fn unreadable_checklist_ends_the_run_with_errno() {
		let dir = tree_with_abc();
		let (code, capture) = run_util::<Shasum>(&["-c", "nofile", "data"], "", dir.path());
		assert_eq!(code, 2);
		assert_eq!(capture.out(), "");
		assert_eq!(capture.err(), "shasum: nofile: No such file or directory\n");
	}

	#[test]
	fn rejects_unknown_algorithms() {
		let (code, capture) = run_util::<Shasum>(&["-a", "3"], "", "/");
		assert_eq!(code, 1);
		assert_eq!(capture.err(), "shasum: Unrecognized algorithm\nType shasum -h for help\n");

		let (code, capture) = run_util::<Shasum>(&["-a", "sha1"], "", "/");
		assert_eq!(code, 1);
		assert_eq!(capture.err(), "Value \"sha1\" invalid for option a (number expected)\nType shasum -h for help\n");
	}

	#[test]
	fn rejects_misused_options() {
		let (code, capture) = run_util::<Shasum>(&["-q"], "", "/");
		assert_eq!(code, 1);
		assert_eq!(
			capture.err(),
			"shasum: --quiet option used only when verifying checksums\nType shasum -h for help\n"
		);

		let (code, capture) = run_util::<Shasum>(&["-b", "-t"], "", "/");
		assert_eq!(code, 1);
		assert_eq!(capture.err(), "shasum: Ambiguous file mode\nType shasum -h for help\n");

		let (code, capture) = run_util::<Shasum>(&["--tag", "-t"], "", "/");
		assert_eq!(code, 1);
		assert_eq!(capture.err(), "shasum: --tag does not support --text mode\nType shasum -h for help\n");
	}

	#[test]
	fn version_prints_the_script_version() {
		let (code, capture) = run_util::<Shasum>(&["-v"], "", "/");
		assert_eq!(code, 0);
		assert_eq!(capture.out(), "6.02\n");
	}
}
