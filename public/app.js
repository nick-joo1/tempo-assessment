/**
 * The page: choose a repository and a period, see its review-flow numbers, and ask the
 * model to explain them. Each piece of evidence the model cites is a button that points at
 * the number it names.
 */
import { renderRecord } from './record.js';
import { fill, fmt, fmtInstant, h } from './ui.js';

const DAY_MS = 86_400_000;
const SYNC_POLL_MS = 2000;

const byId = (id) => document.getElementById(id);
const repoSelect = byId('repo');
const trackForm = byId('track');
const trackInput = byId('track-name');
const notice = byId('notice');
const view = byId('view');
const reading = byId('reading');
const record = byId('record');

const state = {
  /** `owner/name` of the repository on screen. */
  repo: null,
  days: 30,
  insight: null,
  /** Counts what the page was asked to show, so that a slow response for an earlier choice is dropped. */
  request: 0,
  /** Fact id that stays highlighted after its evidence button was pressed. */
  pinned: null,
  /** Shown with the numbers when they are older than they should be. */
  warning: '',
  recordWidth: 0,
};

class ApiError extends Error {
  constructor(status, problem) {
    super(problem?.detail ?? `The request failed (HTTP ${status}).`);
    this.code = problem?.code;
  }
}

async function api(path, options) {
  const response = await fetch(path, options);
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, body);
  return body;
}

const repoPath = (repo) => `/v1/repos/${repo.split('/').map(encodeURIComponent).join('/')}`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function say(message) {
  notice.textContent = message;
}

/** Loads the tracked repositories into the picker and opens `preferred`, or the first one. */
async function loadRepos(preferred) {
  const { repositories } = await api('/v1/repos');
  const names = repositories.map((repo) => `${repo.owner}/${repo.name}`);
  fill(
    repoSelect,
    names.map((name) => h('option', {}, name)),
  );
  repoSelect.disabled = names.length === 0;
  if (names.length === 0) {
    view.hidden = true;
    say('No repository is tracked yet. Enter one as owner/name, for example fastify/fastify.');
    trackInput.focus();
    return;
  }
  repoSelect.value = names.includes(preferred) ? preferred : names[0];
  await openRepo(repoSelect.value);
}

/** Waits for the repository's first sync if it is still running, then shows its numbers. */
async function openRepo(repo) {
  const request = ++state.request;
  state.repo = repo;
  history.replaceState(null, '', `#${repo}`);
  view.hidden = true;

  for (;;) {
    const { sync } = await api(repoPath(repo));
    if (request !== state.request) return;
    if (sync.coveredFrom !== null) {
      state.warning =
        sync.state === 'failed'
          ? `The latest sync of ${repo} failed: ${sync.error} These numbers are from the sync before it.`
          : '';
      break;
    }
    if (sync.state === 'failed') {
      say(`The first sync of ${repo} failed: ${sync.error} Track it again to retry.`);
      return;
    }
    say(
      `Fetching the merged pull requests of ${repo} from GitHub: ${fmt(sync.pullRequests)} so far. The numbers appear here when the first sync is done.`,
    );
    await delay(SYNC_POLL_MS);
    if (request !== state.request) return;
  }
  await showInsight(request);
}

async function showInsight(request) {
  const from = new Date(Date.now() - (state.days - 1) * DAY_MS).toISOString().slice(0, 10);
  // The previous numbers stay in place, dimmed, until the new ones arrive.
  record.classList.add('stale');
  try {
    const insight = await api(`${repoPath(state.repo)}/insights/review-flow?from=${from}`);
    if (request !== state.request) return;
    state.insight = insight;
    state.pinned = null;
    say(state.warning);
    view.hidden = false;
    drawRecord();
    offerNarrative();
  } catch (error) {
    // Numbers for another period or repository must not stay up under the new choice.
    if (request === state.request) view.hidden = true;
    throw error;
  } finally {
    record.classList.remove('stale');
  }
}

