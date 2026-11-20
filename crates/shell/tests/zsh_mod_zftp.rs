//! zsh/zftp against a scripted FTP server: the obash binary run as
//! `zsh -f -c SCRIPT` in a temporary directory talks to a server thread
//! of this test on 127.0.0.1 (passive and sendport data connections,
//! ASCII and image types, stream and block modes, sessions, progress and
//! chpwd hooks, a timeout, a server closing the connection).
//!
//! zftp only opens ports that are TCP services (`getservbyport`), so the
//! server listens on the first free port above 20000 that `/etc/services`
//! names; without `/etc/services` the tests have nothing to run.
//!
//! Expected output from `/bin/zsh -f -c SCRIPT` 5.9 (macOS) against a
//! Python twin of this server (same replies, byte for byte), with
//! `zsh/net/tcp` loaded before `zsh/zftp` (the macOS build cannot load
//! `zsh/zftp` alone). `@PORT@` stands for the server's port.

#![cfg(unix)]

mod obash_support;

use std::{
	collections::BTreeMap,
	io::{BufRead, BufReader, Read, Write},
	net::{Shutdown, SocketAddr, TcpListener, TcpStream},
	os::unix::process::CommandExt,
	sync::{Arc, Mutex},
	thread,
	time::{Duration, Instant, SystemTime},
};

use crate::obash_support::{obash, output};

/// The server's files, shared by its connections.
type Files = Arc<Mutex<BTreeMap<String, Vec<u8>>>>;

/// A scripted FTP server; each finished connection leaves its command log.
struct Server {
	port: u16,
	logs: Arc<Mutex<Vec<String>>>,
}

/// The first port in 20000..=60000 that `/etc/services` lists for TCP and
/// that is free on 127.0.0.1.
fn service_listener() -> Option<(TcpListener, u16)> {
	let services = std::fs::read_to_string("/etc/services").ok()?;
	for line in services.lines() {
		let mut words = line.split_whitespace();
		let (Some(_), Some(spec)) = (words.next(), words.next()) else {
			continue;
		};
		if line.starts_with('#') {
			continue;
		}
		let Some(port) = spec
			.strip_suffix("/tcp")
			.and_then(|p| p.parse::<u16>().ok())
		else {
			continue;
		};
		if !(20000..=60000).contains(&port) {
			continue;
		}
		if let Ok(l) = TcpListener::bind(("127.0.0.1", port)) {
			return Some((l, port));
		}
	}
	None
}

impl Server {
	fn start() -> Option<Self> {
		let (listener, port) = service_listener()?;
		let logs = Arc::new(Mutex::new(Vec::new()));
		let files: Files = Arc::new(Mutex::new(BTreeMap::from([
			("hello.txt".to_owned(), b"hello world\n".to_vec()),
			("crlf.txt".to_owned(), b"one\r\ntwo\r\nthree\r\n".to_vec()),
		])));
		let l = logs.clone();
		thread::spawn(move || {
			for c in listener.incoming() {
				let Ok(c) = c else { break };
				let (files, logs) = (files.clone(), l.clone());
				thread::spawn(move || {
					let log = serve(c, &files);
					logs.lock().unwrap().push(log);
				});
			}
		});
		Some(Self { port, logs })
	}

	/// The command logs of `n` finished connections, sorted.
	fn logs(&self, n: usize) -> Vec<String> {
		let start = Instant::now();
		loop {
			let logs = self.logs.lock().unwrap().clone();
			if logs.len() >= n || start.elapsed() > Duration::from_secs(10) {
				let mut logs = logs;
				logs.sort();
				return logs;
			}
			thread::sleep(Duration::from_millis(20));
		}
	}
}

