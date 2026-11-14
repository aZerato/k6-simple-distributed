import { parse as parseJs } from 'acorn';

// Result shape for both linters:
//   { ok: boolean, message: string, line?: number, col?: number }
// `message` is '' when ok; `line`/`col` are 1-based, best-effort, optional.

// 1-based line/col of a character offset in a source string.
function lineColAt(code, pos) {
  let line = 1;
  let col = 1;
  for (let i = 0; i < pos && i < code.length; i++) {
    if (code[i] === '\n') { line += 1; col = 1; } else { col += 1; }
  }
  return { line, col };
}

// JavaScript syntax check for the pasted k6 script. k6 scripts are ES modules
// (`import`/`export`), so parse as a module with the latest ecmaVersion.
export function lintJs(code) {
  const text = String(code ?? '');
  if (text.trim() === '') return { ok: true, message: '' };
  try {
    parseJs(text, { ecmaVersion: 'latest', sourceType: 'module' });
    return { ok: true, message: '' };
  } catch (err) {
    const pos = typeof err.pos === 'number' ? err.pos : 0;
    const { line, col } = lineColAt(text, pos);
    return { ok: false, message: err.message || 'Syntax error', line, col };
  }
}

// Check for the load profile — a k6 v2 `scenarios` map. Flags invalid JSON,
// then the shape: a non-empty object whose entries each carry an `executor`.
// (The executor whitelist / per-executor fields stay the orchestrator's job.)
export function lintJson(text) {
  const trimmed = String(text ?? '').trim();
  if (trimmed === '') return { ok: true, message: '' };
  let value;
  try {
    value = JSON.parse(trimmed);
  } catch (err) {
    const m = /position (\d+)/.exec(err.message || '');
    if (m) {
      const { line, col } = lineColAt(trimmed, Number(m[1]));
      return { ok: false, message: err.message || 'Invalid JSON', line, col };
    }
    return { ok: false, message: err.message || 'Invalid JSON' };
  }
  const entries =
    value === null || typeof value !== 'object' || Array.isArray(value)
      ? []
      : Object.entries(value);
  if (entries.length === 0) {
    return { ok: false, message: 'Must be a non-empty JSON object — the k6 v2 `scenarios` map.' };
  }
  for (const [name, def] of entries) {
    if (!def || typeof def !== 'object' || typeof def.executor !== 'string') {
      return { ok: false, message: `Scenario "${name}" must be an object with a string "executor" field.` };
    }
  }
  return { ok: true, message: '' };
}
