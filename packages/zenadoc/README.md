# `zenadoc`

Extracts a Zena package's public API from source and serializes it as JSON: every module the package exports, the declarations in each, their members, signatures, resolved type links, and doc comments.

## Usage

### Command Line

```bash
zena doc ./my-package -o api.json   # a package with zena-package.json
zena doc ./src                      # any directory, to stdout
zena doc main.zena                  # a single file
```

### Library API

```zena
import { documentPackage, DocumentOptions } from 'zenadoc';
import { loadPackage } from 'zenadoc/package';
import { packageToJson } from 'zenadoc/json';

let pkg = await loadPackage('./my-package');
let result = await documentPackage(pkg, new DocumentOptions());
let json = packageToJson(result.docs);
```

## Libraries

- `zenadoc` / `zenadoc/document` — compiles and documents a package (`documentPackage`, `DocumentOptions`, `DocumentResult`)
- `zenadoc/package` — discovers a package's exported modules from `zena-package.json` or the filesystem (`loadPackage`, `Package`, `ModuleSpec`)
- `zenadoc/model` — API documentation model (`DocPackage`, `DocModule`, `DocDeclaration`, `DocMember`, `TypeRef`, `TypeLink`, `DeclarationKind`, `MemberKind`)
- `zenadoc/json` — serializes a `DocPackage` to JSON (`packageToJson`)
- `zenadoc/extract` — walks a parsed `Module` AST into a `DocModule` (`extractModule`, `ExtractOptions`)
- `zenadoc/reexports` — follows re-exported declarations across modules (`resolveReexports`, `WalkCache`)
- `zenadoc/inherit` — copies inherited members from supertypes (`inheritMembers`)
- `zenadoc/links` — resolves type references to declaration targets via scope analysis (`linkModule`, `ScopeIndex`)
- `zenadoc/publish` — rewrites declaration links to their public hosting module (`publishLinks`)
- `zenadoc/type-text` — renders type annotations to text and records declaration spans (`renderTypeAnnotation`)
- `zenadoc/ids` — formats module and declaration anchor IDs (`moduleId`, `anchorFor`)

## License

MIT
