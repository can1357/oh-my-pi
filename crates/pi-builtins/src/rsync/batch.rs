//! Batch mode: `--write-batch` / `--only-write-batch` record the sender→receiver
//! stream of a transfer into a file (plus a `.sh` replay script), and
//! `--read-batch` replays such a file as the sender stream of a local receive.
//!
//! File layout: `int stream_flags`, then (at the point the transfer starts)
//! `int protocol`, `varint compat_flags` (protocol ≥ 30), `int checksum_seed`,
//! followed by the recorded data stream. The stream flags are a bitmap of the
//! options that change the data format; a reader adopts the recorded values.

use std::ffi::OsString;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::rsync::flists::lock;
use crate::rsync::exit::{RERR_FILEIO, RERR_FILESELECT, RERR_SYNTAX, RsyncError};
use crate::rsync::log::{Info, LogCode, Logger, Role};
use crate::host::os_bytes_lossy;
use crate::rsync::options::Options;
use crate::rsync::paths::{self, OperatorOpts, bytes_os_lossy};
use crate::rsync::log::syserr_text;
use crate::rsync::wire::{Proto, WriteExt};

/// Options recorded in the stream-flags word, bit by bit, with the name used in
/// the "Setting/Clearing" notices. Bits 7–8 exist from protocol 29, 9+ from 30.
const FLAG_NAMES: [&str; 15] = [
	"--recurse (-r)",
	"--owner (-o)",
	"--group (-g)",
	"--links (-l)",
	"--devices (-D)",
	"--hard-links (-H)",
	"--checksum (-c)",
	"--dirs (-d)",
	"--compress (-z)",
	"--iconv",
	"--acls (-A)",
	"--xattrs (-X)",
	"--inplace",
	"--append",
	"--append-verify",
];
const ICONV_BIT: usize = 9;

/// A writer shared between the multiplexed stream tee and direct batch writes
/// (`--only-write-batch` deltas, the stats record).
pub(crate) type SharedBatch = Arc<Mutex<Box<dyn Write + Send>>>;

/// `Write` adapter over a [`SharedBatch`].
pub(crate) struct BatchTee(pub SharedBatch);

impl Write for BatchTee {
	fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
		lock(&self.0).write(buf)
	}

	fn flush(&mut self) -> io::Result<()> {
		lock(&self.0).flush()
	}
}

/// Current value of stream-flag bit `i` in `opts`.
fn flag_value(opts: &Options, i: usize) -> bool {
	match i {
		0 => opts.recurse != 0,
		1 => opts.preserve_uid,
		2 => opts.preserve_gid,
		3 => opts.preserve_links,
		4 => opts.preserve_devices,
		5 => opts.preserve_hard_links != 0,
		6 => opts.always_checksum,
		7 => opts.xfer_dirs > 0,
		8 => opts.do_compression != 0,
		9 => opts.iconv_opt.is_some(),
		10 => opts.preserve_acls,
		11 => opts.preserve_xattrs != 0,
		12 => opts.inplace,
		13 => opts.append_mode == 1,
		14 => opts.append_mode == 2,
		_ => false,
	}
}

fn set_flag(opts: &mut Options, i: usize, on: bool) {
	match i {
		0 => opts.recurse = u8::from(on),
		1 => opts.preserve_uid = on,
		2 => opts.preserve_gid = on,
		3 => opts.preserve_links = on,
		4 => opts.preserve_devices = on,
		5 => opts.preserve_hard_links = u32::from(on),
		6 => opts.always_checksum = on,
		7 => opts.xfer_dirs = i32::from(on),
		8 => {
			opts.do_compression = if on { crate::rsync::options::CPRES_AUTO } else { 0 };
		}
		10 => opts.preserve_acls = on,
		11 => opts.preserve_xattrs = u32::from(on),
		12 => opts.inplace = on,
		_ => {}
	}
}

/// upstream `write_stream_flags`: the bitmap for `opts`.
pub(crate) fn stream_flags(opts: &Options) -> i32 {
	(0..FLAG_NAMES.len()).filter(|&i| flag_value(opts, i)).fold(0, |acc, i| acc | (1 << i))
}

