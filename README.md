# Networx Affiliate Server

A small Express server that securely proxies requests to the [Networx Affiliates API](https://api.networx.com) — leads (ping/post), phone calls, reports, demand data, and contractor inquiries. Everything lives in `index.js`.

Your `nx_access_key` and `nx_userId` stay server-side only (in `.env`) and are never exposed to the browser.

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env`:

```
PORT=3000
NODE_ENV=development
ALLOWED_ORIGINS=http://localhost:3000
NX_ACCESS_KEY=your_access_key_here
NX_USER_ID=your_user_id_here
NX_API_BASE_URL=https://api.networx.com
CERT_URL=https://cert.trustedform.com/abc123
```

`CERT_URL` is the TrustedForm certificate URL. Networx **requires** it to accept lead posts (otherwise it rejects with `Missing Trusted Form`). If a request omits `cert_url`, the server injects `CERT_URL` automatically. Replace the placeholder with your real TrustedForm cert URL before going live.

Optionally set `INTERNAL_API_KEY` in `.env` to require an `x-api-key` header on every request to your own `/api/*` routes (protects your proxy from being called by strangers who find the URL).

Run it:

```bash
npm start        # production
npm run dev       # auto-restart on file changes (Node 18+)
```

Test zip code **00001** works against Networx's sandbox for all endpoints per their docs.

## Security included

- **helmet** — sensible security headers
- **cors** — locked to `ALLOWED_ORIGINS`, GET/POST only
- **express-rate-limit** — 100 req/15min globally on `/api`, 20 req/5min on submission endpoints (leads/calls/inquiry)
- **hpp** — blocks HTTP parameter pollution
- **express-validator** — every field is validated/sanitized before it's forwarded
- Body size capped at 15kb
- `nx_access_key` / `nx_userId` are injected server-side only — client input can never override them
- Optional `x-api-key` gate via `INTERNAL_API_KEY`
- Centralized error handler that never leaks stack traces in production

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness check |
| POST | `/api/leads/ping` | Check if Networx wants to buy a lead |
| POST | `/api/leads/post` | Submit a full lead (standalone or after a ping, pass `token`) |
| POST | `/api/leads/ping-post` | Convenience: does ping then post automatically in one call |
| POST | `/api/calls/ping` | Ping before forwarding a phone call |
| POST | `/api/calls/post` | Follow-up post for a call (needs `token`) |
| GET | `/api/report?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD` | Pull lead report for a date range |
| GET | `/api/demand` | Get link to CSV of recent bid pricing/demand |
| POST | `/api/inquiry` | Submit a contractor sign-up inquiry |
| GET | `/api/networks` | Reference list of industry name → ID (for `/api/inquiry`) |

### Example: ping then post

```bash
curl -X POST http://localhost:3000/api/leads/ping \
  -H "Content-Type: application/json" \
  -d '{
    "zipcode": "00001",
    "task_id": "12",
    "tcpa_compliance_text": "By submitting, I agree to be contacted..."
  }'
# -> { "token": "...", "price": "...", "statusCode": "..." }

curl -X POST http://localhost:3000/api/leads/post \
  -H "Content-Type: application/json" \
  -d '{
    "f_name": "John",
    "l_name": "Smith",
    "zipcode": "00001",
    "task_id": "12",
    "phone": "8188188188",
    "email": "test@test.com",
    "tcpa_compliance_text": "By submitting, I agree to be contacted...",
    "cert_url": "https://cert.trustedform.com/abc123",
    "token": "<token from ping>"
  }'
```

Or do both in one call with `/api/leads/ping-post`, sending all the fields from both requests at once.

### Example: inquiry

```bash
curl -X POST http://localhost:3000/api/inquiry \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Acme HVAC",
    "contact_name": "Jane Doe",
    "phone": "8188188188",
    "zipcode": "00001",
    "email": "jane@acmehvac.com",
    "networks": [10]
  }'
```

## Notes

- Ping/post must happen within Networx's stated windows (5 minutes for leads, 10 minutes for calls) and post data must match the ping (same `hashed_contacts` / `source_id`). `/api/leads/ping-post` handles this automatically since it fires both requests back to back.
- Responses from Networx are XML; this server parses them into JSON for you.
- `/health` is unauthenticated by design (for load balancer checks); everything under `/api` respects `INTERNAL_API_KEY` if set.
# AC-client
