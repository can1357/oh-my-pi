// Copyright 2017 Google Inc.
//
// Use of this source code is governed by a MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

//! Vendored, patched `find` from uutils/findutils, wired to run in-process as a
//! brush shell builtin via [`pi_uutils_ctx`].

pub mod find;

/// In-process builtin entry point. The host installs a [`pi_uutils_ctx`] scope
/// (stdio + working directory + environment) on a dedicated blocking thread,
/// then calls this.
///
/// Unlike findutils' real `main` (which `std::process::exit`s on the result of
/// `find_main`), this returns the exit code so it is safe to run inside the
/// long-lived host shell process. All output is routed through the context
/// streams and starting-path operands resolve against the shell working dir.
pub fn run(argv: Vec<std::ffi::OsString>) -> i32 {
	// findutils' `find_main` is fundamentally `&[&str]`-based — upstream's real
	// `main` builds it straight from `std::env::args()`, so lossy UTF-8
	// conversion matches the existing upstream behavior for arguments.
	let args: Vec<String> = argv
		.iter()
		.map(|a| a.to_string_lossy().into_owned())
		.collect();
	let mut strs: Vec<&str> = args.iter().map(String::as_str).collect();
	// `find_main` treats argv[0] as the program name and skips it. The host
	// always supplies it; guard against an empty argv to avoid an index panic.
	if strs.is_empty() {
		strs.push("find");
	}
	let deps = find::StandardDependencies::new();
	find::find_main(&strs, &deps)
}
