import type { TasklaceBridge } from '../../src/preload/bridge-contract';

type UntrustedArguments<T> = {
  readonly [Key in keyof T]: T[Key] extends (...values: infer Values) => infer Answer
    ? (...values: { readonly [Index in keyof Values]: unknown }) => Answer
    : T[Key];
};

declare global {
  interface Window {
    readonly tasklace?: UntrustedArguments<TasklaceBridge>;
    ranInlineScript?: boolean;
    ranStringCode?: boolean;
  }
}

export {};
