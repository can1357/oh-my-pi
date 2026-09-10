//! Embed the system webview as a child view of a winit window (macOS).
//!
//! ```sh
//! cargo run -p omp-webview --example child -- https://example.com
//! ```

#[cfg(target_os = "macos")]
use std::env;
use std::error;

#[cfg(target_os = "macos")]
use omp_webview::{Engine, Rect, WebView, WebViewBuilder};
#[cfg(target_os = "macos")]
use winit::{
	application::ApplicationHandler,
	event::WindowEvent,
	event_loop::{ActiveEventLoop, EventLoop},
	window::{Window, WindowId},
};

#[cfg(target_os = "macos")]
/// Margin around the webview, in logical points.
const INSET: f64 = 10.0;

#[cfg(target_os = "macos")]
#[derive(Default)]
struct App {
	window: Option<Window>,
	view:   Option<WebView>,
	url:    String,
}

#[cfg(target_os = "macos")]
impl App {
	fn bounds(window: &Window) -> Rect {
		let size = window.inner_size().to_logical::<f64>(window.scale_factor());
		Rect::new(
			INSET,
			INSET,
			2.0f64.mul_add(-INSET, size.width).max(0.0),
			2.0f64.mul_add(-INSET, size.height).max(0.0),
		)
	}
}

#[cfg(target_os = "macos")]
impl ApplicationHandler for App {
	fn resumed(&mut self, event_loop: &ActiveEventLoop) {
		let window = event_loop
			.create_window(Window::default_attributes().with_title("omp-webview child"))
			.expect("create window");
		let view = WebViewBuilder::new(Engine::system())
			.url(&self.url)
			.build_child(&window, Self::bounds(&window))
			.expect("create webview");
		self.window = Some(window);
		self.view = Some(view);
	}

	fn window_event(
		&mut self,
		event_loop: &ActiveEventLoop,
		_window_id: WindowId,
		event: WindowEvent,
	) {
		match event {
			WindowEvent::Resized(_) => {
				if let (Some(window), Some(view)) = (&self.window, &self.view) {
					let _ = view.set_bounds(Self::bounds(window));
				}
			},
			WindowEvent::CloseRequested => event_loop.exit(),
			_ => {},
		}
	}

	fn about_to_wait(&mut self, _event_loop: &ActiveEventLoop) {
		if let Some(view) = &self.view {
			for event in view.events().try_iter() {
				println!("event: {event:?}");
				if matches!(event, omp_webview::WebViewEvent::LoadFinished(_)) {
					let _ =
						view.eval_with("`${document.title} @ ${innerWidth}x${innerHeight}`", |result| {
							println!("eval: {result}");
						});
				}
			}
		}
	}
}

#[cfg(target_os = "macos")]
fn main() -> Result<(), Box<dyn error::Error>> {
	let url = env::args()
		.nth(1)
		.unwrap_or_else(|| "https://example.com".into());
	let event_loop = EventLoop::new()?;
	let mut app = App { url, ..App::default() };
	event_loop.run_app(&mut app)?;
	Ok(())
}

#[cfg(not(target_os = "macos"))]
fn main() -> Result<(), Box<dyn error::Error>> {
	Err(std::io::Error::other("the `child` example requires macOS").into())
}
