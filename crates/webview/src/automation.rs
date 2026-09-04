//! Engine-neutral browser automation over [`WebView`](crate::WebView).
//!
//! Chromium uses native CDP for accessibility and file input. System webviews
//! and Gecko use injected DOM helpers for selectors and actions.

use std::{
	path::{Path, PathBuf},
	thread,
	time::{Duration, Instant},
};

use omp_core::{IntoStr, Str, sf};
use serde_json::{Value, json};

use crate::{
	EngineKind, Error, Frame, Inner, Input, Result, WebView, WebViewEvent, remote::Command,
};

const QUICK_TIMEOUT: Duration = Duration::from_secs(20);
const ACTION_TIMEOUT: Duration = Duration::from_secs(8);
const ZERO_MATCH_TIMEOUT: Duration = Duration::from_secs(2);
const POLL_INTERVAL: Duration = Duration::from_millis(100);
const MAX_AX_SNAPSHOT_BYTES: usize = 4 * 1024 * 1024;
const MAX_EXTRACT_BYTES: usize = 4 * 1024 * 1024;
const MAX_SCREENSHOT_BYTES: usize = 32 * 1024 * 1024;

const HELPERS: &str = r#"
(() => {
  if (window.__ompAutomation) return;
  const state = { next: 1, elements: new Map(), responses: [] };
  const roleOf = el => el.getAttribute('role') || ({
    A: 'link', BUTTON: 'button', INPUT: el.type === 'checkbox' ? 'checkbox' : 'textbox',
    SELECT: 'combobox', TEXTAREA: 'textbox', IMG: 'img', SUMMARY: 'button'
  }[el.tagName] || el.tagName.toLowerCase());
  const nameOf = el => (el.getAttribute('aria-label') || el.getAttribute('alt') ||
    el.getAttribute('title') || el.innerText || el.value || '').trim().replace(/\s+/g, ' ');
  const visible = el => {
    const style = getComputedStyle(el); const r = el.getBoundingClientRect();
    return style.visibility !== 'hidden' && style.display !== 'none' && r.width > 0 && r.height > 0;
  };
  const remember = el => {
    if (!el.__ompRef) el.__ompRef = state.next++;
    state.elements.set(el.__ompRef, el); return el.__ompRef;
  };
  const deep = (root, selector) => {
    const found = root.querySelector(selector); if (found) return found;
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) { const nested = deep(el.shadowRoot, selector); if (nested) return nested; }
    }
    return null;
  };
  const resolve = spec => {
    if (!spec) return null;
    if (spec.kind === 'ref' || spec.kind === 'id') return state.elements.get(spec.value) || null;
    if (spec.kind === 'css') return document.querySelector(spec.value);
    if (spec.kind === 'xpath') return document.evaluate(spec.value, document, null,
      XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
    if (spec.kind === 'pierce') return deep(document, spec.value);
    if (spec.kind === 'text') {
      const wanted = spec.value.toLowerCase();
      return [...document.querySelectorAll('body *')].find(el =>
        visible(el) && nameOf(el).toLowerCase().includes(wanted)) || null;
    }
    if (spec.kind === 'aria') {
      const match = spec.value.match(/^([^\[]+)(?:\[name=['\"]?(.*?)['\"]?\])?$/);
      const role = match ? match[1].trim().toLowerCase() : spec.value.toLowerCase();
      const name = match && match[2] ? match[2].toLowerCase() : '';
      return [...document.querySelectorAll('body *')].find(el => roleOf(el) === role &&
        (!name || nameOf(el).toLowerCase().includes(name))) || null;
    }
    return null;
  };
  const metadata = el => {
    if (!el) return null; const r = el.getBoundingClientRect(); const id = remember(el);
    return { id, ref: `e${id}`, role: roleOf(el), name: nameOf(el),
      value: 'value' in el ? String(el.value || '') : null,
      x: r.x, y: r.y, width: r.width, height: r.height, visible: visible(el) };
  };
  const originalFetch = window.fetch;
  if (originalFetch) window.fetch = async (...args) => {
    const response = await originalFetch(...args); state.responses.push(response.url);
    if (state.responses.length > 256) state.responses.shift(); return response;
  };
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this.addEventListener('loadend', () => { state.responses.push(this.responseURL || String(url));
      if (state.responses.length > 256) state.responses.shift(); });
    return originalOpen.call(this, method, url, ...rest);
  };
  window.__ompAutomation = state;
  window.__ompResolve = resolve;
  window.__ompMetadata = metadata;
})();
"#;

/// Selector families supported by every automation backend.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Selector {
	/// A CSS selector.
	Css(Str),
	/// An `XPath` expression.
	XPath(Str),
	/// Visible accessible text.
	Text(Str),
	/// Role and optional accessible name.
	Aria(Str),
	/// CSS through open shadow roots.
	Pierce(Str),
	/// An observation reference.
	Ref(u32),
	/// A numeric observation id.
	Id(u32),
}

impl Selector {
	/// Parse CSS or a prefixed `xpath/`, `text/`, `aria/`, `pierce/`, or
	/// `aria-ref=eN` selector.
	pub fn parse(value: &str) -> Result<Self> {
		for (prefix, make) in [
			("xpath/", Self::XPath as fn(Str) -> Self),
			("text/", Self::Text),
			("aria/", Self::Aria),
			("pierce/", Self::Pierce),
		] {
			if let Some(value) = value.strip_prefix(prefix) {
				return Ok(make(value.to_str()));
			}
		}
		if let Some(value) = value.strip_prefix("aria-ref=e") {
			return value
				.parse()
				.map(Self::Ref)
				.map_err(|_| Error::Protocol("invalid ARIA reference".to_str()));
		}
		if value.trim().is_empty() {
			return Err(Error::Protocol("selector must not be empty".to_str()));
		}
		Ok(Self::Css(value.to_str()))
	}

	fn wire(&self) -> Value {
		match self {
			Self::Css(value) => json!({"kind":"css","value":&**value}),
			Self::XPath(value) => json!({"kind":"xpath","value":&**value}),
			Self::Text(value) => json!({"kind":"text","value":&**value}),
			Self::Aria(value) => json!({"kind":"aria","value":&**value}),
			Self::Pierce(value) => json!({"kind":"pierce","value":&**value}),
			Self::Ref(value) | Self::Id(value) => json!({"kind":"ref","value":value}),
		}
	}
}

/// Backend-specific native capabilities.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AutomationCapabilities {
	/// DOM actions are available.
	pub dom:                  bool,
	/// Native browser AX capture is available.
	pub native_accessibility: bool,
	/// Native file input is available.
	pub file_upload:          bool,
}

/// Bounded observation options.
#[derive(Clone, Copy, Debug)]
pub struct ObserveOptions {
	/// Include non-interactive nodes.
	pub include_all:   bool,
	/// Keep only viewport nodes.
	pub viewport_only: bool,
	/// Maximum returned elements.
	pub limit:         usize,
}

impl Default for ObserveOptions {
	fn default() -> Self {
		Self { include_all: false, viewport_only: true, limit: 500 }
	}
}

/// Stable metadata for one remembered element.
#[derive(Clone, Debug)]
pub struct ObservedElement {
	/// Numeric element id.
	pub id:        u32,
	/// `eN` reference.
	pub reference: Str,
	/// Accessibility role.
	pub role:      Str,
	/// Accessible name.
	pub name:      Str,
	/// Form value when applicable.
	pub value:     Option<Str>,
	/// CSS-pixel `[x, y, width, height]`.
	pub bounds:    [f64; 4],
	/// Layout visibility.
	pub visible:   bool,
}

/// Bounded document observation.
#[derive(Clone, Debug)]
pub struct Observation {
	/// Current URL.
	pub url:       Str,
	/// Current title.
	pub title:     Str,
	/// Visible text.
	pub text:      Str,
	/// Remembered elements.
	pub elements:  Vec<ObservedElement>,
	/// Whether elements were capped.
	pub truncated: bool,
}

/// Extracted representation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExtractFormat {
	/// Visible text.
	Text,
	/// Serialized HTML.
	Html,
}
/// PNG screenshot plus the CSS clip used to produce it.
#[derive(Clone, Debug)]
pub struct Screenshot {
	/// PNG bytes.
	pub data: bytes::Bytes,
	/// Element clip, absent for viewport/full-page capture.
	pub clip: Option<[f64; 4]>,
}