/// One control connection: the session's command log.
fn serve(c: TcpStream, files: &Files) -> String {
	let mut log = Vec::new();
	let mut out = c.try_clone().unwrap();
	let mut reader = BufReader::new(c);
	let mut send = |t: &str| {
		let _ = out.write_all(format!("{t}\r\n").as_bytes());
	};
	send("220 test server ready");
	let mut cwd = String::from("/home/test");
	let mut mode = 'S';
	let mut pasv: Option<TcpListener> = None;
	let mut port: Option<SocketAddr> = None;
	let mut rest = 0usize;
	let mut rnfr = String::new();
	let data_conn = |pasv: &mut Option<TcpListener>, port: &mut Option<SocketAddr>| -> TcpStream {
		if let Some(l) = pasv.take() {
			return l.accept().unwrap().0;
		}
		TcpStream::connect(port.take().unwrap()).unwrap()
	};
	let send_data = |mut d: TcpStream, payload: &[u8], mode: char| {
		if mode == 'B' {
			let n = payload.len();
			let _ = d.write_all(&[64, (n >> 8) as u8, (n & 255) as u8]);
		}
		let _ = d.write_all(payload);
		let _ = d.shutdown(Shutdown::Both);
	};
	let recv_data = |mut d: TcpStream, mode: char| -> Vec<u8> {
		let mut buf = Vec::new();
		let _ = d.read_to_end(&mut buf);
		if mode != 'B' {
			return buf;
		}
		let mut out = Vec::new();
		let mut i = 0;
		while i + 3 <= buf.len() {
			let n = (usize::from(buf[i + 1]) << 8) | usize::from(buf[i + 2]);
			let end = (i + 3 + n).min(buf.len());
			out.extend_from_slice(&buf[i + 3..end]);
			i += 3 + n;
		}
		out
	};
	loop {
		let mut raw = Vec::new();
		if reader.read_until(b'\n', &mut raw).unwrap_or(0) == 0 {
			break;
		}
		while matches!(raw.last(), Some(b'\r' | b'\n')) {
			raw.pop();
		}
		let line: String = raw.iter().map(|&b| char::from(b)).collect();
		let (cmd, arg) = line.split_once(' ').unwrap_or((&line, ""));
		let cmd = cmd.to_uppercase();
		log.push(match cmd.as_str() {
			"PORT" | "EPRT" => format!("{cmd} *"),
			"PASS" => "PASS *".to_owned(),
			_ => line.clone(),
		});
		match cmd.as_str() {
			"USER" => send(&format!("331 Password required for {arg}")),
			"PASS" => send("230 User logged in"),
			"SYST" => send("215 UNIX Type: L8"),
			"PWD" => send(&format!("257 \"{cwd}\" is current directory")),
			"CWD" if arg == "nodir" => send("550 No such directory"),
			"CWD" => {
				cwd = if arg.starts_with('/') {
					arg.to_owned()
				} else {
					format!("{}/{arg}", cwd.trim_end_matches('/'))
				};
				send("250 CWD ok");
			},
			"CDUP" => {
				cwd = match cwd.rsplit_once('/') {
					Some((head, _)) if !head.is_empty() => head.to_owned(),
					_ => "/".to_owned(),
				};
				send("250 CDUP ok");
			},
			"TYPE" => send(&format!("200 Type set to {arg}")),
			"MODE" if arg == "S" || arg == "B" => {
				mode = if arg == "S" { 'S' } else { 'B' };
				send(&format!("200 Mode set to {arg}"));
			},
			"MODE" => send("504 Bad mode"),
			"PASV" => {
				let l = TcpListener::bind("127.0.0.1:0").unwrap();
				let p = l.local_addr().unwrap().port();
				pasv = Some(l);
				send(&format!("227 Entering Passive Mode (127,0,0,1,{},{})", p >> 8, p & 255));
			},
			"PORT" => {
				let n: Vec<u16> = arg.split(',').map(|x| x.parse().unwrap()).collect();
				let ip = format!("{}.{}.{}.{}", n[0], n[1], n[2], n[3]);
				port = Some(SocketAddr::new(ip.parse().unwrap(), n[4] * 256 + n[5]));
				send("200 PORT command successful");
			},
			"NLST" | "LIST" => {
				send("150 Opening ASCII mode data connection for file list");
				let d = data_conn(&mut pasv, &mut port);
				let body: String = files
					.lock()
					.unwrap()
					.iter()
					.map(|(name, data)| {
						if cmd == "LIST" {
							format!("-rw-r--r-- 1 ftp ftp {} Jan 1 2024 {name}\r\n", data.len())
						} else {
							format!("{name}\r\n")
						}
					})
					.collect();
				send_data(d, body.as_bytes(), mode);
				send("226 Transfer complete");
			},
			"SIZE" => match files.lock().unwrap().get(arg) {
				Some(f) => send(&format!("213 {}", f.len())),
				None => send(&format!("550 {arg}: No such file")),
			},
			"MDTM" => {
				if files.lock().unwrap().contains_key(arg) {
					send("213 20240102030405");
				} else {
					send(&format!("550 {arg}: No such file"));
				}
			},
			"REST" => {
				rest = arg.parse().unwrap();
				send(&format!("350 Restarting at {rest}"));
			},
			"RETR" => {
				let file = files.lock().unwrap().get(arg).cloned();
				let Some(file) = file else {
					send(&format!("550 {arg}: No such file"));
					pasv = None;
					continue;
				};
				let payload = file[rest.min(file.len())..].to_vec();
				rest = 0;
				send(&format!(
					"150 Opening BINARY mode data connection for {arg} ({} bytes)",
					payload.len()
				));
				let d = data_conn(&mut pasv, &mut port);
				send_data(d, &payload, mode);
				send("226 Transfer complete");
			},
			"STOR" | "APPE" => {
				send("150 Ok to send data");
				let d = data_conn(&mut pasv, &mut port);
				let got = recv_data(d, mode);
				let n = got.len();
				{
					let mut files = files.lock().unwrap();
					let old = files.get(arg).cloned().unwrap_or_default();
					let new = if cmd == "APPE" {
						[old, got].concat()
					} else {
						[old[..rest.min(old.len())].to_vec(), got].concat()
					};
					files.insert(arg.to_owned(), new);
				}
				rest = 0;
				send(&format!("226 Transfer complete ({n} bytes)"));
			},
			"DELE" => {
				if files.lock().unwrap().remove(arg).is_some() {
					send("250 Deleted");
				} else {
					send(&format!("550 {arg}: No such file"));
				}
			},
			"MKD" => send(&format!("257 \"{arg}\" created")),
			"RMD" => send("250 Removed"),
			"RNFR" => {
				if files.lock().unwrap().contains_key(arg) {
					rnfr = arg.to_owned();
					send("350 Ready for RNTO");
				} else {
					send(&format!("550 {arg}: No such file"));
				}
			},
			"RNTO" => {
				let mut files = files.lock().unwrap();
				if let Some(f) = files.remove(&rnfr) {
					files.insert(arg.to_owned(), f);
				}
				drop(files);
				send("250 Renamed");
			},
			"SITE" => send(&format!("200 SITE {arg} ok")),
			"NOOP" => send("200 NOOP ok"),
			// Never answers: the client's timeout.
			"SLEEP" => {},
			"HELP" => {
				send("214-The following commands are recognized:");
				send(" USER PASS QUIT");
				send("214 Help OK.");
			},
			"BYE" => {
				send("421 Service closing control connection");
				break;
			},
			"QUIT" => {
				send("221 Goodbye");
				break;
			},
			_ => send(&format!("502 {cmd} not implemented")),
		}
	}
	let _ = reader.get_ref().shutdown(Shutdown::Both);
	format!("SESSION {}", log.join(" | "))
}

