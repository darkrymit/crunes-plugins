# Patterns

* [Read-only by default, widened by pairing a var with a grant](/patterns/command-enablement.md) - A plugin exposing commands that mutate state ships them disabled, and enabling one is two edits — naming it in an enable var and adding the grant it needs — so neither edit alone can surprise anyone.
