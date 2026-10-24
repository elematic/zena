//! What a `wasm-web-ui` crate would give a Rust module: the protocol's
//! exports over integer ids, templates, values, listeners and elements.
//! The protocol is docs/design/wasm-web-ui.md; this is its linear-memory
//! extension, where the host keeps the identity of the module's objects
//! and tells the module through `webui_release` when it dropped one.
//!
//! The module keeps every object the host can name in one slab, under
//! an id that is not reused until the host releases it. A template, a
//! definition, a property, an element instance and a listener are
//! owned: they live until `webui_release`. A result and the lists in it
//! are transient: the host reads them before it calls back in, so they
//! are dropped at the next render.

use std::any::Any;
use std::cell::RefCell;
use std::sync::atomic::{AtomicU32, Ordering};

// The imports: one module, `wasm-web-ui`. The linker keeps only the
// ones the program references, so a module whose listeners never read
// a key does not import `event_key`, and the page sees that.
#[link(wasm_import_module = "wasm-web-ui")]
extern "C" {
    fn request_update(instance: u32);
    fn dispatch_event(instance: u32, type_ptr: *const u8, type_len: usize, flags: u32) -> i32;
    fn extern_release(id: u32);
    fn event_target_value(event: u32, buffer: *mut u8, capacity: usize) -> usize;
    fn event_key(event: u32, buffer: *mut u8, capacity: usize) -> usize;
    fn event_prevent_default(event: u32);
    fn event_stop_propagation(event: u32);
}

/// A template: the fixed strings between the holes. One per call site,
/// in a `static`, so its id is made once and the host sees the same
/// template on every render.
pub struct Template {
    strings: &'static [&'static str],
    id: AtomicU32,
}

impl Template {
    pub const fn new(strings: &'static [&'static str]) -> Template {
        Template {
            strings,
            id: AtomicU32::new(0),
        }
    }

    fn id(&'static self) -> u32 {
        let id = self.id.load(Ordering::Relaxed);
        if id != 0 {
            return id;
        }
        let id = with_state(|s| s.insert(Object::Template(self), false));
        self.id.store(id, Ordering::Relaxed);
        id
    }
}

/// `template!("<p>", "</p>")`: the strings around the holes, as a tagged
/// template literal would split them.
#[macro_export]
macro_rules! template {
    ($($s:literal),+ $(,)?) => {
        $crate::webui::Template::new(&[$($s),+])
    };
}

/// A value for a hole.
pub enum Value {
    Nothing,
    Text(String),
    Number(f64),
    Bool(bool),
    Template(TemplateResult),
    List(Vec<Value>),
    Listener(u32),
    Host(Extern),
}

impl From<&str> for Value {
    fn from(s: &str) -> Value {
        Value::Text(s.to_string())
    }
}
impl From<String> for Value {
    fn from(s: String) -> Value {
        Value::Text(s)
    }
}
impl From<i32> for Value {
    fn from(n: i32) -> Value {
        Value::Number(n as f64)
    }
}
impl From<f64> for Value {
    fn from(n: f64) -> Value {
        Value::Number(n)
    }
}
impl From<bool> for Value {
    fn from(b: bool) -> Value {
        Value::Bool(b)
    }
}
impl From<TemplateResult> for Value {
    fn from(r: TemplateResult) -> Value {
        Value::Template(r)
    }
}
impl From<Vec<Value>> for Value {
    fn from(l: Vec<Value>) -> Value {
        Value::List(l)
    }
}

/// A template with its values: what `render` returns.
pub struct TemplateResult {
    template: &'static Template,
    values: Vec<Value>,
}

/// `html(&TEMPLATE, vec![...])`, with one value per hole.
pub fn html(template: &'static Template, values: Vec<Value>) -> TemplateResult {
    debug_assert_eq!(values.len() + 1, template.strings.len());
    TemplateResult { template, values }
}

/// A host value the module holds by id, released when dropped.
pub struct Extern(u32);

