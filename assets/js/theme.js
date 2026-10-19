(() => {
  const storageKey = 'youfind-theme';
  let theme = (() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved === 'light' || saved === 'dark') return saved;
    } catch {}
    return 'light';
  })();

  function applyTheme() {
    document.documentElement.dataset.theme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme === 'dark' ? '#101920' : '#f7f7f3';
    document.querySelectorAll('[data-theme-toggle]').forEach(button => {
      button.innerHTML = `<span aria-hidden="true">${theme === 'dark' ? '☀' : '☾'}</span>`;
      button.setAttribute('aria-label', `Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`);
      button.title = `Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`;
      button.setAttribute('aria-pressed', String(theme === 'dark'));
    });
  }

  document.documentElement.dataset.theme = theme;
  document.addEventListener('DOMContentLoaded', applyTheme);
  document.addEventListener('click', event => {
    if (!event.target.closest('[data-theme-toggle]')) return;
    theme = theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(storageKey, theme); } catch {}
    applyTheme();
  });
})();
