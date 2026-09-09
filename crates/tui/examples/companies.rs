//! `/login` provider roster with vendored logos and live paint statistics.
//!
//! ```sh
//! cargo run -p omp-tui --example companies
//! ```

use std::{collections::HashMap, env, io, time::Duration};

use omp_tui::{
	App, AppEvent, AppOptions, Cached, Elements, Graphics, Prop, Props, Size, TerminalCaps, Ui,
	UiContext, components::Img, dom,
};

const SCROLL_ID: &str = "login-providers";
const HUD_ID: &str = "paint-hud";
const CHROME_ROWS: u16 = 5;
const ASSET_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/assets/login");
/// Card cell: rounded border (2) + 1-cell side padding around a 12-wide
/// body that fits the 4-cell logo and every shortened name.
///
/// Cards live in a `wrap` row: the layout engine packs as many per line as
/// the width allows and re-centers each line, so the grid reflows on every
/// resize without rebuilding the tree.
const CARD_W: u16 = 16;

struct Provider {
	id:   &'static str,
	/// Short display name sized for one card-grid cell.
	name: &'static str,
}

// Literal getOAuthProviders() order from @omp/ai's provider
// registry; names shortened to fit one grid card.
const PROVIDERS: &[Provider] = &[
	Provider { id: "openai-codex", name: "Codex" },
	Provider { id: "anthropic", name: "Claude" },
	Provider { id: "zai", name: "Z.AI" },
	Provider { id: "zai-coding-plan", name: "Z.AI GLM" },
	Provider { id: "kimi-code", name: "Kimi Code" },
	Provider { id: "openrouter", name: "OpenRouter" },
	Provider { id: "github-copilot", name: "Copilot" },
	Provider { id: "cursor", name: "Cursor" },
	Provider { id: "devin", name: "Devin" },
	Provider { id: "google-antigravity", name: "Antigravity" },
	Provider { id: "google-gemini-cli", name: "Gemini CLI" },
	Provider { id: "openai-codex-device", name: "Codex CLI" },
	Provider { id: "xai", name: "xAI" },
	Provider { id: "xai-oauth", name: "Grok" },
	Provider { id: "gitlab-duo", name: "GitLab Duo" },
	Provider { id: "gitlab-duo-agent", name: "Duo Agent" },
	Provider { id: "alibaba-coding-plan", name: "Alibaba" },
	Provider { id: "alibaba-token-plan", name: "QwenCloud" },
	Provider { id: "aiand", name: "ai&" },
	Provider { id: "zhipu-coding-plan", name: "Zhipu" },
	Provider { id: "umans", name: "Umans" },
	Provider { id: "qwen-portal", name: "Qwen" },
	Provider { id: "sakana", name: "Sakana" },
	Provider { id: "minimax-code", name: "MiniMax" },
	Provider { id: "minimax-code-cn", name: "MiniMax CN" },
	Provider { id: "xiaomi", name: "MiMo" },
	Provider { id: "xiaomi-token-plan-sgp", name: "MiMo SGP" },
	Provider { id: "xiaomi-token-plan-ams", name: "MiMo EU" },
	Provider { id: "xiaomi-token-plan-cn", name: "MiMo CN" },
	Provider { id: "firepass", name: "Fire Pass" },
	Provider { id: "deepseek", name: "DeepSeek" },
	Provider { id: "meta", name: "Meta" },
	Provider { id: "moonshot", name: "Moonshot" },
	Provider { id: "cerebras", name: "Cerebras" },
	Provider { id: "baseten", name: "Baseten" },
	Provider { id: "fireworks", name: "Fireworks" },
	Provider { id: "together", name: "Together" },
	Provider { id: "nvidia", name: "NVIDIA" },
	Provider { id: "novita", name: "Novita" },
	Provider { id: "huggingface", name: "HuggingFace" },
	Provider { id: "perplexity", name: "Perplexity" },
	Provider { id: "qianfan", name: "Qianfan" },
	Provider { id: "venice", name: "Venice" },
	Provider { id: "siliconflow", name: "SiliconFlow" },
	Provider { id: "siliconflow-cn", name: "SF China" },
	Provider { id: "synthetic", name: "Synthetic" },
	Provider { id: "nanogpt", name: "NanoGPT" },
	Provider { id: "wafer-serverless", name: "Wafer" },
	Provider { id: "coreweave", name: "CoreWeave" },
	Provider { id: "vercel-ai-gateway", name: "Vercel AI" },
	Provider { id: "cloudflare-ai-gateway", name: "Cloudflare" },
	Provider { id: "litellm", name: "LiteLLM" },
	Provider { id: "kilo", name: "Kilo" },
	Provider { id: "zenmux", name: "ZenMux" },
	Provider { id: "opencode-zen", name: "OpenCode Zen" },
	Provider { id: "opencode-go", name: "OpenCode Go" },
	Provider { id: "tavily", name: "Tavily" },
	Provider { id: "kagi", name: "Kagi" },
	Provider { id: "exa", name: "Exa" },
	Provider { id: "parallel", name: "Parallel" },
	Provider { id: "ollama", name: "Ollama" },
	Provider { id: "ollama-cloud", name: "Ollama Cloud" },
	Provider { id: "lm-studio", name: "LM Studio" },
	Provider { id: "llama.cpp", name: "llama.cpp" },
	Provider { id: "vllm", name: "vLLM" },
	Provider { id: "gmi-cloud", name: "GMI Cloud" },
];

