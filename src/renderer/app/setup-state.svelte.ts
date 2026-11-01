import type {
  FileAssociation,
  TasklaceBridge,
  WelcomeChoices,
} from '../../preload/bridge-contract';

export type SetupBridge = Pick<
  TasklaceBridge,
  'setupState' | 'finishWelcome' | 'setFileAssociation'
>;

/** Holds what the page knows of the setup of this copy of Tasklace: whether its welcome window must ask its choices, and which copy opens project files and links. */
export class SetupState {
  readonly #bridge: SetupBridge;
  #welcome = $state(false);
  #loaded = $state(false);
  #association = $state.raw<FileAssociation | null>(null);

  /** Starts with no welcome window and nothing known of the copy that opens project files, until the main process is asked. */
  constructor(bridge: SetupBridge) {
    this.#bridge = bridge;
  }

  /** Tells whether the welcome window asks its choices. */
  get welcome(): boolean {
    return this.#welcome;
  }

  /** Tells whether the main process was asked for the setup of this copy, so that nothing from outside is taken before the welcome is known. */
  get isLoaded(): boolean {
    return this.#loaded;
  }

  /** Gives which copy opens project files and links, or null until it is known. */
  get association(): FileAssociation | null {
    return this.#association;
  }

  /** Asks the main process for the setup of this copy, telling whether it answered, a setup that cannot be read being logged and leaving the welcome window closed, since the main process then holds back what it would send. */
  async load(): Promise<boolean> {
    const state = await this.#bridge.setupState();
    this.#loaded = true;
    if (!state.ok) {
      console.warn('The setup of Tasklace could not be read:', state.error.code);
      return false;
    }
    this.#welcome = state.value.welcome;
    this.#association = state.value.association;
    return true;
  }

  /** Gives the choices of the welcome window to the main process and closes it whatever happens, so that it never holds the person back, telling whether the choices were applied and asking again which copy opens files when they were not. */
  async finishWelcome(choices: WelcomeChoices): Promise<boolean> {
    this.#welcome = false;
    const finished = await this.#bridge.finishWelcome(choices);
    if (!finished.ok) {
      console.warn('The choices of the welcome window could not be applied:', finished.error.code);
      await this.load();
      return false;
    }
    this.#association = finished.value;
    return choices.associate ? finished.value.kind === 'thisCopy' : true;
  }

  /** Makes this copy open project files and links or stops it, telling whether this copy now does what was asked and asking again which copy opens them when it could not be changed. */
  async setAssociation(on: boolean): Promise<boolean> {
    const changed = await this.#bridge.setFileAssociation(on);
    if (!changed.ok) {
      console.warn('The copy that opens project files could not be changed:', changed.error.code);
      await this.load();
      return false;
    }
    this.#association = changed.value;
    return (changed.value.kind === 'thisCopy') === on;
  }
}
