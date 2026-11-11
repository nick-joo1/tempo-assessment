/**
 * The numbers: one review-flow insight drawn as figures and tables. Every value that the
 * narrative can cite carries its fact id in `data-fact`, which is how a piece of evidence
 * finds the number it points to.
 */
import { fill, fmt, fmtDay, fmtInstant, h, hours, s, signed, tip } from './ui.js';

/** Metric key, label and the unit that follows its values, in reading order. */
const METRICS = [
  ['mergedPullRequests', 'Merged pull requests', ''],
  ['botPullRequests', 'Merged pull requests by bots, left out below', ''],
  ['activeAuthors', 'Authors', ''],
  ['cycleTimeP50Hours', 'Time to merge, median', ' h'],
  ['cycleTimeP90Hours', 'Time to merge, 90th percentile', ' h'],
  ['timeToFirstReviewP50Hours', 'Wait for first review, median', ' h'],
  ['timeToFirstReviewP90Hours', 'Wait for first review, 90th percentile', ' h'],
  ['firstReviewToMergeP50Hours', 'First review to merge, median', ' h'],
  ['firstReviewWaitSharePct', 'Share of time spent waiting for first review', '%'],
  ['mergedWithoutReviewPct', 'Merged without review', '%'],
  ['prSizeP50Lines', 'Pull request size, median', ' lines'],
  ['reviewsSubmitted', 'Reviews', ''],
  ['reviewsPerPullRequest', 'Reviews per pull request', ''],
  ['activeReviewers', 'Reviewers', ''],
  ['topReviewerSharePct', 'Share of reviews by the busiest reviewer', '%'],
  ['reviewersForHalfOfReviews', 'Reviewers who submitted half of the reviews', ''],
];

const withUnit = (value, unit) => (value === null ? '–' : `${fmt(value)}${unit}`);
/** A change in a percentage is a number of percentage points, not a percentage. */
const deltaUnit = (unit) => (unit === '%' ? ' points' : unit);
const fact = (id, text) => h('span', { 'data-fact': id }, text);
const plural = (count, noun) => `${fmt(count)} ${noun}${count === 1 ? '' : 's'}`;

/** Replaces the content of `root` with the insight, laid out for `root`'s current width. */
export function renderRecord(root, insight) {
  const merged = insight.metrics.mergedPullRequests.current;
  const { paddingLeft, paddingRight } = getComputedStyle(root);
  const width = root.clientWidth - Number.parseFloat(paddingLeft) - Number.parseFloat(paddingRight);
  fill(
    root,
    periodLine(insight),
    merged === 0
      ? h('p', { class: 'empty' }, emptyMessage(insight))
      : [
          tiles(insight),
          waitShare(insight),
          trend(insight.weekly, width),
          sizes(insight.sizeBuckets),
          reviewers(insight),
          metricsTable(insight),
          slowest(insight),
          authors(insight),
        ],
  );
}

function emptyMessage({ metrics }) {
  const bots = metrics.botPullRequests.current;
  return `No pull requests by human authors were merged in this period${
    bots > 0 ? `; ${plural(bots, 'bot pull request')} were` : ''
  }. Try a longer period.`;
}

function periodLine({ period, baselinePeriod, dataAsOf }) {
  return h(
    'p',
    { class: 'period' },
    fact('period.from', period.from),
    ' to ',
    fact('period.to', period.to),
    ', ',
    fact('period.days', `${period.days} days`),
    '. ',
    baselinePeriod
      ? [
          'Compared with the ',
          fact('baselinePeriod.days', `${baselinePeriod.days} days`),
          ' before, ',
          fact('baselinePeriod.from', baselinePeriod.from),
          ' to ',
          fact('baselinePeriod.to', baselinePeriod.to),
          '.',
        ]
      : 'The synced history does not reach back far enough for a comparison.',
    ` Days are UTC. Data as of ${fmtInstant(dataAsOf)}.`,
  );
}

function section(title, note, ...body) {
  return h(
    'section',
    { class: 'block' },
    h('h3', {}, title),
    note && h('p', { class: 'note' }, note),
    body,
  );
}

/** Entries are `[series, label]`. Lines are keyed by a stroke, bars by a swatch. */
function legend(entries, lines = false) {
  return h(
    'ul',
    { class: lines ? 'legend lines' : 'legend' },
    entries.map(([series, label]) => h('li', {}, h('span', { class: `key key-${series}` }), label)),
  );
}

