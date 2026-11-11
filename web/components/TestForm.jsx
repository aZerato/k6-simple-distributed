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

export default function TestForm({ formStatus, submitting, onSubmit, onStop, workers }) {
  const [scriptPath, setScriptPath] = useState('');
  const [script, setScript] = useState(DEFAULT_SCRIPT);
  const [totalVus, setTotalVus] = useState('50');
  const [duration, setDuration] = useState('30s');
  // workerId -> explicitly targeted. Absence (or `true`) = targeted: a worker
  // that (re)connects is ticked by default, so "all workers" stays the default.
  const [picks, setPicks] = useState({});

  const selected = (workers || []).filter((w) => picks[w.id] !== false);

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
            duration: duration.trim() || '30s',
            workerIds: selected.map((w) => w.id)
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
        <div className="field-row">
          <div className="field">
            <span className="field-label">
              Targeted workers
              <span className="field-quick">
                <button type="button" className="qlink" onClick={() => setPicks({})}>All</button>
                <span className="qsep">/</span>
                <button type="button" className="qlink" onClick={() => setPicks(Object.fromEntries((workers || []).map((w) => [w.id, false])))}>None</button>
              </span>
            </span>
            <div className="workers-pick">
              {(workers || []).length === 0 && <span className="wp-empty">No worker connected…</span>}
              {(workers || []).map((w) => (
                <label className="wp" key={w.id}>
                  <input
                    type="checkbox"
                    checked={picks[w.id] !== false}
                    onChange={(e) => setPicks((cur) => ({ ...cur, [w.id]: e.target.checked }))}
                  />
                  <span className="wp-name">{w.id}</span>
                  <span className={'wp-st ' + (w.status === 'BUSY' ? 'busy' : 'ok')}>{w.status === 'BUSY' ? 'busy' : 'available'}</span>
                </label>
              ))}
            </div>
            <span className="field-hint">
              The total VUS is distributed only over the targeted workers. Unticked workers stay idle.
            </span>
          </div>
        </div>
        <div className="field-row actions">
          <button type="submit" className="btn btn-primary" id="btn-start" disabled={submitting || selected.length === 0}>
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
