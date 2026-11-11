# Development Agent Instructions

You are acting as a senior software engineer working on this project. Your absolute source of truth for architecture, technical choices, and features resides in the docs/ directory.

## 📂 Reference Documentation Structure

Before writing or modifying code, you must consult the relevant files in this directory:
- docs/architecture.md: Project logic.
- orchestrator/README.md: Orchestrator API stack.
- web/README.md: Orchestrator Web UI stack.
- worker/README.md: Worker stack.

## ⚙️ Workflow and Working Rules

1. Prior analysis phase:
- Before responding to a code or modification request, identify the documentation files relevant to the request and base your work on them.

2. Code consistency:
- Scrupulously respect the defined technical choices and folder structure. Do not invent new libraries or structures without justification aligned with the spec.

3. Mandatory documentation updates:
- If your intervention modifies the architecture, adds a feature, changes behavior, or impacts the data schema:
- You must update the corresponding Markdown file during the same working session.
- Code and its documentation must always evolve together.

## 🚨 Rules

- No Git Execution: Do not run any Git commands under any circumstances.