/// Run `script` (with `@PORT@` replaced) as `zsh -f -c` through obash in a
/// new directory holding `up.txt` (`up\n`) and `local.txt` (`abc\n`,
/// modified 2020-01-02 03:04:05 UTC): stdout, stderr, status.
fn zsh(port: u16, script: &str) -> (String, String, i32) {
	let dir = tempfile::tempdir().unwrap();
	std::fs::write(dir.path().join("up.txt"), "up\n").unwrap();
	let local = dir.path().join("local.txt");
	std::fs::write(&local, "abc\n").unwrap();
	let when = SystemTime::UNIX_EPOCH + Duration::from_secs(1_577_934_245);
	std::fs::File::options()
		.write(true)
		.open(&local)
		.unwrap()
		.set_modified(when)
		.unwrap();
	let script = script.replace("@PORT@", &port.to_string());
	let mut cmd = obash();
	cmd.arg0("zsh");
	let out = output(cmd.current_dir(dir.path()).args(["-f", "-c", &script]));
	(
		String::from_utf8_lossy(&out.stdout).into_owned(),
		String::from_utf8_lossy(&out.stderr).into_owned(),
		out.status.code().unwrap_or(-1),
	)
}

#[test]
fn zsh_mod_zftp_passive_session() {
	let Some(server) = Server::start() else {
		eprintln!("no free /etc/services port: nothing to test");
		return;
	};
	let (out, err, st) = zsh(
		server.port,
		r"zmodload zsh/net/tcp zsh/zftp
zftp open 127.0.0.1:@PORT@ alice secret; echo open=$?
typeset -p ZFTP_HOST ZFTP_IP ZFTP_SYSTEM ZFTP_TYPE ZFTP_USER ZFTP_PWD ZFTP_MODE ZFTP_CODE ZFTP_REPLY ZFTP_SESSION ZFTP_ACCOUNT ZFTP_PORT
zftp ls; echo ls=$?
zftp dir; echo dir=$?
zftp get hello.txt; echo get=$?
zftp ascii; x=$(zftp get crlf.txt); print -r -- ${(q+)x}; zftp type
zftp binary; x=$(zftp get crlf.txt); print -r -- ${(q+)x}; zftp type
zftp get nosuch; echo nosuch=$?
zftp cd sub; echo cd=$? $ZFTP_PWD; zftp cdup; echo $ZFTP_PWD; zftp cd nodir; echo cd=$?
zftp type; zftp type b; zftp type; zftp type x; echo $?
zftp mode; zftp mode b; zftp mode; zftp mode s; zftp mode q; echo $?
zftp remote hello.txt nosuch crlf.txt; echo remote=$?
zftp quote NOOP; echo q=$?; zftp site CHMOD 644 x; echo s=$?
zftp mkdir d; zftp rmdir d; zftp delete crlf.txt nosuch; echo del=$?
zftp rename hello.txt h2.txt; echo ren=$?; zftp rename nosuch x; echo ren=$?
echo data | zftp put up.txt; echo put=$?; zftp get up.txt
echo more | zftp append up.txt; zftp get up.txt
zftp getat h2.txt 6; echo
ZFTP_VERBOSE=0123456; zftp quote HELP; zftp pwd 2>&1; zftp quote NOOP; ZFTP_VERBOSE=450
zftp test; echo test=$?
ztcp -L | while read fd type rest; do print $type; done
zftp close; echo close=$?; typeset -p ZFTP_HOST ZFTP_CODE ZFTP_REPLY
zftp ls; echo $?",
	);
	let expected = r#"open=0
typeset -r ZFTP_HOST=127.0.0.1
typeset -r ZFTP_IP=127.0.0.1
typeset -r ZFTP_SYSTEM='UNIX Type: L8'
typeset -r ZFTP_TYPE=I
typeset -r ZFTP_USER=alice
typeset -r ZFTP_PWD=/home/test
typeset -r ZFTP_MODE=S
typeset -r ZFTP_CODE=257
typeset -r ZFTP_REPLY='257 "/home/test" is current directory'
typeset -r ZFTP_SESSION=default
typeset -ir ZFTP_PORT=@PORT@
crlf.txt
hello.txt
ls=0
-rw-r--r-- 1 ftp ftp 17 Jan 1 2024 crlf.txt
-rw-r--r-- 1 ftp ftp 12 Jan 1 2024 hello.txt
dir=0
hello world
get=0
$'one\ntwo\nthree'
A
$'one\C-M\ntwo\C-M\nthree\C-M'
I
nosuch=1
cd=0 /home/test/sub
/home/test
cd=1
I
I
1
S
B
1
hello.txt 12 20240102030405
crlf.txt 17 20240102030405
remote=1
q=0
s=0
del=1
ren=0
ren=1
put=0
data
data

zsh:zftp:20: no such subcommand: pwd
test=0
Z
close=0
typeset -r ZFTP_CODE=221
typeset -r ZFTP_REPLY='221 Goodbye'
1
"#;
	assert_eq!(out, expected.replace("@PORT@", &server.port.to_string()));
	assert_eq!(
		err,
		"zsh:typeset:3: no such variable: ZFTP_ACCOUNT
550 nosuch: No such file
550 No such directory
zsh:zftp type:11: transfer type x not recognised
zsh:zftp mode:12: transfer mode Q not recognised
550 nosuch: No such file
550 nosuch: No such file
550 nosuch: No such file
zsh:zftp:19: short data block
zsh:zftp getat:19: read failed: Input/output error
214-The following commands are recognized:
 USER PASS QUIT
214 Help OK.
200 NOOP ok
zsh:typeset:23: no such variable: ZFTP_HOST
zsh:zftp ls:24: not connected.
"
	);
	assert_eq!(st, 0);
	assert_eq!(server.logs(1), ["SESSION USER alice | PASS * | SYST | PWD | PASV | NLST | PASV | \
	                             LIST | TYPE I | PASV | RETR hello.txt | TYPE A | PASV | RETR \
	                             crlf.txt | TYPE I | PASV | RETR crlf.txt | PASV | RETR nosuch | \
	                             CWD sub | PWD | CDUP | PWD | CWD nodir | MODE B | MODE S | SIZE \
	                             hello.txt | MDTM hello.txt | SIZE nosuch | SIZE crlf.txt | MDTM \
	                             crlf.txt | NOOP | SITE CHMOD 644 x | MKD d | RMD d | DELE \
	                             crlf.txt | DELE nosuch | RNFR hello.txt | RNTO h2.txt | RNFR \
	                             nosuch | PASV | STOR up.txt | PASV | RETR up.txt | PASV | APPE \
	                             up.txt | PASV | RETR up.txt | PASV | REST 6 | RETR h2.txt | \
	                             HELP | NOOP | QUIT"]);
}

