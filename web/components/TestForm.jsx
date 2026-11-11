'use client';
import { useState } from 'react';

const DEFAULT_SCRIPT = [
  "import http from 'k6/http';",
  "import { check, sleep } from 'k6';",
  '',
  'export default function () {',
  "  const res = http.get('https://k6.io');",
  "  check(res, {",
  "    'status is 200': (r) => r.status === 200",
  '  });',
  '  sleep(1);',
  '}'
].join('\n');

export default function TestForm({ formStatus, submitting, onSubmit, onStop }) {
  const [scriptPath, setScriptPath] = useState('');
  const [script, setScript] = useState(DEFAULT_SCRIPT);
  const [totalVus, setTotalVus] = useState('50');
  const [duration, setDuration] = useState('30s');

  return (
    <section className="panel reveal d2">
      <h2 className="panel-title">Start a test</h2>
      <form
        id="test-form"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit({
            scriptPath: scriptPath.trim(),
            scriptContent: script,
            totalVus: Math.max(1, parseInt(totalVus, 10) || 1),
            duration: duration.trim() || '30s'
          });
        }}
      >
        <label className="field">
          <span className="field-label">Script file (.js path)</span>
          <input
            id="script-path"
            type="text"
            value={scriptPath}
            onChange={(e) => setScriptPath(e.target.value)}
            placeholder="e.g. C:\k6\script.js (optional)"
          />
          <span className="field-hint">
            If set, this takes precedence over the code pasted below. The file is read on the orchestrator's machine.
          </span>
        </label>
        <label className="field">
          <span className="field-label">Script k6 (JavaScript)</span>
          <textarea
            id="script"
            className="mono"
            spellCheck="false"
            value={script}
            onChange={(e) => setScript(e.target.value)}
          />
        </label>
        <div className="field-row">
          <label className="field">
            <span className="field-label">Total VUS</span>
            <input id="total-vus" type="number" min="1" value={totalVus} onChange={(e) => setTotalVus(e.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">Duration</span>
            <input id="duration" type="text" value={duration} onChange={(e) => setDuration(e.target.value)} />
          </label>
        </div>
        <div className="field-row actions">
          <button type="submit" className="btn btn-primary" id="btn-start" disabled={submitting}>
            Start the test
          </button>
          <button type="button" className="btn btn-danger" id="btn-stop" onClick={onStop}>
            Emergency stop
          </button>
        </div>
        <p className={'form-status' + (formStatus.cls ? ' ' + formStatus.cls : '')}>{formStatus.text}</p>
      </form>
    </section>
  );
}
