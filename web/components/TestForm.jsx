'use client';
import { useEffect, useState } from 'react';

const DEFAULT_SCRIPT = [
  "import http from 'k6/http';",
  "import { check, sleep } from 'k6';",
  '',
  'export const options = { scenarios: JSON.parse(__ENV.K6_SCENARIO_OPTIONS) };',
  '',
  'export default function () {',
  "  const res = http.get('https://k6.io');",
  "  check(res, {",
  "    'status is 200': (r) => r.status === 200",
  '  });',
  '  sleep(1);',
  '}'
].join('\n');

// Default load profile: a k6 v2 `scenarios` map (JSON), split by the orchestrator
// over the targeted workers and sent to each as the K6_SCENARIO_OPTIONS env var.
const DEFAULT_PROFILE = JSON.stringify({
  default: { executor: 'constant-vus', vus: 50, duration: '30s' }
}, null, 2);

const fmtBytes = (n) => (n < 1000 ? `${n} B` : n < 1e6 ? `${(n / 1e3).toFixed(1)} kB` : `${(n / 1e6).toFixed(2)} MB`);

function fileToB64(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => resolve('');
    reader.readAsDataURL(file);
  });
}

// Recent `.js` paths, kept in the browser to suggest them in the path input
const SCRIPT_HISTORY_KEY = 'k6-script-path-history';
const SCRIPT_HISTORY_MAX = 10;

export default function TestForm({ formStatus, submitting, onSubmit, onStop, workers }) {
  const [scriptPath, setScriptPath] = useState('');
  const [script, setScript] = useState(DEFAULT_SCRIPT);
  const [profileJson, setProfileJson] = useState(DEFAULT_PROFILE);
  // workerId -> explicitly targeted. Absence (or `true`) = targeted: a worker
  // that (re)connects is ticked by default, so "all workers" stays the default.
  const [picks, setPicks] = useState({});
  // Data files (CSV, etc.) uploaded to the workers: name -> { b64, size }
  const [dataFiles, setDataFiles] = useState({});
  // Script path history (datalist of the path input), kept in the browser
  const [scriptHistory, setScriptHistory] = useState([]);

  useEffect(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(SCRIPT_HISTORY_KEY) || '[]');
      if (Array.isArray(raw)) setScriptHistory(raw.filter((p) => typeof p === 'string'));
    } catch { /* corrupted entry: start fresh */ }
  }, []);

  const selected = (workers || []).filter((w) => picks[w.id] !== false);
  const fileNames = Object.keys(dataFiles);

  const addFiles = async (fileList) => {
    for (const f of Array.from(fileList)) {
      const b64 = await fileToB64(f);
      setDataFiles((cur) => ({ ...cur, [f.name]: { b64, size: f.size } }));
    }
  };

  const removeFile = (name) => {
    setDataFiles((cur) => {
      const next = { ...cur };
      delete next[name];
      return next;
    });
  };

  return (
    <section className="panel reveal d2">
      <h2 className="panel-title">Start a test</h2>
      <form
        id="test-form"
        onSubmit={(e) => {
          e.preventDefault();
          const path = scriptPath.trim();
          if (path) {
            // Keep the recent .js paths (deduped, most recent first, capped)
            const next = [path, ...scriptHistory.filter((p) => p !== path)].slice(0, SCRIPT_HISTORY_MAX);
            setScriptHistory(next);
            try { localStorage.setItem(SCRIPT_HISTORY_KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
          }
          onSubmit({
            scriptPath: path,
            scriptContent: script,
            profileJson,
            workerIds: selected.map((w) => w.id),
            attachments: fileNames.length
              ? Object.fromEntries(fileNames.map((n) => [n, dataFiles[n].b64]))
              : undefined
          });
        }}
      >
        <label className="field">
          <span className="field-label">Script file (.js path)</span>
          <input
            id="script-path"
            type="text"
            list="script-path-history"
            value={scriptPath}
            onChange={(e) => setScriptPath(e.target.value)}
            placeholder="e.g. C:\k6\script.js (optional)"
          />
          <datalist id="script-path-history">
            {scriptHistory.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
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
        <label className="field">
          <span className="field-label">Load profile (k6 <code>scenarios</code> JSON)</span>
          <textarea
            id="profile"
            className="mono"
            spellCheck="false"
            rows={7}
            value={profileJson}
            onChange={(e) => setProfileJson(e.target.value)}
          />
          <span className="field-hint">
            A k6 v2 <code>scenarios</code> map. The orchestrator splits it over the targeted
            workers and sends each its share as the <code>K6_SCENARIO_OPTIONS</code> env var;
            the script reads it with{' '}
            <code>{'options = { scenarios: JSON.parse(__ENV.K6_SCENARIO_OPTIONS) }'}</code>.
            Executors: <code>constant-vus</code>, <code>ramping-vus</code>, <code>shared-iterations</code>,{' '}
            <code>per-vu-iterations</code>, <code>constant-arrival-rate</code>, <code>ramping-arrival-rate</code>.
          </span>
        </label>
        <div className="field">
          <span className="field-label">
            Data files (CSV, …)
            {fileNames.length > 0 && (
              <span className="field-quick">
                <button type="button" className="qlink" onClick={() => setDataFiles({})}>Clear</button>
              </span>
            )}
          </span>
          <input
            id="data-files"
            type="file"
            multiple
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = '';
            }}
          />
          {fileNames.length > 0 && (
            <div className="workers-pick">
              {fileNames.map((n) => (
                <span className="wp" key={n}>
                  <span className="wp-name">{n}</span>
                  <span className="wp-st">{fmtBytes(dataFiles[n].size)}</span>
                  <button type="button" className="wp-x" title="Remove" onClick={() => removeFile(n)}>✕</button>
                </span>
              ))}
            </div>
          )}
          <span className="field-hint">
            Sent to every targeted worker and written next to the ephemeral script, so relative paths in the
            script (e.g. `open('./data.csv')`) resolve like a local run.
          </span>
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
              The load profile is split only over the targeted workers. Unticked workers stay idle.
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
