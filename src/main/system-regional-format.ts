import {
  DATE_SEPARATORS,
  type DateOrder,
  type RegionalFormat,
} from '../core/exchange/csv/regional-format';

const SAMPLE_DATE = new Date(Date.UTC(2026, 9, 5, 14));
const SAMPLE_DECIMAL = 1.5;
const DECIMAL_COMMA = ',';
const DIRECTION_MARKS = /[\u061C\u200E\u200F]/g;
const TWELVE_HOUR_CYCLES: readonly string[] = ['h11', 'h12'];
const ORDERS: Readonly<Record<string, DateOrder>> = {
  'day,month,year': 'dayMonthYear',
  'month,day,year': 'monthDayYear',
  'year,month,day': 'yearMonthDay',
};

export const DEFAULT_REGIONAL_FORMAT: RegionalFormat = {
  listSeparator: ',',
  dateOrder: 'yearMonthDay',
  dateSeparator: '-',
  twelveHourClock: false,
};

/** Reads the regional format of a locale for CSV files: list separator from its decimal mark, order and separator of its short dates, and clock, an unknown locale giving the default format and unusual short dates ISO dates, each with a warning. */
export function regionalFormatOf(locale: string): RegionalFormat {
  if (!isKnownLocale(locale)) {
    console.warn(`Unknown locale ${JSON.stringify(locale)}: CSV files use the ISO format.`);
    return DEFAULT_REGIONAL_FORMAT;
  }
  const decimal = new Intl.NumberFormat(locale)
    .formatToParts(SAMPLE_DECIMAL)
    .find((part) => part.type === 'decimal')?.value;
  const dateParts = new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'UTC',
  }).formatToParts(SAMPLE_DATE);
  const order = dateParts
    .filter((part) => ['day', 'month', 'year'].includes(part.type))
    .map((part) => part.type)
    .join(',');
  const literal =
    dateParts
      .find((part) => part.type === 'literal')
      ?.value.replace(DIRECTION_MARKS, '')
      .trim() ?? '';
  const hourCycle = new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions()
    .hourCycle;
  const dateOrder = Object.hasOwn(ORDERS, order) ? ORDERS[order] : undefined;
  const dateSeparator = DATE_SEPARATORS.find((separator) => separator === literal);
  const regional = {
    listSeparator: decimal === DECIMAL_COMMA ? ';' : ',',
    twelveHourClock: TWELVE_HOUR_CYCLES.includes(hourCycle ?? ''),
  } as const;
  if (dateOrder === undefined || dateSeparator === undefined) {
    console.warn(
      `The short dates of ${JSON.stringify(locale)} are written ${JSON.stringify(dateParts.map((part) => part.value).join(''))}, which CSV files cannot follow: they use ISO dates.`,
    );
    return { ...regional, dateOrder: 'yearMonthDay', dateSeparator: '-' };
  }
  return { ...regional, dateOrder, dateSeparator };
}

/** Tells whether the internationalization support knows a locale tag. */
function isKnownLocale(locale: string): boolean {
  try {
    return Intl.getCanonicalLocales(locale).length > 0;
  } catch (error) {
    if (error instanceof RangeError) {
      return false;
    }
    throw error;
  }
}
