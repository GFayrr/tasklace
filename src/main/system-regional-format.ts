import type {
  DateOrder,
  DateSeparator,
  RegionalFormat,
} from '../core/exchange/csv/regional-format';

const SAMPLE_DATE = new Date(Date.UTC(2026, 9, 5, 14));
const SAMPLE_DECIMAL = 1.5;
const DECIMAL_COMMA = ',';
const DATE_SEPARATORS: readonly DateSeparator[] = ['/', '.', '-'];
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

/** Reads the regional format of a locale for CSV exchange: the list separator from its decimal mark, as spreadsheets do, the order and separator of its short dates, and its clock, the default format standing in for an unknown locale. */
export function regionalFormatOf(locale: string): RegionalFormat {
  if (!isKnownLocale(locale)) {
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
  const literal = dateParts.find((part) => part.type === 'literal')?.value.trim() ?? '';
  const hourCycle = new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions()
    .hourCycle;
  return {
    listSeparator: decimal === DECIMAL_COMMA ? ';' : ',',
    dateOrder: ORDERS[order] ?? DEFAULT_REGIONAL_FORMAT.dateOrder,
    dateSeparator: DATE_SEPARATORS.find((separator) => separator === literal) ?? '/',
    twelveHourClock: TWELVE_HOUR_CYCLES.includes(hourCycle ?? ''),
  };
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
