# Skills

Place your skill JSON files here. Each skill is a JSON file with:

```json
{
  "name": "Skill Name",
  "description": "One-line description shown in CLAUDE.md",
  "prompt": "The full skill prompt — instructions the agent follows when this skill is invoked"
}
```

Skills are loaded on extension activation and listed in the thin prompt (CLAUDE.md).
The agent fetches the full prompt via `jet_skill({ name: "Skill Name" })`.
