//! Compact little-endian binary codec for crossing the JS <-> wasm32 engine boundary.

use zenafx_render::events::{Delivery, KeyEvent, Modifiers, PointerKind};
use zenafx_render::scene::{
    Appearance, Binding, BindingTarget, BindingValue, Cursor, Hole, NodeDef, Restyle, State,
    StateStyle, TemplateDef, TemplateRef, TextContent,
};
use zenafx_render::types::{
    Align, Axis, BoxStyle, Color, Edges, Flex, Justify, Length, Overflow, TextStyle,
};

pub struct Reader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    pub fn u8(&mut self) -> Option<u8> {
        let b = *self.data.get(self.pos)?;
        self.pos += 1;
        Some(b)
    }

    pub fn bool(&mut self) -> Option<bool> {
        Some(self.u8()? != 0)
    }

    pub fn u16(&mut self) -> Option<u16> {
        let slice = self.data.get(self.pos..self.pos + 2)?;
        self.pos += 2;
        Some(u16::from_le_bytes([slice[0], slice[1]]))
    }

    pub fn u32(&mut self) -> Option<u32> {
        let slice = self.data.get(self.pos..self.pos + 4)?;
        self.pos += 4;
        Some(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
    }

    pub fn f32(&mut self) -> Option<f32> {
        Some(f32::from_bits(self.u32()?))
    }

    pub fn string(&mut self) -> Option<String> {
        let len = self.u32()? as usize;
        let bytes = self.data.get(self.pos..self.pos + len)?;
        self.pos += len;
        Some(String::from_utf8_lossy(bytes).into_owned())
    }

    pub fn color(&mut self) -> Option<Color> {
        Some(Color {
            r: self.f32()?,
            g: self.f32()?,
            b: self.f32()?,
            a: self.f32()?,
        })
    }

    pub fn opt_color(&mut self) -> Option<Option<Color>> {
        match self.u8()? {
            0 => Some(None),
            _ => Some(Some(self.color()?)),
        }
    }

    pub fn box_style(&mut self) -> Option<BoxStyle> {
        Some(BoxStyle {
            background: self.opt_color()?,
            border_color: self.opt_color()?,
            border_width: self.f32()?,
            corner_radius: self.f32()?,
            opacity: self.f32()?,
        })
    }

    pub fn text_style(&mut self) -> Option<TextStyle> {
        Some(TextStyle {
            family: self.string()?,
            size: self.f32()?,
            weight: self.u16()?,
            italic: self.bool()?,
            color: self.color()?,
        })
    }

    pub fn length(&mut self) -> Option<Length> {
        match self.u8()? {
            0 => Some(Length::Auto),
            1 => Some(Length::Px(self.f32()?)),
            2 => Some(Length::Percent(self.f32()?)),
            _ => None,
        }
    }

    pub fn edges(&mut self) -> Option<Edges> {
        Some(Edges {
            top: self.f32()?,
            right: self.f32()?,
            bottom: self.f32()?,
            left: self.f32()?,
        })
    }

    pub fn overflow(&mut self) -> Option<Overflow> {
        match self.u8()? {
            0 => Some(Overflow::Clip),
            1 => Some(Overflow::Hidden),
            2 => Some(Overflow::Scroll),
            _ => None,
        }
    }

    pub fn flex(&mut self) -> Option<Flex> {
        let axis = match self.u8()? {
            0 => Axis::Row,
            1 => Axis::Column,
            _ => return None,
        };
        let justify_content = match self.u8()? {
            0 => Justify::Start,
            1 => Justify::Center,
            2 => Justify::End,
            3 => Justify::SpaceBetween,
            _ => return None,
        };
        let align_items = match self.u8()? {
            0 => Align::Start,
            1 => Align::Center,
            2 => Align::End,
            3 => Align::Stretch,
            _ => return None,
        };
        Some(Flex {
            axis,
            justify_content,
            align_items,
            gap: self.f32()?,
            padding: self.edges()?,
            width: self.length()?,
            height: self.length()?,
            grow: self.f32()?,
            shrink: self.f32()?,
            overflow_x: self.overflow()?,
            overflow_y: self.overflow()?,
        })
    }

    pub fn appearance(&mut self) -> Option<Appearance> {
        match self.u8()? {
            0 => Some(Appearance::Nothing),
            1 => Some(Appearance::Fill(self.box_style()?)),
            2 => Some(Appearance::Text(TextContent {
                content: self.string()?,
                style: self.text_style()?,
            })),
            _ => None,
        }
    }

    pub fn opt_cursor(&mut self) -> Option<Option<Cursor>> {
        match self.u8()? {
            0 => Some(None),
            _ => Some(Some(Cursor::from_index(self.u8()? as usize)?)),
        }
    }

    pub fn node_def(&mut self) -> Option<NodeDef> {
        Some(NodeDef {
            layout: self.flex()?,
            appearance: self.appearance()?,
            first_child: self.u32()?,
            child_count: self.u32()?,
            is_slot: self.bool()?,
            cursor: self.opt_cursor()?,
            focusable: self.bool()?,
            editable: self.bool()?,
            unselectable: self.bool()?,
        })
    }

    pub fn binding(&mut self) -> Option<Binding> {
        let node = self.u32()?;
        let target = match self.u8()? {
            0 => BindingTarget::Content,
            1 => BindingTarget::Style,
            2 => BindingTarget::Layout,
            _ => return None,
        };
        Some(Binding { node, target })
    }

    pub fn state_style(&mut self) -> Option<StateStyle> {
        let node = self.u32()?;
        let when = match self.u8()? {
            0 => State::Hovered,
            1 => State::Pressed,
            2 => State::Focused,
            _ => return None,
        };
        let of = self.u32()?;
        let style = match self.u8()? {
            0 => Restyle::Fill(self.box_style()?),
            1 => Restyle::Text(self.text_style()?),
            _ => return None,
        };
        Some(StateStyle {
            node,
            when,
            of,
            style,
        })
    }

    pub fn template_ref(&mut self) -> Option<TemplateRef> {
        match self.u8()? {
            0 => Some(TemplateRef::Known(self.u32()?)),
            1 => {
                let id = self.u32()?;
                let n_nodes = self.u32()? as usize;
                let mut nodes = Vec::with_capacity(n_nodes);
                for _ in 0..n_nodes {
                    nodes.push(self.node_def()?);
                }
                let n_bindings = self.u32()? as usize;
                let mut bindings = Vec::with_capacity(n_bindings);
                for _ in 0..n_bindings {
                    bindings.push(self.binding()?);
                }
                let n_states = self.u32()? as usize;
                let mut states = Vec::with_capacity(n_states);
                for _ in 0..n_states {
                    states.push(self.state_style()?);
                }
                Some(TemplateRef::Fresh(TemplateDef {
                    id,
                    nodes,
                    bindings,
                    states,
                }))
            }
            _ => None,
        }
    }

    pub fn hole(&mut self) -> Option<Hole> {
        let binding = self.u32()?;
        let value = match self.u8()? {
            0 => BindingValue::Content(self.string()?),
            1 => BindingValue::Style(self.box_style()?),
            2 => BindingValue::TextStyle(self.text_style()?),
            3 => BindingValue::Layout(self.flex()?),
            _ => return None,
        };
        Some(Hole { binding, value })
    }

    pub fn render_payload(&mut self) -> Option<(TemplateRef, Vec<Hole>)> {
        let template = self.template_ref()?;
        let n_holes = self.u32()? as usize;
        let mut holes = Vec::with_capacity(n_holes);
        for _ in 0..n_holes {
            holes.push(self.hole()?);
        }
        Some((template, holes))
    }

    pub fn key_event(&mut self) -> Option<KeyEvent> {
        let down = self.bool()?;
        let key = self.string()?;
        let code = self.string()?;
        let mods = self.u8()?;
        let repeat = self.bool()?;
        let text = match self.u8()? {
            0 => None,
            _ => Some(self.string()?),
        };
        Some(KeyEvent {
            down,
            key,
            code,
            modifiers: Modifiers {
                shift: (mods & 1) != 0,
                control: (mods & 2) != 0,
                alt: (mods & 4) != 0,
                meta: (mods & 8) != 0,
            },
            repeat,
            text,
        })
    }
}