impl Drop for Extern {
    fn drop(&mut self) {
        unsafe { extern_release(self.0) }
    }
}

/// An event, for the duration of a listener call. Its methods are the
/// capability imports; a module links only the ones it calls.
pub struct Event(u32);

impl Event {
    pub fn target_value(&self) -> String {
        read_string(|buffer, capacity| unsafe { event_target_value(self.0, buffer, capacity) })
    }

    pub fn key(&self) -> String {
        read_string(|buffer, capacity| unsafe { event_key(self.0, buffer, capacity) })
    }

    pub fn prevent_default(&self) {
        unsafe { event_prevent_default(self.0) }
    }

    pub fn stop_propagation(&self) {
        unsafe { event_stop_propagation(self.0) }
    }
}

/// A string the host writes into a buffer: a 64-byte one first, and a
/// second call sized by the first's answer when that was too small.
fn read_string(mut write: impl FnMut(*mut u8, usize) -> usize) -> String {
    let mut buffer = vec![0u8; 64];
    let mut length = write(buffer.as_mut_ptr(), buffer.len());
    if length > buffer.len() {
        buffer.resize(length, 0);
        length = write(buffer.as_mut_ptr(), buffer.len());
    }
    buffer.truncate(length);
    String::from_utf8(buffer).unwrap_or_default()
}

/// The flags of a dispatched event.
#[derive(Clone, Copy, Default)]
pub struct EventFlags {
    pub bubbles: bool,
    pub composed: bool,
    pub cancelable: bool,
}

impl EventFlags {
    fn bits(self) -> u32 {
        (self.bubbles as u32) | ((self.composed as u32) << 1) | ((self.cancelable as u32) << 2)
    }
}

/// What an element gets from the host: a way to ask for a render, to
/// dispatch an event, and to make listeners bound to itself.
pub struct Context {
    instance: u32,
}

impl Context {
    pub fn request_update(&self) {
        unsafe { request_update(self.instance) }
    }

    /// Dispatches a plain `Event` from the element; false if a listener
    /// canceled a cancelable one.
    pub fn dispatch_event(&self, event_type: &str, flags: EventFlags) -> bool {
        unsafe {
            dispatch_event(
                self.instance,
                event_type.as_ptr(),
                event_type.len(),
                flags.bits(),
            ) != 0
        }
    }

    /// A listener value for a hole: when the event fires, `f` runs with
    /// the element it was made for, and the element renders again.
    pub fn on<T, F>(&self, mut f: F) -> Value
    where
        T: Element + 'static,
        F: FnMut(&mut T, &Context, &Event) + 'static,
    {
        let instance = self.instance;
        let listener: ListenerFn = Box::new(move |event| {
            with_element(instance, |element, cx| {
                if let Some(element) = (element as &mut dyn Any).downcast_mut::<T>() {
                    f(element, cx, event);
                }
            });
            unsafe { request_update(instance) }
        });
        Value::Listener(with_state(|s| s.insert(Object::Listener(listener), false)))
    }
}

type ListenerFn = Box<dyn FnMut(&Event)>;

/// A custom element's behaviour. The host constructs instances through
/// the definition's `create` and forwards the lifecycle.
pub trait Element: Any {
    fn render(&mut self, cx: &Context) -> Option<TemplateResult>;
    fn connected(&mut self, _cx: &Context) {}
    fn disconnected(&mut self, _cx: &Context) {}
    fn updated(&mut self, _cx: &Context, _first: bool) {}
}

/// The kinds a property can have, numbered as the protocol's value kinds.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Text = 1,
    Number = 2,
    Bool = 3,
    Host = 7,
}

/// A property's value crossing to or from the host.
pub enum PropertyValue {
    Text(String),
    Number(f64),
    Bool(bool),
    Host(Extern),
}

/// A field type a property can have.
pub trait PropertyType: Sized {
    const KIND: Kind;
    fn into_value(self) -> PropertyValue;
    fn from_value(value: PropertyValue) -> Self;
    /// The value an attribute's text sets, or `None` for its removal.
    fn from_attribute(text: Option<&str>) -> Self;
}

