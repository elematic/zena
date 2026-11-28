//! End-to-end integration tests for the ZenaFX platform style engine
//! (`docs/design/zenafx-styles.md`) running inside `platform.wasm` over
//! `RenderCore`.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use wasmtime::{Config, Engine};
use zenafx::loader::{GuestScene, PlatformRuntime, engine};
use zenafx::loader::style::{
    BuiltinProperty, Condition, ConditionUpdate, Declaration, FactKind, HostFact, PropertyDef,
    PropertyUpdate, RangeTest, Reach, Rule, StyleKey, StyleValue, StylesheetDef, ValueType,
    WatcherUpdate,
};
use zenafx::ui::events::PointerInput;
use zenafx::ui::scene::{Cursor, NodeDef, NodeStyle, TemplateDef, TemplateRef, TextContent};
use zenafx::ui::surface::Scene;
use zenafx::ui::types::{
    Align, Axis, BoxStyle, Color, Command, Flex, FrameEvent, Justify, Layout, Length, Overflow,
    OwnBox, Quad, Size, TextStyle,
};

fn platform_wasm_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("out/platform.wasm")
}

fn new_runtime() -> PlatformRuntime {
    let mut config = Config::new();
    config.wasm_component_model(true);
    let engine = Engine::new(&config).expect("wasmtime engine");
    PlatformRuntime::load(&engine, &platform_wasm_path()).expect("load platform.wasm")
}

fn color(r: f32, g: f32, b: f32) -> Color {
    Color { r, g, b, a: 1.0 }
}

fn plain_box(width: Length, height: Length) -> NodeDef {
    NodeDef {
        own_box: OwnBox {
            width,
            height,
            shrink: 0.0,
            ..OwnBox::default()
        },
        layout: Layout::Flex(Flex {
            axis: Axis::Column,
            justify_content: Justify::Start,
            align_items: Align::Start,
            gap: 0.0,
        }),
        style: NodeStyle::Nothing,
        first_child: 0,
        child_count: 0,
        is_slot: false,
        cursor: None,
        focusable: false,
        editable: false,
        unselectable: false,
    }
}

fn slot_def() -> NodeDef {
    NodeDef {
        is_slot: true,
        ..plain_box(Length::Auto, Length::Auto)
    }
}

fn text_def(content: &str) -> NodeDef {
    NodeDef {
        style: NodeStyle::Text(TextContent {
            content: content.to_string(),
            style: TextStyle {
                family: "system-ui".to_string(),
                size: 16.0,
                weight: 400,
                italic: false,
                color: color(0.0, 0.0, 0.0),
            },
        }),
        ..plain_box(Length::Auto, Length::Auto)
    }
}

fn quads(cmds: &[Command]) -> Vec<Quad> {
    cmds.iter()
        .filter_map(|c| match c {
            Command::Quad(q) => Some(*q),
            _ => None,
        })
        .collect()
}

fn decl(property: StyleKey, value: StyleValue) -> Declaration {
    Declaration {
        property,
        value,
        is_default: false,
    }
}

fn default_decl(property: StyleKey, value: StyleValue) -> Declaration {
    Declaration {
        property,
        value,
        is_default: true,
    }
}

#[test]
fn combining_conditional_properties_and_dynamic_cursor() {
    let mut rt = new_runtime();
    let root = rt.root().unwrap();

    let base_bg = color(0.2, 0.2, 0.2);
    let hover_bg = color(0.3, 0.5, 0.9);
    let press_border = color(0.9, 0.2, 0.2);

    rt.render(
        root,
        TemplateRef::Fresh(TemplateDef {
            id: 1,
            nodes: vec![plain_box(Length::Px(120.0), Length::Px(48.0))],
            bindings: vec![],
            states: vec![],
        }),
        vec![],
    )
    .unwrap();

    // Base background + grab cursor; hovered changes background; pressed adds border + grabbing cursor.
    rt.define_stylesheet(StylesheetDef {
        id: 1,
        conditions: vec![
            Condition::Flag(StyleKey::Host(HostFact::Hovered)),
            Condition::Flag(StyleKey::Host(HostFact::Pressed)),
        ],
        rules: vec![
            Rule {
                when: None,
                then: vec![
                    decl(
                        StyleKey::Builtin(BuiltinProperty::Background),
                        StyleValue::Color(base_bg),
                    ),
                    decl(
                        StyleKey::Builtin(BuiltinProperty::Cursor),
                        StyleValue::Keyword(15), // Grab
                    ),
                ],
            },
            Rule {
                when: Some(0), // hovered
                then: vec![decl(
                    StyleKey::Builtin(BuiltinProperty::Background),
                    StyleValue::Color(hover_bg),
                )],
            },
            Rule {
                when: Some(1), // pressed
                then: vec![
                    decl(
                        StyleKey::Builtin(BuiltinProperty::BorderColor),
                        StyleValue::Color(press_border),
                    ),
                    decl(
                        StyleKey::Builtin(BuiltinProperty::BorderWidth),
                        StyleValue::Number(3.0),
                    ),
                    decl(
                        StyleKey::Builtin(BuiltinProperty::Cursor),
                        StyleValue::Keyword(16), // Grabbing
                    ),
                ],
            },
        ],
    })
    .unwrap();
    assert!(rt.attach_stylesheet(root, 0, 1, Reach::Node).unwrap());

    let area = Size {
        width: 300.0,
        height: 200.0,
    };

    // Resting state: base background, no border.
    let q = quads(&rt.draw(area).unwrap());
    assert_eq!(q.len(), 1);
    assert_eq!(q[0].background, Some(base_bg));
    assert_eq!(q[0].border_width, 0.0);

    // Move pointer over box -> hover_bg + Grab cursor.
    let (_, redraw) = rt
        .pointer(PointerInput::Moved { x: 40.0, y: 20.0 })
        .unwrap();
    assert!(redraw);
    assert_eq!(rt.core().lock().unwrap().cursor(), Cursor::Grab);
    let q = quads(&rt.draw(area).unwrap());
    assert_eq!(q[0].background, Some(hover_bg));
    assert_eq!(q[0].border_width, 0.0);

    // Press while hovered -> BOTH hover_bg AND press_border combine property-by-property,
    // and cursor switches to Grabbing.
    let (_, redraw) = rt
        .pointer(PointerInput::Button {
            x: 40.0,
            y: 20.0,
            button: 0,
            down: true,
        })
        .unwrap();
    assert!(redraw);
    assert_eq!(rt.core().lock().unwrap().cursor(), Cursor::Grabbing);
    let q = quads(&rt.draw(area).unwrap());
    assert_eq!(q[0].background, Some(hover_bg));
    assert_eq!(q[0].border_color, Some(press_border));
    assert_eq!(q[0].border_width, 3.0);

    // Release -> stays hovered (hover_bg), border cleared, cursor back to Grab.
    let (_, redraw) = rt
        .pointer(PointerInput::Button {
            x: 40.0,
            y: 20.0,
            button: 0,
            down: false,
        })
        .unwrap();
    assert!(redraw);
    assert_eq!(rt.core().lock().unwrap().cursor(), Cursor::Grab);
    let q = quads(&rt.draw(area).unwrap());
    assert_eq!(q[0].background, Some(hover_bg));
    assert_eq!(q[0].border_width, 0.0);
}