function tiles(insight) {
  const days = insight.period.days;
  const tile = (key, label, unit, lowerIsBetter) => {
    const { current, baseline, delta } = insight.metrics[key];
    let change = h(
      'p',
      { class: 'tile-delta' },
      `Nothing to compare with in the ${days} days before`,
    );
    if (baseline !== null && delta === 0) {
      change = h('p', { class: 'tile-delta' }, `Unchanged from the ${days} days before`);
    } else if (baseline !== null && delta !== null) {
      const verdict = lowerIsBetter ? (delta < 0 ? ' good' : ' bad') : '';
      change = h(
        'p',
        { class: `tile-delta${verdict}` },
        `${delta > 0 ? '▲' : '▼'} ${withUnit(Math.abs(delta), deltaUnit(unit))}`,
        h('span', {}, ` against the ${days} days before`),
      );
    }
    return h(
      'div',
      { class: 'tile' },
      h('p', { class: 'tile-label' }, label),
      h(
        'p',
        { class: 'tile-value', 'data-fact': `metrics.${key}.current` },
        withUnit(current, unit),
      ),
      change,
    );
  };
  return h(
    'div',
    { class: 'tiles' },
    tile('mergedPullRequests', 'Merged pull requests', '', false),
    tile('cycleTimeP50Hours', 'Median time to merge', ' h', true),
    tile('timeToFirstReviewP50Hours', 'Median wait for first review', ' h', true),
    tile('mergedWithoutReviewPct', 'Merged without review', '%', false),
  );
}

/** Two meters: the share of a pull request's open time that passed before anyone reviewed it. */
function waitShare({ metrics, baselinePeriod }) {
  const { current, baseline } = metrics.firstReviewWaitSharePct;
  const row = (label, value, id) => {
    const meter = h('span', { class: 'meter' }, h('span', { class: 'meter-fill' }));
    meter.style.setProperty('--share', (value ?? 0) / 100);
    return h(
      'div',
      { class: 'meter-row' },
      h('span', {}, label),
      value === null ? h('span', { class: 'quiet' }, 'No reviewed pull requests') : meter,
      value !== null && h('strong', { 'data-fact': id }, `${fmt(value)}%`),
    );
  };
  return section(
    'Where the time goes',
    'Share of its time open that the median reviewed pull request spent waiting for a first review.',
    row('This period', current, 'metrics.firstReviewWaitSharePct.current'),
    baselinePeriod && row('Period before', baseline, 'metrics.firstReviewWaitSharePct.baseline'),
  );
}

/** Rounds up to 1, 2, 2.5 or 5 times a power of ten, so the axis ends on a clean number. */
function niceCeiling(value) {
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return [1, 2, 2.5, 5, 10].map((step) => step * magnitude).find((nice) => nice >= value);
}

/** An SVG path through the points, broken wherever a point is missing. */
function pathThrough(points) {
  let path = '';
  let drawing = false;
  for (const point of points) {
    if (point) path += `${drawing ? 'L' : 'M'}${point.x},${point.y}`;
    drawing = Boolean(point);
  }
  return path;
}

/**
 * Weekly medians as lines, and below them the weekly merge count as columns. The two
 * panels share the weeks but not a value axis: hours and counts are different units.
 */
