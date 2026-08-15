# Choreographic Programming & Asynchronous Service Workflows

Status: **Proposal / Exploration** (2026-08).

This document explores how **Choreographic Programming** fits into Zena's design. It builds directly upon Zena's ownership model ([ownership.md](ownership.md)), affine types (`Own<T>`, `Scoped<T>`), async transformation pass ([async.md](async.md)), and Component Model strategy ([component-model.md](component-model.md)).

---

## Overview & Motivation

As Zena programs expand from single WebAssembly modules to networks of asynchronous services and dynamic WASI component graphs, safely coordinating multi-party interactions becomes a core challenge.

In traditional concurrent or microservice architectures, each participant is written independently from a **local perspective**. The interaction protocol lives implicitly across multiple codebases. This leads to common distributed system failure modes:

- **Deadlocks**: Service A waits on Service B, while Service B waits on Service A (or Service C).
- **Protocol Mismatches**: Service A sends a `payload: String` when Service B expects an `id: i32` or has already transitioned to a closed state.
- **Orphan Messages**: A service sends a message that no participant ever reads.
- **Uncoordinated Branching**: Service A decides to execute an error-recovery branch, but Service B continues down the happy path.

**Choreographic Programming** solves this by shifting to a **global perspective**. A developer writes a single program—a _choreography_—that describes the entire multi-party interaction flow. An **Endpoint Projection (EPP)** process then derives the local code for each participant.

Zena is uniquely positioned to implement choreographies cleanly because its foundational type system already includes **affine ownership (`Own<T>`)**, **scoped lifetime bounds (`Scoped<T>`)**, and **stackless state-machine async execution (`async`/`await`)**.

---

## 1. Guarantees: What does "Correct by Construction" mean?

When a distributed workflow or WASI component graph is projected from a well-formed global choreography, the compiler provides mathematical, static guarantees about execution:

| Guarantee                             | Meaning                                                                                                                                                                      | How Zena Enforces It                                                                                                              |
| :------------------------------------ | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------- |
| **Deadlock Freedom**                  | Communication dependencies across all services form a directed acyclic ordering at any execution step. No cyclic wait conditions can occur.                                  | Endpoint projection guarantees that every `recv` has a matching prior or concurrent `send` on the projected peer.                 |
| **Protocol Compliance & Type Safety** | Every message received matches the exact static type sent by the peer at that point in the sequence.                                                                         | The EPP process generates paired affine session channels (`Send<T, Next>` $\leftrightarrow$ `Recv<T, Next>`).                     |
| **Branch Alignment**                  | When one role makes a conditional decision (`choice`), all participants involved in that protocol branch are informed and transition their local state machines in lockstep. | EPP automatically injects label-selection broadcasts (`select_branch(Label)`) to all target roles.                                |
| **Resource & Leak Safety**            | Session handles and underlying network sockets/descriptors are never double-freed, forgotten, or used after close.                                                           | Zena's `Own<Channel>` ensures linear handle consumption; `Scoped<T>` prevents session references from escaping their async scope. |

---

## 2. Library-Level Session Types vs. Compiler/Macro EPP

There are two primary paradigms for introducing choreographies into a programming language:

```
                      Choreographic Paradigms
                                │
       ┌────────────────────────┴────────────────────────┐
       ▼                                                 ▼
Library-Level Session Types                      Compiler / Macro EPP
(Local Perspective, Pairwise)                  (Global Perspective, Multi-Party)
  - Write each role manually                     - Write 1 global choreography
  - Checked via affine channel types             - Compiler projects N role impls
  - Global deadlock prevention is manual         - Global deadlock-free by construction
```

### Approach A: Library-Level Session Types (Bottom-Up)

In this model, there is no global choreography file. Developers write standard Zena functions for each role, communicating over **Affine Session Channels**.

```zena
// stdlib zena:session (sketch)
export distinct type Send<Value, Next> = Channel;
export distinct type Recv<Value, Next> = Channel;
export distinct type End = Channel;

// Channel operations consume ownership and return the next state:
// send: (this: Own<Send<V, Next>>, val: V) -> Own<Next>
// recv: (this: Own<Recv<V, Next>>) -> (V, Own<Next>)
```

#### Example Usage:

