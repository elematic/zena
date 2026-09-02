/**
 * Sidebar configuration, keyed by URL prefix.
 *
 * This doubles as the site's content plan: every leaf carries the `outline` of
 * sections the page is meant to cover, which `npm run scaffold -w
 * @zena-lang/website` turns into placeholder pages. Keep the outlines honest —
 * they are the spec for a page that isn't written yet.
 *
 * Group shape: `{text, collapsed?, items}`. A group renders collapsed unless it
 * contains the current page; `collapsed: false` pins it open.
 */

const guide = [
  {
    text: 'Introduction',
    items: [
      {
        text: 'What is Zena?',
        link: '/guide/what-is-zena/',
        outline: [
          'Built for Wasm GC',
          'How it compares',
          'What it looks like',
          'Where the project stands',
        ],
      },
      {
        text: 'Why Zena?',
        link: '/guide/why-zena/',
        outline: [
          'The Wasm GC gap',
          'Nothing in your module but your code',
          'Compilation fast enough to stay in the loop',
          'Correctness',
          'Familiar to humans and to agents',
          'Why WebAssembly at all',
          'No users is a superpower',
          'Where Zena fits',
        ],
      },
      {
        text: 'Language Overview',
        link: '/guide/overview/',
        outline: [
          'Values and variables',
          'Functions',
          'Types',
          'Classes',
          'Pattern matching',
          'Collections',
          'Errors',
          'Libraries',
          'Borrowed from other languages',
        ],
      },
      {
        text: 'Getting Started',
        link: '/guide/getting-started/',
        outline: [
          'Install the toolchain',
          'Create a project',
          'Build and run',
          'Editor setup',
          'Next steps',
        ],
      },
      {
        text: 'Your First Program',
        link: '/guide/first-program/',
        outline: [
          'Hello, world',
          'Adding a function',
          'Types and inference',
          'Reading input',
          'Compiling to Wasm',
        ],
      },
    ],
  },
  {
    text: 'Language Basics',
    items: [
      {
        text: 'Values and Variables',
        link: '/guide/values-and-variables/',
        outline: [
          'let and var',
          'Local and module variables',
          'Type annotations and inference',
          'Destructuring',
        ],
      },
      {
        text: 'Types',
        link: '/guide/types/',
        outline: [
          'Type system overview',
          'Taxonomy of types',
          'Type annotations',
          'Primitives, references, and boxing',
          'Nominal and structural types',
          'Generics',
          'Unions and nullability',
          'Type aliases, distinct types, and opaque types',
          'Type operators',
        ],
      },
      {
        text: 'Functions',
        link: '/guide/functions/',
        outline: [
          'Top-level functions and arrow functions',
          'Parameters and arguments',
          'Return types and multi-value returns',
          'Function types and compatibility',
          'Function and method overloading',
          'Generators and async functions',
        ],
      },
      {
        text: 'Classes',
        link: '/guide/classes/',
        outline: [
          'Declaring a class and fields',
          'Constructors and initialization',
          'Methods and accessors',
          'Case classes and sealed hierarchies',
          'Interfaces and mixins',
          'Extension classes',
          'Inheritance and overriding',
          'Operator overloading',
          'Performance and dispatch',
        ],
      },
      {
        text: 'Control Flow',
        link: '/guide/control-flow/',
        outline: [
          'Expression orientation',
          'Conditionals with if and else',
          'Loops and iteration',
          'Multi-branch selection with match',
          'Jump statements and unwinding',
        ],
      },
      {
        text: 'Pattern Matching',
        link: '/guide/pattern-matching/',
        outline: [
          'Irrefutable patterns and destructuring',
          'Refutable patterns and match expressions',
          'Pattern taxonomy',
          'Pattern guards',
        ],
      },
      {
        text: 'Collections',
        link: '/guide/collections/',
        outline: [
          'FixedArray and Array',
          'Maps and Sets',
          'Iterating',
          'Choosing a collection',
        ],
      },
      {
        text: 'Errors',
        link: '/guide/errors/',
        outline: [
          'Throwing and catching',
          'try as an expression',
          'Errors versus result values',
          'When to use which',
        ],
      },
      {
        text: 'Async Programming',
        link: '/guide/async/',
        outline: [
          'The async/await model',
          'Execution model: Eager start and concurrency',
          'Async main',
          'Futures and combinators',
          'Structured cancellation',
        ],
      },
      {
        text: 'Resources and Ownership',
        link: '/guide/resources/',
        outline: [
          'Managed resources vs ordinary objects',
          'The Disposable protocol',
          'Deterministic cleanup with using',
          'Resource classes and affine types',
          'Handles: Own, Borrow, and Unmanaged',
          'Second-class borrows without lifetimes',
          'Regime transitions: disown and adopt',
        ],
      },
      {
        text: 'Libraries',
        link: '/guide/libraries/',
        outline: [
          'A library is a directory',
          'Imports and exports',
          'Using the standard library',
          'Depending on other packages',
        ],
      },
    ],
  },
  {
    text: 'Core Concepts',
    collapsed: true,
    items: [
      {
        text: 'The Type System',
        link: '/guide/type-system/',
        outline: [
          'Goals',
          'Assignability and subtyping',
          'Narrowing',
          'Variance',
          'What Zena deliberately leaves out',
        ],
      },
      {
        text: 'Correctness and Safety',
        link: '/guide/correctness/',
        outline: [
          'What "sound" means',
          'Where TypeScript gives up soundness',
          'What Zena does instead',
          'Memory safety without a borrow checker',
          'The cost of soundness',
        ],
      },
      {
        text: 'WebAssembly',
        link: '/guide/web-assembly/',
        outline: [
          'Wasm GC in one page',
          'How Zena values map to Wasm types',
          'What is heap-allocated',
          'Linear memory and when you need it',
        ],
      },
      {
        // Absorbed the old "Binary Size" page: compile-time cost, run-time
        // cost, and output size are the same subject and kept cross-linking.
        text: 'Performance',
        link: '/guide/performance/',
        outline: [
          'What each construct costs',
          'Monomorphized generics',
          'Devirtualization',
          'Boxing and how to avoid it',
          'What ends up in the binary',
          'Dead code elimination',
          'Measuring',
        ],
      },
      {
        text: 'Strings and Unicode',
        link: '/guide/strings/',
        outline: [
          'One String type, several representations',
          'WTF-8 and WTF-16',
          'Slices, views, and copies',
          'Building and parsing strings',
        ],
      },
    ],
  },
  {
    text: 'Building Things',
    collapsed: true,
    items: [
      {
        text: 'Project Layout',
        link: '/guide/project-layout/',
        outline: [
          'Anatomy of a project',
          'The package manifest',
          'Source and test directories',
          'Build output',
        ],
      },
      {
        text: 'Testing',
        link: '/guide/testing/',
        outline: [
          'Writing a test',
          'Assertions',
          'Running tests',
          'Benchmarks',
        ],
      },
      {
        text: 'Editor Support',
        link: '/guide/editor-support/',
        outline: ['VS Code', 'The language server', 'Other editors'],
      },
      {
        text: 'Formatting',
        link: '/guide/formatting/',
        outline: ['zena fmt', 'Style decisions', 'Editor integration'],
      },
      {
        text: 'Working with AI Agents',
        link: '/guide/ai-agents/',
        outline: [
          'Why Zena is designed for agent feedback loops',
          'Diagnostics agents can act on',
          'Tooling hooks',
          'Practical tips',
        ],
      },
    ],
  },
  {
    text: 'Language Comparisons',
    collapsed: true,
    items: [
      {
        text: 'TypeScript',
        link: '/guide/comparisons/typescript/',
        outline: [
          'What carries over',
          'let means immutable',
          'No implicit coercion, no any escape hatch',
          'Nominal classes',
          'Cheat sheet',
        ],
      },
      {
        text: 'AssemblyScript',
        link: '/guide/comparisons/assemblyscript/',
        outline: [
          'What carries over',
          'let means immutable',
          'No implicit coercion, no any escape hatch',
          'Nominal classes',
          'Cheat sheet',
        ],
      },
      {
        text: 'Rust',
        link: '/guide/comparisons/rust/',
        outline: [
          'GC instead of ownership',
          'Matching and sealed classes',
          'Traits versus interfaces and mixins',
          'Cheat sheet',
        ],
      },
      {
        text: 'Go',
        link: '/guide/comparisons/go/',
        outline: [
          'Nominal interfaces',
          'Errors',
          'Generics',
          'Concurrency, and what Zena has instead',
          'Cheat sheet',
        ],
      },
      {
        text: 'Swift and Dart',
        link: '/guide/comparisons/swift-dart/',
        outline: [
          'Constructors and initializer lists',
          'Mixins',
          'Optionals and non-nullable references',
          'Cheat sheet',
        ],
      },
      {
        text: 'Java, Kotlin, and Scala',
        link: '/guide/comparisons/jvm/',
        outline: [
          'Classes and sealed hierarchies',
          'Case classes and pattern matching',
          'Expression orientation',
          'Cheat sheet',
        ],
      },
    ],
  },
  {
    text: 'Targets and Interop',
    collapsed: true,
    items: [
      {
        text: 'Compile Targets',
        link: '/guide/targets/',
        outline: ['host', 'wasi', 'Choosing a target', 'Feature differences'],
      },
      {
        text: 'JavaScript Interop',
        link: '/guide/javascript-interop/',
        outline: [
          'Loading a module',
          'Passing values across the boundary',
          'Strings and the host',
          'Calling back into JavaScript',
        ],
      },
      {
        text: 'WASI and Components',
        link: '/guide/wasi/',
        outline: [
          'Running under wasmtime',
          'Capabilities',
          'WIT imports and exports',
          'The component model',
        ],
      },
    ],
  },
];