/// Borrowed automation tab.
#[derive(Clone, Copy)]
pub struct TabHandle<'view> {
	view: &'view WebView,
}

/// Borrowed current document.
#[derive(Clone, Copy)]
pub struct DocumentHandle<'view> {
	tab: TabHandle<'view>,
}

/// Re-resolving element handle.
#[derive(Clone)]
pub struct ElementHandle<'view> {
	document: DocumentHandle<'view>,
	selector: Selector,
}

impl WebView {
	/// Borrow the surface as an automation tab.
	pub const fn automation(&self) -> TabHandle<'_> {
		TabHandle { view: self }
	}
}

impl<'view> TabHandle<'view> {
	/// Report native backend capabilities.
	pub const fn capabilities(self) -> AutomationCapabilities {
		let chromium = matches!(self.view.engine(), EngineKind::Chromium);
		AutomationCapabilities {
			dom:                  true,
			native_accessibility: chromium,
			file_upload:          chromium,
		}
	}

	/// Borrow the current document.
	pub const fn document(self) -> DocumentHandle<'view> {
		DocumentHandle { tab: self }
	}

	/// Evaluate JavaScript and decode the engine's JSON result.
	pub fn evaluate(self, script: &str, timeout: Duration) -> Result<Value> {
		self.eval_value(script, timeout)
	}

	/// Navigate and wait for a settled document.
	pub fn goto(self, url: &str, timeout: Duration) -> Result<()> {
		let previous = self.view.url();
		self.view.navigate(url)?;
		let started = Instant::now();
		while self.view.url() == previous {
			if started.elapsed() >= Duration::from_millis(250) && self.view.url().as_str() == url {
				break;
			}
			if started.elapsed() >= timeout {
				return Err(Error::Timeout("waiting for navigation"));
			}
			thread::sleep(POLL_INTERVAL);
		}
		self.wait_for_ready(timeout.saturating_sub(started.elapsed()))
	}

	/// Reload and wait for readiness.
	pub fn reload(self, timeout: Duration) -> Result<()> {
		self.view.reload()?;
		self.wait_for_ready(timeout)
	}

	/// Traverse backward and wait for readiness.
	pub fn back(self, timeout: Duration) -> Result<()> {
		self.view.back()?;
		self.wait_for_ready(timeout)
	}

	/// Traverse forward and wait for readiness.
	pub fn forward(self, timeout: Duration) -> Result<()> {
		self.view.forward()?;
		self.wait_for_ready(timeout)
	}

	/// Wait for the initial navigation and document readiness.
	pub fn wait_for_navigation(self, timeout: Duration) -> Result<()> {
		let started = Instant::now();
		while self.view.url().is_empty() {
			if started.elapsed() >= timeout {
				return Err(Error::Timeout("waiting for navigation"));
			}
			thread::sleep(POLL_INTERVAL);
		}
		self.wait_for_ready(timeout.saturating_sub(started.elapsed()))
	}

	/// Wait until the current URL contains `pattern`.
	pub fn wait_for_url(self, pattern: &str, timeout: Duration) -> Result<Str> {
		let deadline = Instant::now() + timeout;
		loop {
			let url = self.view.url();
			if url.contains(pattern) {
				return Ok(url);
			}
			if Instant::now() >= deadline {
				return Err(Error::Timeout("waiting for URL"));
			}
			thread::sleep(POLL_INTERVAL);
		}
	}

	/// Wait for a URL observed by injected fetch/XHR hooks.
	pub fn wait_for_response(self, pattern: &str, timeout: Duration) -> Result<Str> {
		let pattern = serde_json::to_string(pattern)?;
		let deadline = Instant::now() + timeout;
		loop {
			let script = format!(
				"{HELPERS}\nwindow.__ompAutomation.responses.find(url => url.includes({pattern})) || \
				 null"
			);
			if let Some(url) = self.eval_value(&script, ACTION_TIMEOUT)?.as_str() {
				return Ok(url.to_str());
			}
			if Instant::now() >= deadline {
				return Err(Error::Timeout("waiting for response"));
			}
			thread::sleep(POLL_INTERVAL);
		}
	}

	/// Scroll the frame surface at a viewport coordinate.
	pub fn scroll(self, x: f64, y: f64, dx: f64, dy: f64) -> Result<()> {
		self.view.input(Input::Scroll { x, y, dx, dy })
	}

	/// Receive the next composited frame.
	pub fn capture(self, timeout: Duration) -> Result<Frame> {
		let deadline = Instant::now() + timeout;
		loop {
			match self
				.view
				.events()
				.recv_timeout(deadline.saturating_duration_since(Instant::now()))
			{
				Ok(WebViewEvent::Frame(frame)) => return Ok(frame),
				Ok(WebViewEvent::Closed) => {
					tracing::warn!(
						engine = %self.view.engine(),
						surface = %self.view.surface(),
						error = "closed",
						"webview frame capture failed"
					);
					return Err(Error::Closed);
				},
				Ok(WebViewEvent::Crashed(_)) => return Err(Error::Closed),
				Ok(_) => {},
				Err(_) => {
					tracing::warn!(
						engine = %self.view.engine(),
						surface = %self.view.surface(),
						error = "timeout",
						"webview frame capture failed"
					);
					return Err(Error::Timeout("capturing browser frame"));
				},
			}
		}
	}

	/// Capture a viewport, element, or full-page PNG.
	pub fn screenshot(
		self,
		selector: Option<Selector>,
		full_page: bool,
		timeout: Duration,
	) -> Result<Screenshot> {
		let clip = match selector.as_ref() {
			Some(selector) => Some(
				self
					.document()
					.resolve(selector.clone())?
					.metadata()?
					.bounds,
			),
			None => None,
		};
		let data = if matches!(self.view.engine(), EngineKind::Chromium) {
			let Inner::Remote(remote) = &self.view.inner else {
				return Err(Error::Unsupported("direct screenshot requires remote Chromium"));
			};
			let (tx, rx) = flume::bounded(1);
			remote
				.send(Command::Screenshot { clip, full_page, reply: tx })
				.inspect_err(|error| {
					tracing::warn!(
						engine = %self.view.engine(),
						surface = %self.view.surface(),
						error = error.kind(),
						"webview screenshot capture failed"
					);
				})?;
			let result = rx
				.recv_timeout(timeout)
				.map_err(|_| Error::Timeout("capturing PNG screenshot"))
				.and_then(|result| result);
			match result {
				Ok(data) => data,
				Err(error) => {
					tracing::warn!(
						engine = %self.view.engine(),
						surface = %self.view.surface(),
						error = error.kind(),
						"webview screenshot capture failed"
					);
					return Err(error);
				},
			}
		} else {
			if selector.is_some() || full_page {
				return Err(Error::Unsupported(
					"element and full-page screenshots require Chromium CDP",
				));
			}
			encode_frame_png(&self.capture(timeout)?)?
		};
		if data.len() > MAX_SCREENSHOT_BYTES {
			return Err(Error::Protocol("screenshot exceeds byte limit".to_str()));
		}
		Ok(Screenshot { data, clip })
	}

	/// Extract visible text or serialized HTML.
	pub fn extract(self, format: ExtractFormat) -> Result<Str> {
		let expression = match format {
			ExtractFormat::Text => "document.body ? document.body.innerText : ''",
			ExtractFormat::Html => {
				"document.documentElement ? document.documentElement.outerHTML : ''"
			},
		};
		let value = self.eval_value(expression, QUICK_TIMEOUT)?;
		let text = value
			.as_str()
			.ok_or_else(|| Error::Protocol("document extraction returned a non-string".to_str()))?;
		if text.len() > MAX_EXTRACT_BYTES {
			return Err(Error::Protocol("document extraction exceeds byte limit".to_str()));
		}
		Ok(Str::new(text))
	}

	/// Return native Chromium AX or injected ARIA YAML on other engines.
	pub fn accessibility_snapshot(self, timeout: Duration) -> Result<Value> {
		if !self.capabilities().native_accessibility {
			return Ok(Value::String(self.document().aria_snapshot(None)?.to_string()));
		}
		let Inner::Remote(remote) = &self.view.inner else {
			return Err(Error::Unsupported("native accessibility requires remote Chromium"));
		};
		let (tx, rx) = flume::bounded(1);
		remote.send(Command::AccessibilityTree { reply: tx })?;
		let snapshot = rx
			.recv_timeout(timeout)
			.map_err(|_| Error::Timeout("capturing accessibility tree"))??;
		if serde_json::to_vec(&snapshot)?.len() > MAX_AX_SNAPSHOT_BYTES {
			return Err(Error::Protocol("accessibility snapshot exceeds byte limit".to_str()));
		}
		Ok(snapshot)
	}

	/// Upload files through Chromium CDP.
	pub fn upload_files(
		self,
		selector: Selector,
		paths: &[impl AsRef<Path>],
		timeout: Duration,
	) -> Result<()> {
		if !self.capabilities().file_upload {
			return Err(Error::Unsupported("file upload requires Chromium CDP"));
		}
		let Inner::Remote(remote) = &self.view.inner else {
			return Err(Error::Unsupported("file upload requires remote Chromium"));
		};
		let spec = serde_json::to_string(&selector.wire())?;
		let element = sf!("(() => {{ {HELPERS} return window.__ompResolve({spec}); }})()");
		let paths = paths
			.iter()
			.map(|path| PathBuf::from(path.as_ref()))
			.collect();
		let (tx, rx) = flume::bounded(1);
		remote.send(Command::UploadFiles { element, paths, reply: tx })?;
		rx.recv_timeout(timeout)
			.map_err(|_| Error::Timeout("uploading browser files"))?
	}

	fn wait_for_ready(self, timeout: Duration) -> Result<()> {
		let deadline = Instant::now() + timeout;
		loop {
			if matches!(
				self
					.eval_value("document.readyState", ACTION_TIMEOUT)?
					.as_str(),
				Some("interactive" | "complete")
			) {
				return Ok(());
			}
			if Instant::now() >= deadline {
				return Err(Error::Timeout("waiting for document readiness"));
			}
			thread::sleep(POLL_INTERVAL);
		}
	}

	fn eval_value(self, script: &str, timeout: Duration) -> Result<Value> {
		let (tx, rx) = flume::bounded(1);
		self.view.eval_with(script, move |value| {
			let _ = tx.send(value);
		})?;
		let value = rx
			.recv_timeout(timeout)
			.map_err(|_| Error::Timeout("evaluating browser JavaScript"))?;
		serde_json::from_str(&value).map_err(Error::from)
	}
}

