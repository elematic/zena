# ZenaFX navigation and assets

## Status

- **Status**: Proposed. Nothing here is built.
- **Date**: 2026-09-27
- **Scope**: how a ZenaFX window names what it is showing and moves between
  those things, and how a component refers to an image or a font it did not
  compile into itself.
- **Depends on**: [zenafx-ui.md](./zenafx-ui.md), whose §6.2 loader and §9.2
  child components both grow to accommodate this.

## Contents

1. Status
2. Why the two are one document
3. Navigation — 3.1 What a location is, 3.2 The three stacks, 3.3 The
   interface, 3.4 The chrome, 3.5 A link component, 3.6 What a navigation
   costs
4. Assets — 4.1 The problem with a URL, 4.2 A package is a manifest,
   4.3 Where the asset list lives, 4.4 The interface, 4.5 Images in the
   scene, 4.6 Integrity and caching
5. Open questions

## Why the two are one document

Both are about naming something outside the component and getting it. A
navigation resolves a name to a component and replaces the root; an asset
reference resolves a name to bytes. If they use different naming schemes,
the same image has two names depending on whether you are linking to it or
drawing it, and a component's dependencies are described twice. So the
resolver is one mechanism with two entry points.

## Navigation

### What a location is

A location is a URL. `https://example.com/app.wasm` names a component the
way the web names a document; `zenafx:settings` names one the host provides.
A relative reference resolves against the current location, so a component
bundled with its siblings can link to them without knowing where it was
served from.

The web and Android disagree about what a location addresses, and the
disagreement is worth taking seriously rather than splitting. On the web a
URL addresses a _document_ and the browser owns the back stack. On Android
an Intent addresses an _activity_ and the app owns its own task stack, with
the system stack above it. ZenaFX wants both, because "go back to the
previous app" and "go back within this app" are different user intentions
and conflating them is one of the web's persistent annoyances.

So a location has two parts:

```
scheme://authority/path      the component: what gets loaded
              ?query#fragment   the state within it: what it shows
```

Changing the component is a **navigation**. Changing only the query or
fragment is a **transition**, and the component handles it itself without
being reloaded. That is roughly the web's distinction between a page load
and a `pushState`, and roughly Android's between starting an activity and
changing what an activity shows.

### The three stacks

- The **window stack** holds locations whose component differs. The host
  owns it, the chrome's back button pops it, and a component cannot read
  it — knowing where the user has been is a capability, not a convenience.
- The **component stack** holds transitions within one component. The
  component owns it and tells the host its depth, so that a back gesture
  can be routed to the component before it pops the window stack. This is
  Android's arrangement: the system asks the app first.
- The **forward stack** is what a back pops onto, discarded on a new
  navigation, exactly as on the web.

A back gesture therefore resolves: if the component claims depth, ask it; if
not, pop the window stack.

### The interface

```wit
interface navigation {
  /// Where this component was loaded from, resolved and absolute.
  location: func() -> string;

  /// Load what `url` names, resolved against the current location, and make
  /// it the window's root. Fails if the policy refuses the target.
  navigate: func(url: string) -> result<_, string>;

  /// Change the query and fragment without reloading. The component is not
  /// restarted, and the chrome updates.
  transition: func(query: string, fragment: string);

  /// How many transitions this component can undo. The host asks the
  /// component to go back before it pops its own stack.
  set-depth: func(depth: u32);

  /// Back and forward across components, for chrome and for a component
  /// that wants to offer them.
  back: func();
  forward: func();
}
```

And, exported by a component that handles its own transitions:

```wit
interface navigable {
  /// The query and fragment changed, or the host is asking this component
  /// to undo one of its own transitions.
  locate: func(query: string, fragment: string);
  /// Undo one transition. Answering false hands the back to the host.
  go-back: func() -> bool;
}
```

Any component may call `navigate` today, which is what makes a link
component possible without a privileged widget. That is deliberately
permissive and deliberately temporary: navigation is a capability like any
other, and when the policy check of §6.2 exists, a component that was not
granted it will not have the interface bound at all. A component embedded
three levels deep replacing the whole window is exactly the thing an
untrusted component should not be able to do, so the grant should default to
the root only.

### The chrome

The URL bar is not a component. It is drawn by `zfx` above the content area,
which means it cannot be spoofed by what it frames: a component that could
paint over the bar could lie about where it came from, and the whole point of
showing the location is that it is the host's claim rather than the page's.
This is the same reason browsers keep chrome out of the content process.

Mechanically the window splits into a chrome strip and a content rect, the
root component gets the content rect as its box, and the chrome is painted
from the same display list primitives with the host building the commands.

### A link component

With `navigation` bound, a link is an ordinary widget: a slot for its label,
a pointer handler, and one call.

```zena
export function render(width: f32, height: f32): void { /* draw the slot */ }
export function on-pointer(event: PointerEvent): void {
  if (event.down) { navigate(href); }
}
```

It needs pointer input routed to components, which does not exist yet — §7.4
designs events but nothing delivers them. That is the real prerequisite for
this section, not navigation itself.

### What a navigation costs

