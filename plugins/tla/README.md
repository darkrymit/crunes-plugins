# Crunes Plugin: tla

Run TLC model checking on TLA+ specifications and render the state space (or counterexamples) as Mermaid `stateDiagram-v2` charts, with optional `--view` mapping.

## Usage

```bash
crunes -p run tla doctor
crunes -p run tla install
crunes -p run tla check ./Spec.tla --config ./Spec.cfg --view ./view.js
```

## Permissions

- **`fs.read`:** `**`, `~/.tla/**`, `~/.local/share/tla/**` (read `.tla`/`.cfg`/`.dot`/view files and locate `tla2tools.jar`)
- **`fs.mkdir` / `fs.write`:** `~/.tla` (install `tla2tools.jar`)
- **`shell.run`:** `java *`, `tlc *`, `curl *`, `where.exe *`, `which *`