fn scroll_height(viewport: Size) -> u16 {
	viewport.height.saturating_sub(CHROME_ROWS).max(3)
}

fn build_ui(viewport: Size, context: UiContext) -> Ui {
	let ids = PROVIDERS
		.iter()
		.enumerate()
		.map(|(index, provider)| {
			(format!("{ASSET_DIR}/{}.png", provider.id), u32::try_from(index + 1).unwrap())
		})
		.collect::<HashMap<_, _>>();
	let elements = Elements::builder()
		.with("provider-logo", move |_: &str, props: Props, _: Vec<Cached>| {
			let source = props.str_of(Prop::Src).map_or("", |value| value.as_str());
			let id = ids.get(source).copied().unwrap_or(1);
			Box::new(
				Img::new()
					.with_str(Prop::Src, source)
					.with(Prop::W, 4_u16)
					.kitty(id, 2, 4),
			) as Box<dyn omp_tui::Component>
		})
		.build();
	let root = dom! {
		<col gap=1>
			<row gap=1>
				<i:log-in/>
				<text bold fg="accent..info">{"Choose a provider"}</text>
				<text dim>{format!("{} providers", PROVIDERS.len())}</text>
			</row>
			<scroll id={SCROLL_ID} h={scroll_height(viewport)}>
				<row wrap gap=1 justify=center>
					for provider in PROVIDERS.iter() {
						<box focus id={provider.id} w={CARD_W} border=round bc="muted..muted"
							hover="#38bdf8..#c084fc" lift=1 anim=220 ease=in-out
							align=center pad-x=1>
							<provider-logo src={format!("{ASSET_DIR}/{}.png", provider.id)}/>
							<text bold truncate align=center>{provider.name}</text>
						</box>
					}
				</row>
			</scroll>
			<row gap=2>
				<text dim>{"↹/←→/↑↓ pick · ↵ login · wheel scroll · Ctrl-C quit"}</text>
				<text id={HUD_ID} dim>{"repaint: 0 cells"}</text>
			</row>
		</col>
	};
	let context = UiContext { elements, ..context };
	Ui::from_root(root, viewport.width, context)
}

fn show_stats(app: &mut App, chosen: Option<&str>) {
	let caps = app.caps();
	let stats = app.last_stats();
	let pixels = caps.cell_px.map_or_else(
		|| "cell-px ?".to_owned(),
		|(width, height)| format!("cell-px {width}×{height}"),
	);
	let login = chosen.map_or(String::new(), |id| format!("login: {id} · "));
	app.ui_mut().set_text(
		HUD_ID,
		format!(
			"{login}{} · {} · {} · repaint: {} cells",
			graphics_label(caps.graphics),
			caps.id,
			pixels,
			stats.changed_cells,
		),
	);
}