#[test]
fn custom_properties_defaults_inheritance_and_cycle_safety() {
    let mut rt = new_runtime();
    let page = rt.root().unwrap();

    let accent = rt
        .define_property(PropertyDef {
            kind: ValueType::Color,
            inherits: true,
        })
        .unwrap();
    let button_fill = rt
        .define_property(PropertyDef {
            kind: ValueType::Color,
            inherits: true,
        })
        .unwrap();
    let cyc_a = rt
        .define_property(PropertyDef {
            kind: ValueType::Color,
            inherits: false,
        })
        .unwrap();
    let cyc_b = rt
        .define_property(PropertyDef {
            kind: ValueType::Color,
            inherits: false,
        })
        .unwrap();

    // Tree: page -> slot -> card -> slot -> button
    let mut page_box = plain_box(Length::Px(400.0), Length::Px(300.0));
    page_box.first_child = 1;
    page_box.child_count = 1;
    rt.render(
        page,
        TemplateRef::Fresh(TemplateDef {
            id: 1,
            nodes: vec![page_box, slot_def()],
            bindings: vec![],
            states: vec![],
        }),
        vec![],
    )
    .unwrap();
    let card = rt.content(page, 0, 1).unwrap().unwrap()[0];

    let mut card_box = plain_box(Length::Px(200.0), Length::Px(150.0));
    card_box.first_child = 1;
    card_box.child_count = 1;
    rt.render(
        card,
        TemplateRef::Fresh(TemplateDef {
            id: 2,
            nodes: vec![card_box, slot_def()],
            bindings: vec![],
            states: vec![],
        }),
        vec![],
    )
    .unwrap();
    let button = rt.content(card, 0, 1).unwrap().unwrap()[0];
    rt.render(
        button,
        TemplateRef::Fresh(TemplateDef {
            id: 3,
            nodes: vec![plain_box(Length::Px(100.0), Length::Px(40.0))],
            bindings: vec![],
            states: vec![],
        }),
        vec![],
    )
    .unwrap();

    let gray = color(0.5, 0.5, 0.5);
    let blue = color(0.1, 0.4, 0.9);
    let red = color(0.9, 0.1, 0.1);
    let purple = color(0.6, 0.2, 0.8);

    // Card sets a default accent (gray); Button sets its own default accent (blue),
    // default button_fill: use(accent), and ordinary background: use(button_fill).
    rt.set_declarations(
        card,
        0,
        vec![default_decl(StyleKey::Custom(accent), StyleValue::Color(gray))],
    )
    .unwrap();
    rt.set_declarations(
        button,
        0,
        vec![
            default_decl(StyleKey::Custom(accent), StyleValue::Color(blue)),
            default_decl(
                StyleKey::Custom(button_fill),
                StyleValue::UseProp(StyleKey::Custom(accent)),
            ),
            decl(
                StyleKey::Builtin(BuiltinProperty::Background),
                StyleValue::UseProp(StyleKey::Custom(button_fill)),
            ),
            // Mutual cycle must resolve cleanly to None without hanging.
            decl(
                StyleKey::Custom(cyc_a),
                StyleValue::UseProp(StyleKey::Custom(cyc_b)),
            ),
            decl(
                StyleKey::Custom(cyc_b),
                StyleValue::UseProp(StyleKey::Custom(cyc_a)),
            ),
        ],
    )
    .unwrap();

    let area = Size {
        width: 400.0,
        height: 300.0,
    };

    // 1. No root theme -> Button's nearest default (blue) wins over Card's default (gray).
    assert_eq!(
        rt.resolved_property(button, 0, StyleKey::Builtin(BuiltinProperty::Background))
            .unwrap(),
        Some(StyleValue::Color(blue))
    );
    assert_eq!(
        rt.resolved_property(button, 0, StyleKey::Custom(cyc_a))
            .unwrap(),
        None
    );
    let q = quads(&rt.draw(area).unwrap());
    assert_eq!(q.last().unwrap().background, Some(blue));

    // 2. Ordinary declaration of `accent` on Page beats both Card's and Button's defaults!
    rt.set_declarations(
        page,
        0,
        vec![decl(StyleKey::Custom(accent), StyleValue::Color(red))],
    )
    .unwrap();
    let q = quads(&rt.draw(area).unwrap());
    assert_eq!(q.last().unwrap().background, Some(red));

    // 3. Theme overriding `button_fill` directly colors buttons specifically.
    rt.set_declarations(
        page,
        0,
        vec![
            decl(StyleKey::Custom(accent), StyleValue::Color(red)),
            decl(StyleKey::Custom(button_fill), StyleValue::Color(purple)),
        ],
    )
    .unwrap();
    let q = quads(&rt.draw(area).unwrap());
    assert_eq!(q.last().unwrap().background, Some(purple));

    // 4. Clearing Page's theme reverts Button to its own default (blue).
    rt.set_declarations(page, 0, vec![]).unwrap();
    let q = quads(&rt.draw(area).unwrap());
    assert_eq!(q.last().unwrap().background, Some(blue));
}

