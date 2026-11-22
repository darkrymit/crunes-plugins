# Crunes Plugin: secret

Read config and env files (`.env`, `.ini`, `.properties`, `.conf`, `.json`) with secret values and embedded URL credentials masked.

## Usage

```bash
crunes -p run secret read .env
crunes -p run secret read .env --key DATABASE_URL
crunes -p run secret read config.json --keys port,apiKey
```

## Permissions

- **`fs.read`:** `.`, `**` (read target config or env files)