function drawRecord() {
  state.recordWidth = record.clientWidth;
  renderRecord(record, state.insight);
  cite(state.pinned);
}

function offerNarrative() {
  fill(
    reading,
    h(
      'p',
      {},
      'Ask a language model what stands out in these numbers and what might explain it. It may cite only the figures on this page, and every number it writes is checked against them.',
    ),
    h('button', { type: 'button', id: 'explain' }, 'Explain these numbers'),
    h('p', { id: 'explain-error', class: 'error', role: 'alert' }),
  );
}

async function explain(button) {
  const { request, repo } = state;
  const { from, to } = state.insight.period;
  const query = `from=${from}&to=${to}`;
  button.disabled = true;
  button.textContent = 'Reading the numbers. This can take a minute.';
  try {
    const narrative = await api(`${repoPath(repo)}/insights/review-flow/narrative?${query}`);
    if (request !== state.request) return;
    if (narrative.dataAsOf !== state.insight.dataAsOf) {
      // A sync finished in between: redraw the numbers the narrative was written about.
      state.insight = await api(`${repoPath(repo)}/insights/review-flow?${query}`);
      if (request !== state.request) return;
      drawRecord();
    }
    fill(reading, narrativeParts(narrative));
  } catch (error) {
    if (request !== state.request) return;
    button.disabled = false;
    button.textContent = 'Explain these numbers';
    byId('explain-error').textContent = error.message;
  }
}

const label = (text) => h('h3', { class: 'label' }, text);
const written = (tag, text, extra = '') => h(tag, { class: `model ${extra}`.trim() }, text);

function narrativeParts(narrative) {
  const { hypothesis, confidence, verification } = narrative;
  const verified = verification.status === 'verified';
  const meter = h('div', { class: 'confidence-meter' }, h('span', {}), h('i', {}));
  meter.style.setProperty('--score', confidence.score);
  meter.style.setProperty('--ceiling', confidence.ceiling);

  return [
    written('h2', narrative.headline, 'headline'),
    written('p', narrative.summary, 'summary'),
    narrative.findings.map((finding) =>
      h(
        'article',
        { class: 'finding' },
        written('h3', finding.title),
        written('p', finding.detail),
        evidence(finding.evidence),
      ),
    ),
    hypothesis
      ? h(
          'section',
          { class: 'hypothesis' },
          label('Hypothesis'),
          written('p', hypothesis.statement, 'statement'),
          written('p', hypothesis.reasoning),
          evidence(hypothesis.evidence),
          label('It could also be'),
          h(
            'ul',
            { class: 'model' },
            hypothesis.alternatives.map((other) => h('li', {}, other)),
          ),
          label('How to check'),
          written('p', hypothesis.nextCheck),
        )
      : narrative.model &&
        h(
          'p',
          { class: 'aside' },
          'The model offered no hypothesis: too few signals point the same way.',
        ),
    h(
      'section',
      {},
      label('Confidence'),
      h('p', { class: 'confidence-score' }, h('strong', {}, fmt(confidence.score)), ' out of 1'),
      meter,
      written('p', confidence.rationale),
      h(
        'p',
        { class: 'aside' },
        confidence.modelScore !== null &&
          confidence.modelScore > confidence.score &&
          `The model said ${fmt(confidence.modelScore)}. `,
        `This data supports ${fmt(confidence.ceiling)} at most. ${confidence.ceilingReason}`,
      ),
    ),
    narrative.caveats.length > 0 &&
      h(
        'section',
        {},
        label('Caveats'),
        h(
          'ul',
          { class: 'model' },
          narrative.caveats.map((caveat) => h('li', {}, caveat)),
        ),
      ),
    h(
      'footer',
      { class: 'provenance' },
      h(
        'p',
        { class: verified ? 'status good' : 'status bad' },
        verified ? '✓ Verified' : '! Flagged',
      ),
      h(
        'p',
        {},
        verified
          ? 'Every number in this text matches a figure it cites.'
          : 'Parts of this text could not be matched to the data, even after the model was asked to correct them. Read it with suspicion.',
      ),
      !verified &&
        h(
          'ul',
          {},
          verification.issues.map((issue) => h('li', {}, issue)),
        ),
      h(
        'p',
        { class: 'aside' },
        narrative.model
          ? `Written by ${narrative.model} in ${verification.attempts === 1 ? 'one call' : `${verification.attempts} calls`}, ${fmtInstant(narrative.generatedAt)}${narrative.cached ? ', and served from the cache' : ''}.`
          : 'Written without a model: there was nothing to interpret.',
      ),
    ),
  ];
}

