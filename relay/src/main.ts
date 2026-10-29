import { readConfig } from './config.ts';
import { startRelayServer } from './server.ts';

const FAILED = 1;

/** Starts the relay from the settings of its environment and stops it cleanly when asked to. */
async function main(): Promise<void> {
  const read = readConfig(process.env);
  if (!read.ok) {
    console.error(read.problem);
    process.exitCode = FAILED;
    return;
  }
  const relay = await startRelayServer({ config: read.config });
  console.info(`The Tasklace relay listens on ${read.config.host}, port ${String(relay.port)}.`);
  /** Stops the relay once, letting the writes in progress end. */
  const stop = (): void => {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    relay.close().catch((error: unknown) => {
      console.error('The relay could not stop cleanly:', error);
      process.exitCode = FAILED;
    });
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((error: unknown) => {
  console.error('The relay could not start:', error);
  process.exitCode = FAILED;
});
