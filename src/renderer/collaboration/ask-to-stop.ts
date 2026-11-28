import type { TasklaceBridge } from '../../preload/bridge-contract';

/** Asks the main process to stop sharing, logging under the given words why it refused or failed, and tells whether it confirmed. */
export async function askToStop(
  bridge: Pick<TasklaceBridge, 'stopCollaboration'>,
  failure: string,
): Promise<boolean> {
  try {
    const stopped = await bridge.stopCollaboration();
    if (!stopped.ok) {
      console.error(failure, stopped.error);
    }
    return stopped.ok;
  } catch (error) {
    console.error(failure, error);
    return false;
  }
}
