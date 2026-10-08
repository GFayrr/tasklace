/** Holds what the settings window shows besides the project: whether it is open, its messages, and a refused value that keeps it open once. */
export class SettingsPanel {
  #open = $state(false);
  #resets = $state(0);
  #notice = $state<string | null>(null);
  #alert = $state<string | null>(null);
  #baselineNotice = $state<string | null>(null);
  #held = false;
  readonly #restarted: () => void;

  /** Creates closed settings, calling back each time they start afresh so that what depends on them restarts too. */
  constructor(restarted: () => void) {
    this.#restarted = restarted;
  }

  /** Tells whether the settings are shown. */
  get isOpen(): boolean {
    return this.#open;
  }

  /** Counts the times the settings started afresh, on opening or after an undo or redo, so that what they show restarts too. */
  get resets(): number {
    return this.#resets;
  }

  /** Returns the message about the latest move of the project start, telling how many tasks it moved, or null. */
  get notice(): string | null {
    return this.#notice;
  }

  /** Returns why the schedule could not be computed after a change made in the settings, or null. */
  get alert(): string | null {
    return this.#alert;
  }

  /** Returns how many tasks the latest baseline set from the settings could not freeze, or null. */
  get baselineNotice(): string | null {
    return this.#baselineNotice;
  }

  /** Shows the settings, starting afresh. */
  open(): void {
    this.restart();
    this.#open = true;
  }

  /** Closes the settings. */
  close(): void {
    this.#open = false;
    this.restart();
  }

  /** Keeps the settings open at the next attempt to close them, since a value typed in a field was refused as the field was left, perhaps to close them. */
  hold(): void {
    this.#held = true;
  }

  /** Lets the settings close again, as after a change that was applied. */
  release(): void {
    this.#held = false;
  }

  /** Closes the settings unless a refused value holds them open once on its reason, telling whether they closed. */
  closeUnlessHeld(): boolean {
    if (this.#held) {
      this.#held = false;
      return false;
    }
    this.close();
    return true;
  }

  /** Sets or clears the message about the latest move of the project start. */
  tell(notice: string | null): void {
    this.#notice = notice;
  }

  /** Sets or clears the message about the tasks the latest baseline could not freeze. */
  tellBaseline(notice: string | null): void {
    this.#baselineNotice = notice;
  }

  /** Shows a problem of the schedule inside the open settings, which hide the other messages. */
  alertIfOpen(text: string): void {
    if (this.#open) {
      this.#alert = text;
    }
  }

  /** Clears the problem of the schedule shown in the settings. */
  clearAlert(): void {
    this.#alert = null;
  }

  /** Clears what the settings show about earlier changes. */
  restart(): void {
    this.#notice = null;
    this.#baselineNotice = null;
    this.#alert = null;
    this.#held = false;
    this.#resets += 1;
    this.#restarted();
  }
}
