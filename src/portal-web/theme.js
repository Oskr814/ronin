// Before the first paint, so the page never flashes the other theme.
try {
  const theme = localStorage.getItem('ronin-portal-theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch {
  // No storage (private window): dark, the default.
}
