import { parentPort } from 'node:worker_threads';
import { serveFileTask } from './file-worker-port';

if (parentPort !== null) {
  serveFileTask(parentPort);
}