const reference = [
  {
    text: 'Overview',
    items: [
      {
        text: 'Introduction',
        link: '/reference/',
        outline: [
          'How to read this reference',
          'Conventions',
          'Feature status',
        ],
      },
      {
        // The most complete page on the site: every feature with a short
        // example, written before the per-topic reference pages existed. Those
        // pages will eventually expand on sections of this one.
        text: 'Quick Reference',
        link: '/reference/quick-reference/',
      },
      {
        text: 'Lexical Structure',
        link: '/reference/lexical-structure/',
        outline: [
          'Source encoding',
          'Comments',
          'Identifiers',
          'Keywords',
          'Literals',
          'Semicolons',
        ],
      },
      {
        text: 'Program Structure',
        link: '/reference/program-structure/',
        outline: [
          'Files and libraries',
          'Top-level declarations',
          'Entry points',
          'Initialization order',
        ],
      },
    ],
  },
  {
    text: 'Declarations',
    items: [
      {
        text: 'Variables',
        link: '/reference/variables/',
        outline: [
          'let',
          'var',
          'Type annotations',
          'Definite assignment',
          'Shadowing',
        ],
      },
      {
        text: 'Functions',
        link: '/reference/functions/',
        outline: [
          'Function expressions',
          'Parameters',
          'Default and optional parameters',
          'Arity adaptation',
          'Return types',
          'Closures',
          'Top-level functions versus closures',
          'Generic functions',
        ],
      },
      {
        text: 'Type Aliases and Distinct Types',
        link: '/reference/type-aliases/',
        outline: ['type', 'distinct type', 'Generic aliases', 'Conversions'],
      },
    ],
  },
  {
    text: 'Types',
    items: [
      {
        text: 'Type System Overview',
        link: '/reference/types/',
        outline: [
          'The type hierarchy',
          'Assignability',
          'Nominal versus structural',
          'any, anyref, and never',
        ],
      },
      {
        text: 'Primitives',
        link: '/reference/primitives/',
        outline: [
          'Integers',
          'Floats',
          'boolean',
          'Numeric conversions',
          'Overflow and wrapping',
          'Special float values',
        ],
      },
      {
        text: 'Strings',
        link: '/reference/strings/',
        outline: [
          'The String type',
          'Literals and escapes',
          'Indexing and slicing',
          'Comparison and equality',
          'Encodings',
        ],
      },
      {
        text: 'Unions',
        link: '/reference/unions/',
        outline: [
          'Declaring a union',
          'What may appear in a union',
          'Why primitives are restricted',
          'Narrowing a union',
          'Literal types',
        ],
      },
      {
        text: 'Generics',
        link: '/reference/generics/',
        outline: [
          'Type parameters',
          'Constraints',
          'Monomorphization',
          'Variance',
          'Inference',
        ],
      },
      {
        text: 'Inference and Narrowing',
        link: '/reference/inference/',
        outline: [
          'Local inference',
          'Contextual typing',
          'Control-flow narrowing',
          'is and as',
        ],
      },
    ],
  },
  {
    text: 'Expressions',
    items: [
      {
        text: 'Expressions',
        link: '/reference/expressions/',
        outline: [
          'Literals',
          'Member access',
          'Calls',
          'Conditional expressions',
          'Block expressions',
          'Evaluation order',
        ],
      },
      {
        text: 'Operators',
        link: '/reference/operators/',
        outline: [
          'Arithmetic',
          'Comparison and equality',
          'Logical',
          'Bitwise',
          'Assignment and compound assignment',
          'Type operators',
        ],
      },
      {
        text: 'Operator Precedence',
        link: '/reference/operator-precedence/',
        outline: ['Precedence table', 'Associativity'],
      },
      {
        text: 'Template Literals',
        link: '/reference/template-literals/',
        outline: ['Interpolation', 'Multi-line strings', 'Tagged templates'],
      },
      {
        text: 'Ranges',
        link: '/reference/ranges/',
        outline: ['Range syntax', 'Iterating a range', 'Slicing with ranges'],
      },
      {
        text: 'Pipelines',
        link: '/reference/pipelines/',
        outline: ['The pipeline operator', 'Placeholders', 'Status'],
      },
    ],
  },
  {
    text: 'Statements and Control Flow',
    items: [
      {
        text: 'Control Flow',
        link: '/reference/control-flow/',
        outline: ['if', 'match', 'Blocks', 'return', 'throw'],
      },
      {
        text: 'Loops',
        link: '/reference/loops/',
        outline: [
          'while',
          'for',
          'for-in',
          'break and continue',
          'Labels',
          'while let',
        ],
      },
      {
        text: 'Pattern Matching',
        link: '/reference/pattern-matching/',
        outline: [
          'match expressions',
          'Pattern forms',
          'Guards',
          'Or patterns',
          'Exhaustiveness checking',
          'if let',
        ],
      },
      {
        text: 'Destructuring',
        link: '/reference/destructuring/',
        outline: [
          'Record patterns',
          'Tuple patterns',
          'Class patterns',
          'Rest and defaults',
        ],
      },
    ],
  },
  {
    text: 'Data Types',
    items: [
      {
        text: 'Records',
        link: '/reference/records/',
        outline: [
          'Record literals',
          'Record types',
          'Spread',
          'Structural typing',
          'Representation',
        ],
      },
      {
        text: 'Tuples',
        link: '/reference/tuples/',
        outline: [
          'Tuple literals',
          'Inline tuples',
          'Multi-value returns',
          'Representation',
        ],
      },
      {
        text: 'Arrays',
        link: '/reference/arrays/',
        outline: [
          'FixedArray',
          'Array',
          'ImmutableArray',
          'Literals',
          'Indexing and bounds',
          'Slicing',
        ],
      },
      {
        text: 'Maps and Sets',
        link: '/reference/maps/',
        outline: [
          'Map',
          'OrderedMap',
          'Set',
          'Keys, hashing, and equality',
          'Literals',
        ],
      },
      {
        text: 'Enums',
        link: '/reference/enums/',
        outline: [
          'Declaring an enum',
          'Backing types',
          'Conversions',
          'Enums versus sealed classes',
        ],
      },
      {
        text: 'Boxing',
        link: '/reference/boxing/',
        outline: ['Box', 'Automatic boxing', 'Costs'],
      },
    ],
  },
  {
    text: 'Classes',
    items: [
      {
        text: 'Introduction',
        link: '/reference/classes/',
        outline: [
          'Declaring a class',
          'Instantiation',
          'Identity and equality',
          'Representation',
        ],
      },
      {
        text: 'Fields and Constructors',
        link: '/reference/classes/fields/',
        outline: [
          'Field declarations',
          'var and let fields',
          'Private fields',
          'Asymmetric visibility',
          'Constructors',
          'this. parameters',
          'Initializer lists',
        ],
      },
      {
        text: 'Methods and Accessors',
        link: '/reference/classes/methods/',
        outline: [
          'Methods',
          'Getters and setters',
          'Static members',
          'Generic methods',
        ],
      },
      {
        text: 'Inheritance',
        link: '/reference/classes/inheritance/',
        outline: [
          'extends',
          'Overriding',
          'abstract and final',
          'Method resolution',
          'Virtual dispatch',
        ],
      },
      {
        text: 'Interfaces',
        link: '/reference/classes/interfaces/',
        outline: [
          'Declaring an interface',
          'implements',
          'Interface inheritance',
          'Default members',
          'Representation',
        ],
      },
      {
        text: 'Mixins',
        link: '/reference/classes/mixins/',
        outline: [
          'Declaring a mixin',
          'on constraints',
          'with clauses',
          'Linearization',
        ],
      },
      {
        text: 'Sealed and Case Classes',
        link: '/reference/classes/sealed/',
        outline: [
          'sealed class',
          'case declarations',
          'Case class shorthand',
          'Generated members',
          'Exhaustive matching',
        ],
      },
      {
        text: 'Extension Classes',
        link: '/reference/classes/extensions/',
        outline: [
          'Declaring an extension',
          'Resolution rules',
          'Extending primitives',
          'Limitations',
        ],
      },
      {
        text: 'Operator Overloads',
        link: '/reference/classes/operators/',
        outline: ['operator ==', 'operator hash', 'Other operators'],
      },
    ],
  },
  {
    text: 'Errors',
    items: [
      {
        text: 'Exceptions',
        link: '/reference/exceptions/',
        outline: [
          'throw',
          'try/catch',
          'finally',
          'try as an expression',
          'The Error class',
          'Representation',
        ],
      },
    ],
  },
  {
    text: 'Libraries',
    items: [
      {
        text: 'Libraries and Modules',
        link: '/reference/libraries/',
        outline: [
          'Library directories',
          'Module resolution',
          'Library specifiers',
          'Circular imports',
        ],
      },
      {
        text: 'Imports and Exports',
        link: '/reference/imports-and-exports/',
        outline: [
          'import',
          'from … import',
          'export',
          'Re-exports',
          'Host imports',
        ],
      },
      {
        text: 'Visibility',
        link: '/reference/visibility/',
        outline: ['Module visibility', 'Class member visibility'],
      },
      {
        text: 'Package Manifest',
        link: '/reference/package-manifest/',
        outline: ['Fields', 'Dependencies', 'Targets'],
      },
    ],
  },
  {
    text: 'Attributes',
    items: [
      {
        text: 'Decorators and Intrinsics',
        link: '/reference/decorators/',
        outline: ['@intrinsic', '@pure', 'Other attributes', 'Status'],
      },
    ],
  },
  {
    text: 'Standard Library',
    collapsed: true,
    items: [
      {
        text: 'Overview',
        link: '/reference/stdlib/',
        outline: ['What ships with Zena', 'Importing', 'Stability'],
      },
      {text: 'zena:array', link: '/reference/stdlib/array/'},
      {text: 'zena:string', link: '/reference/stdlib/string/'},
      {text: 'zena:string-builder', link: '/reference/stdlib/string-builder/'},
      {text: 'zena:map', link: '/reference/stdlib/map/'},
      {text: 'zena:set', link: '/reference/stdlib/set/'},
      {text: 'zena:iterator', link: '/reference/stdlib/iterator/'},
      {text: 'zena:math', link: '/reference/stdlib/math/'},
      {text: 'zena:json', link: '/reference/stdlib/json/'},
      {text: 'zena:regex', link: '/reference/stdlib/regex/'},
      {text: 'zena:url', link: '/reference/stdlib/url/'},
      {text: 'zena:fs', link: '/reference/stdlib/fs/'},
      {text: 'zena:console', link: '/reference/stdlib/console/'},
      {text: 'zena:cli', link: '/reference/stdlib/cli/'},
      {text: 'zena:test', link: '/reference/stdlib/test/'},
      {text: 'zena:error', link: '/reference/stdlib/error/'},
      {text: 'zena:memory', link: '/reference/stdlib/memory/'},
    ],
  },
  {
    text: 'Toolchain',
    collapsed: true,
    items: [
      {
        text: 'CLI',
        link: '/reference/cli/',
        outline: [
          'zena build',
          'zena run',
          'zena test',
          'zena fmt',
          'zena lsp',
          'Global options',
        ],
      },
      {
        text: 'Compile Targets',
        link: '/reference/compile-targets/',
        outline: ['host', 'wasi', 'Target-specific behaviour'],
      },
      {
        text: 'Compiler Flags',
        link: '/reference/compiler-flags/',
        outline: [
          'Output',
          'Optimization',
          'Encoding',
          'Diagnostics',
          'Debugging',
        ],
      },
      {
        text: 'Formatter',
        link: '/reference/formatter/',
        outline: ['Usage', 'Formatting rules', 'Ignoring code'],
      },
      {
        text: 'Language Server',
        link: '/reference/language-server/',
        outline: ['Capabilities', 'Configuration'],
      },
    ],
  },
  {
    text: 'Appendix',
    collapsed: true,
    items: [
      {text: 'Grammar', link: '/reference/grammar/'},
      {text: 'Keywords', link: '/reference/keywords/'},
    ],
  },
];