/** The facts a statement rests on, each with the value the server resolved for it. */
function evidence(facts) {
  return h(
    'ul',
    { class: 'evidence', 'aria-label': 'Evidence' },
    facts.map(({ fact, value }) =>
      h(
        'li',
        {},
        h(
          'button',
          { type: 'button', 'data-cites': fact, title: 'Show this number' },
          fact,
          ' ',
          h('strong', {}, typeof value === 'number' ? fmt(value) : (value ?? 'n/a')),
        ),
      ),
    ),
  );
}

/**
 * Highlights the number a fact id names, or the thing it describes when the value itself
 * is not on screen (`topReviewers[octocat]` for `topReviewers[octocat].approvals`).
 */
function cite(factId) {
  for (const marked of record.querySelectorAll('.cited')) marked.classList.remove('cited');
  if (!factId) return [];
  const candidates = [...record.querySelectorAll('[data-fact]')];
  const subject = factId.slice(0, factId.lastIndexOf('.'));
  let targets = candidates.filter((element) => element.dataset.fact === factId);
  if (targets.length === 0)
    targets = candidates.filter((element) => element.dataset.fact === subject);
  for (const target of targets) target.classList.add('cited');
  return targets;
}

const citedBy = (event) => event.target.closest?.('[data-cites]')?.dataset.cites;

reading.addEventListener('pointerover', (event) => {
  const factId = citedBy(event);
  if (factId) cite(factId);
});
reading.addEventListener('focusin', (event) => {
  const factId = citedBy(event);
  if (factId) cite(factId);
});
reading.addEventListener('pointerout', () => cite(state.pinned));
reading.addEventListener('focusout', () => cite(state.pinned));
reading.addEventListener('click', (event) => {
  if (event.target.id === 'explain') {
    explain(event.target);
    return;
  }
  const factId = citedBy(event);
  if (!factId) return;
  state.pinned = factId;
  const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  cite(factId)[0]?.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' });
});

/** Runs a user action and reports its failure in the notice under the controls. */
async function attempt(action) {
  try {
    await action();
  } catch (error) {
    say(error.message);
  }
}

repoSelect.addEventListener('change', () => attempt(() => openRepo(repoSelect.value)));

byId('period').addEventListener('change', (event) => {
  state.days = Number(event.target.value);
  if (state.repo) attempt(() => showInsight(++state.request));
});

trackForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const match = /^(?:https:\/\/github\.com\/)?([\w-]+)\/([\w.-]+?)\/?$/.exec(
    trackInput.value.trim(),
  );
  if (!match) {
    say('Enter the repository as owner/name, for example fastify/fastify.');
    return;
  }
  attempt(async () => {
    const repo = await api(`/v1/repos/${match[1]}/${match[2]}`, { method: 'PUT' });
    trackInput.value = '';
    await loadRepos(`${repo.owner}/${repo.name}`);
  });
});

// The trend chart is drawn for the width it has, so it is redrawn when that changes.
new ResizeObserver(() => {
  if (state.insight && !view.hidden && record.clientWidth !== state.recordWidth) drawRecord();
}).observe(record);

attempt(() => loadRepos(location.hash.slice(1)));
