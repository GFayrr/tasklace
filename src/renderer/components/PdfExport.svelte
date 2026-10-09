<script lang="ts">
  import type { Project } from '../../core/model/project';
  import { MAX_PRINT_PAGES } from '../../core/limits';
  import { pageSizeOf, PAPER_NAMES, PAPER_ORIENTATIONS } from '../../core/print/paper';
  import { valueAt } from '../../core/table-value';
  import { MAX_DAY_INDEX, MIN_DAY_INDEX, type DayIndex } from '../../core/time';
  import type { AppState } from '../app/app-state.svelte';
  import { fillMessage } from '../i18n/messages';
  import { createPatternCache } from '../plan/bar-patterns';
  import { ZOOM_LEVELS } from '../plan/time-scale';
  import {
    buildPrintDocument,
    PRINT_COLUMNS,
    wholePlanDays,
    type PrintColumn,
    type PrintSettings,
    type PrintZoomChoice,
  } from '../print/print-pages';
  import { paintPrintPage } from '../print/print-preview';
  import { readPrintSettings, rememberPrintSettings } from '../print/print-settings';
  import { pageMeasure, type MeasureText } from '../print/print-text';
  import Icon from './Icon.svelte';

  let { app, project }: { app: AppState; project: Project } = $props();

  const PREVIEW_WIDTH = 560;
  const MILLISECONDS_PER_DAY = 86_400_000;
  const ISO_DATE_LENGTH = 10;
  const ZOOM_CHOICES: readonly PrintZoomChoice[] = ['automatic', ...ZOOM_LEVELS];
  const storage = (() => {
    try {
      return window.localStorage;
    } catch (error) {
      console.warn('The print settings will not be remembered:', error);
      return null;
    }
  })();

  const text = $derived(app.messages.print);
  const opening = $derived(app.pdfExport);
  let settings = $state.raw<PrintSettings>(readPrintSettings(null, ''));
  let measure = $state.raw<MeasureText | null>(null);
  let previewFailed = $state(false);
  const patternFor = createPatternCache(
    () => document.createElement('canvas'),
    () => document.createElement('canvas').getContext('2d'),
    () => {
      app.reportDrawingProblem('patterns');
    },
  );

  const current = $derived(app.currentSchedule);
  const schedule = $derived(current.ok ? current.value : null);
  const wholeDays = $derived(schedule === null ? null : wholePlanDays(project, schedule));
  const printed = $derived.by(() => {
    if (opening === null || measure === null || schedule === null || app.calendar === null) {
      return null;
    }
    return buildPrintDocument(
      {
        project,
        schedule,
        calendar: app.calendar,
        theme: app.theme,
        messages: app.messages,
        locale: app.locale,
        exportedAt: opening.exportedAt,
      },
      settings,
      measure,
      1,
    );
  });
  const status = $derived.by(() => {
    if (!current.ok) {
      return text.waiting;
    }
    if (schedule === null) {
      return text.scheduleFailed;
    }
    if (previewFailed) {
      return text.previewUnavailable;
    }
    if (printed?.ok === false) {
      return fillMessage(text.refusals[printed.error], { limit: String(MAX_PRINT_PAGES) });
    }
    return null;
  });
  const dateFormat = $derived(
    new Intl.DateTimeFormat(app.locale, { dateStyle: 'medium', timeZone: 'UTC' }),
  );

  /** Opens the dialog with the settings remembered for the project when an export starts, and closes it when the export is closed elsewhere. */
  function followOpening(dialog: HTMLDialogElement): void {
    if (opening !== null && !dialog.open) {
      settings = readPrintSettings(storage, opening.documentId);
      previewFailed = false;
      void prepareMeasure();
      dialog.showModal();
    } else if (opening === null && dialog.open) {
      dialog.close();
    }
  }

  /** Waits for the printed font to be loaded, then measures texts with it, the preview being unavailable when the page cannot measure text. */
  async function prepareMeasure(): Promise<void> {
    try {
      measure = await pageMeasure(document);
      previewFailed = measure === null;
    } catch (error) {
      console.error('The printed font could not be loaded:', error);
      previewFailed = true;
    }
  }

  /** Changes the settings and remembers them for the project on this computer. */
  function change(changes: Partial<PrintSettings>): void {
    settings = { ...settings, ...changes };
    if (opening !== null) {
      rememberPrintSettings(storage, opening.documentId, settings);
    }
  }

  /** Adds or removes a column from those printed beside the names. */
  function toggleColumn(column: PrintColumn, chosen: boolean): void {
    const others = settings.columns.filter((kept) => kept !== column);
    change({ columns: chosen ? [...others, column] : others });
  }

  /** Writes a day as the value of a date field. */
  function dayValue(day: DayIndex): string {
    return new Date(day * MILLISECONDS_PER_DAY).toISOString().slice(0, ISO_DATE_LENGTH);
  }

  /** Reads the day of a date field, or null when it is empty or outside the years handled. */
  function dayOf(value: string): DayIndex | null {
    const time = Date.parse(`${value}T00:00:00Z`);
    const day = time / MILLISECONDS_PER_DAY;
    return Number.isInteger(day) && day >= MIN_DAY_INDEX && day <= MAX_DAY_INDEX ? day : null;
  }

  /** Prints chosen days, starting from the days of the whole plan, once they are known. */
  function chooseDays(): void {
    if (wholeDays !== null) {
      change({ period: { kind: 'days', ...wholeDays } });
    }
  }

  /** Sets the first or the last day printed from a date field, leaving the period as it was for a date that cannot be read. */
  function setDay(edge: 'firstDay' | 'lastDay', value: string): void {
    const day = dayOf(value);
    if (day === null || settings.period.kind !== 'days') {
      return;
    }
    change({ period: { ...settings.period, [edge]: day } });
  }

  /** Draws the first page of the preview whenever it changes, sized for the screen density. */
  function drawPreview(canvas: HTMLCanvasElement): void {
    if (printed?.ok !== true) {
      return;
    }
    const page = valueAt(printed.value.document.pages, 0);
    const size = pageSizeOf(settings.paper, settings.orientation);
    const density = Math.max(window.devicePixelRatio, 1);
    const scale = PREVIEW_WIDTH / size.width;
    canvas.width = Math.round(PREVIEW_WIDTH * density);
    canvas.height = Math.round(size.height * scale * density);
    canvas.style.width = `${String(PREVIEW_WIDTH)}px`;
    canvas.style.height = `${String(size.height * scale)}px`;
    const context = canvas.getContext('2d');
    if (context === null) {
      previewFailed = true;
      return;
    }
    paintPrintPage(context, page, size, scale * density, patternFor);
  }

  /** Returns the label of a column that can be printed beside the names. */
  function columnLabel(column: PrintColumn): string {
    const labels: Readonly<Record<PrintColumn, string>> = {
      wbs: app.messages.table.wbs,
      start: app.messages.table.start,
      end: app.messages.table.end,
      duration: app.messages.table.duration,
      progress: text.progress,
      predecessors: app.messages.table.predecessors,
      floats: text.floats,
    };
    return labels[column];
  }

  /** Writes a day in the regional format. */
  function dayText(day: DayIndex): string {
    return dateFormat.format(new Date(day * MILLISECONDS_PER_DAY));
  }
