declare global {
  interface Window {
    readonly tasklace?: {
      readonly appVersion: () => Promise<string>;
      readonly openExternal: (url: unknown) => Promise<boolean>;
    };
    ranInlineScript?: boolean;
    ranStringCode?: boolean;
  }
}

export {};
