//! End-to-end Wasmtime integration tests for the Zena platform component
//! (`zenafx:platform@0.1.0`) running over the minimal Rust native core
//! (`zenafx:core/render@0.1.0`).

use std::path::PathBuf;

use zenafx::loader::{PlatformRuntime, engine};
use zenafx_render::events::{Phase, PointerInput, PointerKind, Scope};
use zenafx_render::scene::{
    Binding, BindingTarget, BindingValue, Cursor, Hole, NodeDef, NodeStyle, Restyle, State,
    StateStyle, TemplateDef, TemplateRef, TextContent,
};
use zenafx_render::types::{
    Align, Axis, BoxStyle, Color, Command, Edges, Flex, Justify, Layout, Length, OwnBox, Quad,
    Rect, Size, TextStyle,
};

fn platform() -> PlatformRuntime {
    let wasm = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("out/platform.wasm");
    assert!(
        wasm.exists(),
        "{} is missing; build it with `zena build packages/zenafx-platform/src/main.zena -o packages/zenafx/out/platform.wasm --target component --wit packages/zenafx/wit/deps/platform/platform.wit --world platform`",
        wasm.display()
    );
    let eng = engine(false).expect("could not create wasmtime engine");
    PlatformRuntime::load(&eng, &wasm).expect("could not load platform component")
}

fn box_node(width: Length, height: Length, bg: Color) -> NodeDef {
    NodeDef {
        own_box: OwnBox {
            width,
            height,
            ..OwnBox::default()
        },
        layout: Layout::Flex(Flex::default()),
        style: NodeStyle::Fill(BoxStyle {
            background: Some(bg),
            opacity: 1.0,
            ..BoxStyle::default()
        }),
        first_child: 0,
        child_count: 0,
        is_slot: false,
        cursor: None,
        focusable: false,
        editable: false,
        unselectable: false,
    }
}

fn slot_node() -> NodeDef {
    NodeDef {
        own_box: OwnBox::default(),
        layout: Layout::Flex(Flex::default()),
        style: NodeStyle::Nothing,
        first_child: 0,
        child_count: 0,
        is_slot: true,
        cursor: None,
        focusable: false,
        editable: false,
        unselectable: false,
    }
}