function trend(weekly, availableWidth) {
  const width = Math.max(300, availableWidth);
  const left = 40;
  const right = 56;
  const top = 10;
  const linesHeight = 150;
  const countsTop = top + linesHeight + 44;
  const countsHeight = 44;
  const height = countsTop + countsHeight + 26;
  const band = (width - left - right) / weekly.length;
  const center = (index) => left + band * (index + 0.5);

  const hoursMax = niceCeiling(
    Math.max(
      1,
      ...weekly.flatMap((w) => [w.cycleTimeP50Hours ?? 0, w.timeToFirstReviewP50Hours ?? 0]),
    ),
  );
  const countMax = Math.max(1, ...weekly.map((week) => week.mergedPullRequests));
  const hoursY = (value) => top + linesHeight * (1 - value / hoursMax);
  const countsBase = countsTop + countsHeight;

  const series = (key, name) => {
    const points = weekly.map((week, index) =>
      week[key] === null ? null : { x: center(index), y: hoursY(week[key]), week },
    );
    return [
      s('path', { class: `line stroke-${name}`, d: pathThrough(points) }),
      points.filter(Boolean).map(({ x, y, week }) =>
        s('circle', {
          class: `dot fill-${name}`,
          cx: x,
          cy: y,
          r: 4,
          'data-fact': `weekly[${week.start}].${key}`,
        }),
      ),
    ];
  };

  // An end label names the last value of each line, unless the two would sit on top of each other.
  const ends = ['cycleTimeP50Hours', 'timeToFirstReviewP50Hours']
    .map((key) => {
      const index = weekly.findLastIndex((week) => week[key] !== null);
      return index < 0
        ? null
        : { x: center(index) + 10, y: hoursY(weekly[index][key]), text: hours(weekly[index][key]) };
    })
    .filter(Boolean);
  const endsCollide = ends.length === 2 && Math.abs(ends[0].y - ends[1].y) < 16;

  const columnWidth = Math.min(24, band * 0.6);
  const labelEvery = Math.ceil(52 / band);
  const crosshair = s('line', {
    class: 'crosshair',
    y1: top,
    y2: countsBase,
    visibility: 'hidden',
  });

  const weeks = weekly.map((week, index) => {
    const x = center(index);
    const columnHeight = (week.mergedPullRequests / countMax) * countsHeight;
    const corner = Math.min(4, columnHeight);
    const hit = tip(
      s('rect', {
        class: 'week',
        x: x - band / 2,
        y: top,
        width: band,
        height: countsBase - top,
        tabindex: 0,
        'data-fact': `weekly[${week.start}]`,
        'aria-label': `Week of ${fmtDay(week.start)}: ${plural(week.mergedPullRequests, 'merged pull request')}, median time to merge ${hours(week.cycleTimeP50Hours)}, median wait for first review ${hours(week.timeToFirstReviewP50Hours)}`,
      }),
      `Week of ${fmtDay(week.start)}${week.days < 7 ? `, ${plural(week.days, 'day')} so far` : ''}`,
      [
        [hours(week.cycleTimeP50Hours), 'median time to merge', 'whole'],
        [hours(week.timeToFirstReviewP50Hours), 'median wait for first review', 'wait'],
        [fmt(week.mergedPullRequests), 'merged', 'quiet'],
      ],
    );
    const aim = (visible) => () => {
      crosshair.setAttribute('x1', x);
      crosshair.setAttribute('x2', x);
      crosshair.setAttribute('visibility', visible ? 'visible' : 'hidden');
    };
    hit.addEventListener('pointerenter', aim(true));
    hit.addEventListener('focus', aim(true));
    hit.addEventListener('pointerleave', aim(false));
    hit.addEventListener('blur', aim(false));

    return [
      hit,
      columnHeight > 0 &&
        s('path', {
          class: 'fill-quiet',
          'data-fact': `weekly[${week.start}].mergedPullRequests`,
          d: `M${x - columnWidth / 2},${countsBase}v${corner - columnHeight}q0,${-corner} ${corner},${-corner}h${columnWidth - 2 * corner}q${corner},0 ${corner},${corner}v${columnHeight - corner}z`,
        }),
      index % labelEvery === 0 &&
        s(
          'text',
          { class: 'tick', x, y: countsBase + 18, 'text-anchor': 'middle' },
          fmtDay(week.start),
        ),
    ];
  });

  const chart = s(
    'svg',
    {
      class: 'trend',
      width,
      height,
      viewBox: `0 0 ${width} ${height}`,
      role: 'group',
      'aria-label': 'Weekly trend',
    },
    [0, hoursMax / 2, hoursMax].map((value) => [
      s('line', {
        class: value === 0 ? 'axis' : 'grid',
        x1: left,
        x2: width - right,
        y1: hoursY(value),
        y2: hoursY(value),
      }),
      s(
        'text',
        { class: 'tick', x: left - 8, y: hoursY(value) + 4, 'text-anchor': 'end' },
        fmt(value),
      ),
    ]),
    s('text', { class: 'tick', x: left, y: countsTop - 12 }, 'Merged pull requests'),
    s('line', { class: 'axis', x1: left, x2: width - right, y1: countsBase, y2: countsBase }),
    s(
      'text',
      { class: 'tick', x: left - 8, y: countsTop + 4, 'text-anchor': 'end' },
      fmt(countMax),
    ),
    s('text', { class: 'tick', x: left - 8, y: countsBase + 4, 'text-anchor': 'end' }, '0'),
    crosshair,
    weeks,
    series('cycleTimeP50Hours', 'whole'),
    series('timeToFirstReviewP50Hours', 'wait'),
    !endsCollide &&
      ends.map(({ x, y, text }) => s('text', { class: 'end-label', x, y: y + 4 }, text)),
  );

  return section(
    'Week by week',
    'Median hours per week of merges.',
    legend(
      [
        ['whole', 'Time to merge'],
        ['wait', 'Wait for first review'],
      ],
      true,
    ),
    chart,
    h(
      'details',
      {},
      h('summary', {}, 'Show as a table'),
      table(
        [
          { label: 'Week of', cell: (week) => fmtDay(week.start) },
          { label: 'Merged', numeric: true, cell: (week) => fmt(week.mergedPullRequests) },
          { label: 'Time to merge', numeric: true, cell: (week) => hours(week.cycleTimeP50Hours) },
          {
            label: 'Wait for first review',
            numeric: true,
            cell: (week) => hours(week.timeToFirstReviewP50Hours),
          },
        ],
        weekly,
      ),
    ),
  );
}