impl<'view> DocumentHandle<'view> {
	/// Resolve and validate a selector.
	pub fn resolve(self, selector: Selector) -> Result<ElementHandle<'view>> {
		let handle = ElementHandle { document: self, selector };
		handle.metadata()?;
		Ok(handle)
	}

	/// Resolve a numeric observation id.
	pub fn id(self, id: u32) -> Result<ElementHandle<'view>> {
		self.resolve(Selector::Id(id))
	}

	/// Resolve an `eN` or `aria-ref=eN` observation reference.
	pub fn reference(self, reference: &str) -> Result<ElementHandle<'view>> {
		let number = reference
			.strip_prefix("aria-ref=e")
			.or_else(|| reference.strip_prefix('e'))
			.ok_or_else(|| Error::Protocol("ARIA reference must be eN".to_str()))?
			.parse()
			.map_err(|_| Error::Protocol("invalid ARIA reference".to_str()))?;
		self.resolve(Selector::Ref(number))
	}

	/// Observe a bounded set of document elements.
	pub fn observe(self, options: ObserveOptions) -> Result<Observation> {
		let script = format!(
			r"{HELPERS}
(() => {{
 const all=[...document.querySelectorAll('body *')];
 const candidates=all.filter(el=>{{ const m=window.__ompMetadata(el); if(!m)return false;
  if({viewport}&&(m.x+m.width<0||m.y+m.height<0||m.x>innerWidth||m.y>innerHeight))return false;
  return {all}||['button','link','textbox','checkbox','combobox','option','menuitem','tab'].includes(m.role)||el.tabIndex>=0; }});
 const chosen=candidates.slice(0,{limit}).map(window.__ompMetadata);
 return {{url:location.href,title:document.title,text:(document.body?.innerText||'').slice(0,65536),elements:chosen,truncated:candidates.length>chosen.length}};
}})()",
			viewport = options.viewport_only,
			all = options.include_all,
			limit = options.limit.max(1)
		);
		parse_observation(self.tab.eval_value(&script, QUICK_TIMEOUT)?)
	}

	/// Produce bounded ARIA-style YAML with stable refs.
	pub fn aria_snapshot(self, selector: Option<Selector>) -> Result<Str> {
		let root = selector.map_or_else(
			|| "document.body".to_owned(),
			|selector| format!("window.__ompResolve({})", selector.wire()),
		);
		let script = format!(
			r#"{HELPERS}
(() => {{ const root={root}; if(!root)return null; const lines=[]; let count=0;
 const walk=(el,depth)=>{{ if(!(el instanceof Element)||count>=1000)return; const m=window.__ompMetadata(el); if(!m||!m.visible)return;
  const name=m.name?` "${{m.name.replaceAll('"','\\"')}}"`:''; lines.push(`${{'  '.repeat(depth)}}- ${{m.role}}${{name}} [ref=${{m.ref}}]`); count++;
  for(const child of el.children)walk(child,depth+1); }}; walk(root,0); return lines.join('\n'); }})()"#
		);
		self
			.tab
			.eval_value(&script, QUICK_TIMEOUT)?
			.as_str()
			.map(Str::new)
			.ok_or_else(|| Error::Protocol("ARIA snapshot selector did not resolve".to_str()))
	}

	/// Wait for a selector with a fast zero-match watchdog.
	pub fn wait_for_selector(
		self,
		selector: Selector,
		timeout: Duration,
	) -> Result<ElementHandle<'view>> {
		let timeout = timeout.min(QUICK_TIMEOUT);
		let deadline = Instant::now() + timeout;
		let zero_match = Instant::now() + ZERO_MATCH_TIMEOUT.min(timeout);
		loop {
			let handle = ElementHandle { document: self, selector: selector.clone() };
			if handle.metadata().is_ok() {
				return Ok(handle);
			}
			let now = Instant::now();
			if now >= deadline || now >= zero_match {
				return Err(Error::Timeout("waiting for selector"));
			}
			thread::sleep(POLL_INTERVAL);
		}
	}
}

