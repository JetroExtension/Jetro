# System Prompts

Place your system prompt markdown file here (e.g., `prompt.md`).

The system prompt is your agent's operating doctrine — methodology, analysis priorities,
professional boundaries, and domain-specific instructions. It's delivered to the agent
on the first tool call of each session via `wrapResponse()`.

This file is never written to disk in the user's workspace — it stays in memory only.