#[test]
fn text_properties_and_user_select_inherit_through_slots() {
    let mut rt = new_runtime();
    let root = rt.root().unwrap();

    let mut root_box = plain_box(Length::Px(300.0), Length::Px(100.0));
    root_box.first_child = 1;
    root_box.child_count = 1;
    rt.render(
        root,
        TemplateRef::Fresh(TemplateDef {
            id: 1,
            nodes: vec![root_box, slot_def()],
            bindings: vec![],
            states: vec![],
        }),
        vec![],
    )
    .unwrap();
    let label = rt.content(root, 0, 1).unwrap().unwrap()[0];
    rt.render(
        label,
        TemplateRef::Fresh(TemplateDef {
            id: 2,
            nodes: vec![text_def("Inherited")],
            bindings: vec![],
            states: vec![],
        }),
        vec![],
    )
    .unwrap();

    let gold = color(0.95, 0.75, 0.1);
    rt.set_declarations(
        root,
        0,
        vec![
            decl(
                StyleKey::Builtin(BuiltinProperty::TextColor),
                StyleValue::Color(gold),
            ),
            decl(
                StyleKey::Builtin(BuiltinProperty::TextSize),
                StyleValue::Number(24.0),
            ),
            decl(
                StyleKey::Builtin(BuiltinProperty::UserSelect),
                StyleValue::Keyword(1), // none (unselectable)
            ),
        ],
    )
    .unwrap();

    assert_eq!(
        rt.resolved_property(label, 0, StyleKey::Builtin(BuiltinProperty::TextColor))
            .unwrap(),
        Some(StyleValue::Color(gold))
    );
    assert_eq!(
        rt.resolved_property(label, 0, StyleKey::Builtin(BuiltinProperty::TextSize))
            .unwrap(),
        Some(StyleValue::Number(24.0))
    );
    assert_eq!(
        rt.resolved_property(label, 0, StyleKey::Builtin(BuiltinProperty::UserSelect))
            .unwrap(),
        Some(StyleValue::Keyword(1))
    );
}