impl ElementHandle<'_> {
	/// Read current metadata.
	pub fn metadata(&self) -> Result<ObservedElement> {
		let spec = serde_json::to_string(&self.selector.wire())?;
		let value = self.document.tab.eval_value(
			&format!("{HELPERS}\nwindow.__ompMetadata(window.__ompResolve({spec}))"),
			ACTION_TIMEOUT,
		)?;
		parse_element(&value).ok_or_else(|| Error::Protocol("selector did not resolve".to_str()))
	}

	/// Click the element.
	pub fn click(&self) -> Result<()> {
		self.action("el.focus(); el.click(); return true")
	}

	/// Append text and emit input/change.
	pub fn type_text(&self, text: &str) -> Result<()> {
		let text = serde_json::to_string(text)?;
		self.action(&format!(
			"el.focus(); el.value=String(el.value||'')+{text}; el.dispatchEvent(new \
			 InputEvent('input',{{bubbles:true,inputType:'insertText',data:{text}}})); \
			 el.dispatchEvent(new Event('change',{{bubbles:true}})); return true"
		))
	}

	/// Replace a form value and emit input/change.
	pub fn fill(&self, value: &str) -> Result<()> {
		let value = serde_json::to_string(value)?;
		self.action(&format!(
			"el.focus(); const \
			 setter=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value')?.set; \
			 if(setter)setter.call(el,{value});else el.value={value}; el.dispatchEvent(new \
			 Event('input',{{bubbles:true}})); el.dispatchEvent(new \
			 Event('change',{{bubbles:true}})); return true"
		))
	}

	/// Select options by value or label.
	pub fn select(&self, values: &[Str]) -> Result<()> {
		let values = serde_json::to_string(&values.iter().map(|value| &**value).collect::<Vec<_>>())?;
		self.action(&format!(
			"if(!(el instanceof HTMLSelectElement))throw new Error('selector is not a select'); \
			 const wanted=new Set({values}); for(const option of \
			 el.options)option.selected=wanted.has(option.value)||wanted.has(option.text); \
			 el.dispatchEvent(new Event('input',{{bubbles:true}})); el.dispatchEvent(new \
			 Event('change',{{bubbles:true}})); return true"
		))
	}

	/// Dispatch keydown and keyup.
	pub fn press(&self, key: &str) -> Result<()> {
		let key = serde_json::to_string(key)?;
		self.action(&format!(
			"el.focus(); el.dispatchEvent(new KeyboardEvent('keydown',{{key:{key},bubbles:true}})); \
			 el.dispatchEvent(new KeyboardEvent('keyup',{{key:{key},bubbles:true}})); return true"
		))
	}

	/// Center in the viewport.
	pub fn scroll_into_view(&self) -> Result<()> {
		self.action("el.scrollIntoView({block:'center',inline:'center'}); return true")
	}

	/// Dispatch a DOM drag/drop sequence.
	pub fn drag_to(&self, target: &ElementHandle<'_>) -> Result<()> {
		let target = serde_json::to_string(&target.selector.wire())?;
		self.action(&format!(
			"const target=window.__ompResolve({target}); if(!target)throw new Error('drag target did \
			 not resolve'); const data=new DataTransfer(); el.dispatchEvent(new \
			 DragEvent('dragstart',{{bubbles:true,dataTransfer:data}})); target.dispatchEvent(new \
			 DragEvent('dragenter',{{bubbles:true,dataTransfer:data}})); target.dispatchEvent(new \
			 DragEvent('dragover',{{bubbles:true,dataTransfer:data}})); target.dispatchEvent(new \
			 DragEvent('drop',{{bubbles:true,dataTransfer:data}})); el.dispatchEvent(new \
			 DragEvent('dragend',{{bubbles:true,dataTransfer:data}})); return true"
		))
	}

	/// Evaluate JavaScript with `el` bound.
	pub fn evaluate(&self, body: &str) -> Result<Value> {
		let spec = serde_json::to_string(&self.selector.wire())?;
		self.document.tab.eval_value(
			&format!(
				"{HELPERS}\n(() => {{ const el=window.__ompResolve({spec}); if(!el)throw new \
				 Error('selector did not resolve'); return (()=>{{ {body} }})(); }})()"
			),
			ACTION_TIMEOUT,
		)
	}

	fn action(&self, body: &str) -> Result<()> {
		self.evaluate(body).map(drop)
	}
}

