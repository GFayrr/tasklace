import { HOURS_PER_DAY, type ProjectHour } from '../../core/time';

export type ZoomLevel = 'hour' | 'day' | 'week' | 'month';

export const ZOOM_LEVELS: readonly ZoomLevel[] = ['hour', 'day', 'week', 'month'];

export interface ScaleTick {
  readonly start: ProjectHour;
  readonly end: ProjectHour;
  readonly label: string;
}

export interface ScaleTicks {
  readonly upper: readonly ScaleTick[];
  readonly lower: readonly ScaleTick[];
}

export interface ScaleLabels {
  readonly day: (hour: ProjectHour) => string;
  readonly hourOfDay: (hour: ProjectHour) => string;
  readonly dayOfMonth: (hour: ProjectHour) => string;
  readonly month: (hour: ProjectHour) => string;
  readonly monthOfYear: (hour: ProjectHour) => string;
  readonly year: (hour: ProjectHour) => string;
}

type Unit = 'hour' | 'day' | 'week' | 'month' | 'year';

interface ZoomScale {
  readonly pixelsPerHour: number;
  readonly upper: Unit;
  readonly lower: Unit;
}

const MILLISECONDS_PER_HOUR = 3_600_000;
const DAYS_PER_WEEK = 7;
const SUNDAY_TO_MONDAY_SHIFT = 6;
const HALF_VIEW = 2;
const HOUR_ZOOM_PIXELS_PER_DAY = 40 * HOURS_PER_DAY;
const DAY_ZOOM_PIXELS_PER_DAY = 32;
const WEEK_ZOOM_PIXELS_PER_DAY = 12;
const MONTH_ZOOM_PIXELS_PER_DAY = 4;

const SCALES: Readonly<Record<ZoomLevel, ZoomScale>> = {
  hour: { pixelsPerHour: HOUR_ZOOM_PIXELS_PER_DAY / HOURS_PER_DAY, upper: 'day', lower: 'hour' },
  day: { pixelsPerHour: DAY_ZOOM_PIXELS_PER_DAY / HOURS_PER_DAY, upper: 'month', lower: 'day' },
  week: { pixelsPerHour: WEEK_ZOOM_PIXELS_PER_DAY / HOURS_PER_DAY, upper: 'month', lower: 'week' },
  month: {
    pixelsPerHour: MONTH_ZOOM_PIXELS_PER_DAY / HOURS_PER_DAY,
    upper: 'year',
    lower: 'month',
  },
};

/** Returns how many pixels an hour takes at a zoom level. */
export function pixelsPerHour(zoom: ZoomLevel): number {
  return SCALES[zoom].pixelsPerHour;
}

/** Returns the scroll position that keeps the same instant in the middle of the view after a change of zoom, the timeline starting at the same instant at every zoom. */
export function zoomedScrollLeft(
  scrollLeft: number,
  viewWidth: number,
  from: ZoomLevel,
  to: ZoomLevel,
): number {
  const ratio = pixelsPerHour(to) / pixelsPerHour(from);
  const middle = viewWidth / HALF_VIEW;
  return Math.max(0, (scrollLeft + middle) * ratio - middle);
}

/** Returns the unit a moved or stretched bar aligns to: the hour at the hour zoom, the day otherwise. */
export function snapHours(zoom: ZoomLevel): number {
  return zoom === 'hour' ? 1 : HOURS_PER_DAY;
}

/** Lists the two rows of labels of the time scale between two instants, each label covering its whole period. */
export function buildScaleTicks(
  zoom: ZoomLevel,
  from: ProjectHour,
  to: ProjectHour,
  labels: ScaleLabels,
): ScaleTicks {
  const scale = SCALES[zoom];
  return {
    upper: unitTicks(scale.upper, from, to, upperLabel(scale.upper, labels)),
    lower: unitTicks(scale.lower, from, to, lowerLabel(scale.lower, labels)),
  };
}

/** Returns the start of the period of a unit that contains an instant. */
export function startOfUnit(unit: Unit, hour: ProjectHour): ProjectHour {
  const date = new Date(hour * MILLISECONDS_PER_HOUR);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  switch (unit) {
    case 'hour':
      return Math.floor(hour);
    case 'day':
      return toHour(Date.UTC(year, month, day));
    case 'week':
      return toHour(
        Date.UTC(year, month, day - ((date.getUTCDay() + SUNDAY_TO_MONDAY_SHIFT) % DAYS_PER_WEEK)),
      );
    case 'month':
      return toHour(Date.UTC(year, month, 1));
    case 'year':
      return toHour(Date.UTC(year, 0, 1));
  }
}

/** Returns the start of the next period of a unit after the period starting at an instant. */
export function nextUnit(unit: Unit, start: ProjectHour): ProjectHour {
  const date = new Date(start * MILLISECONDS_PER_HOUR);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  switch (unit) {
    case 'hour':
      return start + 1;
    case 'day':
      return start + HOURS_PER_DAY;
    case 'week':
      return start + HOURS_PER_DAY * DAYS_PER_WEEK;
    case 'month':
      return toHour(Date.UTC(year, month + 1, 1));
    case 'year':
      return toHour(Date.UTC(year + 1, 0, 1));
  }
}

/** Lists the periods of a unit that overlap an interval. */
function unitTicks(
  unit: Unit,
  from: ProjectHour,
  to: ProjectHour,
  label: (hour: ProjectHour) => string,
): ScaleTick[] {
  const ticks: ScaleTick[] = [];
  for (let start = startOfUnit(unit, from); start < to; start = nextUnit(unit, start)) {
    ticks.push({ start, end: nextUnit(unit, start), label: label(start) });
  }
  return ticks;
}

/** Chooses the label of an upper period. */
function upperLabel(unit: Unit, labels: ScaleLabels): (hour: ProjectHour) => string {
  if (unit === 'day') {
    return labels.day;
  }
  return unit === 'year' ? labels.year : labels.month;
}

/** Chooses the label of a lower period. */
function lowerLabel(unit: Unit, labels: ScaleLabels): (hour: ProjectHour) => string {
  if (unit === 'hour') {
    return labels.hourOfDay;
  }
  return unit === 'month' ? labels.monthOfYear : labels.dayOfMonth;
}

/** Converts milliseconds since the epoch into a project hour. */
function toHour(milliseconds: number): ProjectHour {
  return milliseconds / MILLISECONDS_PER_HOUR;
}

/** Creates the labels of the time scale in the regional format, project hours being wall-clock times without time zone. */
export function createScaleLabels(locale: string): ScaleLabels {
  const formatter = (options: Intl.DateTimeFormatOptions) => {
    const format = new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' });
    return (hour: ProjectHour) => format.format(new Date(hour * MILLISECONDS_PER_HOUR));
  };
  return {
    day: formatter({ weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }),
    hourOfDay: formatter({ hour: 'numeric' }),
    dayOfMonth: formatter({ day: 'numeric' }),
    month: formatter({ month: 'long', year: 'numeric' }),
    monthOfYear: formatter({ month: 'short' }),
    year: formatter({ year: 'numeric' }),
  };
}