#[test]
fn custom_facts_boolean_combinators_and_scoped_under_within() {
    let mut rt = new_runtime();
    let root = rt.root().unwrap();

    let f_card = rt.define_fact(FactKind::Flag).unwrap();
    let f_selected = rt.define_fact(FactKind::Flag).unwrap();
    let f_disabled = rt.define_fact(FactKind::Flag).unwrap();

    // Interior: root(0) -> card(1) -> inner(2) -> deep(3)
    let mut n0 = plain_box(Length::Px(300.0), Length::Px(200.0));
    n0.first_child = 1;
    n0.child_count = 1;
    let mut n1 = plain_box(Length::Px(200.0), Length::Px(150.0));
    n1.first_child = 2;
    n1.child_count = 1;
    let mut n2 = plain_box(Length::Px(120.0), Length::Px(80.0));
    n2.first_child = 3;
    n2.child_count = 1;
    let n3 = plain_box(Length::Px(60.0), Length::Px(30.0));

    rt.render(
        root,
        TemplateRef::Fresh(TemplateDef {
            id: 1,
            nodes: vec![n0, n1, n2, n3],
            bindings: vec![],
            states: vec![],
        }),
        vec![],
    )
    .unwrap();

    let direct_col = color(0.1, 0.8, 0.2);
    let active_col = color(0.2, 0.3, 0.9);

    // Conditions table (post-order):
    // 0: flag(f_card)
    // 1: under(0)              -- direct child of card
    // 2: within(0)             -- any descendant of card
    // 3: flag(f_selected)
    // 4: flag(f_disabled)
    // 5: negate(4)
    // 6: all([2, 3, 5])        -- descendant of card && selected && !disabled
    rt.define_stylesheet(StylesheetDef {
        id: 10,
        conditions: vec![
            Condition::Flag(StyleKey::Custom(f_card)),
            Condition::Under(0),
            Condition::Within(0),
            Condition::Flag(StyleKey::Custom(f_selected)),
            Condition::Flag(StyleKey::Custom(f_disabled)),
            Condition::Negate(4),
            Condition::All(vec![2, 3, 5]),
        ],
        rules: vec![
            Rule {
                when: Some(1),
                then: vec![decl(
                    StyleKey::Builtin(BuiltinProperty::Background),
                    StyleValue::Color(direct_col),
                )],
            },
            Rule {
                when: Some(6),
                then: vec![decl(
                    StyleKey::Builtin(BuiltinProperty::Background),
                    StyleValue::Color(active_col),
                )],
            },
        ],
    })
    .unwrap();
    assert!(rt.attach_stylesheet(root, 0, 10, Reach::Scope).unwrap());
    assert!(rt.set_flag(root, 1, f_card, true).unwrap());

    // `inner` (2) is directly under `card` (1) -> direct_col.
    assert_eq!(
        rt.resolved_property(root, 2, StyleKey::Builtin(BuiltinProperty::Background))
            .unwrap(),
        Some(StyleValue::Color(direct_col))
    );
    // `deep` (3) is a grandchild of `card`, NOT directly under it -> None.
    assert_eq!(
        rt.resolved_property(root, 3, StyleKey::Builtin(BuiltinProperty::Background))
            .unwrap(),
        None
    );

    // Select `deep` (3): matches `within(card) && selected && !disabled` -> active_col.
    assert!(rt.set_flag(root, 3, f_selected, true).unwrap());
    assert_eq!(
        rt.resolved_property(root, 3, StyleKey::Builtin(BuiltinProperty::Background))
            .unwrap(),
        Some(StyleValue::Color(active_col))
    );

    // Disable `deep` (3): `negate(disabled)` becomes false -> background reverts to None.
    assert!(rt.set_flag(root, 3, f_disabled, true).unwrap());
    assert_eq!(
        rt.resolved_property(root, 3, StyleKey::Builtin(BuiltinProperty::Background))
            .unwrap(),
        None
    );
}