impl PropertyType for String {
    const KIND: Kind = Kind::Text;
    fn into_value(self) -> PropertyValue {
        PropertyValue::Text(self)
    }
    fn from_value(value: PropertyValue) -> String {
        match value {
            PropertyValue::Text(s) => s,
            _ => String::new(),
        }
    }
    fn from_attribute(text: Option<&str>) -> String {
        text.unwrap_or("").to_string()
    }
}

impl PropertyType for i32 {
    const KIND: Kind = Kind::Number;
    fn into_value(self) -> PropertyValue {
        PropertyValue::Number(self as f64)
    }
    fn from_value(value: PropertyValue) -> i32 {
        match value {
            PropertyValue::Number(n) => n as i32,
            _ => 0,
        }
    }
    fn from_attribute(text: Option<&str>) -> i32 {
        text.and_then(|t| t.trim().parse().ok()).unwrap_or(0)
    }
}

impl PropertyType for f64 {
    const KIND: Kind = Kind::Number;
    fn into_value(self) -> PropertyValue {
        PropertyValue::Number(self)
    }
    fn from_value(value: PropertyValue) -> f64 {
        match value {
            PropertyValue::Number(n) => n,
            _ => 0.0,
        }
    }
    fn from_attribute(text: Option<&str>) -> f64 {
        text.and_then(|t| t.trim().parse().ok()).unwrap_or(0.0)
    }
}

impl PropertyType for bool {
    const KIND: Kind = Kind::Bool;
    fn into_value(self) -> PropertyValue {
        PropertyValue::Bool(self)
    }
    fn from_value(value: PropertyValue) -> bool {
        matches!(value, PropertyValue::Bool(true))
    }
    fn from_attribute(text: Option<&str>) -> bool {
        text.is_some()
    }
}

/// One declared property: its name, kind, the attribute that reflects
/// into it, and accessors over the element. `property!` writes one.
pub struct Property {
    pub name: &'static str,
    pub kind: Kind,
    pub attribute: Option<&'static str>,
    pub get: fn(&dyn Any) -> PropertyValue,
    pub set: fn(&mut dyn Any, PropertyValue),
    pub set_attribute: fn(&mut dyn Any, Option<&str>),
}

/// `property!(Counter, count: i32)` declares `count` reflected from the
/// attribute of the same name; `property!(Counter, draft: String, state)`
/// declares a property with no attribute. A derive macro would write
/// these from the struct's fields, as `@property` does in Zena.
#[macro_export]
macro_rules! property {
    ($element:ty, $field:ident : $type:ty) => {
        $crate::property!(@build $element, $field: $type, Some(stringify!($field)))
    };
    ($element:ty, $field:ident : $type:ty, state) => {
        $crate::property!(@build $element, $field: $type, None)
    };
    (@build $element:ty, $field:ident : $type:ty, $attribute:expr) => {{
        use $crate::webui::PropertyType;
        fn get(element: &dyn ::std::any::Any) -> $crate::webui::PropertyValue {
            element.downcast_ref::<$element>().unwrap().$field.clone().into_value()
        }
        fn set(element: &mut dyn ::std::any::Any, value: $crate::webui::PropertyValue) {
            element.downcast_mut::<$element>().unwrap().$field = <$type>::from_value(value);
        }
        fn set_attribute(element: &mut dyn ::std::any::Any, text: Option<&str>) {
            element.downcast_mut::<$element>().unwrap().$field = <$type>::from_attribute(text);
        }
        $crate::webui::Property {
            name: stringify!($field),
            kind: <$type>::KIND,
            attribute: $attribute,
            get,
            set,
            set_attribute,
        }
    }};
}

/// One custom element the module defines. The host reads it once as a
/// record and derives the page's class from it.
pub struct Definition {
    /// The tag the module suggests; `None` leaves naming to the page.
    pub tag: Option<&'static str>,
    pub styles: Option<&'static str>,
    pub properties: &'static [Property],
    pub create: fn() -> Box<dyn Element>,
}

