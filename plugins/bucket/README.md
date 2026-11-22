# Crunes Plugin: bucket

Register folders anywhere on disk (default root `~/buckets`) and find them by id, label, or README summary.

## Usage

```bash
crunes -p run bucket new notes --label docs --git
crunes -p run bucket register ./existing-folder --id my-proj -l work
crunes -p run bucket where notes
crunes -p run bucket find notes
crunes -p run bucket list
crunes -p run bucket delete notes --yes
```

## Permissions

- **`fs.read` / `fs.write`:** `**`, `~/.crunes/buckets.json` (read/update bucket registry and inspect bucket READMEs)
- **`fs.mkdir` / `fs.rm` / `fs.glob`:** `**` (create/delete buckets and list folder entries)
- **`shell.run`:** `git *` (`--git` init and git state inspection)
