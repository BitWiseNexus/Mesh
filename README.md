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

`npm run dev` starts the Firebase emulators, the backend and the frontend together (Ctrl+C stops
all of them). Services already running in another terminal are reused.

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

No keys yet? Set an agent's model to `mock/echo`: it streams its task back without calling any
provider (available outside production). Nodes that can't run yet (If / Else, Loop, Approval Gate,
tools) are reported when you press Run.

## Tests

```bash
# Backend: lint + tests (Firestore/Auth tests run when the emulators are up)
cd backend && uv run ruff check . && uv run pytest

# Frontend: lint, types, unit tests
cd frontend && npm run lint && npm run typecheck && npm test

# Security rules (starts its own emulators on separate ports)
npm install --prefix firebase && npm run test:rules

# End-to-end, full stack (starts or reuses emulators, backend and frontend)
cd frontend && npx playwright install chromium && npm run test:e2e
```

CI runs all four suites on every push and pull request (`.github/workflows/ci.yml`).