```zena
type SellerChannel = Send<Quote, Recv<Payment, End>>;

async function runSeller(chan: Own<SellerChannel>): Future<void> {
  let quote = Quote { price: 100 };
  let c1: Own<Recv<Payment, End>> = await chan.send(quote);
  let (pay, c2): (Payment, Own<End>) = await c1.recv();
  c2.close();
}
```

- **Pros**: No compiler changes or macros needed today; uses `Own<T>` directly.
- **Cons**: Developers must manually write the code for both sides. If Seller expects `Recv<Payment>` but Buyer sends `ShippingAddress`, the type checker catches it _if_ both types are in the same binary, but multi-party interactions ($>2$ participants) become complex to verify manually.

### Approach B: Compiler/Macro Endpoint Projection (Top-Down)

Developers write a single global choreography block. A Zena macro or compiler pass projects local `async` functions for each participant role.

```zena
// Global specification expressed as a decorated top-level function
@choreography
export function orderProcess(c: Choreo) {
  c.transfer<Buyer, Seller, OrderDetails>();
  c.transfer<Seller, Buyer, Quote>();
  c.branch(
    Buyer,
    (quote: Quote) => quote.price <= 100,
    {
      then: (c) => {
        c.transfer<Buyer, Gateway, Payment>();
        c.transfer<Gateway, Seller, PaymentReceipt>();
      },
      else: (c) => {
        c.transfer<Buyer, Seller, CancelNotice>();
      }
    }
  );
}
```

- **Pros**: Absolute deadlock freedom, global multi-party verification, automatic branch broadcast, using standard top-level function syntax.
- **Cons**: Requires decorator/macro expansion or compile-time EPP projection pass.

---

## 3. Compilation Architecture: Multi-Binary vs. Referenced Entrypoints

A key architectural question: **How does a single choreography become multiple Wasm modules or WASI components?**

Compiling a single `.zena` file into multiple output `.wasm` binaries is typically undesirable because it breaks traditional toolchain assumptions (1 entrypoint source file = 1 output binary module).

Instead, Zena can adopt a **Referenced Endpoint Architecture**:

```
 ┌────────────────────────────────────────────────────────┐
 │ choreography.zena (Shared Protocol Definition)         │
 │   - Defines global choreography OrderFlow              │
 │   - Exports projected endpoint types/handlers          │
 └──────────────────────────┬─────────────────────────────┘
                            │ imports
            ┌───────────────┴───────────────┐
            ▼                               ▼
 ┌──────────────────────┐        ┌──────────────────────┐
 │ buyer_main.zena      │        │ seller_main.zena     │
 │   import {OrderFlow} │        │   import {OrderFlow} │
 │   from './protocol'; │        │   from './protocol'; │
 │                      │        │                      │
 │ export async fn main │        │ export async fn main │
 │ OrderFlow.runBuyer.. │        │ OrderFlow.runSeller. │
 └──────────┬───────────┘        └──────────┬───────────┘
            ▼                               ▼
      buyer.wasm                       seller.wasm
  (WASI Component 1)               (WASI Component 2)
```

### How Referenced Entrypoints Work:

1. **Shared Protocol File (`protocol.zena`)**:
   Contains the choreography macro/declaration `OrderFlow`. The macro expands into generic projected endpoint runner classes or functions:

   ```zena
   export namespace OrderFlow {
     export type BuyerRole = ...;
     export type SellerRole = ...;

     export async function runBuyer(
       chan: Own<BuyerChannel>,
       logic: BuyerLogic
     ): Future<void> { ... }
   }
   ```

2. **Standalone Component Entrypoints (`buyer_main.zena`)**:
   Each component/microservice has its own standard Zena entry file. It imports the projected role handler from the shared protocol file and implements local business logic hooks.

3. **Standard Compilation**:
   `zena-cli build buyer_main.zena -o buyer.wasm` compiles as a completely standard single-entrypoint binary! No special multi-binary compiler output magic is required.

---

## 4. WASI Component Graphs & Dynamic Runtime Linking

In modern WebAssembly architectures (including custom WASI runtimes with dynamic component loading), components are wired together into direct workflow graphs.

```
       Dynamic WASI Component Graph

     ┌────────────────────────┐
     │  Buyer Component       │
     │  (WASI p3 Async Out)   │
     └───────────┬────────────┘
                 │ WASI Component Stream / RPC
                 ▼
     ┌────────────────────────┐
     │  Seller Component      │
     │  (WASI p3 Async In)    │
     └───────────┬────────────┘
                 │
                 ▼
     ┌────────────────────────┐
     │  Gateway Component     │
     └────────────────────────┘
```

