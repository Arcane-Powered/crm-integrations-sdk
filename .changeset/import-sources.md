---
'@arcanepowered/integrations-sdk': minor
---

Sources: a manifest or a TypeScript integration can declare `sources` that list every record of an app page by page
(`list`, cursor read at `next`) and then only what changed since a date (`changes`, `{{since}}` as ISO, Unix seconds or
milliseconds). Items are normalized to `{ id, updatedAt, fields }` from field paths (array indexes allowed) or from an
object of user-defined columns (`fields_from`). New `readSource`, `getSource`, `sourceValue`, `UnknownSourceError` and
`runSource` in `/testing`.