#[test]
fn widget_boundary_isolation_and_projected_slot_scope() {
    let mut rt = new_runtime();
    let page = rt.root().unwrap();

    let f_mark = rt.define_fact(FactKind::Flag).unwrap();
    let f_card_host = rt.define_fact(FactKind::Flag).unwrap();

    // Page -> slot(0) -> Card
    let mut page_box = plain_box(Length::Px(400.0), Length::Px(300.0));
    page_box.first_child = 1;
    page_box.child_count = 1;
    rt.render(
        page,
        TemplateRef::Fresh(TemplateDef {
            id: 1,
            nodes: vec![page_box, slot_def()],
            bindings: vec![],
            states: vec![],
        }),
        vec![],
    )
    .unwrap();
    let card = rt.content(page, 0, 1).unwrap().unwrap()[0];

    // Card interior: card(0) -> [card_title(1), card_slot(2)]
    let mut card_box = plain_box(Length::Px(250.0), Length::Px(150.0));
    card_box.first_child = 1;
    card_box.child_count = 2;
    rt.render(
        card,
        TemplateRef::Fresh(TemplateDef {
            id: 2,
            nodes: vec![
                card_box,
                plain_box(Length::Px(100.0), Length::Px(20.0)),
                slot_def(),
            ],
            bindings: vec![],
            states: vec![],
        }),
        vec![],
    )
    .unwrap();

    // Page projects a detached Label into Card's slot 0, owned by Page's scope.
    let label = rt.create_node().unwrap();
    rt.render(
        label,
        TemplateRef::Fresh(TemplateDef {
            id: 3,
            nodes: vec![text_def("Projected")],
            bindings: vec![],
            states: vec![],
        }),
        vec![],
    )
    .unwrap();
    assert!(rt.set_scope_owner(label, page).unwrap());
    assert!(rt.set_slot(card, 0, vec![label]).unwrap());

    let page_accent = color(0.1, 0.5, 0.9);
    let card_bg = color(0.8, 0.2, 0.3);
    let card_ink = color(0.9, 0.85, 0.2);

    // Page scope stylesheet:
    // - sets `border-width: 4` on `f_card_host` (should win over Card's own `border-width: 1`!)
    // - sets `background: page_accent` on `f_mark` (should style `label`, NOT `card_title`!)
    rt.define_stylesheet(StylesheetDef {
        id: 20,
        conditions: vec![
            Condition::Flag(StyleKey::Custom(f_card_host)),
            Condition::Flag(StyleKey::Custom(f_mark)),
        ],
        rules: vec![
            Rule {
                when: Some(0),
                then: vec![decl(
                    StyleKey::Builtin(BuiltinProperty::BorderWidth),
                    StyleValue::Number(4.0),
                )],
            },
            Rule {
                when: Some(1),
                then: vec![decl(
                    StyleKey::Builtin(BuiltinProperty::Background),
                    StyleValue::Color(page_accent),
                )],
            },
        ],
    })
    .unwrap();

    // Card scope stylesheet:
    // - sets `border-width: 1` on `f_card_host`
    // - sets `background: card_bg` on `f_mark` (should style `card_title`, NOT projected `label`!)
    // - sets inheriting `text-color: card_ink` on `f_card_host` (MUST inherit to `label`!)
    rt.define_stylesheet(StylesheetDef {
        id: 21,
        conditions: vec![
            Condition::Flag(StyleKey::Custom(f_card_host)),
            Condition::Flag(StyleKey::Custom(f_mark)),
        ],
        rules: vec![
            Rule {
                when: Some(0),
                then: vec![
                    decl(
                        StyleKey::Builtin(BuiltinProperty::BorderWidth),
                        StyleValue::Number(1.0),
                    ),
                    decl(
                        StyleKey::Builtin(BuiltinProperty::TextColor),
                        StyleValue::Color(card_ink),
                    ),
                ],
            },
            Rule {
                when: Some(1),
                then: vec![decl(
                    StyleKey::Builtin(BuiltinProperty::Background),
                    StyleValue::Color(card_bg),
                )],
            },
        ],
    })
    .unwrap();

    assert!(rt.attach_stylesheet(page, 0, 20, Reach::Scope).unwrap());
    assert!(rt.attach_stylesheet(card, 0, 21, Reach::Scope).unwrap());

    assert!(rt.set_flag(card, 0, f_card_host, true).unwrap());
    assert!(rt.set_flag(card, 1, f_mark, true).unwrap()); // card's interior box
    assert!(rt.set_flag(label, 0, f_mark, true).unwrap()); // projected label

    // 1. On Card's outer node, Page's scope rules come after Card's own rules -> border-width = 4.0.
    assert_eq!(
        rt.resolved_property(card, 0, StyleKey::Builtin(BuiltinProperty::BorderWidth))
            .unwrap(),
        Some(StyleValue::Number(4.0))
    );

    // 2. Inside Card's interior, Page's stylesheet does NOT penetrate -> card_title gets card_bg.
    assert_eq!(
        rt.resolved_property(card, 1, StyleKey::Builtin(BuiltinProperty::Background))
            .unwrap(),
        Some(StyleValue::Color(card_bg))
    );

    // 3. Projected Label is in Page's scope, NOT Card's -> background is page_accent (not card_bg)...
    assert_eq!(
        rt.resolved_property(label, 0, StyleKey::Builtin(BuiltinProperty::Background))
            .unwrap(),
        Some(StyleValue::Color(page_accent))
    );
    // ...yet inheriting properties STILL cross widget boundaries from Card -> Label!
    assert_eq!(
        rt.resolved_property(label, 0, StyleKey::Builtin(BuiltinProperty::TextColor))
            .unwrap(),
        Some(StyleValue::Color(card_ink))
    );
}

#[test]
fn responsive_size_fact_inheritance_and_single_frame_relayout() {
    let mut rt = new_runtime();
    let root = rt.root().unwrap();

    let panel_width = rt
        .define_property(PropertyDef {
            kind: ValueType::Number,
            inherits: true,
        })
        .unwrap();

    // root(0, 100%x100%) -> container(1) -> [childA(2, 100x40), childB(3, 100x40)]
    let mut n0 = plain_box(Length::Percent(100.0), Length::Percent(100.0));
    n0.first_child = 1;
    n0.child_count = 1;
    let mut n1 = plain_box(Length::Percent(100.0), Length::Auto);
    n1.first_child = 2;
    n1.child_count = 2;
    let mut n2 = plain_box(Length::Px(100.0), Length::Px(40.0));
    n2.style = NodeStyle::Fill(BoxStyle {
        background: Some(color(0.2, 0.4, 0.8)),
        border_color: None,
        border_width: 0.0,
        corner_radius: 0.0,
        opacity: 1.0,
    });
    let mut n3 = plain_box(Length::Px(100.0), Length::Px(40.0));
    n3.style = NodeStyle::Fill(BoxStyle {
        background: Some(color(0.8, 0.4, 0.2)),
        border_color: None,
        border_width: 0.0,
        corner_radius: 0.0,
        opacity: 1.0,
    });

    rt.render(
        root,
        TemplateRef::Fresh(TemplateDef {
            id: 1,
            nodes: vec![n0, n1, n2, n3],
            bindings: vec![],
            states: vec![],
        }),
        vec![],
    )
    .unwrap();

    // Root publishes its measured width as inheriting property `panel_width`.
    rt.set_declarations(
        root,
        0,
        vec![decl(
            StyleKey::Custom(panel_width),
            StyleValue::UseFact(StyleKey::Host(HostFact::Width)),
        )],
    )
    .unwrap();

    // Container switches to horizontal row with gap=20 when inherited `panel_width >= 600`.
    rt.define_stylesheet(StylesheetDef {
        id: 30,
        conditions: vec![Condition::Range(RangeTest {
            key: StyleKey::Custom(panel_width),
            min: Some(600.0),
            min_inclusive: true,
            max: None,
            max_inclusive: false,
        })],
        rules: vec![Rule {
            when: Some(0),
            then: vec![
                decl(
                    StyleKey::Builtin(BuiltinProperty::Axis),
                    StyleValue::Keyword(0), // Row
                ),
                decl(
                    StyleKey::Builtin(BuiltinProperty::Gap),
                    StyleValue::Number(20.0),
                ),
            ],
        }],
    })
    .unwrap();
    assert!(rt.attach_stylesheet(root, 1, 30, Reach::Node).unwrap());

    // Wide frame (800x400): settles in the SAME draw() call -> side-by-side!
    let wide_quads = quads(
        &rt.draw(Size {
            width: 800.0,
            height: 400.0,
        })
        .unwrap(),
    );
    assert_eq!(wide_quads.len(), 2);
    assert_eq!(wide_quads[0].bounds.x, 0.0);
    assert_eq!(wide_quads[0].bounds.y, 0.0);
    assert_eq!(wide_quads[1].bounds.x, 120.0); // 100 + 20 gap
    assert_eq!(wide_quads[1].bounds.y, 0.0);

    // Narrow frame (400x400): settles in the SAME draw() call -> stacked column!
    let narrow_quads = quads(
        &rt.draw(Size {
            width: 400.0,
            height: 400.0,
        })
        .unwrap(),
    );
    assert_eq!(narrow_quads.len(), 2);
    assert_eq!(narrow_quads[0].bounds.x, 0.0);
    assert_eq!(narrow_quads[0].bounds.y, 0.0);
    assert_eq!(narrow_quads[1].bounds.x, 0.0);
    assert_eq!(narrow_quads[1].bounds.y, 40.0);
}

