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

export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;

  const validTheme = ALL_THEMES.includes(theme) ? theme : 'light';

  // Clear all theme classes from both documentElement and body
  ALL_THEMES.forEach((t) => {
    document.documentElement.classList.remove(t);
    document.body.classList.remove(t);
  });

  // Apply new theme class and attribute to documentElement & body
  if (validTheme !== 'light') {
    document.documentElement.classList.add(validTheme);
    document.body.classList.add(validTheme);
  } else {
    document.documentElement.classList.add('light');
    document.body.classList.add('light');
  }

  document.documentElement.setAttribute('data-theme', validTheme);
  document.body.setAttribute('data-theme', validTheme);

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
  return ALL_THEMES[nextIdx];
}
