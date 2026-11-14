// This script triggers a demo load test via the orchestrator's API.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptAbs = path.join(path.dirname(fileURLToPath(import.meta.url)), 'basic.test.js');

const payload = {
  scenarioOptions: {
    default: { executor: 'constant-vus', vus: 200, duration: '45s' }
  },
  scriptContent: fs.readFileSync(scriptAbs, 'utf8')
};

fetch('http://localhost:3000/api/test/start', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload)
})
.then(res => res.json())
.then(data => console.log('Orchestrator response:', data))
.catch(err => console.error('Error:', err));
