'use client';
import { useState } from 'react';

const DEFAULT_SCRIPT = [
  "import http from 'k6/http';",
  "import { check, sleep } from 'k6';",
  '',
  'export default function () {',
  "  const res = http.get('https://k6.io');",
  "  check(res, {",
  "    'status est 200': (r) => r.status === 200",
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
      <h2 className="panel-title">Lancer un test</h2>
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
          <span className="field-label">Fichier de script (chemin .js)</span>
          <input
            id="script-path"
            type="text"
            value={scriptPath}
            onChange={(e) => setScriptPath(e.target.value)}
            placeholder="ex. C:\k6\script.js (optionnel)"
          />
          <span className="field-hint">
            Si renseignée, cette voie l'emporte sur le code collé ci-dessous. Le fichier est lu sur la machine de l'orchestrateur.
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
            <span className="field-label">VUS totales</span>
            <input id="total-vus" type="number" min="1" value={totalVus} onChange={(e) => setTotalVus(e.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">Durée</span>
            <input id="duration" type="text" value={duration} onChange={(e) => setDuration(e.target.value)} />
          </label>
        </div>
        <div className="field-row actions">
          <button type="submit" className="btn btn-primary" id="btn-start" disabled={submitting}>
            Lancer le test
          </button>
          <button type="button" className="btn btn-danger" id="btn-stop" onClick={onStop}>
            Stop d'urgence
          </button>
        </div>
        <p className={'form-status' + (formStatus.cls ? ' ' + formStatus.cls : '')}>{formStatus.text}</p>
      </form>
    </section>
  );
}
