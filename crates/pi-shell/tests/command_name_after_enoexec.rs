//! Hand-written because Bash's failed script-read diagnostic has no `line 1:`
//! prefix, while this branch still renders it; the recorded corpus must remain
//! byte-exact against Bash. The prefix belongs to sibling pull request #18246;
//! this test defends the command name chosen before ENOEXEC recovery fails.

#![cfg(unix)]

use std::{collections::HashMap, os::unix::fs::PermissionsExt};

use pi_shell::{Shell, ShellRunOptions, cancel::CancelToken};

#[tokio::test]
async fn failed_enoexec_recovery_keeps_the_resolved_command_name() {
	let cases = [
		// Bash 5.3.0 stderr: b"bash: bin/unreadable: Permission denied\n".
		(
			"enoexec-unreadable-path",
			"PATH=bin:/usr/bin:/bin; unreadable",
			"bash: line 1: bin/unreadable: Permission denied\n",
		),
		// Bash 5.3.0 stderr: b"bash: ./bin/unreadable: Permission denied\n".
		(
			"enoexec-unreadable-hash",
			"hash -p bin/unreadable q; q",
			"bash: line 1: ./bin/unreadable: Permission denied\n",
		),
		// Bash 5.3.0 stderr: b"bash: {D}/bin/unreadable: Permission denied\n".
		(
			"enoexec-unreadable-exec",
			"exec ./bin/unreadable",
			"bash: line 1: {D}/bin/unreadable: Permission denied\n",
		),
	];
	let mut differing = Vec::new();
	for (id, script, expected) in cases {
		let dir = tempfile::Builder::new()
			.prefix(id)
			.tempdir()
			.expect("case directory");
		let home = dir.path().display().to_string();
		std::fs::create_dir(dir.path().join("bin")).expect("fixture directory");
		let fixture = dir.path().join("bin/unreadable");
		std::fs::write(&fixture, b"echo fallback\n").expect("script without a shebang");
		std::fs::set_permissions(&fixture, std::fs::Permissions::from_mode(0o111))
			.expect("executable but unreadable script");
		assert_eq!(
			std::fs::read(&fixture)
				.expect_err("run this test as a user unable to read mode-0111 files")
				.kind(),
			std::io::ErrorKind::PermissionDenied,
			"{id}: the fixture must trigger a real read failure after ENOEXEC",
		);
		let env: HashMap<String, String> = [
			("PATH", "/usr/bin:/bin"),
			("LC_ALL", "C.UTF-8"),
			("TERM", "dumb"),
			("HOME", home.as_str()),
		]
		.into_iter()
		.map(|(key, value)| (key.to_owned(), value.to_owned()))
		.collect();
		let stdout = dir.path().join("stdout.bin");
		let stderr = dir.path().join("stderr.bin");
		let result = Shell::new(None)
			.run(
				ShellRunOptions {
					command: format!("exec >'{}' 2>'{}'; {script}", stdout.display(), stderr.display()),
					cwd: Some(home.clone()),
					env: Some(env),
					..Default::default()
				},
				None,
				CancelToken::new(Some(30_000)),
			)
			.await
			.expect("run the shell consumer");
		let out = std::fs::read(stdout).expect("captured stdout");
		let err = std::fs::read(stderr).expect("captured stderr");
		let expected = expected.replace("{D}", &home);
		if result.exit_code != Some(126) || !out.is_empty() || err != expected.as_bytes() {
			differing.push(format!(
				"{id}: expected status=126 stdout=[] stderr={expected:?}; got status={:?} \
				 stdout={out:?} stderr={:?}",
				result.exit_code,
				String::from_utf8_lossy(&err),
			));
		}
	}
	assert!(differing.is_empty(), "{} rows differ:\n{}", differing.len(), differing.join("\n"));
}