/// upstream `check_batch_flags`: adopt the batch file's recorded options.
pub(crate) fn check_batch_flags(
	opts: &mut Options,
	flags: i32,
	protocol: u32,
	logger: &Logger,
) -> Result<(), RsyncError> {
	let count = if protocol < 29 {
		7
	} else if protocol < 30 {
		ICONV_BIT
	} else {
		FLAG_NAMES.len()
	};
	let mut append = opts.append_mode == 1;
	let mut append_verify = opts.append_mode == 2;
	for (i, name) in FLAG_NAMES.iter().enumerate().take(count) {
		let set = flags & (1 << i) != 0;
		let current = match i {
			13 => append,
			14 => append_verify,
			_ => flag_value(opts, i),
		};
		if current == set {
			continue;
		}
		if i == ICONV_BIT {
			let verb = if set { "Please" } else { "Do not" };
			return Err(RsyncError::new(
				RERR_SYNTAX,
				format!("{verb} specify the --iconv option to use this batch file."),
			)
			.at("batch.c", 141));
		}
		if logger.levels().info(Info::Misc) >= 1 {
			let verb = if set { "Sett" } else { "Clear" };
			logger.rprintf(
				LogCode::Info,
				format!("{verb}ing the {name} option to match the batchfile.\n").as_bytes(),
			);
		}
		match i {
			13 => append = set,
			14 => append_verify = set,
			_ => set_flag(opts, i, set),
		}
	}
	if protocol < 29 {
		if opts.recurse != 0 {
			opts.xfer_dirs |= 1;
		} else if opts.xfer_dirs < 2 {
			opts.xfer_dirs = 0;
		}
	}
	if append {
		opts.append_mode = 1;
	} else if append_verify {
		opts.append_mode = 2;
	}
	Ok(())
}

/// The opened batch files of a client.
pub(crate) enum BatchFiles {
	/// `--write-batch`/`--only-write-batch`: the data file and the script path.
	Write { data: SharedBatch, script: PathBuf },
	/// `--read-batch`: the recorded stream (after its stream-flags word).
	Read { data: Box<dyn Read + Send>, flags: i32 },
}

fn open_error(cwd: &Path, name: &[u8], err: &io::Error, code: i32, line: u32) -> RsyncError {
	let text = format!("Batch file {} open error", String::from_utf8_lossy(&paths::full_fname(cwd, name)));
	RsyncError::new(code, syserr_text(Role::Client, err, &text)).at("batch.c", line)
}

/// upstream `open_batch_files` + `write_stream_flags`/`read_stream_flags`.
///
/// `resolve` maps an operator path to what the shell would open; `stdin`
/// supplies `--read-batch=-`.
pub(crate) fn open_batch_files(
	opts: &Options,
	fs: &pi_vfs::BlockingFs,
	cwd: &Path,
	resolve: &dyn Fn(&Path) -> PathBuf,
	stdin: &mut dyn FnMut() -> Box<dyn Read + Send>,
) -> Result<BatchFiles, RsyncError> {
	let name = opts.batch_name.clone().unwrap_or_default();
	let name_bytes = os_bytes_lossy(&name).into_owned();
	let operator = OperatorOpts { insecure: opts.insecure_links, confine: None };
	if opts.write_batch != 0 {
		let mut sh = name.clone();
		sh.push(".sh");
		let sh_bytes = os_bytes_lossy(&sh).into_owned();
		let script = resolve(Path::new(&sh));
		paths::create_operator_file_with(fs, &script, false, 0o700, &operator)
			.map_err(|e| open_error(cwd, &sh_bytes, &e, RERR_FILESELECT, 257))?;
		let path = resolve(Path::new(&name));
		let mut file = paths::create_operator_file_with(fs, &path, false, 0o600, &operator)
			.map_err(|e| open_error(cwd, &name_bytes, &e, RERR_FILEIO, 271))?;
		file.write_int(stream_flags(opts)).map_err(|e| RsyncError::from_io(&e, RERR_FILEIO))?;
		let data: Box<dyn Write + Send> = Box::new(io::BufWriter::new(file));
		return Ok(BatchFiles::Write { data: Arc::new(Mutex::new(data)), script });
	}
	let mut data: Box<dyn Read + Send> = if name_bytes == b"-" {
		stdin()
	} else {
		let path = resolve(Path::new(&name));
		let file = paths::open_operator_file_with(fs, &path, &operator)
			.map_err(|e| open_error(cwd, &name_bytes, &e, RERR_FILEIO, 271))?;
		if !paths::batch_input_ok(&file).unwrap_or(true) {
			let shown = String::from_utf8_lossy_owned(paths::full_fname(cwd, &name_bytes));
			return Err(RsyncError::new(
				RERR_FILEIO,
				format!("Batch file {shown} is neither a regular file nor a FIFO"),
			)
			.at("batch.c", 281));
		}
		Box::new(io::BufReader::new(file))
	};
	let mut word = [0u8; 4];
	data.read_exact(&mut word).map_err(RsyncError::from_stream)?;
	Ok(BatchFiles::Read { data, flags: i32::from_le_bytes(word) })
}

