/**
 * DOM helpers shared by the page. Everything the API returns reaches the document through
 * these, as text nodes and attributes: no markup is ever built from strings.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** An HTML element. Children are nodes or strings; nested arrays and empty values are fine. */
export function h(tag, attributes = {}, ...children) {
  return build(document.createElement(tag), attributes, children);
}

/** An SVG element. */
export function s(tag, attributes = {}, ...children) {
  return build(document.createElementNS(SVG_NS, tag), attributes, children);
}

/** Replaces the content of `element`. Children follow the same rules as for `h`. */
export function fill(element, ...children) {
  element.replaceChildren(...present(children));
}

function build(element, attributes, children) {
  for (const [name, value] of Object.entries(attributes)) {
    if (value === null || value === undefined || value === false) continue;
    element.setAttribute(name, value === true ? '' : String(value));
  }
  element.append(...present(children));
  return element;
}

const present = (children) =>
  children.flat(3).filter((child) => child !== null && child !== undefined && child !== false);

const number = new Intl.NumberFormat('en', { maximumFractionDigits: 2 });
const instant = new Intl.DateTimeFormat('en', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
});
const shortDay = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', timeZone: 'UTC' });

export const fmt = (value) => (value === null ? '–' : number.format(value));
export const hours = (value) => (value === null ? '–' : `${number.format(value)} h`);
export const signed = (value) =>
  `${value < 0 ? '−' : value > 0 ? '+' : ''}${number.format(Math.abs(value))}`;
export const fmtInstant = (iso) => `${instant.format(new Date(iso))} UTC`;
export const fmtDay = (day) => shortDay.format(new Date(`${day}T00:00:00Z`));

const tipBox = document.getElementById('tip');
const tips = new WeakMap();

/**
 * Shows `title` and `rows` beside `element` on hover and on keyboard focus. A row is
 * `[value, label]` or `[value, label, series]`, where the series adds a colour key.
 */
export function tip(element, title, rows) {
  tips.set(element, { title, rows });
  element.setAttribute('data-tip', '');
  return element;
}

function openTip(target, x, y) {
  const content = tips.get(target);
  if (!content) return;
  fill(
    tipBox,
    h('p', { class: 'tip-title' }, content.title),
    content.rows.map(([value, label, series]) =>
      h(
        'p',
        { class: 'tip-row' },
        series && h('span', { class: `key key-${series}` }),
        h('strong', {}, String(value)),
        ' ',
        label,
      ),
    ),
  );
  tipBox.hidden = false;
  const left = Math.min(x + 14, window.innerWidth - tipBox.offsetWidth - 8);
  const top = Math.min(y + 14, window.innerHeight - tipBox.offsetHeight - 8);
  tipBox.style.left = `${Math.max(8, left)}px`;
  tipBox.style.top = `${Math.max(8, top)}px`;
}

const tipTarget = (event) =>
  event.target instanceof Element ? event.target.closest('[data-tip]') : null;

document.addEventListener('pointermove', (event) => {
  const target = tipTarget(event);
  if (target) openTip(target, event.clientX, event.clientY);
  else tipBox.hidden = true;
});
/**
 * Without a pointer to follow, the tip sits under the element that has keyboard focus. It is
 * placed in viewport coordinates, so this runs again whenever anything scrolls.
 */
function followFocus() {
  const target = document.activeElement?.closest('[data-tip]');
  const box = target?.matches(':focus-visible') && target.getBoundingClientRect();
  if (box && box.bottom > 0 && box.top < window.innerHeight) openTip(target, box.left, box.bottom);
  else tipBox.hidden = true;
}

document.addEventListener('focusin', followFocus);
document.addEventListener('focusout', () => {
  tipBox.hidden = true;
});
document.addEventListener('scroll', followFocus, { capture: true, passive: true });
