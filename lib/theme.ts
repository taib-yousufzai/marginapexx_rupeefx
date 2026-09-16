export type Theme = 'light' | 'dark' | 'black' | 'blue';

export const ALL_THEMES: Theme[] = ['light', 'dark', 'black', 'blue'];

export function getSavedTheme(): Theme {
  if (typeof window === 'undefined') return 'light';
  try {
    const saved = localStorage.getItem('marginApexTheme') as Theme | null;
    if (saved && ALL_THEMES.includes(saved)) {
      return saved;
    }
  } catch (e) {}
  return 'light';
}

export function applyTheme(theme: Theme, animated = false): void {
  if (typeof document === 'undefined') return;

  const validTheme = ALL_THEMES.includes(theme) ? theme : 'light';

  if (animated) {
    document.documentElement.classList.add('theme-transitioning');
    setTimeout(() => {
      document.documentElement.classList.remove('theme-transitioning');
    }, 350);
  }

  // Clear stale theme classes from both documentElement and body
  ALL_THEMES.forEach((t) => {
    if (t !== validTheme) {
      document.documentElement.classList.remove(t);
      document.body?.classList.remove(t);
    }
  });

  // Apply new theme class and attribute to documentElement & body
  document.documentElement.classList.add(validTheme);
  document.body?.classList.add(validTheme);

  document.documentElement.setAttribute('data-theme', validTheme);
  document.body?.setAttribute('data-theme', validTheme);

  const bg = validTheme === 'black' ? '#000000' : (validTheme === 'dark' ? '#121212' : (validTheme === 'blue' ? '#0A1128' : '#F0F2F5'));
  document.documentElement.style.backgroundColor = bg;
  if (document.body) {
    document.body.style.backgroundColor = bg;
  }

  try {
    localStorage.setItem('marginApexTheme', validTheme);
  } catch (e) {}

  // Dispatch custom event for reactive UI components across the app
  window.dispatchEvent(new CustomEvent('themeChanged', { detail: { theme: validTheme } }));
}

export function cycleTheme(currentTheme: Theme): Theme {
  // Cycle: light -> dark -> black -> blue -> light
  const idx = ALL_THEMES.indexOf(currentTheme);
  const nextIdx = (idx + 1) % ALL_THEMES.length;
  const nextTheme = ALL_THEMES[nextIdx];
  applyTheme(nextTheme, true);
  return nextTheme;
}
