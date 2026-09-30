import type { TasklaceBridge } from '../preload/bridge-contract';

declare global {
  interface Window {
    readonly tasklace: TasklaceBridge;
  }
}

export {};
