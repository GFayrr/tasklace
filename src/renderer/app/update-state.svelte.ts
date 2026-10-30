import type { BridgeResult, TasklaceBridge } from '../../preload/bridge-contract';

export type UpdateBridge = Pick<
  TasklaceBridge,
  | 'appVersion'
  | 'updateSettings'
  | 'setCheckForNewVersions'
  | 'checkAtLaunch'
  | 'checkNow'
  | 'openReleasePage'
  | 'openPrivacyPolicy'
>;

export type CheckStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'checking' }
  | { readonly kind: 'latest'; readonly checkedAt: Date }
  | { readonly kind: 'newer'; readonly version: string }
  | { readonly kind: 'failed' };

/** Holds what the page knows about the version of Tasklace: the version in use, whether this computer checks for new versions, and the result of the last check asked from the settings. */
export class UpdateState {
  readonly #bridge: UpdateBridge;
  readonly #now: () => Date;
  #version = $state<string | null>(null);
  #checkForNewVersions = $state<boolean | null>(null);
  #status = $state.raw<CheckStatus>({ kind: 'idle' });

  /** Starts with nothing known, until the main process is asked. */
  constructor(bridge: UpdateBridge, now: () => Date) {
    this.#bridge = bridge;
    this.#now = now;
  }

  /** Gives the version in use, or null until it is known. */
  get version(): string | null {
    return this.#version;
  }

  /** Tells whether this computer checks for new versions, or null until it is known. */
  get checkForNewVersions(): boolean | null {
    return this.#checkForNewVersions;
  }

  /** Gives the result of the last check asked from the settings. */
  get status(): CheckStatus {
    return this.#status;
  }

  /** Asks the main process for the version in use and the setting of the check, telling whether both are known, a failure being logged. */
  async load(): Promise<boolean> {
    const [version, settings] = await Promise.all([
      this.#bridge.appVersion(),
      this.#bridge.updateSettings(),
    ]);
    if (version.ok) {
      this.#version = version.value;
    }
    if (settings.ok) {
      this.#checkForNewVersions = settings.value.checkForNewVersions;
    }
    logFailure('The version of Tasklace could not be read:', version);
    logFailure('The settings of new versions could not be read:', settings);
    return version.ok && settings.ok;
  }

  /** Runs the check of a new launch, which the main process skips when it is off or already done today, giving the newer version found, or null. */
  async checkAtLaunch(): Promise<string | null> {
    const result = await this.#bridge.checkAtLaunch();
    logFailure('The check for new versions at launch could not run:', result);
    return result.ok && result.value.kind === 'newer' ? result.value.version : null;
  }

  /** Turns the check for new versions on or off, telling whether this computer kept the choice. */
  async setCheck(check: boolean): Promise<boolean> {
    const result = await this.#bridge.setCheckForNewVersions(check);
    logFailure('The setting of new versions could not be kept:', result);
    if (result.ok) {
      this.#checkForNewVersions = check;
    }
    return result.ok;
  }

  /** Checks for a new version now, whatever the setting, showing the result under the version. */
  async checkNow(): Promise<void> {
    this.#status = { kind: 'checking' };
    const result = await this.#bridge.checkNow();
    logFailure('The check for new versions could not run:', result);
    if (!result.ok || result.value.kind === 'failed') {
      this.#status = { kind: 'failed' };
      return;
    }
    this.#status =
      result.value.kind === 'newer'
        ? { kind: 'newer', version: result.value.version }
        : { kind: 'latest', checkedAt: this.#now() };
  }

  /** Opens the page of a release in the browser, telling whether it opened. */
  async openReleasePage(version: string): Promise<boolean> {
    return (await this.#bridge.openReleasePage(version)).ok;
  }

  /** Opens the privacy policy in the browser, telling whether it opened. */
  async openPrivacyPolicy(): Promise<boolean> {
    return (await this.#bridge.openPrivacyPolicy()).ok;
  }
}

/** Logs the failure of a request about versions with its cause, a success logging nothing. */
function logFailure(what: string, result: BridgeResult<unknown>): void {
  if (!result.ok) {
    console.warn(what, result.error.code);
  }
}
