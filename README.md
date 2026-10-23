# Mesh

[![CI](https://github.com/BitWiseNexus/Mesh/actions/workflows/ci.yml/badge.svg)](https://github.com/BitWiseNexus/Mesh/actions/workflows/ci.yml)

Open-source visual builder for multi-agent AI workflows. Drag nodes (triggers, agents, tools,
knowledge, logic, actions) onto a canvas, connect them, and run them with live streaming.

| Folder | What's in it |
|---|---|
| `frontend/` | Next.js app: flow dashboard and React Flow editor |
| `backend/` | FastAPI API and the flow execution engine |
| `firebase/` | Firestore / Storage security rules and their tests |
| `scripts/` | Local development tooling |

Firebase provides Auth, Firestore and Storage. Local development runs entirely on the Firebase
emulators — no Firebase project or keys needed.

## Prerequisites

- Node.js 24+
- Python tooling: [uv](https://docs.astral.sh/uv/) (installs Python 3.12 for the backend)
- Java 21+ (the Firestore and Storage emulators are Java programs)
- Firebase CLI: `npm install -g firebase-tools`

## Getting started

```bash
npm install --prefix frontend
uv sync --project backend
npm run dev
```

`npm run dev` starts the Firebase emulators, the backend and the frontend, one after another —
open the app once it prints **Ready** (Ctrl+C stops all of them). Services already running in
another terminal are reused, and an emulator left over from an earlier session is stopped first.

| URL | |
|---|---|
| http://localhost:3000 | App |
| http://localhost:8000/docs | API docs |
| http://127.0.0.1:4000 | Firebase emulator UI |

## Running flows

Press **Run** in the editor (or Ctrl+Enter): the flow is saved, executed by the backend, and each
node's status, the agents' streamed replies and a log appear live in the run panel.

Agents call OpenAI, Anthropic or Google Gemini through [LiteLLM](https://docs.litellm.ai/). Add
the keys you have to `backend/.env`:

```bash
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GEMINI_API_KEY=...
```

Users can also save their own keys under **API keys** (account menu): they're stored encrypted
and used automatically for the matching provider. In production, set `CREDENTIALS_ENCRYPTION_KEY`
(see `backend/.env.example`).

No keys yet? Set an agent's model to `mock/echo` (streams its task back) or `mock/tools` (calls
every attached tool once, then reports the results) — no provider involved, available outside
production.

### Tools

Attach nodes to an agent's **Tools** handle and the agent can call them: **Web Search** (Tavily
with a key, DuckDuckGo without), **Web Scraper** (a page's readable text), **API Caller** (any
REST endpoint) and **other agents**. A **Supervisor Agent** leads a team: connect worker agents to
its Tools handle and it splits the task, hands out the parts (in parallel where it can) and
combines the answers. In an API Caller or sub-agent, `{{input.<name>}}` declares a
value the agent fills in. Tools that fetch URLs can't reach private or local addresses in
production.

### Logic and history

**If / Else** continues on True or False (text is compared ignoring case); **Loop** repeats the
nodes on its Loop output until "Max iterations" or until the result contains a stop text, then
continues on Done. **Run history** (toolbar) lists a flow's past runs and replays any of them on
the canvas.

### Approvals

An **Approval Gate** pauses the run until a person approves or rejects (and, if allowed, edits)
what reached it; the run then continues on Approved or Rejected. Waiting runs keep their state in
Firestore, so they can wait for hours and survive restarts. The bell in the header lists
everything waiting for you.

### Knowledge bases

Under **Knowledge**, create a knowledge base and upload PDF, text or Markdown files: they're split
into chunks and embedded (OpenAI or Gemini embedding models; `mock/embedding` works without keys
outside production). A **Retriever** finds the passages that best match a query — as a step, or
as a tool an agent calls — and **Add to Knowledge Base** stores text from a run as a new document.

### Webhooks

A **Webhook** trigger gives its flow a URL, shown in the trigger's settings (with a ready-made curl
command to copy). A request to it with the configured method runs the flow as last saved and
answers `202 {"run_id": …}` right away; the run appears in **Run history**. Add an **HTTP
Response** node to answer with something else: the caller then waits for it and gets its status
code, body (objects as JSON) and headers — or, if the flow takes longer than a minute
(`WEBHOOK_RESPONSE_TIMEOUT_SECONDS`), `202` with the run id. The trigger outputs
the request as `{method, query, headers, body}` (JSON and form bodies are parsed), so later nodes
can use e.g. `{{webhook.output.body.email}}`. Set a secret to require an `X-Mesh-Secret` header.
Bodies are limited to 1 MB and each webhook to 60 requests a minute (`WEBHOOK_MAX_BODY_BYTES`,
`WEBHOOK_REQUESTS_PER_MINUTE`). Pressing **Run** in the editor uses the trigger's Test body
instead of a request. In production the backend (`NEXT_PUBLIC_API_URL`) must be reachable by
whoever calls the URL.

### Email, Slack and Telegram

**Send Email** sends through [Resend](https://resend.com): add a Resend key under **API keys** (or
`RESEND_API_KEY` in `backend/.env`) and send from an address on a domain you verified there
(`EMAIL_FROM` sets the default; Resend's test sender `onboarding@resend.dev` only delivers to your
own Resend account's address). **Slack Message** posts with a Slack bot token (`xoxb-…`, scope
`chat:write`; invite the bot to the channel) and **Telegram Message** sends from a bot made with
[@BotFather](https://t.me/BotFather) (people must start the bot first; long plain-text messages are
split). Save their tokens under **API keys**, or set `SLACK_BOT_TOKEN` / `TELEGRAM_BOT_TOKEN`. All
three have a **Test mode** that shows the message in the run panel instead of sending it.

### Schedules

A **Schedule** trigger runs its flow on a cron expression (`minute hour day month weekday`, e.g.
`0 9 * * 1-5` for 9:00 on weekdays) in the timezone you pick. Its settings show the next run
times — or why it isn't scheduled — and when it last ran; runs appear in **Run history**. The
trigger outputs `{scheduled_at, timezone}`. Switch "Run on this schedule" off to pause it; copies
of a flow start with their schedules off. The backend checks schedules once a minute (set
`SCHEDULER_ENABLED=false` to stop it); a run missed because the server was down is skipped, not
caught up later.

## Tests

```bash
# Backend: lint, then all tests inside throwaway Auth + Firestore emulators on separate ports
# (plain `uv run pytest` skips the emulator tests — they wipe Firestore between tests)
cd backend && uv run ruff check . && cd .. && npm run test:backend

# Frontend: lint, types, unit tests
cd frontend && npm run lint && npm run typecheck && npm test

# Security rules (starts its own emulators on separate ports)
npm install --prefix firebase && npm run test:rules

# End-to-end, full stack (starts or reuses emulators, backend and `next dev`)
cd frontend && npx playwright install chromium && npm run test:e2e

# End-to-end the way CI runs it: fresh emulators, backend and a production build, on ports of
# their own — safe to run next to `npm run dev`
cd frontend && npm run test:e2e:ci
```

CI runs all four suites on every push and pull request (`.github/workflows/ci.yml`).
