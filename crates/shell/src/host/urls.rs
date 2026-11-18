//! The host files behind the URL paths an external is spawned with
//! ([`PiHost::spawn`](super::PiHost)).
//!
//! An external has no view of the shell's virtual filesystem, so a
//! `scheme://` path handed to one means nothing there. File-backed schemes
//! (`skill://`, `local://`, `attachment://`, …) alias a real file and resolve
//! to it; rendered ones and schemes no provider serves alias nothing and keep
//! their spelling. So does anything the provider cannot resolve in an
//! argument or an environment value: a program is as often handed a URL as
//! an identifier or as part of a message (`bm read memory://notes/x`,
//! `log.sh 'agent://A; agent://B'`) as it is handed a path. Only a program
//! or working directory the provider rejects fails the spawn, since nothing
//! could run there. `omp` resolves the URLs it is given itself (with their
//! selectors: `omp read skill://x:1-20`), so its arguments and environment
//! are never rewritten.
//!
//! A spawn that names a URL is taken apart ([`split`]) into the [`Names`] to
//! resolve and the [`Rest`] it moves untouched; the provider is awaited
//! with only the names, so the future [`Host::spawn`](crate::bash::Host::spawn)
//! returns owns everything it needs and is `Send`.

use std::{
	io,
	path::{Path, PathBuf},
};

use bstr::{BStr, BString, ByteSlice};

use crate::bash::{
	ChildRedirs, CmdTag, EnvView, Lineage, OsHandle, PgroupSpec, Rlimit, SigSet, SpawnSpec,
	StdioSpec, Vpid,
};

/// What a spawn hands the OS in place of the URLs it names; before
/// [`resolve`], what the command wrote.
pub(super) struct Names {
	/// The program.
	pub path: BString,
	/// The argument vector (`argv[0]` as written).
	pub argv: Vec<BString>,
	/// The environment, `PWD` naming the host working directory.
	pub env:  EnvView,
	/// The working directory.
	pub cwd:  BString,
}

/// The parts of a [`SpawnSpec`] URL resolution does not touch, owned.
pub(super) struct Rest {
	stdio:       [StdioSpec; 3],
	extra_fds:   Vec<(i32, StdioSpec)>,
	pgroup:      PgroupSpec,
	tag:         CmdTag,
	vpid:        Vpid,
	umask:       u32,
	sigmask_ign: SigSet,
	rlimits:     Vec<(Rlimit, Option<u64>, Option<u64>)>,
	lineage:     Lineage,
	redirs:      Option<ChildRedirs>,
	ctty:        Option<OsHandle>,
}