/// A result handed out by a module's own export, outside an element:
/// the host reads it before calling in again, so the previous ones go.
pub fn result(result: TemplateResult) -> u32 {
    with_state(|s| {
        s.drop_transients();
        s.intern_result(result)
    })
}

// ---- The slab ----------------------------------------------------------

/// A value as stored: nested results and lists by id.
enum Slot {
    Nothing,
    Text(String),
    Number(f64),
    Bool(bool),
    Ref(u32),
    Listener(u32),
    Host(u32),
}

impl Slot {
    fn kind(&self) -> i32 {
        match self {
            Slot::Nothing => 0,
            Slot::Text(_) => 1,
            Slot::Number(_) => 2,
            Slot::Bool(_) => 3,
            Slot::Ref(_) => 4, // or 5: `value_kind` tells the two apart
            Slot::Listener(_) => 6,
            Slot::Host(_) => 7,
        }
    }
}

struct Instance {
    /// None while a listener or lifecycle call has the element out.
    element: Option<Box<dyn Element>>,
}

enum Object {
    Template(&'static Template),
    Definition(usize),
    Property(usize, usize),
    Instance(Instance),
    Listener(ListenerFn),
    Result(&'static Template, Vec<Slot>),
    List(Vec<Slot>),
    /// Out on loan to a listener or lifecycle call.
    Taken,
}

struct State {
    objects: Vec<Option<Object>>,
    free: Vec<u32>,
    transients: Vec<u32>,
    /// Ids of the definitions and their properties, made on first read.
    definition_ids: Vec<(u32, Vec<u32>)>,
    /// The last text returned to the host, alive until its next call.
    scratch: String,
    /// The `{ptr, len}` record a string crosses out through.
    record: [u32; 2],
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State {
        objects: vec![None], // id 0 is null
        free: Vec::new(),
        transients: Vec::new(),
        definition_ids: Vec::new(),
        scratch: String::new(),
        record: [0, 0],
    });
}

fn with_state<R>(f: impl FnOnce(&mut State) -> R) -> R {
    STATE.with(|s| f(&mut s.borrow_mut()))
}

impl State {
    fn insert(&mut self, object: Object, transient: bool) -> u32 {
        let id = match self.free.pop() {
            Some(id) => {
                self.objects[id as usize] = Some(object);
                id
            }
            None => {
                self.objects.push(Some(object));
                (self.objects.len() - 1) as u32
            }
        };
        if transient {
            self.transients.push(id);
        }
        id
    }

    fn remove(&mut self, id: u32) -> Option<Object> {
        let slot = self.objects.get_mut(id as usize)?;
        let object = slot.take();
        if object.is_some() {
            self.free.push(id);
        }
        object
    }

    fn get(&self, id: u32) -> Option<&Object> {
        self.objects.get(id as usize).and_then(|o| o.as_ref())
    }

    fn drop_transients(&mut self) {
        let ids = std::mem::take(&mut self.transients);
        for id in ids {
            self.remove(id);
        }
    }

    fn intern_result(&mut self, result: TemplateResult) -> u32 {
        let slots = self.intern_values(result.values);
        self.insert(Object::Result(result.template, slots), true)
    }

    fn intern_values(&mut self, values: Vec<Value>) -> Vec<Slot> {
        values
            .into_iter()
            .map(|value| match value {
                Value::Nothing => Slot::Nothing,
                Value::Text(s) => Slot::Text(s),
                Value::Number(n) => Slot::Number(n),
                Value::Bool(b) => Slot::Bool(b),
                Value::Template(r) => Slot::Ref(self.intern_result(r)),
                Value::List(l) => {
                    let slots = self.intern_values(l);
                    Slot::Ref(self.insert(Object::List(slots), true))
                }
                Value::Listener(id) => Slot::Listener(id),
                Value::Host(e) => {
                    let id = e.0;
                    std::mem::forget(e); // the host's table entry moves with the value
                    Slot::Host(id)
                }
            })
            .collect()
    }