#[test]
fn zsh_mod_zftp_sendport_sessions_and_hooks() {
	let Some(server) = Server::start() else {
		eprintln!("no free /etc/services port: nothing to test");
		return;
	};
	let (out, err, st) = zsh(
		server.port,
		r#"zmodload zsh/net/tcp zsh/zftp
ZFTP_PREFS=S
zftp_progress() { print -r -- "progress $ZFTP_TRANSFER ${ZFTP_COUNT-unset} ${ZFTP_SIZE-unset} $ZFTP_FILE" >&2 }
zftp_chpwd() { print -r -- "chpwd ${ZFTP_PWD-unset}" >&2 }
zftp params 127.0.0.1:@PORT@ bob pw
zftp params
zftp open; echo open=$?
zftp ls; echo ls=$?
zftp get hello.txt nosuch; echo get=$?
print up > up.txt; zftp put new.txt < up.txt; echo put=$?
zftp session second; zftp session; typeset -p ZFTP_SESSION; zftp ls; echo $?
ZFTP_PREFS=PD
zftp open 127.0.0.1:@PORT@ carol; echo open2=$?; typeset -p ZFTP_PWD ZFTP_SYSTEM ZFTP_TYPE
zftp ls; zftp session default; typeset -p ZFTP_USER ZFTP_SESSION
zftp session second; zftp rmsession; zftp session; typeset -p ZFTP_SESSION ZFTP_USER
ZFTP_VERBOSE=0; zftp quote HELP; ZFTP_VERBOSE=450
ZFTP_PREFS=x; zftp quote NOOP; echo q=$?
zftp quote BYE; echo bye=$?; typeset -p ZFTP_HOST
zftp ls; echo $?"#,
	);
	let expected = "127.0.0.1:@PORT@
bob
**
open=0
crlf.txt
hello.txt
ls=0
hello world
get=1
put=0
default
second
typeset -r ZFTP_SESSION=second
1
open2=1
typeset -r ZFTP_TYPE=A
crlf.txt
hello.txt
new.txt
typeset -r ZFTP_USER=bob
typeset -r ZFTP_SESSION=default
default
typeset -r ZFTP_SESSION=default
typeset -r ZFTP_USER=bob
q=0
bye=1
1
";
	assert_eq!(out, expected.replace("@PORT@", &server.port.to_string()));
	assert_eq!(
		err,
		"chpwd /home/test
progress G 0 12 hello.txt
progress G 12 12 hello.txt
progress GF 12 12 hello.txt
550 nosuch: No such file
progress P 0 3 new.txt
progress P 3 3 new.txt
progress PF 3 3 new.txt
zsh:zftp ls:11: not connected.
zsh:typeset:13: no such variable: ZFTP_PWD
zsh:typeset:13: no such variable: ZFTP_SYSTEM
chpwd unset
The following commands are recognized:
 USER PASS QUIT
zsh:zftp:17: preference x not recognized
zsh:zftp:18: preference x not recognized
421 Service closing control connection
chpwd unset
zsh:zftp:18: remote server has closed connection
zsh:typeset:18: no such variable: ZFTP_HOST
zsh:zftp ls:19: not connected.
"
	);
	assert_eq!(st, 0);
	assert_eq!(server.logs(2), [
		"SESSION USER bob | PASS * | SYST | PWD | PORT * | NLST | TYPE I | SIZE hello.txt | PORT * \
		 | RETR hello.txt | PORT * | RETR nosuch | PORT * | STOR new.txt | HELP | NOOP | BYE",
		"SESSION USER carol | PASS * | PASV | NLST | QUIT",
	]);
}

