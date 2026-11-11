// This script triggers a load test via the orchestrator's API.
import fs from 'fs';

const payload = {
  totalVus: 200,                  // Desired global load
  duration: '45s',                // Test duration
  scriptContent: fs.readFileSync('./basic.test.js', 'utf8') // Automatic read
};

fetch('http://localhost:3000/api/test/start', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload)
})
.then(res => res.json())
.then(data => console.log('Orchestrator response:', data))
.catch(err => console.error('Error:', err));
