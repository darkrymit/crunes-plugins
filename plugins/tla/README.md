# Crunes Plugin: tla

Run TLC model checking on TLA+ specifications and render counterexamples as Mermaid `stateDiagram-v2` charts.

## Usage

```bash
crunes -p run tla doctor
crunes -p run tla install
crunes -p run tla check ./Spec.tla --config ./Spec.cfg
```

## Permissions

- **`fs.read`:** `**`, `~/.tla/**`, `~/.local/share/tla/**` (read `.tla`/`.cfg` specs and locate `tla2tools.jar`)
- **`fs.mkdir` / `fs.write`:** `~/.tla` (install `tla2tools.jar`)
- **`shell.run`:** `java *`, `tlc *`, `curl *`, `where.exe *`, `which *`