fn forced_from_args(caps: &TerminalCaps) -> Option<Graphics> {
	let mut forced = None;
	for argument in env::args().skip(1) {
		forced = match argument.as_str() {
			"--cells" => Some(Graphics::Cells),
			"--kitty" if caps.kitty_placeholders => Some(Graphics::KittyPlaceholders),
			"--kitty" => Some(Graphics::KittyDirect),
			"--kitty-placeholders" => Some(Graphics::KittyPlaceholders),
			"--sixel" => Some(Graphics::Sixel),
			_ => forced,
		};
	}
	forced
}

#[tokio::main]
async fn main() -> io::Result<()> {
	let mut app = AppOptions::new()
		.mouse()
		.probe(Duration::from_millis(150))
		.graphics_with(forced_from_args)
		.start(|env| build_ui(env.viewport, env.ctx))
		.await?;
	if app.caps().graphics != Graphics::Cells {
		for (index, provider) in PROVIDERS.iter().enumerate() {
			let path = format!("{ASSET_DIR}/{}.png", provider.id);
			let png = tokio::fs::read(path).await?;
			app.renderer_mut().register_image(
				u32::try_from(index + 1).expect("provider count fits image IDs"),
				png,
			)?;
		}
		app.ui_mut().invalidate(SCROLL_ID);
	}
	show_stats(&mut app, None);
	let mut chosen: Option<String> = None;
	while let Some(event) = app.next().await? {
		match event {
			AppEvent::Resized(viewport) => {
				app.ui_mut().set_height(SCROLL_ID, scroll_height(viewport));
			},
			AppEvent::Pressed(id) => chosen = Some(id.to_string()),
			_ => {},
		}
		show_stats(&mut app, chosen.as_deref());
	}
	Ok(())
}

const fn graphics_label(graphics: Graphics) -> &'static str {
	match graphics {
		Graphics::Cells => "cells",
		Graphics::Sixel => "sixel",
		Graphics::KittyDirect => "kitty-direct",
		Graphics::KittyPlaceholders => "kitty-placeholders",
		Graphics::Iterm2 => "iterm2",
	}
}

#[cfg(test)]
mod tests {

	use std::{fs, mem, time};

	use omp_tui::{Key, Mouse, Renderer, Size, test_support::TerminalModel};

	use super::{CARD_W, PROVIDERS, build_ui, scroll_height};

	fn replay(renderer: &mut Renderer<Vec<u8>>, terminal: &mut TerminalModel) {
		let output =
			String::from_utf8(mem::take(renderer.writer_mut())).expect("renderer emits UTF-8");
		terminal.apply(&output);
	}

	/// Renders `ui` at `width`×18 and returns the first row containing a
	/// card's top border.
	fn first_card_line(ui: &omp_tui::Ui, width: u16) -> String {
		let mut renderer = Renderer::new(Vec::new());
		let mut terminal = TerminalModel::new(width.into(), 18);
		renderer
			.present(ui.frame().clone(), 18, &[])
			.expect("paint succeeds");
		replay(&mut renderer, &mut terminal);
		terminal
			.visible_rows()
			.iter()
			.find(|row| row.contains('╭'))
			.cloned()
			.expect("a card border row is visible")
	}

	#[test]
	fn grid_reflows_columns_and_recenters_on_resize() {
		let mut context = omp_tui::UiContext::default();
		context.graphics = omp_tui::Graphics::Cells;
		let mut ui = build_ui(Size::new(100, 18), context);

		// n cards fit when n*CARD_W + (n-1) gaps ≤ width - 1 (scrollbar
		// column), i.e. n = width / (CARD_W + 1).
		let columns = |width: u16| usize::from(width / (CARD_W + 1));
		let centered = |row: &str, inner: usize| {
			let cells: Vec<char> = row.chars().collect();
			let left = cells.iter().position(|&ch| ch == '╭').unwrap();
			let last = cells.iter().rposition(|&ch| ch == '╮').unwrap();
			let right = inner - 1 - last;
			assert!(
				left.abs_diff(right) <= 1,
				"line not centered: left pad {left}, right pad {right}: {row}"
			);
		};

		let narrow = first_card_line(&ui, 100);
		assert_eq!(narrow.matches('╭').count(), columns(100));
		centered(&narrow, 99);

		ui.resize(150);
		let wide = first_card_line(&ui, 150);
		assert_eq!(wide.matches('╭').count(), columns(150));
		assert!(wide.matches('╭').count() > narrow.matches('╭').count());
		centered(&wide, 149);
	}

