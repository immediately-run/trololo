import { useTheme } from '../hooks/useTheme';

function ThemeSwitch() {
  const { theme, toggle } = useTheme();
  const isLight = theme === 'light';

  return (
    <button
      className="themeswitch"
      type="button"
      aria-label="Toggle color theme"
      onClick={toggle}
    >
      <span className="ic">{isLight ? '☾' : '☀'}</span>
      <span>{isLight ? 'Dark' : 'Light'}</span>
    </button>
  );
}

export default ThemeSwitch;
