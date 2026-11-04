//! A host with MCP off (`PI_NO_MCP=1`) starts a server with MCP off, whatever
//! the command's own environment says. Its own test binary: it sets the
//! process environment.

#![cfg(unix)]

use std::time::Duration;

use omp_rpc::*;

fn server_saw(host: &str, override_value: &str) -> String {
	// SAFETY: this test binary holds this one test, so no other thread reads
	// the environment while it changes.
	unsafe { std::env::set_var("PI_NO_MCP", host) };
	let out = std::env::temp_dir()
		.join(format!("omp-rpc-mcp-env-{}-{host}-{override_value}", std::process::id()));
	let _ = std::fs::remove_file(&out);
	let script =
		r#"printf '%s' "${PI_NO_MCP-unset}" > "$0"; printf '{"type":"ready"}\n'; exec sleep 30"#;
	let mut process = std::process::Command::new("sh");
	process
		.arg("-c")
		.arg(script)
		.arg(&out)
		.env("PI_NO_MCP", override_value);
	let (client, _events) = Client::spawn(process, ClientOptions::default()).unwrap();
	let deadline = std::time::Instant::now() + Duration::from_secs(5);
	let seen = loop {
		if let Ok(seen) = std::fs::read_to_string(&out) {
			break seen;
		}
		assert!(std::time::Instant::now() < deadline, "server wrote no environment");
		std::thread::sleep(Duration::from_millis(20));
	};
	drop(client);
	let _ = std::fs::remove_file(&out);
	seen
}

#[test]
fn keeps_mcp_off_for_a_host_with_mcp_off() {
	for override_value in ["", "0", "false"] {
		assert_eq!(server_saw("1", override_value), "1", "override {override_value:?}");
	}
	// A host with MCP on passes the command's own value through.
	assert_eq!(server_saw("", "1"), "1");
	assert_eq!(server_saw("", ""), "");
}