fn text_node(s: &str) -> NodeDef {
    NodeDef {
        own_box: OwnBox::default(),
        layout: Layout::Flex(Flex::default()),
        style: NodeStyle::Text(TextContent {
            content: s.to_owned(),
            style: TextStyle::default(),
        }),
        first_child: 0,
        child_count: 0,
        is_slot: false,
        cursor: None,
        focusable: false,
        editable: false,
        unselectable: false,
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

#[test]
fn templates_slots_and_hole_patching_flatten_into_render_core() {
    let mut rt = platform();
    let root = rt.root().unwrap();

    let red = Color::rgb(1.0, 0.0, 0.0);
    let green = Color::rgb(0.0, 1.0, 0.0);
    let blue = Color::rgb(0.0, 0.0, 1.0);

    // Card template: node 0 is row container, node 1 is a slot.
    let mut card = box_node(Length::Px(300.0), Length::Px(100.0), red);
    card.own_box.padding = Edges::all(10.0);
    card.layout = Layout::Flex(Flex {
        axis: Axis::Row,
        justify_content: Justify::Start,
        align_items: Align::Start,
        gap: 10.0,
    });
    card.first_child = 1;
    card.child_count = 1;
    card.cursor = Some(Cursor::Pointer);

    rt.render(
        root,
        TemplateRef::Fresh(TemplateDef {
            id: 1,
            nodes: vec![card, slot_node()],
            bindings: vec![Binding {
                node: 0,
                target: BindingTarget::Style,
            }],
            states: vec![],
        }),
        vec![],
    )
    .unwrap();

    // RenderCore never sees the slot node — only the root box (1 node).
    assert_eq!(rt.core().lock().unwrap().len(), 1);

    // Add two children into slot 0.
    let kids = rt.content(root, 0, 2).unwrap().expect("slot 0 exists");
    assert_eq!(kids.len(), 2);

    rt.render(
        kids[0],
        TemplateRef::Fresh(TemplateDef {
            id: 2,
            nodes: vec![box_node(Length::Px(50.0), Length::Px(40.0), green)],
            bindings: vec![],
            states: vec![],
        }),
        vec![],
    )
    .unwrap();
    rt.render(
        kids[1],
        TemplateRef::Fresh(TemplateDef {
            id: 3,
            nodes: vec![box_node(Length::Px(60.0), Length::Px(40.0), blue)],
            bindings: vec![],
            states: vec![],
        }),
        vec![],
    )
    .unwrap();

    // 3 concrete render nodes (root + 2 children; slot is flattened away).
    assert_eq!(rt.core().lock().unwrap().len(), 3);

    let vp = Size {
        width: 400.0,
        height: 300.0,
    };
    let cmds = rt.draw(vp).unwrap();
    let qs = quads(&cmds);
    assert_eq!(qs.len(), 3);
    assert_eq!(
        qs[1].bounds,
        Rect {
            x: 10.0,
            y: 10.0,
            width: 50.0,
            height: 40.0
        }
    );
    assert_eq!(
        qs[2].bounds,
        Rect {
            x: 70.0,
            y: 10.0,
            width: 60.0,
            height: 40.0
        }
    );

    // Inherited cursor from parent card propagates to child in RenderCore.
    let _ = rt.pointer(PointerInput::Moved { x: 20.0, y: 20.0 }).unwrap();
    assert_eq!(rt.core().lock().unwrap().cursor(), Cursor::Pointer);

    // Patching hole 0 on root updates background and keeps slot children intact.
    let yellow = Color::rgb(1.0, 1.0, 0.0);
    rt.render(
        root,
        TemplateRef::Known(1),
        vec![Hole {
            binding: 0,
            value: BindingValue::Style(BoxStyle {
                background: Some(yellow),
                opacity: 1.0,
                ..BoxStyle::default()
            }),
        }],
    )
    .unwrap();
    let qs2 = quads(&rt.draw(vp).unwrap());
    assert_eq!(qs2.len(), 3);
    assert_eq!(qs2[0].background, Some(yellow));
    assert_eq!(qs2[1].background, Some(green));
    assert_eq!(qs2[2].background, Some(blue));
}

#[test]
fn detached_nodes_and_set_slot_reorder_and_drop_cleanly() {
    let mut rt = platform();
    let root = rt.root().unwrap();

    let mut container = box_node(Length::Px(300.0), Length::Px(100.0), Color::rgb(1.0, 1.0, 1.0));
    container.layout = Layout::Flex(Flex {
        axis: Axis::Row,
        justify_content: Justify::Start,
        align_items: Align::Start,
        gap: 0.0,
    });
    container.first_child = 1;
    container.child_count = 1;

    rt.render(
        root,
        TemplateRef::Fresh(TemplateDef {
            id: 1,
            nodes: vec![container, slot_node()],
            bindings: vec![],
            states: vec![],
        }),
        vec![],
    )
    .unwrap();

    let a = rt.create_node().unwrap();
    let b = rt.create_node().unwrap();
    let red = Color::rgb(1.0, 0.0, 0.0);
    let blue = Color::rgb(0.0, 0.0, 1.0);

    rt.render(
        a,
        TemplateRef::Fresh(TemplateDef {
            id: 2,
            nodes: vec![box_node(Length::Px(50.0), Length::Px(30.0), red)],
            bindings: vec![],
            states: vec![],
        }),
        vec![],
    )
    .unwrap();
    rt.render(
        b,
        TemplateRef::Fresh(TemplateDef {
            id: 3,
            nodes: vec![box_node(Length::Px(80.0), Length::Px(30.0), blue)],
            bindings: vec![],
            states: vec![],
        }),
        vec![],
    )
    .unwrap();

    assert!(rt.set_slot(root, 0, vec![a, b]).unwrap());
    let vp = Size {
        width: 300.0,
        height: 200.0,
    };
    let qs = quads(&rt.draw(vp).unwrap());
    assert_eq!(qs[1].bounds.x, 0.0);
    assert_eq!(qs[1].background, Some(red));
    assert_eq!(qs[2].bounds.x, 50.0);
    assert_eq!(qs[2].background, Some(blue));

    // Reorder [b, a]: b moves to x=0, a moves to x=80.
    assert!(rt.set_slot(root, 0, vec![b, a]).unwrap());
    let qs = quads(&rt.draw(vp).unwrap());
    assert_eq!(qs[1].bounds.x, 0.0);
    assert_eq!(qs[1].background, Some(blue));
    assert_eq!(qs[2].bounds.x, 80.0);
    assert_eq!(qs[2].background, Some(red));

    // Detach `a` via set_slot([b]): `a` stays alive in RenderCore until dropped.
    assert!(rt.set_slot(root, 0, vec![b]).unwrap());
    assert_eq!(quads(&rt.draw(vp).unwrap()).len(), 2);
    assert_eq!(rt.core().lock().unwrap().len(), 3);

    // Dropping `a`'s handle frees its render node.
    assert!(rt.drop_node(a).unwrap());
    assert_eq!(rt.core().lock().unwrap().len(), 2);
}

#[test]
fn hover_and_press_restyle_and_logical_event_routing_across_slots() {
    let mut rt = platform();
    let root = rt.root().unwrap();

    let idle = Color::rgb(0.2, 0.2, 0.2);
    let hover = Color::rgb(0.4, 0.4, 0.9);
    let pressed = Color::rgb(0.9, 0.2, 0.2);

    // Button (node 0) contains a slot (node 1); state styles restyle node 0 when hovered/pressed.
    let mut btn = box_node(Length::Px(120.0), Length::Px(40.0), idle);
    btn.first_child = 1;
    btn.child_count = 1;

    rt.render(
        root,
        TemplateRef::Fresh(TemplateDef {
            id: 1,
            nodes: vec![btn, slot_node()],
            bindings: vec![],
            states: vec![
                StateStyle {
                    node: 0,
                    when: State::Hovered,
                    of: 0,
                    style: Restyle::Fill(BoxStyle {
                        background: Some(hover),
                        opacity: 1.0,
                        ..BoxStyle::default()
                    }),
                },
                StateStyle {
                    node: 0,
                    when: State::Pressed,
                    of: 0,
                    style: Restyle::Fill(BoxStyle {
                        background: Some(pressed),
                        opacity: 1.0,
                        ..BoxStyle::default()
                    }),
                },
            ],
        }),
        vec![],
    )
    .unwrap();

    let kids = rt.content(root, 0, 1).unwrap().unwrap();
    rt.render(
        kids[0],
        TemplateRef::Fresh(TemplateDef {
            id: 2,
            nodes: vec![text_node("Click me")],
            bindings: vec![],
            states: vec![],
        }),
        vec![],
    )
    .unwrap();

    // Register enter/leave/down listeners on slot 1 (subtree) and root 0 (bubble).
    assert!(
        rt.listen_pointer(root, 1, 10, PointerKind::Enter, Scope::Subtree, Phase::Bubble)
            .unwrap()
    );
    assert!(
        rt.listen_pointer(root, 1, 11, PointerKind::Down, Scope::Subtree, Phase::Intercept)
            .unwrap()
    );
    assert!(
        rt.listen_pointer(root, 0, 12, PointerKind::Down, Scope::Subtree, Phase::Bubble)
            .unwrap()
    );

    let vp = Size {
        width: 300.0,
        height: 200.0,
    };
    assert_eq!(quads(&rt.draw(vp).unwrap())[0].background, Some(idle));

    // Move pointer over button -> hover restyle triggers + Enter listener on slot fires.
    let (deliveries, restyled) = rt.pointer(PointerInput::Moved { x: 20.0, y: 15.0 }).unwrap();
    assert!(restyled);
    assert_eq!(quads(&rt.draw(vp).unwrap())[0].background, Some(hover));
    assert_eq!(deliveries.len(), 1);
    assert_eq!(deliveries[0].calls[0].listener, 10);
    assert_eq!(deliveries[0].calls[0].event.kind, PointerKind::Enter);

    // Press button -> pressed restyle overrides hover + Intercept (slot 11) fires before Bubble (root 12).
    let (deliveries, restyled) = rt
        .pointer(PointerInput::Button {
            x: 20.0,
            y: 15.0,
            button: 0,
            down: true,
        })
        .unwrap();
    assert!(restyled);
    assert_eq!(quads(&rt.draw(vp).unwrap())[0].background, Some(pressed));
    assert_eq!(deliveries.len(), 1);
    let ids: Vec<u32> = deliveries[0].calls.iter().map(|c| c.listener).collect();
    assert_eq!(ids, vec![11, 12]);

    // Replacing root's template ends its old listeners.
    rt.render(
        root,
        TemplateRef::Fresh(TemplateDef {
            id: 99,
            nodes: vec![box_node(Length::Px(50.0), Length::Px(50.0), idle)],
            bindings: vec![],
            states: vec![],
        }),
        vec![],
    )
    .unwrap();
    let mut ended = rt.take_ended_listeners().unwrap();
    ended.sort();
    assert_eq!(ended, vec![10, 11, 12]);
}