### Mapping Choreographies to WASI Components

1. **WIT Async Streams/Futures**:
   As described in [async.md §4.1](async.md#41-wasi-03-httpfs-and-serving-a-website-from-zena) and [component-model.md](component-model.md), WASI 0.3 (`wasi:http@0.3`, component-model-async) represents async communication via native canonical-ABI `stream<u8>` and `future<T>` waitables.

2. **Channel Transport Abstraction**:
   Zena session channels can wrap raw WASI Component Model streams:

   ```zena
   class WasiSessionChannel {
     #stream: Own<WasiStream>;
     new(this.#stream);

     async send<T>(val: T): Future<void> {
       let bytes = serialize(val);
       await this.#stream.write(bytes);
     }

     async recv<T>(): Future<T> {
       let bytes = await this.#stream.read();
       return deserialize<T>(bytes);
     }
   }
   ```

3. **Dynamic Topology Guarantees**:
   When a runtime dynamically links WASI Component A's export to WASI Component B's import, choreographic projection ensures that as long as the runtime links components matching the roles of the projected choreography, **the dynamic graph will execute without deadlocking or unexpected message drops**.

---

## 5. Structural Choices: Functions, Record Literals, or Whole Modules?

A choreography does **not** belong inside a `class` with static methods. In Zena, `class` is for instance-backed object structures, whereas top-level declarations and module scopes are first-class containers.

When designing a choreography, what is the best container structure? There are three natural options in native Zena syntax:

---

### Option A: Top-Level Function with Context (`function`)

A top-level `function` declaration decorated with `@choreography`. Top-level functions in Zena are never closures, making them ideal containers for static protocol graphs:

```zena
@choreography
export function orderProcess(c: Choreo) {
  c.transfer<Buyer, Seller, OrderDetails>();
  c.transfer<Seller, Buyer, Quote>();
  c.branch(
    Buyer,
    (quote: Quote) => quote.price <= 100,
    {
      then: (c) => {
        c.transfer<Buyer, Gateway, Payment>();
        c.transfer<Gateway, Seller, PaymentReceipt>();
      },
      else: (c) => {
        c.transfer<Buyer, Seller, CancelNotice>();
      }
    }
  );
}
```

- **Pros**: Native Zena syntax; uses ordinary statements and block scoping.
- **Cons**: The imperative function body (`c.transfer(...)`) is evaluated sequentially to construct the protocol AST.

---

### Option B: Exported Record / Data Literal (Declarative Builder)

Instead of imperative function statements, the choreography is declared directly as an exported top-level record literal. This aligns directly with **Declarative Zena** (used for config files, build manifests, and HTML templates):

```zena
export let orderProcess = choreography({
  roles: [Buyer, Seller, Gateway],
  steps: [
    send(Buyer, Seller, OrderDetails),
    send(Seller, Buyer, Quote),
    branch(Buyer, (quote: Quote) => quote.price <= 100, {
      then: [
        send(Buyer, Gateway, Payment),
        send(Gateway, Seller, PaymentReceipt),
      ],
      else: [
        send(Buyer, Seller, CancelNotice),
      ],
    }),
  ],
});
```

- **Pros**:
  - **Statically Analyzable**: The protocol is a pure data structure DAG without arbitrary execution side-effects.
  - **Tooling Friendly**: Easy to generate Mermaid sequence diagrams, WIT interface bindings, or security boundary audits directly from the record structure at compile time.
  - **Zero Macro Magic**: `choreography(...)` can simply be a generic type-checked builder function returning a protocol graph object.

---

### Option C: Whole Module as Container (`protocol.zena`)

An entire Zena module can serve as the choreography container. Top-level declarations in `protocol.zena` describe roles, channels, and interaction steps:

```zena
// protocol.zena — The Module IS the Choreography Container
import {role, step, branch} from 'zena:choreography';

export let Buyer = role('Buyer');
export let Seller = role('Seller');
export let Gateway = role('Gateway');

export let flow = [
  step(Buyer, Seller, OrderDetails),
  step(Seller, Buyer, Quote),
  branch(Buyer, (q: Quote) => q.price <= 100, ...),
];
```

In `buyer_main.zena`:

```zena
import {flow, Buyer} from './protocol';
import {projectEndpoint} from 'zena:choreography';

export async function main(chan: Own<Channel>): Future<void> {
  let buyerEndpoint = projectEndpoint(flow, Buyer);
  await buyerEndpoint.run(chan);
}
```

---

### Comparison of Structural Options

| Container Choice                 | Zena Syntax                                     | Static Analyzability                              | Macro Requirement                            |
| :------------------------------- | :---------------------------------------------- | :------------------------------------------------ | :------------------------------------------- |
| **Top-Level `function`**         | `export function orderProcess(c: Choreo)`       | Medium (requires AST inspection of function body) | High (requires `@choreography` decorator)    |
| **Record Literal (Declarative)** | `export let orderProcess = choreography({...})` | **Highest** (pure data structure AST)             | **Low** (can be library-only or light macro) |
| **Whole Module Scope**           | `protocol.zena` exports                         | High (module-level declarations)                  | Medium                                       |

### Alignment with Declarative Zena (`docs/design/declarative.md`)

Using **Record Literals (Option B)** or **Module Containers (Option C)** fits directly into Zena's **Declarative Architecture** ([declarative.md](declarative.md)):

1. **The Static Graph Guarantee**: A choreography evaluates at `comptime` to produce a static, serializable **Interaction Graph (DAG)**. Endpoint Projection (EPP) is then a pure function mapping `InteractionGraph × Role → ProjectedStateMachine`.
2. **Visual Tooling & The Overlay Protocol (`.zlayout`)**: Complex WASI component graphs and microservice topologies can be rendered visually in workflow editors. Machine-generated layout positions, debug flags, or node routing overrides are stored in `.zlayout` files without mutating the underlying Zena choreography code.
3. **Decoupled Business Logic**: The choreography defines _what types and choices flow between roles_, while individual WASI component entrypoint files (`buyer_main.zena`, `seller_main.zena`) supply local compute implementation hooks.

---

## 6. Concrete Code Sketch: A End-to-End Example

Here is how a complete Choreography definition and component implementation looks in Zena:

### Step 1: The Protocol (`order_protocol.zena`)

```zena
import {Channel, Own, Send, Recv, End, Select} from 'zena:session';

// Data types
export class Order { item: String; amount: i32; new(this.item, this.amount); }
export class Receipt { id: String; new(this.id); }

// Global projected interface contracts for Buyer and Seller
export type BuyerChan = Send<Order, Recv<Receipt, End>>;
export type SellerChan = Recv<Order, Send<Receipt, End>>;

// Workflow runner for Buyer
export async function executeBuyer(
  chan: Own<BuyerChan>,
  order: Order
): Future<Receipt> {
  // Step 1: Send Order (consumes chan, returns c1)
  let c1 = await chan.send(order);

  // Step 2: Recv Receipt (consumes c1, returns receipt + c2)
  let (receipt, c2) = await c1.recv();

  // Step 3: Close channel
  c2.close();

  return receipt;
}

// Workflow runner for Seller
export async function executeSeller(
  chan: Own<SellerChan>,
  fulfillOrder: (o: Order) => Future<Receipt>
): Future<void> {
  let (order, c1) = await chan.recv();
  let receipt = await fulfillOrder(order);
  let c2 = await c1.send(receipt);
  c2.close();
}
```

### Step 2: Buyer Component Entrypoint (`buyer_main.zena`)

```zena
import {executeBuyer, Order} from './order_protocol';
import {connectToSeller} from 'zena:wasi-network';

export function main(): i32 {
  let chan = connectToSeller();
  let order = new Order('Laptop', 1200);

  // Execute projected choreography role
  let receiptFuture = executeBuyer(chan, order);

  // Async microtask executor handles suspension
  return 0;
}
```

---

## 7. Summary & Roadmap

Choreographic Programming is not an isolated paradigm; it is the natural convergence of Zena's core features:

```
  Zena Ownership (Own<T>) ──┐
                            ├─► Session-Typed Choreographies ──► Deadlock-Free WASI Component Graphs
  Zena Async (Future<T>) ───┘
```

### Next Steps:

1. **Phase 1 (Library Level)**: Implement `zena:session` in stdlib using `Own<T>` for affine session channels.
2. **Phase 2 (WASI Transport)**: Connect `zena:session` channels to WASI 0.3 stream/future handles.
3. **Phase 3 (Macro / Generator Tooling)**: Design a `#choreography` macro or CLI preprocessor for automatic Endpoint Projection (EPP).
