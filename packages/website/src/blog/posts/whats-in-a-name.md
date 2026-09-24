---
title: "What's in a Name?"
description: 'Where the name "Zena" comes from, the ancient Greek concept of xenia (guest-friendship), and what it means to be a great guest language for WebAssembly.'
date: 2026-09-24T12:00:00Z
author: justinfagnani
tags:
  - design
hero:
  image: 'https://images.unsplash.com/photo-1516384100354-0e0bbc0d2e00?auto=format&fit=crop&w=1600&q=80'
  alt: 'Hello my name is name tags and markers on a table'
  credit: 'Photo by Jon Tyson on Unsplash'
---

People often ask where the name "Zena" comes from.

The name draws inspiration from the ancient Greek concept of **xenia** (ξενία):

<div class="dictionary-card">
  <div class="dictionary-header">
    <span class="dictionary-word">xe·ni·a</span>
    <span class="dictionary-pronunciation">/zɛˈniː.ə/</span>
    <span class="dictionary-pos">noun</span>
    <span class="dictionary-etymology">(Ancient Greek: <strong>ξενία</strong>, from <em>ξένος</em>, guest/stranger)</span>
  </div>
  <ol class="dictionary-senses">
    <li>The ancient Greek sacred law and custom of <strong>guest-friendship</strong>: hospitality, protection, and generosity extended to travelers and guests far from home.</li>
    <li>A reciprocal relationship of mutual courtesy between host and guest, obligating the guest to respect the host’s house, customs, and boundaries.</li>
  </ol>
</div>

In WebAssembly, the execution environment (a browser, Node.js, Wasmtime, or an
edge runtime) is the **host**, and the WebAssembly module executing within it is
the **guest**.

Since Zena only targets WebAssembly it is inherently a guest language, and from
the very beginning was designed to be a **great guest**:

- **Aligned semantics and types**: Zena's low-level semantics and types —
  primitives, references, functions, nullability and mutability, operations,
  field access, garbage collection, and more — are designed to mirror Wasm GC as
  much as possible, with as little indirection, emitted bytecode, and runtime
  overhead as possible.
- **Native Wasm GC**: Zena was created specifically for WebAssembly GC, so it
  doesn't bring its own garbage collector or memory management, and seamlessly
  integrates with GC-based hosts like JavaScript and the DOM.
- **Thoughtful interop**: Integrated WASI p3 component support, direct WIT
  imports, strings that can use host encodings, JS interop, virtual libraries
  that change per host environment, a borrow checking system for external
  resources... Zena knows that to be a good guest means to be flexible and adapt
  to your host.

Most languages running in WebAssembly today were originally designed for their
own virtual machine, interpreter, or compiler targeting native executables with
few runtime restrictions. To run in Wasm, they naturally need to bring along
parts of their runtime—like a custom garbage collector, custom function call or
property access logic, runtime type information, or mutable classes—resulting in
larger bundles and heavier interop layers. That isn't a defect in their design;
they were just designed for a different execution environment.

Zena has the benefit of a clean slate and of being designed specifically for the
Wasm GC host environment, letting it deliver high performance, compact binaries,
and seamless interop.

## And yes, the Warrior Princess

Whenever I tell someone about Zena, another connection inevitably comes up:
_like Xena: Warrior Princess?_

While _xenia_ was the real etymological spark, we'll gladly take the
association.

In the show, Xena was a wandering warrior with no permanent home - she was a
perpetual guest across the ancient world. But crucially, Xena was a _good_
guest. She respected hospitality, defended her hosts from harm, and stood up
against those who violated the laws of hospitality.

<figure class="blog-post-figure">
  <img src="/images/blog/xena-warrior-princess.jpg" alt="Lucy Lawless as Xena: Warrior Princess holding a flaming torch" class="blog-post-image" loading="lazy" />
  <figcaption class="blog-post-caption">A good guest who knows how to handle a challenge.</figcaption>
</figure>

Zena brings that same spirit to WebAssembly: lightweight, respectful of its
host, fast, and designed to fit naturally into the WebAssembly ecosystem.

If you want to read more on how Zena makes a great WebAssembly guest language,
check out the (draft) [WebAssembly](/guide/web-assembly/) page in the
guide, as well as our detailed catalog of
[WebAssembly alignment](/development/design/wasm-alignment/) design decisions.

<!--
Zena also benefits from
modern programming language trends where the traditionally separate worlds of
dynamic and static languages converge more and more on static types and
ahead-of-time compilation form static languages, but type inference and pleasant
high-level syntax that makes the languages "feel" dynamic.

This benefit of hindsight and going after other trailblazers lets Zena deliver
high performance, compact binaries, sound typing while feeling right at home wherever Wasm
runs.
-->
