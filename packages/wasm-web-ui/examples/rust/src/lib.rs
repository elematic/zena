//! A Wasm Web UI element module in Rust: a counter, and a template-only
//! export, over the support code in `webui.rs`. Built for
//! `wasm32-unknown-unknown` and loaded by the same host as the Zena
//! modules (`src/test/linear_test.ts`).

pub mod webui;

use webui::{html, Context, Definition, Element, Event, EventFlags, Template, TemplateResult};

static COUNTER: Template = template!("<button ?disabled=", " @click=", ">", ": ", "</button>",);

struct Counter {
    count: i32,
    step: i32,
    label: String,
    disabled: bool,
}

impl Element for Counter {
    fn render(&mut self, cx: &Context) -> Option<TemplateResult> {
        Some(html(
            &COUNTER,
            vec![
                self.disabled.into(),
                cx.on(|counter: &mut Counter, cx: &Context, _event: &Event| {
                    counter.count += counter.step;
                    cx.dispatch_event(
                        "count-changed",
                        EventFlags {
                            bubbles: true,
                            ..Default::default()
                        },
                    );
                }),
                self.label.clone().into(),
                self.count.into(),
            ],
        ))
    }
}

fn new_counter() -> Box<dyn Element> {
    Box::new(Counter {
        count: 0,
        step: 1,
        label: "Count".to_string(),
        disabled: false,
    })
}

static DEFINITIONS: [Definition; 1] = [Definition {
    tag: Some("x-rust-counter"),
    styles: Some("button { font: inherit; }"),
    properties: &[
        property!(Counter, count: i32),
        property!(Counter, step: i32),
        property!(Counter, label: String),
        property!(Counter, disabled: bool),
    ],
    create: new_counter,
}];

/// The elements this module defines; the support code reads them.
pub fn definitions() -> &'static [Definition] {
    &DEFINITIONS
}

static GREETING: Template = template!("<p>Hello ", ", you have ", " messages.</p>");

/// A template-only export: a result the page renders where it likes.
#[unsafe(no_mangle)]
pub extern "C" fn greeting(unread: i32) -> u32 {
    webui::result(html(&GREETING, vec!["Ada".into(), unread.into()]))
}