	#[test]
	fn scrolling_keeps_damage_inside_viewport_and_decodes_vendored_logos() {
		let viewport = Size::new(100, 18);
		let mut context = omp_tui::UiContext::default();
		context.graphics = omp_tui::Graphics::Cells;
		let mut ui = build_ui(viewport, context);
		let mut renderer = Renderer::new(Vec::new());
		let mut terminal = TerminalModel::new(viewport.width.into(), viewport.height.into());
		renderer
			.present(ui.frame().clone(), viewport.height, &[])
			.expect("initial paint succeeds");
		replay(&mut renderer, &mut terminal);

		let initial = terminal.visible_rows().join("\n");
		assert!(initial.contains(PROVIDERS[0].name));
		assert!(initial.contains(PROVIDERS[1].name));
		assert!(initial.contains('▀'), "decoded image must paint half-block cells:\n{initial}");
		assert!(!initial.contains("[img:"), "vendored image unexpectedly failed to decode");

		for (step, key) in [Key::Down, Key::PageDown, Key::Down, Key::PageDown]
			.into_iter()
			.enumerate()
		{
			ui.handle_key(key);
			let stats = ui
				.present(&mut renderer, viewport.height)
				.expect("scroll paint succeeds");
			replay(&mut renderer, &mut terminal);
			let scroll_area = usize::from(viewport.width) * usize::from(scroll_height(viewport));
			assert!(
				stats.changed_cells <= scroll_area,
				"step {step} repainted {} cells outside {scroll_area}-cell scroll viewport",
				stats.changed_cells,
			);
		}

		ui.handle_mouse(1, 3, Mouse::WheelDown);
		let stats = ui
			.present(&mut renderer, viewport.height)
			.expect("wheel paint succeeds");
		let scroll_area = usize::from(viewport.width) * usize::from(scroll_height(viewport));
		assert!(stats.changed_cells <= scroll_area);
	}

	#[test]
	fn kitty_mode_uploads_and_materializes_placeholders() {
		let viewport = Size::new(100, 18);
		let mut context = omp_tui::UiContext::default();
		context.graphics = omp_tui::Graphics::KittyPlaceholders;
		let ui = build_ui(viewport, context);
		let mut renderer = Renderer::new(Vec::new());
		for (index, provider) in PROVIDERS.iter().enumerate() {
			let path = format!("{}/{}.png", super::ASSET_DIR, provider.id);
			renderer
				.register_image(
					u32::try_from(index + 1).expect("provider count fits image IDs"),
					fs::read(path).unwrap(),
				)
				.unwrap();
		}
		renderer
			.present(ui.frame().clone(), viewport.height, &[])
			.expect("Kitty initial paint succeeds");
		let output = String::from_utf8(renderer.into_inner()).unwrap();
		assert!(output.starts_with("\x1b_Gf=100,t=d,a=t,i=1,q=2,"));
		// Placement id rides `p=`: rows<<9 | cols for a 2×4 logo box.
		assert!(output.contains("\x1b_Ga=p,U=1,i=1,p=1028,r=2,c=4,q=2\x1b\\"));
		assert!(output.contains("\u{10eeee}\u{0305}\u{0305}"));
		// Image ID in the fg, placement ID (1028 = 0:4:4) in the underline
		// color of every placeholder cell.
		assert!(output.contains("38;2;0;0;1m"));
		assert!(output.contains("58:2::0:4:4"));
	}

