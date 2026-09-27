//! `zenafx:host/layout`: flexbox, solved by [`taffy`], with text measured
//! from inside the solve.
//!
//! Flexbox needs the intrinsic size of a text run, and that size depends on
//! the width the run is given — the same string is one line at 600px and
//! three at 200px. So measurement cannot be an input computed beforehand:
//! `solve` hands taffy a closure that calls the text engine at whatever width
//! it discovers mid-solve. §8.1 of `docs/design/zenafx-ui.md`.

use taffy::{
    AlignItems, AvailableSpace, Dimension, Display, FlexDirection, JustifyContent,
    LengthPercentage, NodeId, Style, TaffyTree, compute_leaf_layout,
};

use super::text::TextEngine;
use super::types::{
    Align, Available, Axis, Content, Flex, Justify, Length, Measured, MeasureRequest, Node, Rect,
    Size,
};

/// Solve one tree. The result is parallel to `nodes`, and each rect is in the
/// root's coordinate space.
///
/// `nodes` is in pre-order: index 0 is the root, and a node's children are
/// the `child_count` entries starting at `first_child`. Nodes carrying a run
/// id are leaves whose size comes from `text`.
pub fn solve(nodes: &[Node], available: Size, text: &mut TextEngine) -> Vec<Rect> {
    solve_with(nodes, available, |content, query| match content {
        Content::Text(run) => measure_text(text, *run, query),
        // Nothing else is measurable without a component registry; a
        // caller that embeds children uses `solve_with` and supplies one.
        _ => Measured {
            width: 0.0,
            height: 0.0,
            baseline: 0.0,
        },
    })
}

/// Measure a text run against one query.
///
/// A width the parent fixed wins. Otherwise the answer depends on which
/// question was asked: the two intrinsic widths are different numbers, and
/// answering `MinContent` with the unconstrained width would tell the solve
/// the text cannot wrap.
pub fn measure_text(text: &mut TextEngine, run: u32, query: MeasureRequest) -> Measured {
    let width = match (query.known_width, query.available_width) {
        (Some(w), _) => Some(w),
        (None, Available::Definite(w)) => Some(w),
        (None, Available::MaxContent) => None,
        (None, Available::MinContent) => text.content_widths(run).map(|(min, _)| min),
    };
    text.measure_run(run, width)
}

/// [`solve`] with measurement supplied by the caller.
///
/// `measure` is given a leaf's content and one [`MeasureRequest`], and is
/// called several times per leaf — see `taffy_queries_a_text_leaf_repeatedly`
/// below for what a real tree produces. Everything that is not a plain box
/// goes through it, so this is where a child component is asked for its size
/// and where a slot resolves to whatever fills it.
pub fn solve_with(
    nodes: &[Node],
    available: Size,
    mut measure: impl FnMut(&Content, MeasureRequest) -> Measured,
) -> Vec<Rect> {
    if nodes.is_empty() {
        return Vec::new();
    }

    let mut tree: TaffyTree<Content> = TaffyTree::with_capacity(nodes.len());
    let mut ids: Vec<Option<NodeId>> = vec![None; nodes.len()];

    // A child always follows its parent in pre-order, so building from the
    // end means every child exists by the time its parent is created.
    for i in (0..nodes.len()).rev() {
        let node = &nodes[i];
        let style = taffy_style(&node.style);
        let children: Vec<NodeId> = (node.first_child as usize
            ..node.first_child as usize + node.child_count as usize)
            .filter_map(|c| ids.get(c).copied().flatten())
            .collect();
        let id = if children.is_empty() {
            tree.new_leaf_with_context(style, node.content.clone())
                .expect("taffy rejected a leaf")
        } else {
            tree.new_with_children(style, &children)
                .expect("taffy rejected a container")
        };
        ids[i] = Some(id);
    }

    let root = ids[0].expect("the root is always created");
    tree.compute_layout_with_measure(
        root,
        taffy::Size {
            width: AvailableSpace::Definite(available.width),
            height: AvailableSpace::Definite(available.height),
        },
        |inputs, _node_id, context, style| {
            // `context` is None for a container; only leaves are measured.
            let content = context.map(|c| c.clone()).unwrap_or(Content::Box);
            compute_leaf_layout(inputs, style, |_, _| 0.0, |known, space| {
                if matches!(content, Content::Box) {
                    // A childless box has no content of its own; its size
                    // comes from its style, which `compute_leaf_layout` has
                    // already applied.
                    return taffy::Size::ZERO;
                }
                let m = measure(
                    &content,
                    MeasureRequest {
                        known_width: known.width,
                        known_height: known.height,
                        available_width: available_of(space.width),
                        available_height: available_of(space.height),
                    },
                );
                taffy::Size {
                    width: known.width.unwrap_or(m.width),
                    height: known.height.unwrap_or(m.height),
                }
            })
        },
    )
    .expect("taffy failed to compute a layout");

    // taffy reports each node's location relative to its parent's border box;
    // the scene wants window coordinates.
    let mut out = vec![
        Rect {
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: 0.0
        };
        nodes.len()
    ];
    absolutize(&tree, nodes, &ids, 0, 0.0, 0.0, &mut out);
    out
}

