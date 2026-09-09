//! Minimal native-window chat-shell example.

use std::time::Duration;

use omp_gui::{Effect, HostConfig, Scene, SceneFrame};
use omp_tui::{Frame, Key, MouseReport, Size, Ui, UiContext, dom};
use smallvec::SmallVec;

fn main() {
	omp_gui::run(HostConfig::default(), |ui| Example::new(ui.clone()));
}

struct Example {
	frame: Frame,
	size:  Size,
	ui:    UiContext,
}

impl Example {
	fn new(ui: UiContext) -> Self {
		let size = Size::new(100, 32);
		let mut scene = Self { frame: Frame::new(size), size, ui };
		scene.rebuild();
		scene
	}

	fn rebuild(&mut self) {
		let tree = dom! {
			<col gap=1>
				<text fg=accent attr=bold>{"OMP native chat"}</text>
				<text fg=muted>{"The production app feeds this window from omp-chat's detached session actor."}</text>
				<box border bc=muted pad="0 1"><text>{"> "}</text></box>
			</col>
		};
		self.frame = Ui::from_root(tree, self.size.width, self.ui.clone())
			.frame()
			.clone();
	}
}

impl Scene for Example {
	fn resize(&mut self, viewport: Size, _settled: bool) {
		self.size = viewport;
		self.rebuild();
	}

	fn render(&mut self) -> SceneFrame<'_> {
		SceneFrame {
			frame:       &self.frame,
			viewport:    self.size,
			editor_rows: 1,
			layers:      SmallVec::new(),
		}
	}

	fn key(&mut self, key: Key) -> Effect {
		if key == Key::Ctrl('c') {
			Effect::Quit
		} else {
			Effect::Ignored
		}
	}

	fn mouse(&mut self, _report: MouseReport) -> Effect {
		Effect::Ignored
	}

	fn paste(&mut self, _text: &str, _raw: bool) -> Effect {
		Effect::Ignored
	}

	fn tick(&self) -> Duration {
		Duration::from_millis(100)
	}
}
