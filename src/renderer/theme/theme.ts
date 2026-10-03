export interface Theme {
  readonly background: string;
  readonly surface: string;
  readonly panel: string;
  readonly border: string;
  readonly text: string;
  readonly textSecondary: string;
  readonly action: string;
  readonly actionHover: string;
  readonly actionText: string;
  readonly selection: string;
  readonly focus: string;
  readonly success: string;
  readonly warning: string;
  readonly error: string;
  readonly bar: string;
  readonly nonWorking: string;
  readonly gridLine: string;
}

export type ThemeColor = keyof Theme;

export const THEME_COLORS: readonly ThemeColor[] = [
  'background',
  'surface',
  'panel',
  'border',
  'text',
  'textSecondary',
  'action',
  'actionHover',
  'actionText',
  'selection',
  'focus',
  'success',
  'warning',
  'error',
  'bar',
  'nonWorking',
  'gridLine',
];

/** Returns the name of the style variable holding a color of the theme. */
export function themeVariable(color: ThemeColor): string {
  return `--color-${color.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}

/** Gives an element the colors of a theme as style variables, which the style sheets of the interface use. */
export function applyTheme(theme: Theme, element: HTMLElement): void {
  THEME_COLORS.forEach((color) => {
    element.style.setProperty(themeVariable(color), theme[color]);
  });
}