#[test]
fn scroll_fact_and_slot_index_fact() {
    let mut rt = new_runtime();
    let root = rt.root().unwrap();

    // Scrollable box (200x100) containing a slot with three 100px-tall items (300px total).
    let mut scroller = plain_box(Length::Px(200.0), Length::Px(100.0));
    scroller.own_box.overflow_y = Overflow::Scroll;
    scroller.first_child = 1;
    scroller.child_count = 1;
    rt.render(
        root,
        TemplateRef::Fresh(TemplateDef {
            id: 1,
            nodes: vec![scroller, slot_def()],
            bindings: vec![],
            states: vec![],
        }),
        vec![],
    )
    .unwrap();

    let first_col = color(0.9, 0.5, 0.1);
    let scrolled_border = color(0.1, 0.1, 0.1);

    // Scroller gains a border once scrolled at least 20px.
    rt.define_stylesheet(StylesheetDef {
        id: 40,
        conditions: vec![Condition::Range(RangeTest {
            key: StyleKey::Host(HostFact::ScrollY),
            min: Some(20.0),
            min_inclusive: true,
            max: None,
            max_inclusive: false,
        })],
        rules: vec![Rule {
            when: Some(0),
            then: vec![
                decl(
                    StyleKey::Builtin(BuiltinProperty::BorderColor),
                    StyleValue::Color(scrolled_border),
                ),
                decl(
                    StyleKey::Builtin(BuiltinProperty::BorderWidth),
                    StyleValue::Number(2.0),
                ),
            ],
        }],
    })
    .unwrap();
    assert!(rt.attach_stylesheet(root, 0, 40, Reach::Node).unwrap());

    // Scoped rule highlighting the first child of the slot (`index == 0`).
    rt.define_stylesheet(StylesheetDef {
        id: 41,
        conditions: vec![Condition::Range(RangeTest {
            key: StyleKey::Host(HostFact::Index),
            min: Some(0.0),
            min_inclusive: true,
            max: Some(0.0),
            max_inclusive: true,
        })],
        rules: vec![Rule {
            when: Some(0),
            then: vec![decl(
                StyleKey::Builtin(BuiltinProperty::Background),
                StyleValue::Color(first_col),
            )],
        }],
    })
    .unwrap();
    assert!(rt.attach_stylesheet(root, 0, 41, Reach::Scope).unwrap());

    let mut kids = Vec::new();
    for i in 0..3 {
        let kid = rt.create_node().unwrap();
        rt.render(
            kid,
            TemplateRef::Fresh(TemplateDef {
                id: 100 + i,
                nodes: vec![plain_box(Length::Px(200.0), Length::Px(100.0))],
                bindings: vec![],
                states: vec![],
            }),
            vec![],
        )
        .unwrap();
        kids.push(kid);
    }
    assert!(rt.set_slot(root, 0, kids.clone()).unwrap());

    // Verify `index == 0` styles kids[0] and not kids[1].
    assert_eq!(
        rt.resolved_property(kids[0], 0, StyleKey::Builtin(BuiltinProperty::Background))
            .unwrap(),
        Some(StyleValue::Color(first_col))
    );
    assert_eq!(
        rt.resolved_property(kids[1], 0, StyleKey::Builtin(BuiltinProperty::Background))
            .unwrap(),
        None
    );

    // Reorder via `set_slot`: now kids[2] is at index 0!
    assert!(rt.set_slot(root, 0, vec![kids[2], kids[0], kids[1]]).unwrap());
    assert_eq!(
        rt.resolved_property(kids[2], 0, StyleKey::Builtin(BuiltinProperty::Background))
            .unwrap(),
        Some(StyleValue::Color(first_col))
    );
    assert_eq!(
        rt.resolved_property(kids[0], 0, StyleKey::Builtin(BuiltinProperty::Background))
            .unwrap(),
        None
    );

    // Draw initial frame so layout computes scroll reach (200px).
    let area = Size {
        width: 200.0,
        height: 100.0,
    };
    let _ = rt.draw(area).unwrap();
    assert_eq!(
        rt.resolved_property(root, 0, StyleKey::Builtin(BuiltinProperty::BorderWidth))
            .unwrap(),
        Some(StyleValue::Number(0.0))
    );

    // Scroll by 10px (< 20): still no border.
    let _ = rt
        .pointer(PointerInput::Wheel {
            x: 50.0,
            y: 50.0,
            dx: 0.0,
            dy: 10.0,
        })
        .unwrap();
    assert_eq!(
        rt.resolved_property(root, 0, StyleKey::Builtin(BuiltinProperty::BorderWidth))
            .unwrap(),
        Some(StyleValue::Number(0.0))
    );

    // Scroll another 15px (total 25px >= 20): border activates immediately!
    let (_, redraw) = rt
        .pointer(PointerInput::Wheel {
            x: 50.0,
            y: 50.0,
            dx: 0.0,
            dy: 15.0,
        })
        .unwrap();
    assert!(redraw);
    assert_eq!(
        rt.resolved_property(root, 0, StyleKey::Builtin(BuiltinProperty::BorderWidth))
            .unwrap(),
        Some(StyleValue::Number(2.0))
    );
}

