import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { ChannelAnswers, InvokeChannel } from '../preload/bridge-contract';
import type { TrustCheck } from './ipc-trust';

export type ChannelHandler<C extends InvokeChannel> = (
  event: IpcMainInvokeEvent,
  ...values: unknown[]
) => ChannelAnswers[C] | Promise<ChannelAnswers[C]>;

/** Answers a request channel of the bridge only from a page of the application, with the type of answer the channel promises. */
export function handleChannel<C extends InvokeChannel>(
  assertTrusted: TrustCheck,
  channel: C,
  answer: ChannelHandler<C>,
): void {
  registerChannel(assertTrusted, channel, answer);
}

/** Answers a request channel of the bridge only from a page of the application, for a caller that checks the type of its answers itself. */
export function registerChannel(
  assertTrusted: TrustCheck,
  channel: InvokeChannel,
  answer: (event: IpcMainInvokeEvent, ...values: unknown[]) => unknown,
): void {
  ipcMain.handle(channel, (event, ...values: unknown[]) => {
    assertTrusted(event);
    return answer(event, ...values);
  });
}
