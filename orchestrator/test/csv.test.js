import http from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import papaparse from 'https://jslib.k6.io/papaparse/5.1.1/index.js';

// not using SharedArray here will mean that the code in the function call (that is what loads and
// parses the csv) will be executed per each VU which also means that there will be a complete copy
// per each VU
const csvData = new SharedArray('another data name', function () {
  // Load CSV file and parse it using Papa Parse.
  // The path comes from the environment (`CSV_FILE_PATH`): the scenario runner
  // passes the data file name and uploads it next to the script, so `open()`
  // resolves it exactly like a local run.
  return papaparse.parse(open(__ENV.CSV_FILE_PATH), { header: true }).data;
});

export default function () {
  // Now you can use the CSV data in your test logic below.
  // Below are some examples of how you can access the CSV data.

  // Loop through all username/password pairs
  for (const userPwdPair of csvData) {
    console.log(JSON.stringify(userPwdPair));
  }

  // Pick a random username/password pair
  const randomUser = csvData[Math.floor(Math.random() * csvData.length)];
  console.log('Random user: ', JSON.stringify(randomUser));

  const credentials = `${randomUser.username}:${randomUser.password}`;

  console.log('Random user: ', JSON.stringify(credentials));

  const url = `https://${credentials}@quickpizza.grafana.com/api/basic-auth/${randomUser.username}/${randomUser.password}`;
  const res = http.get(url);
// Verify response
  check(res, {
    'status is 200': (r) => r.status === 200,
    'is authenticated': (r) => r.json().authenticated === true,
    'is correct user': (r) => r.json().user === randomUser.username,
  });

  sleep(1);
}