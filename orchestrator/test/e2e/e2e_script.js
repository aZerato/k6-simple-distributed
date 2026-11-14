import http from 'k6/http';
import { check } from 'k6';

export const options = { scenarios: JSON.parse(__ENV.K6_SCENARIO_OPTIONS) };

export default function () {
  const res = http.get('https://k6.io');
  check(res, { 'status is 200': (r) => r.status === 200 });
}
