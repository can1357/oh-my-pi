#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

#[cfg(windows)]
fn main() {
	if let Err(error) = desktop_tag_host::windows::run(desktop_tag_host::config::Config::parse()) {
		desktop_tag_host::windows::report_fatal(&error);
		std::process::exit(1);
	}
}

#[cfg(not(windows))]
fn main() {
	eprintln!("desktop-tag-host is unsupported on this platform; Windows 10 or newer is required");
	std::process::exit(1);
}
