import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../workers/console/public/theme.js', import.meta.url), 'utf8');

// Exercise preference behavior without adding a browser/test-framework dependency.
function boot({ saved, dark = false, blocked = false, lang = 'en' } = {}) {
  const values = new Map(saved === undefined ? [] : [['pvuv.theme', saved]]);
  const storage = {
    getItem(key) { if (blocked) throw new Error('storage denied'); return values.get(key) ?? null; },
    setItem(key, value) { if (blocked) throw new Error('storage denied'); values.set(key, value); },
  };
  class Element extends EventTarget {
    options = [];
    attributes = {};
    value = '';
    setAttribute(key, value) { this.attributes[key] = value; }
    appendChild(child) { this.options.push(child); }
  }
  const host = new Element();
  const document = new EventTarget();
  document.documentElement = { dataset: {} };
  document.readyState = 'loading';
  document.createElement = () => new Element();
  document.querySelectorAll = (selector) => selector === '[data-theme-picker]' ? [host] : host.options;
  const media = new EventTarget();
  media.matches = dark;
  const window = new EventTarget();
  window.matchMedia = () => media;
  window.PVI18N = { lang };
  const events = [];
  document.addEventListener('pvuv:theme', (event) => events.push(event.detail));
  vm.runInNewContext(source, { document, window, localStorage: storage, navigator: { language: lang }, CustomEvent });
  const initial = { ...document.documentElement.dataset };
  document.dispatchEvent(new Event('DOMContentLoaded'));
  const select = host.options[0];
  return {
    initial, root: document.documentElement.dataset, values, select, events,
    choose(value) { select.value = value; select.dispatchEvent(new Event('change')); },
    system(dark) { media.matches = dark; media.dispatchEvent(new Event('change')); },
    stored(key, value, storageArea = storage) {
      const event = new Event('storage');
      Object.assign(event, { key, newValue: value, storageArea });
      window.dispatchEvent(event);
    },
    language(lang) { window.PVI18N.lang = lang; document.dispatchEvent(new Event('pvuv:lang')); },
  };
}

test('first paint follows the system; system changes update the effective theme', () => {
  const page = boot({ dark: true });
  assert.deepEqual(page.initial, { themePreference: 'system', theme: 'dark' });
  assert.equal(page.select.value, 'system');
  page.system(false);
  assert.equal(page.root.theme, 'light');
  assert.equal(page.values.has('pvuv.theme'), false);
});

test('explicit selection survives navigation and ignores OS changes until System is selected', () => {
  const page = boot({ dark: true });
  page.choose('light');
  page.system(true);
  assert.equal(page.root.theme, 'light');
  assert.equal(boot({ saved: page.values.get('pvuv.theme'), dark: true }).initial.theme, 'light');
  page.choose('dark');
  page.system(false);
  assert.equal(page.root.theme, 'dark');
  page.choose('system');
  assert.equal(page.root.theme, 'light');
});

test('blocked storage does not prevent switching or remembering the in-page choice', () => {
  const page = boot({ blocked: true, dark: false });
  page.choose('dark');
  page.system(false);
  assert.equal(page.root.theme, 'dark');
  assert.equal(page.select.value, 'dark');
});

test('invalid stored values fall back to system', () => {
  assert.equal(boot({ saved: 'invalid', dark: false }).initial.theme, 'light');
  assert.equal(boot({ saved: 'invalid', dark: true }).initial.themePreference, 'system');
});

test('cross-tab changes and removal update the selector; unrelated storage is ignored', () => {
  const page = boot({ saved: 'dark', dark: false });
  page.stored('unrelated', 'light');
  page.stored('pvuv.theme', 'light', {});
  assert.equal(page.root.theme, 'dark');
  page.stored('pvuv.theme', 'light');
  assert.equal(page.select.value, 'light');
  assert.equal(page.root.theme, 'light');
  page.stored('pvuv.theme', null);
  assert.equal(page.select.value, 'system');
  page.stored('pvuv.theme', 'dark');
  page.stored(null, null);
  assert.equal(page.root.theme, 'light');
});

test('accessible labels follow the UI language without resetting the preference', () => {
  const page = boot({ saved: 'dark', lang: 'zh' });
  assert.equal(page.select.attributes['aria-label'], '主题');
  assert.equal(page.select.options[0].textContent, '跟随系统');
  page.language('en');
  assert.equal(page.select.attributes['aria-label'], 'Theme');
  assert.equal(page.select.options[1].textContent, 'Light');
  assert.equal(page.select.value, 'dark');
});
