# Crunes Plugin: signal

Named timers that run a command when they expire. Built for hook-driven reminders such as prompt-cache expiry warnings: arm on one event, cancel on the next, from any folder.

## Usage

```bash
crunes -p run signal set cache/claude/abc/20m --in 40m -- node notify.js "Cache expires in 20m"
crunes -p run signal cancel --prefix cache/claude/abc/
crunes -p run signal cancel cache/claude/abc/20m
crunes -p run signal list cache/ --json
```

Setting an existing name re-arms it; the previous timer will not fire.

## How it works

`~/.signal/signals.json` is the source of truth. `set` stores the signal with a fresh random token and starts one background job: `node src/sleeper.mjs <token> <ms>`. When the delay is over, the sleeper fires the stored command only if the registry still holds that exact token. `cancel` and re-arm just edit the registry, so they work from any folder — crunes files jobs per project folder, so killing a job from elsewhere is not possible.

Trade-off: a cancelled timer's sleeping process stays alive, idle, until its original deadline.

The fired command runs directly as a detached process with a hidden window, with the stored arguments as plain argv. Shell features such as pipes and `&&` are not interpreted; wrap them yourself, e.g. `-- bash -c '...'`.

## Permissions

- **`fs.read` / `fs.write`:** `~/.signal/signals.json` (the registry) and `~/.signal` (creating its folder)
- **`shell.job.start` / `shell.run`:** `*` (the manifest grants both; only `shell.job.start` is used today, to start the sleeper)