const development = [
  {
    text: 'Development',
    items: [
      {
        text: 'Overview',
        link: '/development/',
        outline: [
          'How the project works',
          'Why the language is like this',
          'Where to start',
        ],
      },
      {
        text: 'Built with AI',
        link: '/development/built-with-ai/',
        outline: [
          'What "almost entirely" means',
          'How the loop works',
          'What the language does to help',
          'What has gone wrong',
          'What we have learned',
        ],
      },
      {
        text: 'Status and Roadmap',
        link: '/development/roadmap/',
        outline: [
          'Where things stand',
          'What is next',
          'Further out',
          'What is not planned',
        ],
      },
      {
        text: 'Contributing',
        link: '/development/contributing/',
        outline: [
          'Getting set up',
          'Repository layout',
          'Tests and formatting',
          'Working alongside agents',
          'Opening a change',
        ],
      },
    ],
  },
  {
    text: 'Design',
    items: [
      {
        text: 'Overview',
        link: '/development/design/',
        outline: ['Decisions', 'The working documents'],
      },
      {
        text: 'Strings',
        link: '/development/design/strings/',
        outline: [
          'Problem',
          'Goals',
          'Design overview',
          'Host interop',
          'Current implementation',
        ],
      },
      {
        text: 'Multi-value returns',
        link: '/development/design/multi-value-returns/',
        outline: [
          'Motivation',
          'The shape Zena uses',
          'Option still exists',
          'Errors',
          'Planned changes',
        ],
      },
      {
        text: 'Union types',
        link: '/development/design/unions/',
        outline: [
          'Two questions',
          'Illegal unions',
          'Allowed unions',
          'Casts and type checks',
        ],
      },
      {
        text: 'Classes and interfaces',
        link: '/development/design/classes-and-interfaces/',
        outline: [
          'Classes are Wasm structs',
          'Virtual calls go through a vtable',
          'Calls are devirtualized when the target is unambiguous',
          'Interfaces are fat pointers',
          'Mixins become classes',
        ],
      },
      {
        text: 'Generics',
        link: '/development/design/generics/',
        outline: [
          'Generics are reified',
          'Generics are monomorphized',
          'Generic methods',
          'Variance',
          'Constraints',
          'Casts and type checks',
          'Soundness',
        ],
      },
      {
        text: 'Literal types',
        link: '/development/design/literal-types/',
        outline: [
          'Literal types are not sound',
          'is tests the base type',
          'Values from outside the program are unchecked',
        ],
      },
      {
        text: 'Distinct types',
        link: '/development/design/distinct-types/',
        outline: [
          'Distinct types are opaque in both directions',
          'Distinct types are not sound',
          'is tests the base type',
          'Erasure restricts unions and matching',
        ],
      },
      {
        text: 'Automatic boxing',
        link: '/development/design/automatic-boxing/',
        outline: ['Why it is rejected', 'No any', 'anyref is a different type'],
      },
      {
        text: 'Regular expressions',
        link: '/development/design/regex/',
        outline: [
          'Engine size',
          'No JIT in Wasm',
          'Linear-time matching',
          'Compile-time specialization',
          'Patterns as strings',
        ],
      },
    ],
  },
];

export default {
  '/guide/': guide,
  '/reference/': reference,
  '/development/': development,
};