#[test]
fn zsh_mod_zftp_block_mode_timeout_and_local_files() {
	let Some(server) = Server::start() else {
		eprintln!("no free /etc/services port: nothing to test");
		return;
	};
	let (out, err, st) = zsh(
		server.port,
		r"zmodload zsh/net/tcp zsh/zftp
zftp open 127.0.0.1:@PORT@ dave pw
zftp mode B; zftp get hello.txt; echo get=$?
echo blockdata | zftp put b.txt; echo put=$?
zftp mode S; zftp mode; x=$(zftp get b.txt); echo $?; print -r -- ${(q+)x}
zftp local local.txt /nonexist; echo local=$?
zftp test; echo test=$?
ZFTP_TMOUT=1; zftp quote SLEEP; echo sleep=$?; typeset -p ZFTP_CODE ZFTP_REPLY
zftp test; echo test=$?
zftp; echo $?
zftp cd; echo $?
zftp foo
zftp open 127.0.0.1:nosuchservice; echo $?",
	);
	assert_eq!(
		out,
		"hello world
get=0
put=0
B
1
''
local.txt 4 20200102030405
local=1
test=0
sleep=1
typeset -r ZFTP_CODE=200
typeset -r ZFTP_REPLY=''
test=1
1
1
1
"
	);
	assert_eq!(
		err,
		"zsh:zftp:5: short data block
zsh:zftp get:5: read failed: Input/output error
zsh:zftp:8: timeout getting response
zsh:zftp:10: not enough arguments
zsh:zftp:11: wrong no. of arguments for cd
zsh:zftp:12: no such subcommand: foo
zsh:zftp open:13: Can't find port for service `nosuchservice'
"
	);
	assert_eq!(st, 0);
	assert_eq!(server.logs(1), ["SESSION USER dave | PASS * | SYST | PWD | MODE B | PASV | RETR \
	                             hello.txt | PASV | STOR b.txt | MODE S | PASV | RETR b.txt | \
	                             SLEEP"]);
}