/// upstream `start_write_batch`: the stream header before the recorded data.
pub(crate) fn write_header(batch: &SharedBatch, proto: Proto, seed: i32) -> io::Result<()> {
	let mut w = lock(&batch);
	w.write_int(proto.version as i32)?;
	if proto.version >= 30 {
		w.write_varint(proto.compat as i32)?;
	}
	w.write_int(seed)
}

/// Shell-quotes one argument like upstream's `write_arg`: a plain `--opt=`
/// prefix stays bare, the rest is single-quoted with `'\''` for quotes.
fn write_arg(out: &mut Vec<u8>, arg: &[u8]) {
	let mut arg = arg;
	if arg.first() == Some(&b'-')
		&& let Some(eq) = arg.iter().position(|&b| b == b'=')
		&& arg[..eq].iter().all(|&b| b == b'-' || b == b'_' || b.is_ascii_alphanumeric())
	{
		out.extend_from_slice(&arg[..=eq]);
		arg = &arg[eq + 1..];
	}
	out.push(b'\'');
	for &b in arg {
		if b == b'\'' {
			out.extend_from_slice(b"'\\''");
		} else {
			out.push(b);
		}
	}
	out.push(b'\'');
}

fn write_opt(out: &mut Vec<u8>, opt: &[u8], arg: Option<&[u8]>) {
	out.push(b' ');
	out.extend_from_slice(opt);
	if let Some(arg) = arg {
		out.push(b'=');
		write_arg(out, arg);
	}
}