Replacing the root tears down every component in the window: one `Store`
holds them all (§6.5), and the cheapest correct thing is to drop it. State
that should survive has to be somewhere else, which is the same conclusion
the web reached about `sessionStorage`. Keeping the old `Store` alive for a
back navigation is a cache, and a cache with a component's memory in it is a
policy question, so the first version will not have one.

## Assets

### The problem with a URL

A URL works for an image on the web and not for one in a package. An npm
package that ships `logo.png` beside its code refers to it by relative path,
resolved at build time by a bundler or at run time by the module loader.
Neither is available here: a component is a single `.wasm` file with no
filesystem and no module loader, and a relative path has nothing to be
relative to.

The three candidates:

- **Compile it in.** A byte array in the component. Works today, costs
  memory permanently, and means an image shared by two components is stored
  twice and decoded twice.
- **Fetch it by URL.** Works for the web case, useless offline, and makes a
  component's dependencies invisible until it runs.
- **Name it in the component and let the host supply it.** The component
  says `logo.png` and something outside resolves that. This is what a
  bundler does, moved to run time.

The third is right, and it needs somewhere to write down what the names mean.

### A package is a manifest

A ZenaFX package is a directory or archive containing a manifest, one or
more components, and their assets:

```
app/
  zenafx.json        name, version, entry component, dependencies
  app.wasm
  card.wasm
  assets/
    logo.png
    Inter.ttf
```

The manifest is what makes it a unit that can be versioned, signed and
cached. It is also where a component's _component_ dependencies go, which is
the point of connecting this to navigation: `spawn("card.wasm")` today
resolves a sibling filename because there is nothing better, and it should
resolve a manifest entry naming a version and a hash.

### Where the asset list lives

The instinct to put the asset list in a Wasm custom section is worth
resisting, for one reason: the host has to know what a component needs
_before_ it instantiates it, and ideally before it downloads it. A list
inside the `.wasm` is available only after fetching the whole thing.

The manifest is outside, small, and fetched first. A custom section is still
useful for a different job — recording which manifest a `.wasm` was built
against, so a component and a manifest that do not belong together are
caught rather than silently mismatched. So:

- **manifest**: what assets exist, their hashes, their media types.
- **custom section** (`zenafx:package`): the manifest's name, version and
  hash. One line, for checking.

A component that wants to be a single file can inline its assets as data
URLs in its own manifest, which keeps the one-file case possible without
making it the model.

### The interface

```wit
interface assets {
  /// An asset of this component's package, by the name its manifest gives.
  /// The handle is valid for the component's lifetime.
  open: func(name: string) -> result<asset, string>;

  resource asset {
    media-type: func() -> string;
    /// Decoded size for an image, in device-independent pixels.
    intrinsic-size: func() -> option<size>;
  }
}
```

Bytes are deliberately absent. A component asking for `logo.png` almost
always wants to _draw_ it, and handing over the bytes would mean every
component decodes its own PNG, holds the pixels in its own memory, and
uploads its own texture. A handle lets the host decode once, cache by hash,
and share the decoded image between every component that names it. A
component that genuinely needs the bytes — a component that is itself an
image decoder — asks for a capability to read them, which is a different
grant.

### Images in the scene

An image becomes a fourth `content` case beside `box`, `text` and `child`:

```wit
variant content {
  box,
  text(u32),
  child(u32),
  slot(string),
  image(u32),        // an asset handle
}
```

It measures to its intrinsic size, which the solve can override the way it
overrides a text run's, and it paints as a new display-list command carrying
the handle and a destination rect. The layout machinery of §8.1 needs no
change: an image is a leaf that answers `measure-request`, and answering it
is cheaper than text because the answer does not depend on the width.

### Integrity and caching

Every asset and every component in a manifest carries a hash. The hash is
the cache key, which makes the cache content-addressed and sharing across
packages automatic — two packages that ship the same font store it once. It
is also the integrity check, which is what makes fetching over the network
from an untrusted mirror safe.

This is where assets meet the policy check of §6.2: the loader already has
to decide whether to instantiate a component, and it should decide the same
way for an asset. A manifest that names a hash the policy has not seen is
the hook for "this package wants to load something new".

## Open questions

- **Does a transition survive a navigation?** The web says a URL fully
  determines what is shown, and mostly lies about it. Saying so honestly
  means a component must be able to serialize its state into the query,
  which is a constraint on every component that wants deep links.
- **Who owns the back gesture on a touch screen?** The three-stack
  resolution above assumes a discrete Back. An edge swipe that a component
  also wants for its own navigation needs an arbitration rule.
- **Is `spawn` a navigation?** A component that embeds another from a
  different package is doing something close to an iframe, and iframes have
  their own history entries on the web, to nearly universal regret.
- **How large may an inlined asset be?** Allowing data URLs in a manifest
  keeps the single-file case working and invites a 40MB manifest.
- **Fonts.** Treated as assets here, but the text engine wants them
  registered with `fontique` rather than handed over per use, so
  `zenafx:host/text` probably grows a `register-font(asset)` rather than
  reading them through `assets`.
