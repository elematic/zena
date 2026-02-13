# Formal Verification and Proof Assistants for Zena

This document explores what it would mean to integrate formal verification and
proof assistant capabilities into Zena—building on the contracts discussed in
[ai-first-language.md](./ai-first-language.md) and taking them further.

## Table of Contents

1. [Introduction: What Is Formal
   Verification?](#introduction-what-is-formal-verification)
2. [The Verification Spectrum](#the-verification-spectrum)
3. [Survey of Verification-Aware
   Languages](#survey-of-verification-aware-languages)
4. [What Would It Mean to Prove Zena Code
   Correct?](#what-would-it-mean-to-prove-zena-code-correct)
5. [Key Concepts](#key-concepts)
6. [Design Options for Zena](#design-options-for-zena)
7. [AI and Formal Verification](#ai-and-formal-verification)
8. [Recommendations](#recommendations)

---

## Introduction: What Is Formal Verification?

**Formal verification** is the use of mathematical techniques to prove that a
program satisfies a specification. Unlike testing (which shows the presence of
bugs) or type checking (which catches a limited class of errors), formal
verification can prove the _absence_ of entire categories of bugs.

### Testing vs. Types vs. Proofs

| Approach          | What It Checks                                   | Guarantee                      |
| ----------------- | ------------------------------------------------ | ------------------------------ |
| **Testing**       | Specific inputs produce expected outputs         | "Works for these cases"        |
| **Types**         | Values have correct shapes, operations are valid | "Won't crash with type errors" |
| **Contracts**     | Preconditions/postconditions at runtime          | "Fails fast if violated"       |
| **Formal Proofs** | Mathematical properties hold for ALL inputs      | "Correct by construction"      |

Consider a function that computes the maximum element of an array:

```zena
// Testing: Check specific cases
test "max of [1, 3, 2]" { assert(max([1, 3, 2]) == 3); }

// Types: Ensure we return the right type
let max = (arr: array<i32>): i32 => { ... };

// Contracts: Check properties at runtime
let max = (arr: array<i32>): i32
  requires arr.length > 0
  ensures result >= arr[0]  // But this doesn't prove it's the MAXIMUM!
=> { ... };

// Formal proof: Prove it's actually the maximum
let max = (arr: array<i32>): i32
  requires arr.length > 0
  ensures forall i: i32 :: 0 <= i && i < arr.length ==> result >= arr[i]
  ensures exists i: i32 :: 0 <= i && i < arr.length && result == arr[i]
=> { ... };
```

The formal specification says: "The result is greater than or equal to every
element, AND the result equals some element." That's what "maximum" actually
means—and a proof assistant can verify the implementation satisfies this.

### What Is a Proof Assistant?

A **proof assistant** (also called an **interactive theorem prover**) is a
software tool that helps users construct mathematical proofs. The "assistant"
part means it's interactive—the human guides the proof, and the tool checks each
step is valid and handles routine details automatically.

Key components:

- **Specification language**: A way to express what you want to prove
- **Proof language**: A way to write proofs (tactics, terms, or both)
- **Proof checker**: A small, trusted core that verifies proofs are valid
- **Automation**: Tactics and solvers that handle routine proof steps

The key insight: **proofs are programs, and programs are proofs** (the
Curry-Howard correspondence). A proof that "for all natural numbers n, n + 0 =
n" is structurally identical to a program that, given any n, produces evidence
of this equality.

---

## The Verification Spectrum

There's a spectrum from "no verification" to "fully verified," and different
points make different trade-offs:

### Level 0: Dynamic Languages (Python, JavaScript)

- No compile-time type checking
- Errors discovered at runtime
- Fast iteration, fragile at scale

### Level 1: Static Types (TypeScript, Java)

- Compiler catches type mismatches
- Still allows null pointer errors, array bounds errors, logic bugs
- Good balance for most applications

### Level 2: Rich Types + Exhaustiveness (Rust, Zena today)

- Non-nullable by default
- Exhaustive pattern matching
- Ownership/borrowing (Rust) prevents data races
- Catches more bugs, but not logic errors

### Level 3: Runtime Contracts (Eiffel, Zena with `requires`/`ensures`)

- Preconditions and postconditions checked at runtime
- Documents intent, catches violations early
- No compile-time guarantee the contracts hold

### Level 4: Static Contract Verification (SPARK, Dafny)

- Compiler/verifier proves contracts hold for ALL inputs
- Requires loop invariants, additional annotations
- Catches logic errors at compile time

### Level 5: Dependent Types + Proof Terms (Lean, F\*, Rocq)

- Types can depend on values (`array<n>` where `n` is a specific number)
- Proofs are first-class values
- Can prove arbitrary mathematical properties
- Steeper learning curve, but maximum assurance

**The question for Zena**: How far along this spectrum should we go?

---

## Survey of Verification-Aware Languages

### Dafny (Microsoft Research)

**Philosophy**: Verification-aware programming—write code and proofs together.

**Key Features**:

- Familiar imperative syntax (looks like C#/Java)
- Ghost code for specification (erased at runtime)
- Automatic verification via SMT solver (Z3)
- Compiles to C#, Java, JavaScript, Go, Python

**Example**:

```dafny
method Max(arr: array<int>) returns (max: int)
  requires arr.Length > 0
  ensures forall j :: 0 <= j < arr.Length ==> max >= arr[j]
  ensures exists j :: 0 <= j < arr.Length && max == arr[j]
{
  max := arr[0];
  var i := 1;
  while i < arr.Length
    invariant 1 <= i <= arr.Length
    invariant forall j :: 0 <= j < i ==> max >= arr[j]
    invariant exists j :: 0 <= j < i && max == arr[j]
  {
    if arr[i] > max { max := arr[i]; }
    i := i + 1;
  }
}
```

**Strengths**: Accessible to mainstream programmers, good automation, practical
for real systems.

**Weaknesses**: Loop invariants can be tedious, SMT solvers can time out on
complex proofs, limited expressiveness compared to dependent types.

**Relevance to Zena**: Closest model for "verification for working programmers."
The syntax and workflow could translate well.

---

### SPARK (Ada subset)

**Philosophy**: High-integrity systems where failure is unacceptable.

**Key Features**:

- Subset of Ada designed for formal verification
- Information flow analysis (tracks what data affects what)
- Absence of runtime errors provable (no buffer overflows, division by zero)
- Used in aerospace, rail, defense

**Example**:

```ada
procedure Increment (X : in out Counter_Type)
  with Global  => null,
       Depends => (X => X),
       Pre     => X < Counter_Type'Last,
       Post    => X = X'Old + 1;
```

**Strengths**: Proven in critical industries (jet engines, nuclear plants),
excellent tooling (GNATprove), can verify absence of runtime errors without full
functional specs.

**Weaknesses**: Ada syntax unfamiliar to most, designed for embedded systems
rather than general programming, verbose.

**Relevance to Zena**: The "information flow" concept (tracking which outputs
depend on which inputs) is interesting. The `Global` and `Depends` annotations
prevent hidden side effects.

---

### F\* (Microsoft Research + Inria)

**Philosophy**: Proof-oriented programming with effects.

**Key Features**:

- ML-family functional language
- Dependent types for expressive specifications
- Effect system tracks side effects precisely
- Extracts to OCaml, F#, C, WebAssembly
- Used to build verified cryptographic libraries (HACL\*, EverCrypt)

**Example**:

```fstar
val factorial: n:nat -> Tot (r:nat{r >= 1})
let rec factorial n =
  if n = 0 then 1
  else n * factorial (n - 1)
```

The type `r:nat{r >= 1}` is a _refinement type_—an integer that's also proven to
be at least 1.

**Strengths**: Very expressive, excellent effect tracking, production-proven for
cryptography, compiles to efficient C code.

**Weaknesses**: Steep learning curve, functional paradigm may feel foreign,
requires significant expertise.

**Relevance to Zena**: The effect system and refinement types are interesting.
F\*'s ability to extract efficient C (and WASM!) makes it relevant for Zena's
performance goals.

---

### Lean 4 (Microsoft Research / Lean FRO)

**Philosophy**: A single language for programming AND theorem proving.

**Key Features**:

- Dependent type theory (Calculus of Constructions)
- Powerful tactic system for proof automation
- Metaprogramming in Lean itself
- Active mathematical community (Mathlib has 210,000+ theorems)
- AI integration (AlphaProof, DeepSeek-Prover)

**Example**:

```lean
def factorial : Nat → Nat
  | 0 => 1
  | n + 1 => (n + 1) * factorial n

theorem factorial_pos : ∀ n, factorial n > 0 := by
  intro n
  induction n with
  | zero => simp [factorial]
  | succ n ih => simp [factorial]; omega
```

**Strengths**: Beautiful unified language, excellent metaprogramming, strong
community, AI integration advancing rapidly.

**Weaknesses**: Steep learning curve, more suited to mathematics than systems
programming, less focus on imperative code.

**Relevance to Zena**: The AI integration is fascinating—Lean proofs can be
generated by AI models. Lean 4 also compiles to efficient code, showing
verification and performance aren't incompatible.

---

### Comparison Table

| Language   | Paradigm              | Verification Method | Automation | Learning Curve | Industry Use          |
| ---------- | --------------------- | ------------------- | ---------- | -------------- | --------------------- |
| **Dafny**  | Imperative/Functional | SMT solver          | High       | Medium         | Growing               |
| **SPARK**  | Imperative            | SMT + flow analysis | High       | Medium         | Aerospace, Defense    |
| **F\***    | Functional            | SMT + tactics       | Medium     | High           | Cryptography          |
| **Lean 4** | Functional            | Tactics + SMT       | Medium     | High           | Mathematics, emerging |

---

## What Would It Mean to Prove Zena Code Correct?

### Beyond Contracts

Contracts (as discussed in [ai-first-language.md](./ai-first-language.md)) are
the starting point:

```zena
let withdraw = (account: Account, amount: i32): Account
  requires amount > 0
  requires account.balance >= amount
  ensures result.balance == account.balance - amount
=> { ... };
```

But contracts alone are just _claims_. Proving code correct means the compiler
_verifies_ these claims hold for all possible inputs.

### What Can Be Proven?

**1. Absence of Runtime Errors**

- No null pointer dereferences (already handled by non-nullable types)
- No array index out of bounds
- No integer overflow (or proven overflow is intentional)
- No division by zero

**2. Functional Correctness**

- The output satisfies the postcondition for all inputs satisfying the
  precondition
- Example: "sort returns a sorted array containing the same elements"

**3. Termination**

- The function always terminates (doesn't loop forever)
- Proven via _decreases_ clauses (loop variants)

**4. Information Flow**

- Secret data doesn't leak to public outputs
- Relevant for security-critical code

**5. Resource Bounds**

- Memory usage bounded by some function of input size
- Execution time bounded (important for real-time systems)

### What Does a Proof Look Like?

For simple properties, the verifier handles everything automatically:

```zena
let abs = (x: i32): i32
  ensures result >= 0
=> if (x >= 0) { x } else { -x };
// SMT solver: "In both branches, result >= 0. QED."
```

For loops, you need **invariants**—properties that hold at every iteration:

```zena
let sum = (arr: array<i32>): i32
  ensures result == sumOf(arr)  // sumOf is a mathematical spec function
=> {
  var total = 0;
  for (var i = 0; i < arr.length; i = i + 1)
    invariant total == sumOf(arr[0..i])  // Partial sum so far
  {
    total = total + arr[i];
  }
  return total;
};
```

For recursive functions, you need **decreases clauses**:

```zena
let factorial = (n: i32): i32
  requires n >= 0
  ensures result >= 1
  decreases n  // Proves termination: n gets smaller each call
=> {
  if (n == 0) { 1 }
  else { n * factorial(n - 1) }
};
```

For complex proofs, you write **lemmas**—helper theorems:

```zena
lemma reversePreservesLength<T>(list: List<T>)
  ensures list.reverse().length == list.length
{
  match (list) {
    case Nil: // trivial
    case Cons(head, tail): {
      reversePreservesLength(tail);  // Inductive hypothesis
      // ... rest follows
    }
  }
}
```

---

## Key Concepts

### Refinement Types

A refinement type is a base type plus a predicate that values must satisfy:

```zena
type PositiveInt = i32 where self > 0;
type BoundedIndex<n> = i32 where self >= 0 && self < n;
type SortedArray<T> = array<T> where isSorted(self);
```

These are more expressive than simple types but less powerful than full
dependent types. The verifier checks that values placed in refinement types
actually satisfy the predicate.

### Ghost Code

Ghost code exists only for specification—it's erased at compile time:

```zena
let binarySearch = (arr: array<i32>, target: i32): i32
  requires isSorted(arr)  // Ghost precondition
  ensures result == -1 || arr[result] == target
=> {
  var lo = 0;
  var hi = arr.length;

  while (lo < hi)
    invariant 0 <= lo && lo <= hi && hi <= arr.length
    ghost invariant forall j :: 0 <= j < lo ==> arr[j] < target
    ghost invariant forall j :: hi <= j < arr.length ==> arr[j] > target
  {
    // ... implementation
  }
};
```

Ghost code lets you write rich specifications without runtime cost.

### Loop Invariants

A loop invariant is a property that:

1. Holds before the loop starts
2. Is preserved by each iteration
3. Combined with the loop exit condition, implies the postcondition

This is the most common source of annotation burden in verified code.

### Termination and Decreases Clauses

To prove a loop or recursion terminates, you specify a _measure_ that decreases
on each iteration and is bounded below:

```zena
let gcd = (a: i32, b: i32): i32
  requires a > 0 && b > 0
  decreases b  // b decreases and is bounded below by 0
=> {
  if (b == 0) { a }
  else { gcd(b, a % b) }
};
```

### SMT Solvers

Most verification tools use **SMT solvers** (Satisfiability Modulo Theories)
like Z3, CVC5, or Alt-Ergo. These are automated theorem provers that can decide
whether a logical formula is satisfiable.

**How it works**:

1. Compiler translates code + specs into logical formulas
2. SMT solver tries to find a counterexample
3. If no counterexample exists, the property is proven
4. If a counterexample exists, it's reported as a bug

**Limitations**:

- SMT solvers can time out on complex formulas
- Some properties are undecidable
- Quantifiers (forall, exists) are hard

### Tactics and Interactive Proving

When automation fails, you need manual proof guidance. **Tactics** are commands
that transform proof goals:

```lean
theorem add_comm : ∀ n m : Nat, n + m = m + n := by
  intro n m       -- Assume n and m
  induction n     -- Proof by induction on n
  · simp          -- Base case: 0 + m = m + 0, trivial
  · simp [*]      -- Inductive case: use inductive hypothesis
```

The tactic language lets experts guide proofs while automation handles routine
steps.

---

## Design Options for Zena

### Option 1: Dafny-Style Verification

**Approach**: Contracts verified by SMT solver. Looks like normal code with
extra annotations.

```zena
let max = (arr: array<i32>): i32
  requires arr.length > 0
  ensures forall i :: 0 <= i < arr.length ==> result >= arr[i]
  ensures exists i :: 0 <= i < arr.length && result == arr[i]
=> {
  var max = arr[0];
  for (var i = 1; i < arr.length; i = i + 1)
    invariant forall j :: 0 <= j < i ==> max >= arr[j]
    invariant exists j :: 0 <= j < i && max == arr[j]
  {
    if (arr[i] > max) { max = arr[i]; }
  }
  return max;
};
```

**Pros**:

- Familiar syntax for imperative programmers
- High automation for many properties
- Gradual adoption (verify critical functions first)

**Cons**:

- Loop invariants are tedious
- SMT timeouts on complex proofs
- Limited expressiveness

### Option 2: Refinement Types

**Approach**: Enrich the type system with predicates. Less annotation burden
than full contracts for common patterns.

```zena
type NonEmpty<T> = array<T> where self.length > 0;
type Sorted<T: Ord> = array<T> where isSorted(self);
type Bounded<lo: i32, hi: i32> = i32 where lo <= self && self < hi;

let binarySearch = (arr: Sorted<i32>, target: i32): i32 | -1 => {
  // arr is statically known to be sorted
  // ...
};
```

**Pros**:

- Types document and enforce properties
- Less verbose than explicit contracts
- Composes well

**Cons**:

- Predicate inference is limited
- Some properties don't fit the type mold
- Subtyping complexity

### Option 3: Hybrid Approach (Recommended)

**Approach**: Multiple levels of verification, each appropriate for different
needs:

**Level 1: Runtime Contracts** (always available)

```zena
let withdraw = (account: Account, amount: i32): Account
  requires amount > 0
  requires account.balance >= amount
=> { ... };
```

Preconditions checked at runtime. Documents intent, catches bugs early.

**Level 2: Verified Contracts** (opt-in per module/function)

```zena
@verify
let withdraw = (account: Account, amount: i32): Account
  requires amount > 0
  requires account.balance >= amount
  ensures result.balance == account.balance - amount
=> { ... };
```

Compiler proves postconditions hold. Requires loop invariants etc.

**Level 3: Refinement Types** (for common patterns)

```zena
type Money = i32 where self >= 0;
type NonEmptyArray<T> = array<T> where self.length > 0;

let sum = (arr: NonEmptyArray<Money>): Money => { ... };
```

Types carry lightweight proofs. Verified automatically where possible.

**Level 4: Lemmas and Proofs** (for complex properties)

```zena
@proof
lemma sortPreservesElements<T>(arr: array<T>)
  ensures arr.sort().toSet() == arr.toSet()
{
  // Proof by induction...
}
```

Full proof language for when automation isn't enough.

### Option 4: External Proof Assistant

**Approach**: Keep Zena simple, use a separate tool for verification.

Generate Lean/Dafny/F\* from Zena code, prove properties there, link proofs back
to Zena.

**Pros**:

- Simpler core language
- Use best-in-class proof tools
- Proofs don't clutter code

**Cons**:

- Tooling complexity
- Translation correctness is a concern
- Friction slows adoption

---

## AI and Formal Verification

This is where things get exciting for an AI-first language.

### AI Can Generate Proofs

Recent breakthroughs show AI can generate formal proofs:

- **AlphaProof** (Google DeepMind, 2024): Solved IMO problems at silver medal
  level by generating Lean proofs
- **DeepSeek-Prover** (2025): Automated theorem proving in Lean 4
- **OpenAI/Meta** (2022): Generated proofs for olympiad problems

The workflow: AI generates proof candidates, proof assistant checks them. The
proof assistant's trusted kernel means we don't have to trust the AI—only the
(small, verified) checker.

### Why This Matters for Zena

1. **AI writes contracts**: Given a function, AI can propose
   `requires`/`ensures` clauses. The verifier checks if they hold.

2. **AI fills in loop invariants**: The tedious part of verification. AI can
   propose invariants, verifier confirms.

3. **AI generates proofs for lemmas**: When automation fails, AI can write
   tactic-style proofs.

4. **Verification checks AI-generated code**: AI generates implementations, the
   verifier ensures they match specs. Trust the spec, verify the code.

### The Flywheel

```
Human writes spec (what the code should do)
    ↓
AI generates implementation
    ↓
Verifier checks implementation matches spec
    ↓
If fails: AI refines implementation
If succeeds: Code is provably correct
```

This is the dream: **specifications are the new programming**. Humans say what,
AI figures out how, verifier ensures correctness.

### Current Limitations

- AI proofs are best for well-understood domains (math, algorithms)
- Novel properties still need human insight
- Specification errors propagate (garbage in, garbage out)
- Training data for verification languages is limited

---

## Recommendations

### Near-Term (2026-2027)

1. **Implement runtime contracts** (`requires`, `ensures`, `invariant`)
   - Checked at runtime (like current Zena error handling)
   - Documents intent, catches bugs early
   - Foundation for future verification

2. **Add simple refinement types**
   - `type Positive = i32 where self > 0`
   - Compiler proves simple predicates automatically
   - Subsumption checking via SMT

3. **Static analysis for common errors**
   - Array bounds checking with known lengths
   - Integer overflow detection
   - Nullability (already done)

### Medium-Term (2027-2028)

4. **Optional static verification**
   - `@verify` annotation opts functions into verification
   - Requires loop invariants, termination proofs
   - Use Z3 or similar SMT solver

5. **Ghost code support**
   - Specification-only functions and variables
   - Erased at compile time
   - Enables rich specifications without runtime cost

6. **Integration with AI assistants**
   - AI suggests contracts based on function names and bodies
   - AI proposes loop invariants
   - Verifier validates suggestions

### Long-Term (2028+)

7. **Proof language for complex properties**
   - Lemmas, induction, case analysis
   - May require tactic language
   - Consider Lean-like approach

8. **Explore dependent types**
   - `array<n>` where `n` is a value
   - `Vec<T, n>` with length in type
   - Significant language complexity

9. **Certified compiler**
   - Prove the compiler preserves semantics
   - Extremely ambitious, but ideal for WASM-GC

---

## Conclusion

Formal verification represents a fundamental shift from "testing shows
correctness for some inputs" to "proof shows correctness for all inputs." For an
AI-first language, this is particularly powerful: AI generates code, proofs
verify it, humans specify intent.

Zena doesn't need to become Lean or F\*. The Dafny model—verification-aware
imperative programming with SMT automation—fits Zena's philosophy better. Start
with runtime contracts, add static verification gradually, and let AI assistance
lower the annotation burden.

The goal: **make verified code feel like regular code**, with AI handling the
proof obligations that humans find tedious.

---

## Further Reading

- [Dafny Tutorial](https://dafny.org/latest/OnlineTutorial/guide)
- [SPARK User's Guide](https://docs.adacore.com/spark2014-docs/html/ug/)
- [F\* Tutorial](https://fstar-lang.org/tutorial/)
- [Lean 4 Documentation](https://lean-lang.org/doc/reference/latest/)
- [Program Proofs](https://mitpress.mit.edu/9780262546232/program-proofs/)
  (Leino, MIT Press)
- [Software Foundations](https://softwarefoundations.cis.upenn.edu/) (free
  online textbook)