fn encode_frame_png(frame: &Frame) -> Result<bytes::Bytes> {
	let mut output = Vec::new();
	{
		let mut encoder = png::Encoder::new(&mut output, frame.width, frame.height);
		encoder.set_color(png::ColorType::Rgba);
		encoder.set_depth(png::BitDepth::Eight);
		let mut writer = encoder.write_header().map_err(Error::PngEncode)?;
		writer
			.write_image_data(&frame.data)
			.map_err(Error::PngEncode)?;
	}
	Ok(bytes::Bytes::from(output))
}

fn parse_observation(value: Value) -> Result<Observation> {
	let object = value
		.as_object()
		.ok_or_else(|| Error::Protocol("observation returned a non-object".to_str()))?;
	Ok(Observation {
		url:       object
			.get("url")
			.and_then(Value::as_str)
			.unwrap_or_default()
			.to_str(),
		title:     object
			.get("title")
			.and_then(Value::as_str)
			.unwrap_or_default()
			.to_str(),
		text:      object
			.get("text")
			.and_then(Value::as_str)
			.unwrap_or_default()
			.to_str(),
		elements:  object
			.get("elements")
			.and_then(Value::as_array)
			.into_iter()
			.flatten()
			.filter_map(parse_element)
			.collect(),
		truncated: object
			.get("truncated")
			.and_then(Value::as_bool)
			.unwrap_or(false),
	})
}

fn parse_element(value: &Value) -> Option<ObservedElement> {
	let object = value.as_object()?;
	Some(ObservedElement {
		id:        u32::try_from(object.get("id")?.as_u64()?).ok()?,
		reference: object.get("ref")?.as_str()?.to_str(),
		role:      object.get("role")?.as_str()?.to_str(),
		name:      object
			.get("name")
			.and_then(Value::as_str)
			.unwrap_or_default()
			.to_str(),
		value:     object.get("value").and_then(Value::as_str).map(Str::new),
		bounds:    [
			object.get("x").and_then(Value::as_f64).unwrap_or_default(),
			object.get("y").and_then(Value::as_f64).unwrap_or_default(),
			object
				.get("width")
				.and_then(Value::as_f64)
				.unwrap_or_default(),
			object
				.get("height")
				.and_then(Value::as_f64)
				.unwrap_or_default(),
		],
		visible:   object
			.get("visible")
			.and_then(Value::as_bool)
			.unwrap_or(false),
	})
}