fn available_of(space: AvailableSpace) -> Available {
    match space {
        AvailableSpace::Definite(v) => Available::Definite(v),
        AvailableSpace::MinContent => Available::MinContent,
        AvailableSpace::MaxContent => Available::MaxContent,
    }
}

fn absolutize(
    tree: &TaffyTree<Content>,
    nodes: &[Node],
    ids: &[Option<NodeId>],
    index: usize,
    parent_x: f32,
    parent_y: f32,
    out: &mut [Rect],
) {
    let Some(id) = ids[index] else { return };
    let l = tree.layout(id).expect("taffy has no layout for a node it built");
    let x = parent_x + l.location.x;
    let y = parent_y + l.location.y;
    out[index] = Rect {
        x,
        y,
        width: l.size.width,
        height: l.size.height,
    };
    let node = &nodes[index];
    for c in node.first_child as usize..node.first_child as usize + node.child_count as usize {
        if c < nodes.len() {
            absolutize(tree, nodes, ids, c, x, y, out);
        }
    }
}

fn taffy_style(flex: &Flex) -> Style {
    Style {
        display: Display::Flex,
        flex_direction: match flex.axis {
            Axis::Row => FlexDirection::Row,
            Axis::Column => FlexDirection::Column,
        },
        justify_content: Some(match flex.justify_content {
            Justify::Start => JustifyContent::FLEX_START,
            Justify::Center => JustifyContent::CENTER,
            Justify::End => JustifyContent::FLEX_END,
            Justify::SpaceBetween => JustifyContent::SPACE_BETWEEN,
        }),
        align_items: Some(match flex.align_items {
            Align::Start => AlignItems::FLEX_START,
            Align::Center => AlignItems::CENTER,
            Align::End => AlignItems::FLEX_END,
            Align::Stretch => AlignItems::STRETCH,
        }),
        gap: taffy::Size {
            width: LengthPercentage::length(flex.gap),
            height: LengthPercentage::length(flex.gap),
        },
        padding: taffy::Rect {
            top: LengthPercentage::length(flex.padding.top),
            right: LengthPercentage::length(flex.padding.right),
            bottom: LengthPercentage::length(flex.padding.bottom),
            left: LengthPercentage::length(flex.padding.left),
        },
        size: taffy::Size {
            width: dimension(flex.width),
            height: dimension(flex.height),
        },
        flex_grow: flex.grow,
        flex_shrink: flex.shrink,
        ..Style::DEFAULT
    }
}