pub fn encode_key_result(default_action: u8, dirty: bool, listeners: &[u32], out: &mut Vec<u8>) {
    out.clear();
    out.push(default_action);
    out.push(u8::from(dirty));
    out.extend_from_slice(&(listeners.len() as u32).to_le_bytes());
    for id in listeners {
        out.extend_from_slice(&id.to_le_bytes());
    }
}

pub fn encode_deliveries(deliveries: &[Delivery], out: &mut Vec<u8>) {
    out.clear();
    out.extend_from_slice(&(deliveries.len() as u32).to_le_bytes());
    for d in deliveries {
        out.push(u8::from(d.stops_when_handled));
        out.extend_from_slice(&(d.calls.len() as u32).to_le_bytes());
        for c in &d.calls {
            out.extend_from_slice(&c.listener.to_le_bytes());
            out.push(match c.event.kind {
                PointerKind::Down => 0,
                PointerKind::Up => 1,
                PointerKind::Move => 2,
                PointerKind::Enter => 3,
                PointerKind::Leave => 4,
            });
            out.extend_from_slice(&c.event.x.to_le_bytes());
            out.extend_from_slice(&c.event.y.to_le_bytes());
            out.push(c.event.button);
        }
    }
}

pub fn encode_u32_slice(items: &[u32], out: &mut Vec<u8>) {
    out.clear();
    out.extend_from_slice(&(items.len() as u32).to_le_bytes());
    for item in items {
        out.extend_from_slice(&item.to_le_bytes());
    }
}
