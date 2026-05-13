# OutboundAI MVP (prompt-aligned)

## 1) Supabase
1. Create project in Supabase.
2. Run SQL from `supabase/schema_v2.sql` in SQL Editor.
3. Copy Postgres URI to `.env` as `DATABASE_URL`.

## 2) App start
```bash
cp .env.example .env
npm install
npm run dev
```

Health:
```bash
curl http://localhost:3000/health
```

## 3) Test /handle-turn
```bash
curl -X POST http://localhost:3000/handle-turn \
  -H "Content-Type: application/json" \
  -d '{
    "project":"rheinpfalz",
    "call_id":"test-identity-1",
    "current_state":"identity_gate",
    "customer_text":"ja",
    "lead":{
      "salutation":"Herr",
      "first_name":"Max",
      "last_name":"Mustermann",
      "street":"Hauptstr. 12",
      "city":"Ludwigshafen",
      "email":"max@example.com"
    },
    "context":{
      "identity_confirmed":true,
      "address_confirmed":false,
      "email_confirmed":false,
      "selected_variant":"digital",
      "rejection_count":0,
      "human_recovery_attempted":false
    }
  }'
```

## 4) ElevenLabs Server Tool mapping
- Endpoint: `POST https://YOUR_DOMAIN/handle-turn`
- Required input: `project`, `call_id`, `current_state`, `customer_text`
- Recommended input: `lead`, `context`
- Use output fields:
  - `response` -> assistant speech
  - `next_state` -> pass to next turn
  - `end_call` -> terminate call
  - `handoff` / `handoff_reason` -> handoff tool trigger
  - `context_patch` -> merge into conversation context before next turn

Example `context_patch` handling:
- if response returns `{ "context_patch": { "selected_variant":"digital" } }`
- update your runtime context and send it back in next `/handle-turn` request

## 5) Post-call webhook
Set ElevenLabs post-call webhook URL:
`POST https://YOUR_DOMAIN/webhook/post-call`

Webhook result:
- writes/upserts `call_logs`
- appends raw payload to `call_events`

## 6) Queue smoke test
```sql
insert into leads(project_id, first_name, last_name, phone)
select id, 'Jan', 'Nowak', '+49123456789' from projects where project_key='rheinpfalz'
returning id;

insert into call_queue(project_id, lead_id)
select p.id, '<lead_uuid>'::uuid from projects p where p.project_key='rheinpfalz';
```

Run worker once:
```bash
npm run worker
```

## 7) Prepare lead payload (step 5 quick start)
Create runtime payload for one lead:
```bash
curl -X POST http://localhost:3010/prepare-call \
  -H "Content-Type: application/json" \
  -d '{"project":"rheinpfalz","lead_id":"<lead_uuid>"}'
```

This returns:
- `lead` object (`salutation`, `first_name`, `last_name`, `street`, `city`, `email`)
- default `context` ready for first turn

## 8) Minimal-Latenztest (A/B/C)
Endpoint:
`POST /api/latency-probe?mode=A|B|C`

Modes:
- `A`: fixed response (no DB, no LLM)
- `B`: intent + rules only (no LLM)
- `C`: like `B` + optional LLM fallback (only if `LLM_FALLBACK_ENABLED=true`)

Example:
```bash
curl -X POST "http://localhost:3010/api/latency-probe?mode=A" \
  -H "Content-Type: application/json" \
  -d '{"state":"intro","customer_text":"Hallo"}'
```

Response contains:
- `metrics.backend_ms`
- `response_source`
- `intent`

ElevenLabs test:
- Point webhook tool URL to `/api/latency-probe?mode=A`
- If call latency is still high (>1s-2s), bottleneck is not your knowledge logic.
