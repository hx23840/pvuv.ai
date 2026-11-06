/* Runs before the stylesheet to apply a saved/system theme before first paint. */
(function () {
  'use strict';
  var key = 'pvuv.theme';
  var root = document.documentElement;
  var system = window.matchMedia('(prefers-color-scheme: dark)');
  var choices = ['system', 'light', 'dark'];
  var preference = 'system';
  try { preference = normalize(localStorage.getItem(key)); } catch (_) { /* storage blocked */ }

  function normalize(value) { return choices.indexOf(value) >= 0 ? value : 'system'; }
  function apply() {
    var theme = preference === 'system' ? (system.matches ? 'dark' : 'light') : preference;
    root.dataset.themePreference = preference;
    var changed = root.dataset.theme !== theme;
    root.dataset.theme = theme;
    document.querySelectorAll('[data-theme-select]').forEach(function (el) { el.value = preference; });
    if (changed) document.dispatchEvent(new CustomEvent('pvuv:theme', { detail: { theme: theme, preference: preference } }));
  }
  function setPreference(value) {
    preference = normalize(value);
    try { localStorage.setItem(key, preference); } catch (_) { /* keep working in memory */ }
    apply();
  }
  apply();
  system.addEventListener('change', function () { if (preference === 'system') apply(); });
  window.addEventListener('storage', function (event) {
    if (event.key !== key && event.key !== null) return;
    // Ignore sessionStorage events, which use a separate preference namespace.
    try { if (event.storageArea && event.storageArea !== localStorage) return; } catch (_) { return; }
    preference = normalize(event.newValue);
    apply();
  });

  var labels = {
    en: ['Theme', 'System', 'Light', 'Dark'],
    zh: ['主题', '跟随系统', '浅色', '暗色'],
    ja: ['テーマ', 'システム', 'ライト', 'ダーク'],
    ko: ['테마', '시스템', '라이트', '다크'],
    de: ['Design', 'System', 'Hell', 'Dunkel'],
    fr: ['Thème', 'Système', 'Clair', 'Sombre'],
    es: ['Tema', 'Sistema', 'Claro', 'Oscuro']
  };
  function translate() {
    var lang = window.PVI18N && window.PVI18N.lang;
    if (!lang) {
      try { lang = localStorage.getItem('pvuv.lang'); } catch (_) { /* storage blocked */ }
      lang = lang || navigator.language || 'en';
    }
    var text = labels[lang.toLowerCase().split('-')[0]] || labels.en;
    document.querySelectorAll('[data-theme-select]').forEach(function (el) {
      el.setAttribute('aria-label', text[0]);
      el.title = text[0];
      Array.from(el.options).forEach(function (option, index) { option.textContent = text[index + 1]; });
    });
  }
  function mount() {
    document.querySelectorAll('[data-theme-picker]').forEach(function (host) {
      var select = document.createElement('select');
      select.setAttribute('data-theme-select', '');
      select.className = 'theme-select';
      choices.forEach(function (value) {
        var option = document.createElement('option');
        option.value = value;
        select.appendChild(option);
      });
      select.value = preference;
      select.addEventListener('change', function () { setPreference(select.value); });
      host.appendChild(select);
    });
    translate();
  }
  document.addEventListener('pvuv:lang', translate);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();