fn dimension(length: Length) -> Dimension {
    match length {
        Length::Auto => Dimension::auto(),
        Length::Px(v) => Dimension::length(v),
        // `length.percent` is a CSS percentage, 0..100; taffy wants a
        // fraction.
        Length::Percent(v) => Dimension::percent(v / 100.0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ui::types::{Edges, TextLook};

    fn boxed(style: Flex, first_child: u32, child_count: u32) -> Node {
        Node {
            style,
            content: Content::Box,
            first_child,
            child_count,
        }
    }

    fn leaf(run: u32) -> Node {
        Node {
            style: Flex::default(),
            content: Content::Text(run),
            first_child: 0,
            child_count: 0,
        }
    }

    /// The milestone-1 shape: one text run centred in the window by a flex
    /// container that fills it.
    #[test]
    fn text_is_centred_in_a_filling_container() {
        let mut text = TextEngine::new();
        let run = text.register_run("Hello, world", &TextLook::default());
        let nodes = vec![
            boxed(
                Flex {
                    justify_content: Justify::Center,
                    align_items: Align::Center,
                    width: Length::Percent(100.0),
                    height: Length::Percent(100.0),
                    ..Flex::default()
                },
                1,
                1,
            ),
            leaf(run),
        ];
        let available = Size {
            width: 800.0,
            height: 600.0,
        };
        let rects = solve(&nodes, available, &mut text);

        assert_eq!(rects.len(), 2);
        assert_eq!(rects[0].width, 800.0);
        assert_eq!(rects[0].height, 600.0);

        let label = rects[1];
        assert!(label.width > 0.0 && label.height > 0.0, "{label:?}");
        let cx = label.x + label.width / 2.0;
        let cy = label.y + label.height / 2.0;
        assert!((cx - 400.0).abs() < 1.0, "centre x was {cx}, {label:?}");
        assert!((cy - 300.0).abs() < 1.0, "centre y was {cy}, {label:?}");
    }

    /// The reason the measure closure is inside the solve: a container
    /// narrower than the text makes the text wrap, which makes it taller,
    /// which changes where centring puts it.
    #[test]
    fn a_narrow_container_wraps_the_text_and_the_solve_sees_it() {
        let mut text = TextEngine::new();
        let run = text.register_run(
            "The quick brown fox jumps over the lazy dog",
            &TextLook::default(),
        );
        let nodes = vec![
            boxed(
                Flex {
                    align_items: Align::Stretch,
                    width: Length::Percent(100.0),
                    height: Length::Percent(100.0),
                    ..Flex::default()
                },
                1,
                1,
            ),
            leaf(run),
        ];

        let wide = solve(
            &nodes,
            Size {
                width: 2000.0,
                height: 600.0,
            },
            &mut text,
        );
        let narrow = solve(
            &nodes,
            Size {
                width: 120.0,
                height: 600.0,
            },
            &mut text,
        );
        assert!(
            narrow[1].height > wide[1].height,
            "wide {:?} narrow {:?}",
            wide[1],
            narrow[1]
        );
    }

    #[test]
    fn a_row_lays_children_out_left_to_right_with_a_gap() {
        let mut text = TextEngine::new();
        let nodes = vec![
            boxed(
                Flex {
                    axis: Axis::Row,
                    gap: 10.0,
                    width: Length::Px(300.0),
                    height: Length::Px(100.0),
                    ..Flex::default()
                },
                1,
                2,
            ),
            boxed(
                Flex {
                    width: Length::Px(40.0),
                    height: Length::Px(20.0),
                    ..Flex::default()
                },
                0,
                0,
            ),
            boxed(
                Flex {
                    width: Length::Px(60.0),
                    height: Length::Px(20.0),
                    ..Flex::default()
                },
                0,
                0,
            ),
        ];
        let rects = solve(
            &nodes,
            Size {
                width: 300.0,
                height: 100.0,
            },
            &mut text,
        );
        assert_eq!(rects[1].x, 0.0);
        assert_eq!(rects[1].width, 40.0);
        assert_eq!(rects[2].x, 50.0, "40 wide plus a 10 gap");
        assert_eq!(rects[2].width, 60.0);
    }

    #[test]
    fn padding_insets_the_children_and_rects_are_absolute() {
        let mut text = TextEngine::new();
        let nodes = vec![
            boxed(
                Flex {
                    padding: Edges::all(16.0),
                    width: Length::Px(200.0),
                    height: Length::Px(200.0),
                    ..Flex::default()
                },
                1,
                1,
            ),
            boxed(
                Flex {
                    padding: Edges::all(8.0),
                    width: Length::Px(100.0),
                    height: Length::Px(100.0),
                    ..Flex::default()
                },
                2,
                1,
            ),
            boxed(
                Flex {
                    width: Length::Px(10.0),
                    height: Length::Px(10.0),
                    ..Flex::default()
                },
                0,
                0,
            ),
        ];
        let rects = solve(
            &nodes,
            Size {
                width: 200.0,
                height: 200.0,
            },
            &mut text,
        );
        assert_eq!((rects[1].x, rects[1].y), (16.0, 16.0));
        // The grandchild's rect is in the root's space, not its parent's.
        assert_eq!((rects[2].x, rects[2].y), (24.0, 24.0));
    }

    /// What a solve actually asks a leaf, and in what order.
    ///
    /// Layout is not one pass down and one pass up: a leaf is queried
    /// repeatedly, and which queries it gets depends on the styles above it.
    /// Two trees are printed here rather than asserted line by line, because
    /// the exact sequence is taffy's business. What is asserted is the part
    /// the ZenaFX design rests on — that one leaf is asked more than once in
    /// a single solve.
    #[test]
    fn taffy_queries_a_text_leaf_repeatedly() {
        let long = "The quick brown fox jumps over the lazy dog";

        // A fixed-width parent: the child's width is imposed.
        let mut text = TextEngine::new();
        let run = text.register_run(long, &TextLook::default());
        let fixed = vec![
            boxed(
                Flex {
                    align_items: Align::Start,
                    width: Length::Px(160.0),
                    height: Length::Percent(100.0),
                    ..Flex::default()
                },
                1,
                1,
            ),
            leaf(run),
        ];
        let mut imposed = Vec::new();
        solve_with(
            &fixed,
            Size {
                width: 160.0,
                height: 600.0,
            },
            |c, q| {
                imposed.push(q);
                let Content::Text(r) = c else { unreachable!() };
                measure_text(&mut text, *r, q)
            },
        );

        // A shrink-to-fit parent: the child's width is its own to choose, so
        // the solve has to discover it.
        let mut text = TextEngine::new();
        let run = text.register_run(long, &TextLook::default());
        let hugging = vec![
            boxed(
                Flex {
                    axis: Axis::Row,
                    align_items: Align::Start,
                    ..Flex::default()
                },
                1,
                1,
            ),
            leaf(run),
        ];
        let mut discovered = Vec::new();
        solve_with(
            &hugging,
            Size {
                width: 1000.0,
                height: 600.0,
            },
            |c, q| {
                discovered.push(q);
                let Content::Text(r) = c else { unreachable!() };
                measure_text(&mut text, *r, q)
            },
        );

        println!("imposed width:   {} queries", imposed.len());
        for q in &imposed {
            println!("  known {:?} available {:?}", q.known_width, q.available_width);
        }
        println!("shrink to fit:   {} queries", discovered.len());
        for q in &discovered {
            println!("  known {:?} available {:?}", q.known_width, q.available_width);
        }

        assert!(imposed.len() > 1, "{imposed:?}");
        assert!(discovered.len() > 1, "{discovered:?}");
    }

    #[test]
    fn an_empty_tree_solves_to_nothing() {
        let mut text = TextEngine::new();
        assert!(
            solve(
                &[],
                Size {
                    width: 10.0,
                    height: 10.0
                },
                &mut text
            )
            .is_empty()
        );
    }
}
