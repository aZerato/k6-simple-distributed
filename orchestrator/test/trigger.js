import fs from 'fs';

const payload = {
  totalVus: 200,                  // Charge globale voulue
  duration: '45s',                // Durée du test
  scriptContent: fs.readFileSync('./basic.test.js', 'utf8') // Lecture automatique
};

fetch('http://localhost:3000/api/test/start', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload)
})
.then(res => res.json())
.then(data => console.log('Réponse de l\'orchestrateur :', data))
.catch(err => console.error('Erreur :', err));
