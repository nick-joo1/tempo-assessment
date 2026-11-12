# Notes

## 1. Running it locally

```bash
npm install
cp .env.example .env    # GITHUB_TOKEN is required; ANTHROPIC_API_KEY enables narratives
npm run dev             # UI on http://127.0.0.1:3000, API docs on /docs
```

Node.js 22.12 or newer. The GitHub token needs no scopes for public repositories. Track a
repository from the UI, or with `curl -X PUT http://127.0.0.1:3000/v1/repos/<owner>/<name>`,
and query it once `sync.coveredFrom` is set. The README has the curl walkthrough, the
configuration table and the Docker variant.

`npm test`, `npm run lint`, `npm run typecheck` and `npm run build` need neither network
nor credentials. `npm run eval` calls the configured model and spends tokens.

## 2. Architecture tour

Ingestion and queries are separate and share only the SQLite database.

`PUT /v1/repos/{owner}/{name}` checks the repository on GitHub and queues it. A background
worker (`src/sync`) pages through its merged pull requests over GraphQL, 50 per request,
each with its reviews and the time it left draft, and upserts them as rows (`src/store`).
The first sync backfills 180 days. Later syncs stop at the first pull request that has not
changed.

Insight requests do not call GitHub. `computeReviewFlow` (`src/insights`) is a pure function
over the stored pull requests of the period and of the equally long period before it. Raw
pull requests are stored, not aggregates, so any period can be queried and a metric
definition can change without fetching anything again.

The narrative (`src/narrative`) is one model call with checks around it. The insight is
flattened into a fact sheet. The model must cite fact ids for every finding and for its
hypothesis. The draft is verified against the sheet, sent back once if it fails, and
returned flagged if it fails again. The server fills in the evidence values and caps the
confidence by sample size. Verified narratives are cached under a hash of their inputs.

The HTTP layer (`src/http`, `src/app.ts`) is Fastify with Zod schemas that validate, type
and document each route. Errors are RFC 9457 problem details. `buildApp` takes its
dependencies as arguments, so the API tests run the real application against a fake GitHub
and a scripted model.

### Main decisions

- GraphQL, not REST. REST needs an extra request per pull request to get its reviews.
  GraphQL returns 50 pull requests with their reviews in one request.
- Sync runs in a background worker, one repository at a time. GitHub usage is predictable
  and the rate limit is handled in one place: when it is nearly used up, the queue pauses
  until the reset. The cost is that the first insight is not available until the first sync
  finishes. Until then the API answers `409 sync_in_progress` with `Retry-After`.
- SQLite with a synchronous driver. It needs no setup, the data survives restarts, and every
  query on the request path is a short indexed read. Moving to Postgres would mean
  rewriting `src/store` and making its callers async.
- All arithmetic is done in code. The model is given the deltas and percentage changes and
  told not to compute its own.
- Evidence values come from the server. The model cites fact ids and the server looks up
  the values, so a cited value cannot be wrong. The prose is then checked number by number.
  A narrative that fails the check is still returned, with a flag and the list of issues,
  so the failure is visible to the reader and in the logs.
- One structured call, not an agent. The whole fact sheet is about 160 lines, so tools
  would add latency and cost without giving the model anything new. That changes if the
  model needs to look at individual pull requests (item 6 below).
- The hypothesis is optional and confidence is capped. The brief asks for a hypothesis
  "where the signal supports one". The prompt requires two independent signals,
  alternatives and a next check. With three pull requests the confidence cannot exceed 0.3,
  whatever the model reports.
- Evals cover what verification does not. Verification checks that the numbers are real.
  The evals check the reasoning on synthetic periods with a known cause, through the same
  service code, and count a bad narrative, a missing narrative and a failed call
  separately. The grader has its own tests, because the evals themselves need a model key.
- No frontend framework. The UI is three ES modules and a stylesheet served as static
  files, with no build step and a strict Content Security Policy.

## 3. With another day

In priority order:

1. Run the evals against the live model several times and adjust the prompt based on what
   fails. Then add a second model as judge for the quality of the reasoning, calibrated on
   a few hand-labelled narratives, add a small golden set of real repositories with known
   history, and run all of it in CI whenever `PROMPT_VERSION` changes.
