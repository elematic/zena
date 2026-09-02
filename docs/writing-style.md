# Writing Style

How to write prose in this project: design documents, commit messages, PR
descriptions, and code comments. Much of this text is written by AI agents,
and several rules here exist to counter habits common in AI writing.

## Voice

Write plain technical prose, like a note to a colleague. Be brief: if a
sentence can be cut without losing information, cut it.

Avoid marketing language ("powerful", "seamless", "robust", "blazing fast").
Describe what a thing does and let the reader judge it.

Avoid rhetorical flourishes that emphasize through contrast or cadence
rather than content:

- "Not X. Y." / "This isn't X — it's Y."
- "No X, no Y, no Z — just W."
- Aphorisms and slogans ("Recovering is not excusing.")
- One-word verdict sentences ("Simple.", "Done.")

Say the thing directly instead. "This is not a workaround, it's the real
fix" becomes "This fixes the root cause."

Skip intensifiers that signal importance without adding information:
"critically", "importantly", "the key insight", "load-bearing". If a fact
matters, lead with it.

Do not correct a belief you have not given the reader. "Not merely
imprecise", "contrary to what you might expect", "it is not, actually"
and "this is more than just X" all presuppose the reader arrived holding
a wrong view, and the reader usually did not. State what is true and
stop:

- "Both directions were wrong, not merely imprecise." → "Parsing and
  printing both returned incorrect results."
- "This is not just a size win — it is also faster." → "It is smaller
  and faster."

Anticipating a misreading is worth doing when the misreading is likely
and specific, but say so plainly and say why: "Writing `2^(e-1)` gives
the width in units of the lower binade's ulp" beats "the natural
misreading".

Do not coin a phrase and then explain what it means ("consumption is
the release", "the flip", "the honest version"). State the rule or fact
in plain words the first time. Introduce a new term only when it will
be used repeatedly afterward, and define it where it first appears. The
same goes for figurative verbs standing in for plain ones: "what the
annotation purchases" is "what the annotation allows".

Argue only against positions someone could actually hold. "Requiring
the await is sounder and cheaper than synthesizing release glue" sets
up a comparison the reader never proposed; if no alternative is on the
table, state what the design does and why it works. When a real
alternative was considered and rejected, name it as such.

## Self-contained documents

A document should make sense to someone who has only the repository — not
the conversation, plan, or working context it was written in. Phrases like
"as discussed", "per the plan", or "the previous approach" usually mean
context is missing.

- Define terms before using them.
- If a document depends on a plan, milestone, or alternative described
  elsewhere, either summarize it inline or link the document that defines
  it. Never assume the reader knows internal shorthand or roadmap labels.
- Name the thing. A general word standing in for something specific —
  "both directions", "the mechanism", "the one gap", "this behaviour" —
  reads as precise to the author, who knows the referent, and as vague
  to everyone else. Write the referent out at least once per section,
  even when it makes the sentence longer:
  - "the `p` range both directions index" → "printing indexes `p` over
    `[-292, 324]` and parsing over `[-344, 309]`"
  - "the mechanism was general" → "`mv_get` already worked for any
    producer"
  - "which is what says the flag is the only thing that decides" →
    "a lowering that ignored the flag fails one of the two"

  This applies hardest to the first sentence of a section, where the
  reader has the least context to resolve a pronoun or a category noun
  against.

## Design documents

- Headings are noun phrases: "Overview", "Detailed design", "Alternatives
  considered". Avoid full sentences and questions as headings. Deeply
  nested sections (h3–h5) can be more specific ("Erasure of generic
  function values") but stay noun phrases.
- Avoid Q&A framing (posing a question as a heading and answering it below).
- A surprising claim needs evidence in the document: a measurement, a
  reproduction, a link to an upstream issue. An assertion alone is not
  enough.
- Cut findings that were never in doubt; report what a reader would not
  have predicted.

## Commit messages and PR descriptions

- Say what was done, concisely. A short title (scope tags like
  `[zena-compiler]` are fine), then a body only if the change needs
  explanation beyond the diff.
- Describe the change, not the process. Leave out how the work unfolded
  ("after investigating...", "first tried...").
- Refer to work by what it does, never by plan step or roadmap label —
  plan documents change, commits are permanent. Write "waits on move
  checking", not "(O2)".

## Code comments

A comment states what the code cannot: a constraint, an invariant, the
reason for a non-obvious choice. Comments that restate the next line, or
that describe the change relative to an old version ("now handles X"),
belong in the commit message or nowhere. Formatting conventions for
comments are in `AGENTS.md` under Coding Standards.
