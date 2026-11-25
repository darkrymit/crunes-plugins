# Crunes Plugin: secret

Read config and env files (`.env`, `.ini`, `.properties`, `.conf`, `.json`) with secret values and embedded URL credentials masked.

## Usage

```bash
crunes -p run secret read .env
crunes -p run secret read .env --key DATABASE_URL
crunes -p run secret read config.json --keys port,apiKey
```

## What is masked

- Values whose name looks sensitive (`password`, `token`, `*_KEY`, …), in live and commented-out assignments.
- Known token shapes (`sk-…`, `ghp_…`, `AIza…`, `eyJ…`, …), under any name and in comments.
- Credentials inside URLs, and private key blocks.

The shapes are a list: an unknown kind of token under an innocent name is still printed.

## Permissions

- **`fs.read`:** `.`, `**` (read target config or env files)