/// The `BATCH.sh` replay script text (upstream `write_batch_shell_file`).
///
/// `raw_argv` is the whole command line including argv[0]; `cooked` are the
/// operands left after option parsing. `filter_lines` are the global filter
/// rules rendered for the here-doc.
pub(crate) fn shell_script(
	raw_argv: &[OsString],
	cooked: &[OsString],
	filter_lines: &[Vec<u8>],
	eol_nulls: bool,
	protocol: u32,
	is_local_vfs: &dyn Fn(&std::ffi::OsStr) -> bool,
) -> Result<Vec<u8>, RsyncError> {
	let mut raw: Vec<Option<Vec<u8>>> = raw_argv.iter().map(|a| Some(os_bytes_lossy(a).into_owned())).collect();
	let cooked: Vec<Vec<u8>> = cooked.iter().map(|a| os_bytes_lossy(a).into_owned()).collect();
	let mut out = Vec::new();
	write_arg(&mut out, raw.first().and_then(Option::as_ref).map_or(&b"rsync"[..], Vec::as_slice));
	if !filter_lines.is_empty() {
		if protocol >= 29 {
			write_opt(&mut out, b"--filter", Some(b"._-"));
		} else {
			write_opt(&mut out, b"--exclude-from", Some(b"-"));
		}
	}
	// Elide the operands, scanning both lists from the end.
	let mut j = cooked.len();
	let mut i = raw.len();
	while i > 1 && j > 0 {
		i -= 1;
		if raw[i].as_deref() == Some(cooked[j - 1].as_slice()) {
			raw[i] = None;
			j -= 1;
		}
	}
	let mut i = 1;
	while i < raw.len() {
		let Some(p) = raw[i].clone() else {
			i += 1;
			continue;
		};
		if [&b"--files-from"[..], b"--filter", b"--include", b"--exclude"].iter().any(|pre| p.starts_with(pre)) {
			if !p.contains(&b'=') {
				i += 1;
			}
			i += 1;
			continue;
		}
		if p == b"-f" {
			i += 2;
			continue;
		}
		let batch_opt = [&b"--write-batch"[..], b"--only-write-batch"].into_iter().find(|pre| p.starts_with(pre));
		if let Some(pre) = batch_opt {
			let value = (p.get(pre.len()) == Some(&b'=')).then(|| &p[pre.len() + 1..]);
			write_opt(&mut out, b"--read-batch", value);
		} else {
			out.push(b' ');
			write_arg(&mut out, &p);
		}
		i += 1;
	}
	let last = cooked.last().cloned().unwrap_or_default();
	let hostspec = crate::rsync::operands::files_from_hostspec(&bytes_os_lossy(&last), is_local_vfs);
	let dest = match hostspec {
		Some((_, path)) => os_bytes_lossy(&path).into_owned(),
		None => last,
	};
	write_opt(&mut out, b"${1:-", None);
	write_arg(&mut out, &dest);
	out.push(b'}');
	if !filter_lines.is_empty() {
		out.extend_from_slice(b" <<'#E#'\n");
		for line in filter_lines {
			if line.contains(&b'\n') {
				return Err(RsyncError::new(
					RERR_SYNTAX,
					"cannot write a filter rule containing a newline to the batch replay script",
				)
				.at("batch.c", 229));
			}
			out.extend_from_slice(line);
			out.push(if eol_nulls { 0 } else { b'\n' });
		}
		if eol_nulls {
			out.extend_from_slice(b";\n");
		}
		out.extend_from_slice(b"#E#");
	}
	out.push(b'\n');
	Ok(out)
}

/// Writes the replay script (created 0700 when the batch files were opened).
pub(crate) fn write_shell_file(
	fs: &pi_vfs::BlockingFs,
	script: &Path,
	text: &[u8],
	batch_name: &OsString,
	insecure: bool,
) -> Result<(), RsyncError> {
	let operator = OperatorOpts { insecure, confine: None };
	let res = paths::create_operator_file_with(fs, script, false, 0o700, &operator)
		.and_then(|mut f| f.write_all(text).and_then(|()| f.flush()));
	res.map_err(|e| {
		let text = format!("Batch file {}.sh write error", batch_name.display());
		RsyncError::new(RERR_FILEIO, syserr_text(Role::Client, &e, &text)).at("batch.c", 345)
	})
}

#[cfg(test)]
mod tests {
	use super::*;

	fn os(v: &[&str]) -> Vec<OsString> {
		v.iter().map(OsString::from).collect()
	}

	/// Captured from rsync 3.5.1: `rsync -a --exclude='*.o' --write-batch=foo src/ dst/`.
	#[test]
	fn script_matches_reference_with_filters() {
		let raw = os(&["/opt/homebrew/bin/rsync", "-a", "--exclude=*.o", "--write-batch=foo", "src/", "dst/"]);
		let cooked = os(&["src/", "dst/"]);
		let text = shell_script(&raw, &cooked, &[b"- *.o".to_vec()], false, 33, &|_| false).unwrap();
		assert_eq!(
			String::from_utf8(text).unwrap(),
			"'/opt/homebrew/bin/rsync' --filter='._-' '-a' --read-batch='foo' ${1:-'dst/'} <<'#E#'\n- *.o\n#E#\n"
		);
	}