2. Count open pull requests. The metric only sees merged ones, so a review stall shows up
   only when those pull requests finally merge. The age of open pull requests waiting for a
   first review would show it earlier.
3. Generate the narrative for the default period after each sync instead of on request, and
   stream the others, so a request does not wait for the model.
4. Use a GitHub App with webhooks instead of a token and polling: fresher data, a rate
   limit per installation, and access an organisation can grant and revoke.
5. Add authentication and budgets: API keys, `trustProxy` behind a load balancer, and a
   token budget per key for narratives instead of a request rate per address.
6. Give the model one read-only tool that lists pull requests by filter, limited to a few
   calls, for when a hypothesis depends on detail the fact sheet lacks.
7. Add browser tests for the UI and a control to stop tracking a repository.

At a larger scale: Postgres, sync workers in separate processes behind a queue, daily
aggregates per repository so an insight is not recomputed on every request, and for private
repositories pseudonymised logins in the prompt, mapped back after the model answers.
Verification failures, repair attempts, token counts and latency are already logged per
model call and could be exported as metrics.

## 4. What AI was used for

Claude Code (Anthropic's coding agent, on Claude Fable 5.2) generated the UI in `public/`
and the tests in `test/`. The metric, the architecture and the rest of the code were
written by hand.

At runtime the service uses Claude (`claude-opus-5-5` by default) for one thing: writing
the narrative. Every number the model sees, and every number it is allowed to write, is
computed in code.

## What was run

- The test suite, type checker, linter and production build.
- The compiled server, probed with curl.
- The UI in a headless browser at desktop, tablet and phone widths, in light and dark mode,
  on synthetic data: a sync in progress, a quiet period, a flagged narrative, and a server
  without a model key.
- The three GraphQL documents the service sends, validated against GitHub's published
  schema.
- The eval runner, against a local stand-in for the model API.

Not run: a sync against the real GitHub API, a real model call, the evals against a real
model, and the Docker image build. The machine this was built on had no credentials and no
Docker. The narrative example in the README says which of its parts are real output.

## Known limits

### The metric

- Only merged pull requests are counted. Open and abandoned ones are not (see item 2 in
  section 3).
- Durations are calendar hours. A pull request opened on Friday evening waits the weekend.
- Bots are recognised by GitHub's account type or a `[bot]` suffix. An automation running
  as an ordinary user account counts as a person.
- The wait for review starts when a pull request becomes reviewable, not when a review was
  requested from a particular person.
- History older than the lookback window is never pruned.

### The narrative

- Verification checks numbers, dates and pull request numbers. It does not check reasoning
  or adjectives. Whole numbers up to 10 are treated as counting words and not checked.
  Numbers in the headline and summary must match a fact cited somewhere in the narrative,
  not in a specific finding.
- Confidence is the model's own estimate under a heuristic cap. It is not calibrated
  against outcomes.
- The narrative endpoint is a `GET` that may call a model and take tens of seconds. It is
  idempotent and cached, but a job resource with polling would suit a slower model better.
- A narrative that stays flagged is not cached, so each request for it costs two model
  calls. The route's rate limit bounds that. A global token budget would be better.
- The evals use synthetic periods with clear signals. They do not show how the narrative
  does on a real repository.

### The service

- No authentication. It binds to loopback, caps tracked repositories, refuses private ones
  and rate-limits per client address. `trustProxy` is not configured, so behind a reverse
  proxy all clients would share one address.
- One process and one SQLite file. The sync worker, the rate-limit counters and the
  in-flight narrative de-duplication live in memory and do not scale horizontally.
- An insight is recomputed on every request. The ETag saves the response body, not the
  computation. For the window stored per repository that is milliseconds, on the event
  loop.
- A first sync that fails restarts from the beginning. Upserts make the repeat safe, but it
  spends the same requests again.
- The readiness check covers only the database. A GitHub or model outage does not make the
  service unready, because restarting it would not help.
- The HSTS header is sent although the process speaks plain HTTP. TLS is expected at a
  proxy. Swagger UI logs one Content Security Policy violation for an inline style, and the
  policy was not loosened for it.
- The UI has no automated tests, shows fact ids verbatim as evidence labels, and asks for a
  narrative only on an explicit click, because each one spends tokens.
