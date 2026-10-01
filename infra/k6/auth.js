// k6 load test for the OTP login path (excluding SMS provider latency).
//   k6 run -e BASE_URL=http://localhost:4001 infra/k6/auth.js
// Use a staging build with relaxed per-phone/IP OTP limits; production limits will (correctly) throttle this.
import http from 'k6/http';
import { check } from 'k6';

export const options = {
  scenarios: {
    request_otp: {
      executor: 'constant-arrival-rate',
      rate: 200,
      timeUnit: '1s',
      duration: '2m',
      preAllocatedVUs: 50,
    },
  },
  thresholds: {
    // docs/architecture/07-operations.md §3 targets
    'http_req_duration{scenario:request_otp}': ['p(50)<30', 'p(95)<100', 'p(99)<200'],
    http_req_failed: ['rate<0.001'],
  },
};

const BASE = __ENV.BASE_URL || 'http://localhost:4001';

export default function () {
  const phone = `017${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
  const res = http.post(`${BASE}/api/v1/auth/request-otp`, JSON.stringify({ phone }), {
    headers: { 'content-type': 'application/json' },
  });
  check(res, { accepted: (r) => r.status === 202 });
}
