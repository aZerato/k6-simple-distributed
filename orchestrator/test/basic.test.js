// This is an example K6 test
import http from 'k6/http';
import { sleep } from 'k6';

export const options = {
  scenarios: JSON.parse(__ENV.K6_SCENARIO_OPTIONS)
};

export default function () {
  http.get('https://k6.io');
  sleep(1);
}