impl Rest {
	/// Hand `launch` the spawn with the (resolved) `names` in place of the
	/// ones it was split from. Synchronous: nothing of the spec outlives the
	/// call, so no borrow of it crosses an await.
	pub(super) fn launch<R>(self, names: &Names, launch: impl FnOnce(SpawnSpec<'_>) -> R) -> R {
		let Self {
			stdio,
			extra_fds,
			pgroup,
			tag,
			vpid,
			umask,
			sigmask_ign,
			rlimits,
			lineage,
			redirs,
			ctty,
		} = self;
		launch(SpawnSpec {
			path: names.path.as_bstr(),
			argv: &names.argv,
			env: &names.env,
			cwd: names.cwd.as_bstr(),
			stdio,
			extra_fds,
			pgroup,
			tag,
			vpid,
			umask,
			sigmask_ign,
			rlimits: &rlimits,
			lineage,
			redirs,
			ctty,
		})
	}
}

/// Whether `spec` names a URL (program, working directory, an argument
/// containing `://`, or an environment value that is one): then it resolves
/// first, else it spawns as it is.
pub(super) fn names_url(spec: &SpawnSpec<'_>) -> bool {
	is_url(spec.path)
		|| is_url(spec.cwd)
		|| (!runs_omp(spec.argv)
			&& (spec.argv.iter().skip(1).any(|arg| arg.contains_str("://"))
				|| spec.env.iter().any(|(name, value)| env_url(name, value))))
}

/// Whether `argv` runs `omp`: as the program, or as the command a wrapper
/// (`nice omp …`, `npx omp …`) is given ahead of any URL.
fn runs_omp(argv: &[BString]) -> bool {
	argv
		.iter()
		.take_while(|arg| !arg.contains_str("://"))
		.any(|arg| is_omp(arg))
}

/// Whether `word` names the `omp` program, by any path.
fn is_omp(word: &[u8]) -> bool {
	let name = word
		.rsplit(|&b| b == b'/' || (cfg!(windows) && b == b'\\'))
		.next()
		.unwrap_or(word);
	name == b"omp" || (cfg!(windows) && name.eq_ignore_ascii_case(b"omp.exe"))
}

/// Whether the environment variable `name` holds a URL to resolve. `PWD`
/// follows the working directory instead, and a web address aliases no file,
/// so the provider is not asked about one on every spawn.
fn env_url(name: &BStr, value: &BStr) -> bool {
	name != "PWD"
		&& as_path(value)
			.and_then(omp_vfs::url_scheme)
			.is_some_and(|scheme| !matches!(scheme, "http" | "https"))
}

/// Take `spec` apart for a spawn that waits on the provider: the names as
/// written (copied) and the rest (moved, its borrowed slice copied).
pub(super) fn split(spec: SpawnSpec<'_>) -> (Names, Rest) {
	let SpawnSpec {
		path,
		argv,
		env,
		cwd,
		stdio,
		extra_fds,
		pgroup,
		tag,
		vpid,
		umask,
		sigmask_ign,
		rlimits,
		lineage,
		redirs,
		ctty,
	} = spec;
	let names = Names {
		path: BString::from(path.as_bytes()),
		argv: argv.to_vec(),
		env:  env.clone(),
		cwd:  BString::from(cwd.as_bytes()),
	};
	let rest = Rest {
		stdio,
		extra_fds,
		pgroup,
		tag,
		vpid,
		umask,
		sigmask_ign,
		rlimits: rlimits.to_vec(),
		lineage,
		redirs,
		ctty,
	};
	(names, rest)
}

fn is_url(path: &BStr) -> bool {
	as_path(path).is_some_and(omp_vfs::is_virtual_path)
}

/// `bytes` as a path (`None` for bytes that are not one on this platform).
fn as_path(bytes: &[u8]) -> Option<&Path> {
	bytes.to_path().ok()
}

fn path_bytes(path: &Path) -> BString {
	BString::from(path.as_os_str().as_encoded_bytes())
}

/// The host spelling of `names`: every URL the filesystem backs replaced by
/// its file.
pub(super) async fn resolve(fs: &omp_vfs::Fs, names: &Names) -> io::Result<Names> {
	let name = names
		.argv
		.first()
		.map_or_else(|| names.path.to_str_lossy(), |arg| arg.to_str_lossy())
		.into_owned();
	let cwd_bytes: &[u8] = &names.cwd;
	let spawn_dir = match as_path(cwd_bytes) {
		Some(cwd) => match host_path(fs, cwd).await? {
			// A child may write anywhere under its working directory, so it must
			// not start in one the shell itself refuses to change (`skill://`,
			// a read-only `local://`). Arguments still translate: those name single files
			// the program was asked to use.
			Some(backing) => match fs.access(cwd, false, true, false).await {
				Ok(()) => Some(backing),
				Err(err) if err.kind() == io::ErrorKind::ReadOnlyFilesystem => {
					return Err(io::Error::other(format!(
						"cannot run external command '{name}' in read-only working directory {}",
						cwd.display()
					)));
				},
				Err(err) => return Err(unresolved(cwd, &err)),
			},
			None if omp_vfs::is_virtual_path(cwd) && !fs.is_native_local(cwd) => {
				return Err(io::Error::other(format!(
					"cannot run external command '{name}' in virtual working directory {}",
					cwd.display()
				)));
			},
			None => None,
		},
		None => None,
	};
	let path = match as_path(&names.path) {
		Some(program) if omp_vfs::is_virtual_path(program) && !fs.is_native_local(program) => {
			let backing = host_path(fs, program).await?.ok_or_else(|| {
				io::Error::other(format!(
					"{} is a virtual file: an external command cannot run it",
					program.display()
				))
			})?;
			path_bytes(&backing)
		},
		_ => names.path.clone(),
	};
	let literal = runs_omp(&names.argv);
	let mut argv = Vec::with_capacity(names.argv.len());
	for (i, arg) in names.argv.iter().enumerate() {
		let host = if i == 0 || literal {
			None
		} else {
			host_arg(fs, arg.as_bstr()).await
		};
		argv.push(host.unwrap_or_else(|| arg.clone()));
	}
	// What the child's environment says differently from the shell's.
	let mut hosted: Vec<(BString, BString)> = Vec::new();
	if !literal {
		for (name, value) in names.env.iter() {
			if env_url(name, value)
				&& let Some(host) = host_arg(fs, value).await
			{
				hosted.push((BString::from(name.as_bytes()), host));
			}
		}
	}
	let cwd = match spawn_dir {
		// The shell's `$PWD` keeps the URL spelling; only the child is told
		// the directory it actually starts in, so what it reads from `PWD`
		// agrees with its own `getcwd()`.
		Some(dir) => {
			let dir = path_bytes(&dir);
			hosted.push((BString::from("PWD"), dir.clone()));
			dir
		},
		None => names.cwd.clone(),
	};
	let env = if hosted.is_empty() {
		names.env.clone()
	} else {
		let mut pairs: Vec<(BString, BString)> = names
			.env
			.iter()
			.map(|(k, v)| (BString::from(k.as_bytes()), BString::from(v.as_bytes())))
			.collect();
		pairs.append(&mut hosted);
		EnvView::new(pairs)
	};
	Ok(Names { path, argv, env, cwd })
}

/// The host path `path` aliases, if it is a URL the filesystem backs.
async fn host_path(fs: &omp_vfs::Fs, path: &Path) -> io::Result<Option<PathBuf>> {
	if fs.is_native() || !omp_vfs::is_virtual_path(path) {
		return Ok(None);
	}
	fs.backing_path(path)
		.await
		.map_err(|err| unresolved(path, &err))
}

/// A URL the provider could not resolve; `Other`, so the engine prints the
/// reason rather than a bare "No such file".
fn unresolved(path: &Path, err: &io::Error) -> io::Error {
	io::Error::other(format!("cannot resolve {} for an external command: {err}", path.display()))
}

/// `arg` rewritten to the host path it names, if it names one.
///
/// The URL may be the whole argument (`skill://example-skill/tool.py`) or
/// follow a lead that attaches it ([`url_start`]). Anything the filesystem
/// does not route to a backing file, or cannot resolve, is left exactly as
/// it was written, so `https://…`, `s3://…`, an identifier that only looks
/// like one of the provider's URLs, and ordinary words reach the child
/// untouched. A bare scheme root (`local://`), or one followed by words
/// (`skill:// external command`), is far likelier a search pattern or message
/// text than a path, so it stays literal too, as does a URL with words after
/// it (`local://12.log shows the failure`) unless a file has exactly that name.
async fn host_arg(fs: &omp_vfs::Fs, arg: &BStr) -> Option<BString> {
	let text = arg.to_str().ok()?;
	let (lead, url) = text.split_at(url_start(text)?);
	if names_nothing(url) {
		return None;
	}
	let host = host_path(fs, Path::new(url)).await.ok()??;
	if url.contains(char::is_whitespace) && std::fs::symlink_metadata(&host).is_err() {
		return None;
	}
	let mut rewritten = BString::from(lead);
	rewritten.extend_from_slice(&path_bytes(&host));
	Some(rewritten)
}

/// Where the URL `text` hands a program starts: at its beginning, or after
/// what attaches it to an option: a name and `=` (`--index=skill://x/data`,
/// `if=local://in`), a short option letter (`-olocal://out`), and then an `@`
/// that says "the contents of" (`@local://body.json`, `body=@local://b.md`,
/// `-d@local://b.json`).
///
/// Only an option name may carry an attached URL. A URL of its own that
/// happens to embed one in a query string (`https://host/cb?next=local://x`)
/// is one opaque string to the program receiving it.
fn url_start(text: &str) -> Option<usize> {
	if !text.contains("://") {
		return None;
	}
	let url_at = |at: usize| omp_vfs::is_virtual_path(Path::new(&text[at..]));
	if url_at(0) {
		return Some(0);
	}
	let bytes = text.as_bytes();
	let mut at = match text.split_once('=') {
		Some((name, _)) if !name.contains("://") => name.len() + 1,
		_ if bytes.first() == Some(&b'-') && bytes.get(1).is_some_and(u8::is_ascii_alphabetic) => 2,
		_ => 0,
	};
	if bytes.get(at) == Some(&b'@') {
		at += 1;
	}
	url_at(at).then_some(at)
}

/// Whether `text` is a URL naming nothing below its scheme: a bare root
/// (`local://`) or a root followed by whitespace (`skill:// some words`).
fn names_nothing(text: &str) -> bool {
	omp_vfs::url_scheme(Path::new(text)).is_some_and(|scheme| {
		let rest = text[scheme.len() + 3..].trim_start_matches('/');
		rest.trim_end_matches('/').is_empty() || rest.starts_with(char::is_whitespace)
	})
}