/// zsh `zexit` runs zsh/zftp's exit hook (`zftp_cleanup`) after the
/// `zshexit` hooks: an open session is closed with `QUIT`, at `exit` and at
/// the end of a `-c` string alike, and the shell keeps its exit status.
#[test]
fn zsh_mod_zftp_session_quits_at_shell_exit() {
	let Some(server) = Server::start() else {
		eprintln!("no free /etc/services port: nothing to test");
		return;
	};
	let (out, err, st) = zsh(
		server.port,
		r"zmodload zsh/net/tcp zsh/zftp
zftp open 127.0.0.1:@PORT@ erin secret; echo open=$?
zshexit() { echo bye $?; }
exit 3",
	);
	assert_eq!((out.as_str(), err.as_str(), st), ("open=0\nbye 3\n", "", 3));
	let (out, err, st) = zsh(
		server.port,
		r"zmodload zsh/net/tcp zsh/zftp
zftp open 127.0.0.1:@PORT@ frank secret; echo open=$?
false",
	);
	assert_eq!((out.as_str(), err.as_str(), st), ("open=0\n", "", 1));
	assert_eq!(server.logs(2), [
		"SESSION USER erin | PASS * | SYST | PWD | QUIT",
		"SESSION USER frank | PASS * | SYST | PWD | QUIT",
	]);
}

/// At exit the current session's close unsets its parameters and calls
/// `zftp_chpwd` (zsh `zftp_cleanup` → `zfclose(0)`), after the `QUIT`
/// whose reply `ZFTP_VERBOSE` prints.
#[test]
fn zsh_mod_zftp_exit_runs_zftp_chpwd() {
	let Some(server) = Server::start() else {
		eprintln!("no free /etc/services port: nothing to test");
		return;
	};
	let (out, err, st) = zsh(
		server.port,
		r"zmodload zsh/net/tcp zsh/zftp
zftp_chpwd(){ print chpwd:$ZFTP_PWD }
zftp open 127.0.0.1:@PORT@ gina secret; echo open=$?
ZFTP_VERBOSE=2
echo end; exit 4",
	);
	assert_eq!(
		(out.as_str(), err.as_str(), st),
		("chpwd:/home/test\nopen=0\nend\nchpwd:\n", "221 Goodbye\n", 4)
	);
	assert_eq!(server.logs(1), ["SESSION USER gina | PASS * | SYST | PWD | QUIT"]);
}