	#[test]
	fn hovering_a_card_lifts_it_and_recolors_its_ring() {
		let mut context = omp_tui::UiContext::default();
		context.graphics = omp_tui::Graphics::Cells;
		let mut ui = build_ui(Size::new(100, 18), context);
		let rows = |ui: &omp_tui::Ui| -> Vec<String> {
			(0..ui.frame().size().height)
				.map(|y| omp_tui::test_support::frame_row_text(ui.frame(), y))
				.collect()
		};
		let resting = rows(&ui);
		let rest_top = resting
			.iter()
			.position(|row| row.contains('╭'))
			.expect("cards render a border row");
		let column = resting[rest_top]
			.chars()
			.position(|glyph| glyph == '╭')
			.unwrap() as u16;

		// Enter the first card, then advance the clock past the 220ms ease.
		ui.handle_mouse(column + 2, rest_top as u16 + 2, Mouse::Move);
		ui.tick(time::Duration::from_millis(400));
		let lifted = rows(&ui);
		let lifted_top = lifted.iter().position(|row| row.contains('╭')).unwrap();
		assert_eq!(lifted_top + 1, rest_top, "the hovered card rises into its headroom");
		let ring = omp_tui::test_support::frame_cell_style(ui.frame(), column + 2, lifted_top as u16)
			.foreground_color();
		assert_ne!(
			ring,
			omp_tui::Theme::default().muted,
			"the border cell over the pointer carries the glow"
		);
		assert!(lifted[rest_top + 4].contains('▀'), "the vacated row carries the shadow");
	}

	#[test]
	fn keyboard_focus_lifts_a_card_and_enter_presses_it() {
		let mut context = omp_tui::UiContext::default();
		context.graphics = omp_tui::Graphics::Cells;
		let mut ui = build_ui(Size::new(100, 18), context);
		let rows = |ui: &omp_tui::Ui| -> Vec<String> {
			(0..ui.frame().size().height)
				.map(|y| omp_tui::test_support::frame_row_text(ui.frame(), y))
				.collect()
		};
		let rest_top = rows(&ui)
			.iter()
			.position(|row| row.contains('╭'))
			.expect("cards render a border row");

		// Initial focus sits on the scroll pane; one Tab reaches the first
		// card.
		ui.handle_key(Key::Tab);
		ui.tick(time::Duration::from_millis(400));
		let focused_top = rows(&ui).iter().position(|row| row.contains('╭')).unwrap();
		assert_eq!(focused_top + 1, rest_top, "keyboard focus lifts the card like hover");
		assert_eq!(
			ui.handle_key(Key::Enter),
			omp_tui::UiEvent::Pressed(PROVIDERS[0].id.into()),
			"enter presses the focused card"
		);
	}

	#[test]
	fn arrow_navigation_stays_anchored_and_presses_the_selected_card() {
		let mut context = omp_tui::UiContext::default();
		context.graphics = omp_tui::Graphics::Cells;
		let mut ui = build_ui(Size::new(100, 18), context);
		let rows = |ui: &omp_tui::Ui| -> Vec<String> {
			(0..ui.frame().size().height)
				.map(|y| omp_tui::test_support::frame_row_text(ui.frame(), y))
				.collect()
		};

		// Tab enters the grid, Right steps to the second card. The viewport
		// must stay on the first providers instead of chasing the scrollbar
		// to the end of the roster.
		ui.handle_key(Key::Tab);
		ui.handle_key(Key::Right);
		ui.tick(time::Duration::from_millis(400));
		let grid = rows(&ui);
		assert!(
			grid.iter().any(|row| row.contains(PROVIDERS[0].name)),
			"arrow navigation keeps the viewport anchored at the top"
		);
		assert_eq!(
			ui.handle_key(Key::Enter),
			omp_tui::UiEvent::Pressed(PROVIDERS[1].id.into()),
			"enter presses the arrow-selected card"
		);
	}

	#[test]
	fn arrow_down_reaches_the_card_below() {
		let mut context = omp_tui::UiContext::default();
		context.graphics = omp_tui::Graphics::Cells;
		let mut ui = build_ui(Size::new(100, 18), context);
		// Tab reaches the first card; Down must land on the card directly
		// beneath it — one full 5-column row ahead in the roster — rather
		// than the next ring neighbor.
		ui.handle_key(Key::Tab);
		ui.handle_key(Key::Down);
		assert_eq!(
			ui.handle_key(Key::Enter),
			omp_tui::UiEvent::Pressed(PROVIDERS[5].id.into()),
			"down picks the card in the row below"
		);
	}
}
