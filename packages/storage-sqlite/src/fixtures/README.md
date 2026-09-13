# Historical SQLite fixtures

These files are immutable compatibility inputs, not current implementation templates.

- `schema-v1.sql`: the first relational schema, before state lookup indexes.
- `legacy-v2.sql` and `legacy-v2-state.json`: generated from Git commit `cc48b20` by running that commit's actual Harness, fake providers and SQLite adapter. The archived sources were bundled separately, so concurrent P3 edits could not change the producer. The SQL contains the exported v2 schema and rows; the JSON is the public RuntimeStore state read before closing it.

The v2 discussion includes one completed turn, a second turn with two linked unknown model attempts, one queued question, seven original command receipts (including a rejected command), and 22 journal events. Its messages and evidence are synthetic test data. Tests must preserve the historical content and identities while migrating representation; do not regenerate these inputs whenever contracts change.

`interrupted-runtime.ts` is different: it is a live current-version process fixture used for forced-exit recovery tests, and should follow current contracts.
