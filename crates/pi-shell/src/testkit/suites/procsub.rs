//! Process substitution: `/dev/fd/N` words backed by in-memory pipes the
//! engine's builtins and redirections read (goldens from bash 5.3.20).

use crate::testkit::{FakeHost, Fault, run_script};

fn run(src: &str) -> (String, i32) {
	let out = run_script(FakeHost::new(), src.as_bytes(), &[], Fault::None);
	(String::from_utf8_lossy(&out.stdout).into_owned(), out.status)
}

#[test]
fn fds_count_down_from_63_and_close_after_the_command() {
	let (out, status) = run("read x < <(echo hi); echo $x; echo <(:) <(:); : <(:); echo <(:)");
	assert_eq!(out, "hi\n/dev/fd/63 /dev/fd/62\n/dev/fd/63\n");
	assert_eq!(status, 0);
}

#[test]
fn loops_source_and_functions_read_the_pipe() {
	let (out, status) = run(
		"while read l; do echo \"[$l]\"; done < <(printf 'a\\nb\\n'); source <(echo 'echo \
		 sourced'); cat_() { while read -r l; do echo \"c:$l\"; done; }; cat_ < <(echo x)",
	);
	assert_eq!(out, "[a]\n[b]\nsourced\nc:x\n");
	assert_eq!(status, 0);
}