	/// Captured from rsync 3.5.1: `rsync -a --only-write-batch b2 -v src/ dst2/`.
	#[test]
	fn script_matches_reference_separate_value() {
		let raw = os(&["/opt/homebrew/bin/rsync", "-a", "--only-write-batch", "b2", "-v", "src/", "dst2/"]);
		let cooked = os(&["src/", "dst2/"]);
		let text = shell_script(&raw, &cooked, &[], false, 33, &|_| false).unwrap();
		assert_eq!(
			String::from_utf8(text).unwrap(),
			"'/opt/homebrew/bin/rsync' '-a' --read-batch 'b2' '-v' ${1:-'dst2/'}\n"
		);
	}

	#[test]
	fn script_quotes_and_rejects_newline_rules() {
		let raw = os(&["rsync", "--out-format=%n it's", "--write-batch=b", "s", "host:d'x"]);
		let cooked = os(&["s", "host:d'x"]);
		let text = shell_script(&raw, &cooked, &[], false, 33, &|_| false).unwrap();
		assert_eq!(
			String::from_utf8(text).unwrap(),
			"'rsync' --out-format='%n it'\\''s' --read-batch='b' ${1:-'d'\\''x'}\n"
		);
		let err = shell_script(&raw, &cooked, &[b"- a\nb".to_vec()], false, 33, &|_| false).unwrap_err();
		assert_eq!(err.code, RERR_SYNTAX);
	}

	#[test]
	fn stream_flags_round_trip() {
		let o = Options { recurse: 2, preserve_uid: true, inplace: true, append_mode: 2, ..Options::default() };
		let flags = stream_flags(&o);
		assert_eq!(flags, 1 | 2 | (1 << 12) | (1 << 14));
		let logger = Logger::local(Box::new(io::sink()), Box::new(io::sink()), Default::default());
		let mut target = Options::default();
		check_batch_flags(&mut target, flags, 33, &logger).unwrap();
		assert_eq!(target.recurse, 1);
		assert!(target.preserve_uid && target.inplace);
		assert_eq!(target.append_mode, 2);
		let iconv = Options { iconv_opt: Some("utf8".into()), ..Options::default() };
		let err = check_batch_flags(&mut Options::default(), stream_flags(&iconv), 33, &logger).unwrap_err();
		assert_eq!(err.message.as_deref(), Some("Please specify the --iconv option to use this batch file."));
	}

	/// Captured from rsync 3.5.1 (`-a --write-batch=foo src/ dst/`): flags 0x9f.
	#[test]
	fn archive_stream_flags_match_reference() {
		let argv: Vec<OsString> = ["-a", "--write-batch=foo", "src/", "dst/"].iter().map(OsString::from).collect();
		let Ok(crate::rsync::options::Parsed::Run(o)) = crate::rsync::options::parse(&argv, &|_| None) else {
			panic!("parse failed");
		};
		assert_eq!(stream_flags(&o), 0x9f);
	}

	/// The batch header written before the recorded stream. A 3.5.1 batch file
	/// starts `9f000000 21000000 81ff …`: flags, protocol 33, compat 0x1ff as the
	/// varint `81 ff`, then the seed.
	#[test]
	fn header_layout() {
		let buf: SharedBatch = Arc::new(Mutex::new(Box::new(Vec::new())));
		struct Probe(Arc<Mutex<Vec<u8>>>);
		impl Write for Probe {
			fn write(&mut self, b: &[u8]) -> io::Result<usize> {
				self.0.lock().unwrap().extend_from_slice(b);
				Ok(b.len())
			}
			fn flush(&mut self) -> io::Result<()> {
				Ok(())
			}
		}
		let sink = Arc::new(Mutex::new(Vec::new()));
		*buf.lock().unwrap() = Box::new(Probe(Arc::clone(&sink)));
		write_header(&buf, Proto { version: 33, compat: 0x1ff }, 0x01ac_6aee).unwrap();
		assert_eq!(*sink.lock().unwrap(), [0x21, 0, 0, 0, 0x81, 0xff, 0xee, 0x6a, 0xac, 0x01]);
	}
}