</script>

<dialog
  class="export"
  aria-labelledby="export-title"
  {@attach followOpening}
  oncancel={() => {
    app.closePdfExport();
  }}
  onclose={(event) => {
    if (!event.currentTarget.open) {
      app.closePdfExport();
    }
  }}
>
  {#if opening !== null}
    <div class="head">
      <h2 id="export-title">{text.title}</h2>
      <button
        type="button"
        class="icon-button"
        aria-label={text.close}
        title={text.close}
        onclick={() => {
          app.closePdfExport();
        }}
      >
        <Icon name="close" />
      </button>
    </div>
    <div class="body">
      <div class="settings">
        <fieldset>
          <legend>{text.paper}</legend>
          <div class="segments">
            {#each PAPER_NAMES as paper (paper)}
              <label class={['segment', { chosen: settings.paper === paper }]}>
                <input
                  type="radio"
                  name="paper"
                  checked={settings.paper === paper}
                  onchange={() => {
                    change({ paper });
                  }}
                />{text[paper]}
              </label>
            {/each}
          </div>
          <div class="segments">
            {#each PAPER_ORIENTATIONS as orientation (orientation)}
              <label class={['segment', { chosen: settings.orientation === orientation }]}>
                <input
                  type="radio"
                  name="orientation"
                  checked={settings.orientation === orientation}
                  onchange={() => {
                    change({ orientation });
                  }}
                />{text[orientation]}
              </label>
            {/each}
          </div>
        </fieldset>
        <fieldset>
          <legend>{text.period}</legend>
          <label class="choice">
            <input
              type="radio"
              name="period"
              checked={settings.period.kind === 'whole'}
              onchange={() => {
                change({ period: { kind: 'whole' } });
              }}
            />
            {wholeDays === null
              ? text.wholeProjectWithoutDates
              : fillMessage(text.wholeProject, {
                  span: `${dayText(wholeDays.firstDay)} – ${dayText(wholeDays.lastDay)}`,
                })}
          </label>
          <label class="choice">
            <input
              type="radio"
              name="period"
              checked={settings.period.kind === 'days'}
              disabled={wholeDays === null}
              onchange={chooseDays}
            />
            {text.days}
          </label>
          {#if settings.period.kind === 'days'}
            <div class="days">
              <input
                type="date"
                aria-label={text.firstDay}
                value={dayValue(settings.period.firstDay)}
                onchange={(event) => {
                  setDay('firstDay', event.currentTarget.value);
                }}
              />
              <input
                type="date"
                aria-label={text.lastDay}
                value={dayValue(settings.period.lastDay)}
                onchange={(event) => {
                  setDay('lastDay', event.currentTarget.value);
                }}
              />
            </div>
          {/if}
        </fieldset>
        <fieldset>
          <legend>{text.zoom}</legend>
          <div class="segments">
            {#each ZOOM_CHOICES as zoom (zoom)}
              <label class={['segment', { chosen: settings.zoom === zoom }]}>
                <input
                  type="radio"
                  name="zoom"
                  checked={settings.zoom === zoom}
                  onchange={() => {
                    change({ zoom });
                  }}
                />{zoom === 'automatic' ? text.automatic : app.messages.zoom[zoom]}
              </label>
            {/each}
          </div>
          {#if settings.zoom === 'automatic' && printed?.ok === true}
            <small
              >{fillMessage(text.automaticHint, {
                zoom: app.messages.zoom[printed.value.zoom],
              })}</small
            >
          {/if}
        </fieldset>
        <fieldset>
          <legend>{text.columns}</legend>
          <label class="choice"><input type="checkbox" checked disabled />{text.nameAlways}</label>
          {#each PRINT_COLUMNS as column (column)}
            {#if column !== 'floats' || project.options.criticalPathEnabled}
              <label class="choice">
                <input
                  type="checkbox"
                  checked={settings.columns.includes(column)}
                  onchange={(event) => {
                    toggleColumn(column, event.currentTarget.checked);
                  }}
                />{columnLabel(column)}
              </label>
            {/if}
          {/each}
          {#if !project.options.criticalPathEnabled}
            <small>{text.floatsHint}</small>
          {/if}
        </fieldset>
      </div>
      <div class="preview">
        {#if status !== null}
          <p class="status" role="status">{status}</p>
        {:else if printed?.ok === true}
          <p class="caption">
            {fillMessage(text.preview, { count: String(printed.value.layout.pages.length) })}
          </p>
          <canvas aria-label={text.previewLabel} {@attach drawPreview}></canvas>
        {/if}
      </div>
    </div>
    <div class="foot">
      <button
        type="button"
        class="button"
        onclick={() => {
          app.closePdfExport();
        }}>{text.cancel}</button
      >
      <button type="button" class="button primary" disabled>{text.export}</button>
    </div>
  {/if}
</dialog>

<style>
  .export {
    width: min(960px, calc(100% - 32px));
    max-height: calc(100% - 64px);
    padding: 0;
    color: var(--color-text);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: calc(var(--radius) + 4px);
  }

  .export[open] {
    display: flex;
    flex-direction: column;
  }

  .export::backdrop {
    background: color-mix(in srgb, var(--color-text) 35%, transparent);
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-4) var(--space-6) var(--space-1);
  }

  h2 {
    margin: 0;
    font-size: 20px;
    font-weight: 600;
  }

  .body {
    display: flex;
    gap: var(--space-6);
    padding: var(--space-4) var(--space-6);
    overflow: auto;
  }

  .settings {
    flex: 0 0 280px;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  fieldset {
    margin: 0;
    padding: var(--space-3);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
  }

  legend {
    padding: 0 var(--space-1);
    font-size: 12px;
    font-weight: 600;
  }

  .segments {
    display: flex;
    flex-wrap: wrap;
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    overflow: hidden;
  }

  .segment {
    flex: 1 1 auto;
    padding: var(--space-1) var(--space-2);
    font-size: var(--font-size-small);
    text-align: center;
    cursor: pointer;
  }

  .segment input {
    position: absolute;
    opacity: 0;
    pointer-events: none;
  }

  .segment.chosen {
    color: var(--color-action-text);
    background: var(--color-action);
  }

  .segment:has(input:focus-visible) {
    outline: 2px solid var(--color-focus);
    outline-offset: -2px;
  }

  .choice {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--font-size-small);
  }

  .days {
    display: flex;
    gap: var(--space-2);
  }

  .days input {
    min-width: 0;
    flex: 1;
    height: var(--control-height);
    font: inherit;
    font-size: var(--font-size-small);
  }

  small {
    font-size: 12px;
    color: var(--color-text-secondary);
  }

  .preview {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-4);
    background: var(--color-panel);
    border-radius: var(--radius);
  }

  .caption,
  .status {
    margin: 0;
    font-size: var(--font-size-small);
    color: var(--color-text-secondary);
  }

  canvas {
    max-width: 100%;
    box-shadow: 0 1px 4px color-mix(in srgb, var(--color-text) 20%, transparent);
  }

  .foot {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-6);
    background: var(--color-background);
    border-top: 1px solid var(--color-border);
  }

  .button {
    height: var(--control-height);
    padding: 0 var(--space-4);
    font-weight: 500;
    color: var(--color-text);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    cursor: pointer;
  }

  .button.primary {
    color: var(--color-action-text);
    background: var(--color-action);
    border-color: var(--color-action);
  }

  .button:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .icon-button {
    width: var(--control-height);
    height: var(--control-height);
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--color-text-secondary);
    background: none;
    border: 0;
    border-radius: var(--radius);
    cursor: pointer;
  }

  .icon-button:hover {
    background: var(--color-panel);
  }
</style>
