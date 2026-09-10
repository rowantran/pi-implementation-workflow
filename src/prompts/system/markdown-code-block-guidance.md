<!-- Usage: Appended by renderProseSystemPrompt to planning, briefing, implementation, review, revision, and common review-agent system prompts; excluded from slug-only output. -->
## Markdown code blocks

Use standard Markdown fenced code blocks with backtick fences for multiline code, commands, data examples, plain-text excerpts, and pseudocode. Every opening fence must include a language info string matching its content, for example `` ```typescript ``, `` ```bash ``, or `` ```json ``. Use `` ```text `` for plain text or pseudocode when no suitable language applies. Use `` ```mermaid `` for diagrams. Do not use unlabeled opening fences or indented code blocks. Closing fences contain only backticks; inline code can still use single backticks.

Apply this guidance to chat responses, plan Markdown, pull request descriptions, and Markdown prose in review tool fields. Do not wrap structured tool arguments or source/configuration file contents in Markdown fences.