    fn values(&self, container: u32) -> &[Slot] {
        match self.get(container) {
            Some(Object::Result(_, slots)) | Some(Object::List(slots)) => slots,
            _ => &[],
        }
    }

    /// The ids of every definition, made on the first read.
    fn definitions(&mut self) -> &[(u32, Vec<u32>)] {
        if self.definition_ids.is_empty() {
            let definitions = crate::definitions();
            for (d, definition) in definitions.iter().enumerate() {
                let id = self.insert(Object::Definition(d), false);
                let properties = (0..definition.properties.len())
                    .map(|p| self.insert(Object::Property(d, p), false))
                    .collect();
                self.definition_ids.push((id, properties));
            }
        }
        &self.definition_ids
    }

    fn string(&mut self, s: &str) -> u32 {
        self.record = [s.as_ptr() as u32, s.len() as u32];
        self.record.as_ptr() as u32
    }

    fn scratch_string(&mut self, s: String) -> u32 {
        self.scratch = s;
        self.record = [self.scratch.as_ptr() as u32, self.scratch.len() as u32];
        self.record.as_ptr() as u32
    }
}

fn property(id: u32) -> Option<&'static Property> {
    with_state(|s| match s.get(id) {
        Some(&Object::Property(d, p)) => Some(&crate::definitions()[d].properties[p]),
        _ => None,
    })
}

/// Runs `f` with an instance's element taken out of the slab, so the
/// call may use the host, which may call back into these exports.
fn with_element<R>(instance: u32, f: impl FnOnce(&mut dyn Element, &Context) -> R) -> Option<R> {
    let taken = with_state(|s| match s.objects.get_mut(instance as usize) {
        Some(Some(Object::Instance(i))) => i.element.take(),
        _ => None,
    });
    let mut element = taken?;
    let cx = Context { instance };
    let out = f(&mut *element, &cx);
    with_state(|s| {
        if let Some(Some(Object::Instance(i))) = s.objects.get_mut(instance as usize) {
            i.element = Some(element);
        }
    });
    Some(out)
}

fn take_string(ptr: *mut u8, length: usize) -> String {
    // Bytes the host wrote into memory from `webui_alloc`.
    let bytes = unsafe { Vec::from_raw_parts(ptr, length, length) };
    String::from_utf8(bytes).unwrap_or_default()
}

// ---- The exports -------------------------------------------------------

#[unsafe(no_mangle)]
pub extern "C" fn webui_version() -> i32 {
    1
}

#[unsafe(no_mangle)]
pub extern "C" fn webui_alloc(length: usize) -> *mut u8 {
    let mut bytes = Vec::<u8>::with_capacity(length);
    let ptr = bytes.as_mut_ptr();
    std::mem::forget(bytes);
    ptr
}

#[unsafe(no_mangle)]
pub extern "C" fn webui_release(id: u32) {
    with_state(|s| {
        s.remove(id);
    });
}

/// How many objects the slab holds: for tests of release.
#[unsafe(no_mangle)]
pub extern "C" fn webui_debug_live() -> i32 {
    with_state(|s| s.objects.iter().filter(|o| o.is_some()).count() as i32)
}

#[unsafe(no_mangle)]
pub extern "C" fn webui_result_strings(result: u32) -> u32 {
    let template: Option<&'static Template> = with_state(|s| match s.get(result) {
        Some(Object::Result(template, _)) => Some(*template),
        _ => None,
    });
    template.map_or(0, |t| t.id())
}

#[unsafe(no_mangle)]
pub extern "C" fn webui_result_type(_result: u32) -> i32 {
    1
}