/** A horizontal bar with its labels at the tip. `share` is the bar's length, 0 to 1. */
function bar(series, share, ...labels) {
  const mark = h('span', { class: `bar fill-${series}` });
  mark.style.setProperty('--share', share);
  return h('div', { class: 'bar-line' }, mark, labels);
}

function sizes(buckets) {
  const longest = Math.max(
    1,
    ...buckets.flatMap((b) => [b.cycleTimeP50Hours ?? 0, b.timeToFirstReviewP50Hours ?? 0]),
  );
  return section(
    'Size and speed',
    'Median hours by pull request size, in changed lines.',
    legend([
      ['whole', 'Time to merge'],
      ['wait', 'Wait for first review'],
    ]),
    buckets.map((bucket) => {
      const id = `sizeBuckets[${bucket.label}]`;
      const range =
        bucket.maxLines === null
          ? `${fmt(bucket.minLines)} lines or more`
          : `${fmt(bucket.minLines)} to ${fmt(bucket.maxLines)} lines`;
      return h(
        'div',
        { class: 'bar-row' },
        h(
          'p',
          { class: 'bar-name' },
          h('strong', { 'data-fact': id }, bucket.label),
          h('span', {}, range),
          h('span', { 'data-fact': `${id}.pullRequests` }, `${fmt(bucket.pullRequests)} merged`),
        ),
        h(
          'div',
          { class: 'bars' },
          [
            ['whole', 'cycleTimeP50Hours'],
            ['wait', 'timeToFirstReviewP50Hours'],
          ].map(
            ([series, key]) =>
              bucket[key] !== null &&
              bar(series, bucket[key] / longest, fact(`${id}.${key}`, hours(bucket[key]))),
          ),
        ),
      );
    }),
  );
}

/** Reviewers by share of reviews; the few who together submitted half of them stand out. */
function reviewers({ metrics, topReviewers }) {
  const total = metrics.reviewsSubmitted.current;
  if (total === 0) {
    return section(
      'Who reviews',
      'Nobody other than the authors reviewed these pull requests before they merged.',
    );
  }
  const half = metrics.reviewersForHalfOfReviews.current;
  const active = metrics.activeReviewers.current;
  const busiest = topReviewers[0].reviews;
  return section(
    'Who reviews',
    [
      fact('metrics.reviewersForHalfOfReviews.current', fmt(half)),
      ' of ',
      fact('metrics.activeReviewers.current', plural(active, 'reviewer')),
      ' submitted half of the ',
      fact('metrics.reviewsSubmitted.current', plural(total, 'review')),
      '.',
      active > topReviewers.length && ` The ${topReviewers.length} busiest are shown.`,
    ],
    legend([
      ['review', 'Submitted half of the reviews'],
      ['quiet', 'Everyone else'],
    ]),
    topReviewers.map((reviewer, index) => {
      const id = `topReviewers[${reviewer.login}]`;
      return tip(
        h(
          'div',
          { class: 'bar-row', tabindex: 0 },
          h('p', { class: 'bar-name' }, h('strong', { 'data-fact': id }, reviewer.login)),
          h(
            'div',
            { class: 'bars' },
            bar(
              index < half ? 'review' : 'quiet',
              reviewer.reviews / busiest,
              fact(`${id}.reviews`, plural(reviewer.reviews, 'review')),
              h(
                'span',
                { class: 'quiet', 'data-fact': `${id}.sharePct` },
                `${fmt(reviewer.sharePct)}%`,
              ),
            ),
          ),
        ),
        reviewer.login,
        [
          [fmt(reviewer.pullRequestsReviewed), 'pull requests reviewed'],
          [fmt(reviewer.approvals), 'approvals'],
          [fmt(reviewer.changesRequested), 'change requests'],
        ],
      );
    }),
  );
}