#[test]
fn condition_and_property_watchers_fire_only_on_transitions() {
    let mut rt = new_runtime();
    let root = rt.root().unwrap();

    let accent = rt
        .define_property(PropertyDef {
            kind: ValueType::Color,
            inherits: true,
        })
        .unwrap();
    let panel_width = rt
        .define_property(PropertyDef {
            kind: ValueType::Number,
            inherits: true,
        })
        .unwrap();

    let mut root_box = plain_box(Length::Percent(100.0), Length::Percent(100.0));
    root_box.first_child = 1;
    root_box.child_count = 1;
    rt.render(
        root,
        TemplateRef::Fresh(TemplateDef {
            id: 1,
            nodes: vec![root_box, slot_def()],
            bindings: vec![],
            states: vec![],
        }),
        vec![],
    )
    .unwrap();

    let child = rt.create_node().unwrap();
    rt.render(
        child,
        TemplateRef::Fresh(TemplateDef {
            id: 2,
            nodes: vec![plain_box(Length::Px(50.0), Length::Px(50.0))],
            bindings: vec![],
            states: vec![],
        }),
        vec![],
    )
    .unwrap();
    assert!(rt.set_slot(root, 0, vec![child]).unwrap());

    let c1 = color(0.1, 0.2, 0.8);
    let c2 = color(0.8, 0.2, 0.1);
    rt.set_declarations(
        root,
        0,
        vec![
            decl(StyleKey::Custom(accent), StyleValue::Color(c1)),
            decl(
                StyleKey::Custom(panel_width),
                StyleValue::UseFact(StyleKey::Host(HostFact::Width)),
            ),
        ],
    )
    .unwrap();

    // First draw at 800x400 so `panel_width` is 800.
    let _ = rt
        .draw(Size {
            width: 800.0,
            height: 400.0,
        })
        .unwrap();

    // Watch `panel_width >= 600` on `child` (watcher 1) and `accent` on `child` (watcher 2).
    let init_wide = rt
        .watch_condition(
            child,
            0,
            1,
            vec![Condition::Range(RangeTest {
                key: StyleKey::Custom(panel_width),
                min: Some(600.0),
                min_inclusive: true,
                max: None,
                max_inclusive: false,
            })],
            0,
        )
        .unwrap();
    assert_eq!(init_wide, Some(true));

    let init_accent = rt
        .watch_property(child, 0, 2, StyleKey::Custom(accent))
        .unwrap();
    assert_eq!(init_accent, Some(StyleValue::Color(c1)));
    assert!(rt.take_watcher_updates().unwrap().is_empty());

    // Resize within the wide interval (800 -> 720 -> 610): ZERO watcher updates!
    let _ = rt
        .draw(Size {
            width: 720.0,
            height: 400.0,
        })
        .unwrap();
    let _ = rt
        .draw(Size {
            width: 610.0,
            height: 400.0,
        })
        .unwrap();
    assert!(rt.take_watcher_updates().unwrap().is_empty());

    // Cross the 600px threshold (610 -> 550): ONE condition update `holds: false`!
    let _ = rt
        .draw(Size {
            width: 550.0,
            height: 400.0,
        })
        .unwrap();
    assert_eq!(
        rt.take_watcher_updates().unwrap(),
        vec![WatcherUpdate::Condition(ConditionUpdate {
            watcher: 1,
            holds: false,
        })]
    );

    // Switch theme accent on root -> ONE property update!
    rt.set_declarations(
        root,
        0,
        vec![
            decl(StyleKey::Custom(accent), StyleValue::Color(c2)),
            decl(
                StyleKey::Custom(panel_width),
                StyleValue::UseFact(StyleKey::Host(HostFact::Width)),
            ),
        ],
    )
    .unwrap();
    assert_eq!(
        rt.take_watcher_updates().unwrap(),
        vec![WatcherUpdate::Property(PropertyUpdate {
            watcher: 2,
            value: Some(StyleValue::Color(c2)),
        })]
    );

    // Unwatch watcher 2, then drop `child` -> only watcher 1 emits `Ended(1)`.
    rt.unwatch(2).unwrap();
    assert!(rt.drop_node(child).unwrap());
    assert_eq!(
        rt.take_watcher_updates().unwrap(),
        vec![WatcherUpdate::Ended(1)]
    );
}

