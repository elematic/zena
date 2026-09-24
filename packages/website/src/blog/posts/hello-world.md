---
title: 'Hello, World: Welcome to the Zena Blog'
description: 'Welcome to the Zena blog, where we will share project updates, design deep dives, and tutorials for the Zena programming language.'
date: 2026-09-24T09:00:00Z
author: justinfagnani
tags:
  - announcements
hero:
  image: 'https://images.unsplash.com/photo-1518770660439-4636190af475?auto=format&fit=crop&w=1600&q=80'
  alt: 'Macro photograph of computer motherboard circuitry'
  credit: 'Photo by Alexandre Debiève on Unsplash'
---

Welcome to the Zena blog!

Zena is a statically typed programming language purpose-built for **WebAssembly
GC**. It combines familiar syntax from TypeScript, Dart, Swift, and Scala with a
sound type system, immutability by default, and ahead-of-time compilation to
compact, fast Wasm binaries.

We'll be using this space to share:

- **Project updates**: Language evolution, compiler milestones, and standard
  library releases.
- **Design deep dives**: Technical write-ups explaining the architectural
  decisions behind the Zena language.
- **Tutorials**: Practical guides for building libraries, web applications, and
  WASI components.

Zena is not just a TypeScript clone for WebAssembly, it makes some very
meaningful additions and departures, so there's a lot to write about!

## A quick example of Zena

Here is a quick look at what writing Zena feels like. You can run and edit it
right in your browser:

<zena-playground vertical>
  <script type="sample/zena" filename="main.zena">
    class Greeting(message: String) {
      greet(name: String) {
        console.log(`${this.message}, ${name}!`);
      }
    }

    export function main() {
      let greeting = new Greeting('Hello, World');
      greeting.greet('Zena');
    }

  </script>
</zena-playground>

The Zena compiler and LSP loaded with the playground and weigh in at about
2.3MB.

## Explore further

If you'd like to learn more about Zena:

- Read through the [Language Reference](/reference/) for in-depth documentation
  on Zena's syntax, type system, classes, and standard library.
- Walk through the [Language Guide](/guide/what-is-zena/) for an introduction to
  the language, its design philosophy, and comparisons with TypeScript, Rust,
  and Go.
- Jump into the full [Playground](/playground/) to explore interactive
  multi-file examples and test your own code in WebAssembly GC.

Stay tuned for our upcoming posts as we explore language features, compiler
benchmarks, and the roadmap ahead!