#[unsafe(no_mangle)]
pub extern "C" fn webui_strings_count(strings: u32) -> i32 {
    with_state(|s| match s.get(strings) {
        Some(Object::Template(t)) => t.strings.len() as i32,
        _ => 0,
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn webui_strings_at(strings: u32, index: i32) -> u32 {
    with_state(|s| match s.get(strings) {
        Some(Object::Template(t)) => {
            let text = t.strings[index as usize];
            s.string(text)
        }
        _ => 0,
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn webui_strings_raw_at(strings: u32, index: i32) -> u32 {
    // Rust string literals are the source text; nothing is cooked.
    webui_strings_at(strings, index)
}

#[unsafe(no_mangle)]
pub extern "C" fn webui_value_count(container: u32) -> i32 {
    with_state(|s| s.values(container).len() as i32)
}

#[unsafe(no_mangle)]
pub extern "C" fn webui_value_kind(container: u32, index: i32) -> i32 {
    with_state(|s| match s.values(container).get(index as usize) {
        Some(Slot::Ref(id)) => match s.get(*id) {
            Some(Object::List(_)) => 5,
            _ => 4,
        },
        Some(slot) => slot.kind(),
        None => 0,
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn webui_value_extern(container: u32, index: i32) -> u32 {
    with_state(|s| {
        let text = match s.values(container).get(index as usize) {
            Some(Slot::Text(t)) => t.clone(),
            Some(Slot::Host(id)) => return *id,
            _ => return 0,
        };
        s.scratch_string(text)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn webui_value_ref(container: u32, index: i32) -> u32 {
    with_state(|s| match s.values(container).get(index as usize) {
        Some(Slot::Ref(id)) | Some(Slot::Listener(id)) => *id,
        _ => 0,
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn webui_value_number(container: u32, index: i32) -> f64 {
    with_state(|s| match s.values(container).get(index as usize) {
        Some(Slot::Number(n)) => *n,
        Some(Slot::Bool(b)) => *b as i32 as f64,
        _ => 0.0,
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn webui_listener_invoke(listener: u32, event: u32) {
    // Out of the slab while it runs: the listener may dispatch an event
    // whose JavaScript handler calls back into these exports.
    let taken = with_state(|s| match s.objects.get_mut(listener as usize) {
        Some(slot @ Some(Object::Listener(_))) => match slot.replace(Object::Taken) {
            Some(Object::Listener(f)) => Some(f),
            _ => None,
        },
        _ => None,
    });
    let Some(mut f) = taken else { return };
    f(&Event(event));
    with_state(|s| {
        if let Some(slot) = s.objects.get_mut(listener as usize) {
            if matches!(slot, Some(Object::Taken)) {
                *slot = Some(Object::Listener(f));
            }
        }
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn webui_element_count() -> i32 {
    with_state(|s| s.definitions().len() as i32)
}

#[unsafe(no_mangle)]
pub extern "C" fn webui_element_at(index: i32) -> u32 {
    with_state(|s| s.definitions()[index as usize].0)
}

fn definition(id: u32) -> Option<(usize, &'static Definition)> {
    with_state(|s| match s.get(id) {
        Some(&Object::Definition(d)) => Some((d, &crate::definitions()[d])),
        _ => None,
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn webui_definition_tag(id: u32) -> u32 {
    match definition(id).and_then(|(_, d)| d.tag) {
        Some(tag) => with_state(|s| s.string(tag)),
        None => 0,
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn webui_definition_styles(id: u32) -> u32 {
    match definition(id).and_then(|(_, d)| d.styles) {
        Some(styles) => with_state(|s| s.string(styles)),
        None => 0,
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn webui_definition_property_count(id: u32) -> i32 {
    definition(id).map_or(0, |(_, d)| d.properties.len() as i32)
}

#[unsafe(no_mangle)]
pub extern "C" fn webui_definition_property(id: u32, index: i32) -> u32 {
    let Some((d, _)) = definition(id) else {
        return 0;
    };
    with_state(|s| s.definitions()[d].1[index as usize])
}

#[unsafe(no_mangle)]
pub extern "C" fn webui_definition_create(id: u32) -> u32 {
    let Some((_, def)) = definition(id) else {
        return 0;
    };
    let element = (def.create)();
    with_state(|s| {
        s.insert(
            Object::Instance(Instance {
                element: Some(element),
            }),
            false,
        )
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn webui_property_name(id: u32) -> u32 {
    match property(id) {
        Some(p) => with_state(|s| s.string(p.name)),
        None => 0,
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn webui_property_kind(id: u32) -> i32 {
    property(id).map_or(0, |p| p.kind as i32)
}

#[unsafe(no_mangle)]
pub extern "C" fn webui_property_attribute(id: u32) -> u32 {
    match property(id).and_then(|p| p.attribute) {
        Some(attribute) => with_state(|s| s.string(attribute)),
        None => 0,
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn webui_element_connected(instance: u32) {
    with_element(instance, |element, cx| element.connected(cx));
}

#[unsafe(no_mangle)]
pub extern "C" fn webui_element_disconnected(instance: u32) {
    with_element(instance, |element, cx| element.disconnected(cx));
}

#[unsafe(no_mangle)]
pub extern "C" fn webui_element_attribute_changed(
    instance: u32,
    property_id: u32,
    ptr: *mut u8,
    length: usize,
) {
    let text = take_string(ptr, length);
    let Some(p) = property(property_id) else {
        return;
    };
    with_element(instance, |element, cx| {
        (p.set_attribute)(element as &mut dyn Any, Some(&text));
        cx.request_update();
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn webui_element_attribute_removed(instance: u32, property_id: u32) {
    let Some(p) = property(property_id) else {
        return;
    };
    with_element(instance, |element, cx| {
        (p.set_attribute)(element as &mut dyn Any, None);
        cx.request_update();
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn webui_element_get_extern(instance: u32, property_id: u32) -> u32 {
    let Some(p) = property(property_id) else {
        return 0;
    };
    let value = with_element(instance, |element, _| (p.get)(element as &dyn Any));
    match value {
        Some(PropertyValue::Text(text)) => with_state(|s| s.scratch_string(text)),
        Some(PropertyValue::Host(e)) => {
            let id = e.0;
            std::mem::forget(e);
            id
        }
        _ => 0,
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn webui_element_get_number(instance: u32, property_id: u32) -> f64 {
    let Some(p) = property(property_id) else {
        return 0.0;
    };
    match with_element(instance, |element, _| (p.get)(element as &dyn Any)) {
        Some(PropertyValue::Number(n)) => n,
        Some(PropertyValue::Bool(b)) => b as i32 as f64,
        _ => 0.0,
    }
}

fn set_property(instance: u32, p: &'static Property, value: PropertyValue) {
    with_element(instance, |element, cx| {
        (p.set)(element as &mut dyn Any, value);
        cx.request_update();
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn webui_element_set_text(
    instance: u32,
    property_id: u32,
    ptr: *mut u8,
    length: usize,
) {
    let text = take_string(ptr, length);
    if let Some(p) = property(property_id) {
        set_property(instance, p, PropertyValue::Text(text));
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn webui_element_set_extern(instance: u32, property_id: u32, extern_id: u32) {
    if let Some(p) = property(property_id) {
        set_property(instance, p, PropertyValue::Host(Extern(extern_id)));
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn webui_element_set_number(instance: u32, property_id: u32, value: f64) {
    if let Some(p) = property(property_id) {
        let value = if p.kind == Kind::Bool {
            PropertyValue::Bool(value != 0.0)
        } else {
            PropertyValue::Number(value)
        };
        set_property(instance, p, value);
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn webui_element_render(instance: u32) -> u32 {
    // The previous render's results were read before this call.
    with_state(|s| s.drop_transients());
    let result = with_element(instance, |element, cx| element.render(cx)).flatten();
    match result {
        Some(result) => with_state(|s| s.intern_result(result)),
        None => 0,
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn webui_element_updated(instance: u32, first: i32) {
    with_element(instance, |element, cx| element.updated(cx, first != 0));
}