fn wait_for_writes(scene: &GuestScene, at_least: u32) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while scene.writes() < at_least {
        assert!(
            Instant::now() < deadline,
            "timed out waiting for writes >= {at_least} (got {})",
            scene.writes()
        );
        std::thread::sleep(Duration::from_millis(2));
    }
}

fn drawn_text(scene: &GuestScene, cmds: &[Command]) -> Vec<String> {
    let text = scene.text();
    let text = text.lock().unwrap();
    cmds.iter()
        .filter_map(|c| match c {
            Command::Glyphs(g) => text.get(g.run).map(|r| r.content().to_owned()),
            _ => None,
        })
        .collect()
}

/// Full three-layer stack test: guest `styles.wasm` -> `platform.wasm` -> `RenderCore`.
/// Verifies theme inheritance, hover + selected property combining, responsive
/// single-frame relayout, and `watch-condition` stream updates only on threshold crossings.
#[test]
fn guest_styles_component_end_to_end() {
    let wasm = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("out/styles.wasm");
    assert!(
        wasm.exists(),
        "{} is missing; build it with `zena build ./packages/zenafx:build:styles`",
        wasm.display()
    );
    let eng = engine(false).expect("engine");
    let mut app = GuestScene::load(&eng, &wasm).expect("load styles.wasm");

    let accent = color(0.18, 0.42, 0.92);
    let selected = color(0.12, 0.72, 0.36);
    let hover_border = color(0.95, 0.45, 0.10);

    let draw_at = |app: &mut GuestScene, width: u32, height: u32| {
        app.frame(FrameEvent {
            time_ms: 0.0,
            width,
            height,
            scale: 1.0,
        })
    };

    // 1. Wide frame (800x400): tiles lay out horizontally (120 + 16 gap = 136) with theme accent.
    let writes_before_wide = app.writes();
    let cmds = draw_at(&mut app, 800, 400);
    let qs = quads(&cmds);
    assert_eq!(qs.len(), 3, "page + 2 tiles");
    assert_eq!(qs[1].background, Some(accent));
    assert_eq!(qs[1].bounds.x, 0.0);
    assert_eq!(qs[2].bounds.x, 136.0);
    assert_eq!(qs[2].bounds.y, 0.0);

    // Wait for `watch-condition` stream to deliver `Wide` and update the text label.
    wait_for_writes(&app, writes_before_wide + 1);
    let cmds = draw_at(&mut app, 800, 400);
    assert_eq!(drawn_text(&app, &cmds), vec!["Wide".to_string()]);

    // 2. Resizing within the wide interval (800 -> 700 -> 620) wakes no guest code.
    let writes_steady = app.writes();
    let _ = draw_at(&mut app, 700, 400);
    let _ = draw_at(&mut app, 620, 400);
    std::thread::sleep(Duration::from_millis(20));
    assert_eq!(app.writes(), writes_steady);

    // 3. Hover tileA -> orange border added purely in platform.wasm (0 guest writes).
    assert!(app.pointer(PointerInput::Moved { x: 40.0, y: 20.0 }));
    assert_eq!(app.writes(), writes_steady);
    let qs = quads(&draw_at(&mut app, 620, 400));
    assert_eq!(qs[1].background, Some(accent));
    assert_eq!(qs[1].border_color, Some(hover_border));
    assert_eq!(qs[1].border_width, 2.0);

    // 4. Click tileA -> guest toggles `selected` -> turns green WHILE keeping hovered border!
    let _ = app.pointer(PointerInput::Button {
        x: 40.0,
        y: 20.0,
        button: 0,
        down: true,
    });
    wait_for_writes(&app, writes_steady + 1);
    let qs = quads(&draw_at(&mut app, 620, 400));
    assert_eq!(qs[1].background, Some(selected));
    assert_eq!(qs[1].border_color, Some(hover_border));
    assert_eq!(qs[1].border_width, 2.0);

    // 5. Resize across the 600px threshold (620 -> 400): tiles immediately stack vertically
    //    in the SAME frame, and `watch-condition` delivers `Narrow` to update the label!
    let writes_before_narrow = app.writes();
    let qs = quads(&draw_at(&mut app, 400, 400));
    assert_eq!(qs[1].bounds.x, 0.0);
    assert_eq!(qs[1].bounds.y, 0.0);
    assert_eq!(qs[2].bounds.x, 0.0);
    assert_eq!(qs[2].bounds.y, 48.0);

    wait_for_writes(&app, writes_before_narrow + 1);
    let cmds = draw_at(&mut app, 400, 400);
    assert_eq!(drawn_text(&app, &cmds), vec!["Narrow".to_string()]);
}
