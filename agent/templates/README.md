# Templates

Place your template JSON files here. Each template is a JSON file with:

```json
{
  "name": "Template Name",
  "description": "One-line description shown in CLAUDE.md",
  "content": "The full template content — formatting instructions or canvas structure"
}
```

Templates are loaded on extension activation and listed in the thin prompt (CLAUDE.md).
The agent fetches the full content via `jet_template({ name: "Template Name" })`.
