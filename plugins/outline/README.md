# Crunes Plugin: outline

Structural code outline: collapse function and method bodies while preserving signatures, types, classes, and annotations. Strips comments and imports by default.

## Usage

```bash
crunes -p run outline show src/index.js
crunes -p run outline show src/index.js --comments --imports
cat src/index.js | crunes -p run outline show -
```

## Permissions

- **`fs.read`:** `.`, `**` (read target files and directory stats)
