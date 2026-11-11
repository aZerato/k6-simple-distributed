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

const fmtBytes = (n) => (n < 1000 ? `${n} B` : n < 1e6 ? `${(n / 1e3).toFixed(1)} kB` : `${(n / 1e6).toFixed(2)} MB`);

function fileToB64(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => resolve('');
    reader.readAsDataURL(file);
  });
}

export default function TestForm({ formStatus, submitting, onSubmit, onStop, workers }) {
  const [scriptPath, setScriptPath] = useState('');
  const [script, setScript] = useState(DEFAULT_SCRIPT);
  const [totalVus, setTotalVus] = useState('50');
  const [duration, setDuration] = useState('30s');
  // workerId -> explicitly targeted. Absence (or `true`) = targeted: a worker
  // that (re)connects is ticked by default, so "all workers" stays the default.
  const [picks, setPicks] = useState({});
  // Data files (CSV, etc.) uploaded to the workers: name -> { b64, size }
  const [dataFiles, setDataFiles] = useState({});

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
          onSubmit({
            scriptPath: scriptPath.trim(),
            scriptContent: script,
            totalVus: Math.max(1, parseInt(totalVus, 10) || 1),
            duration: duration.trim() || '30s',
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