/** Columns are `{ label, numeric?, wide?, cell(row), fact?(row) }`; the first column heads each row. */
function table(columns, rows) {
  return h(
    'div',
    { class: 'scroll' },
    h(
      'table',
      {},
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          columns.map(({ label, numeric }) =>
            h('th', { scope: 'col', class: numeric && 'num' }, label),
          ),
        ),
      ),
      h(
        'tbody',
        {},
        rows.map((row) =>
          h(
            'tr',
            {},
            columns.map((column, index) =>
              h(
                index === 0 ? 'th' : 'td',
                {
                  scope: index === 0 && 'row',
                  class: column.numeric ? 'num' : column.wide && 'wide',
                  'data-fact': column.fact?.(row),
                },
                column.cell(row),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

function metricsTable({ metrics, baselinePeriod }) {
  const value = (row, part) => fact(`metrics.${row.key}.${part}`, withUnit(row[part], row.unit));
  const rows = METRICS.map(([key, label, unit]) => ({ key, label, unit, ...metrics[key] }));
  return section(
    'Every metric',
    null,
    table(
      [
        { label: 'Metric', wide: true, cell: (row) => row.label },
        { label: 'This period', numeric: true, cell: (row) => value(row, 'current') },
        ...(baselinePeriod
          ? [
              { label: 'Period before', numeric: true, cell: (row) => value(row, 'baseline') },
              {
                label: 'Change',
                numeric: true,
                cell: (row) =>
                  row.delta === null
                    ? '–'
                    : [
                        fact(
                          `metrics.${row.key}.delta`,
                          `${signed(row.delta)}${deltaUnit(row.unit)}`,
                        ),
                        row.changePct !== null && [
                          ' (',
                          fact(`metrics.${row.key}.changePct`, `${signed(row.changePct)}%`),
                          ')',
                        ],
                      ],
              },
            ]
          : []),
      ],
      rows,
    ),
  );
}

function slowest({ repository, slowestPullRequests }) {
  const id = (pr) => `slowestPullRequests[#${pr.number}]`;
  return section(
    'Slowest pull requests',
    null,
    table(
      [
        {
          label: 'Pull request',
          fact: id,
          cell: (pr) =>
            h(
              'a',
              {
                href: `https://github.com/${repository}/pull/${pr.number}`,
                rel: 'noopener noreferrer',
              },
              `#${pr.number}`,
            ),
        },
        { label: 'Author', fact: (pr) => `${id(pr)}.author`, cell: (pr) => pr.author },
        {
          label: 'Time to merge',
          numeric: true,
          fact: (pr) => `${id(pr)}.cycleTimeHours`,
          cell: (pr) => hours(pr.cycleTimeHours),
        },
        {
          label: 'Wait for first review',
          numeric: true,
          fact: (pr) => `${id(pr)}.timeToFirstReviewHours`,
          cell: (pr) => hours(pr.timeToFirstReviewHours),
        },
        {
          label: 'Lines changed',
          numeric: true,
          fact: (pr) => `${id(pr)}.sizeLines`,
          cell: (pr) => fmt(pr.sizeLines),
        },
        {
          label: 'Reviews',
          numeric: true,
          fact: (pr) => `${id(pr)}.reviews`,
          cell: (pr) => fmt(pr.reviews),
        },
      ],
      slowestPullRequests,
    ),
  );
}

function authors({ topAuthors }) {
  const id = (author) => `topAuthors[${author.login}]`;
  return section(
    'Most active authors',
    null,
    table(
      [
        { label: 'Author', fact: id, cell: (author) => author.login },
        {
          label: 'Merged',
          numeric: true,
          fact: (author) => `${id(author)}.mergedPullRequests`,
          cell: (author) => fmt(author.mergedPullRequests),
        },
        {
          label: 'Lines changed',
          numeric: true,
          fact: (author) => `${id(author)}.linesChanged`,
          cell: (author) => fmt(author.linesChanged),
        },
        {
          label: 'Median time to merge',
          numeric: true,
          fact: (author) => `${id(author)}.cycleTimeP50Hours`,
          cell: (author) => hours(author.cycleTimeP50Hours),
        },
      ],
      topAuthors,
    ),
  );
}
