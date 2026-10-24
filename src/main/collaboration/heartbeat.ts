import type { WebSocket } from 'ws';
import { HEARTBEAT_MILLISECONDS } from '../../core/limits';
import type { StartTimer } from './secure-connection';

const SILENT_BEATS_BEFORE_CUT = 2;

export type HeartbeatSocket = Pick<WebSocket, 'ping' | 'terminate' | 'on'>;

/** Pings the other end of a socket at a steady pace and cuts it once silent for a few pings, as when the other computer was switched off without closing the connection, reading first what already arrived in case this process was busy. */
export function watchHeartbeat(socket: HeartbeatSocket, startTimer: StartTimer): void {
  let silentBeats = 0;
  let stop: () => void;
  /** Notes that the other end answered or sent something. */
  const hear = (): void => {
    silentBeats = 0;
  };
  /** Cuts the socket if it is still silent once what already arrived has been read, or beats again. */
  const cutIfSilent = (): void => {
    if (silentBeats >= SILENT_BEATS_BEFORE_CUT) {
      console.warn('A connection to the shared plan stayed silent and was cut.');
      socket.terminate();
      return;
    }
    beat();
  };
  /** Pings the socket again, or, once it stayed silent too long, lets what already arrived be read before deciding. */
  const beat = (): void => {
    if (silentBeats >= SILENT_BEATS_BEFORE_CUT) {
      stop = startTimer(0, cutIfSilent);
      return;
    }
    silentBeats += 1;
    socket.ping();
    stop = startTimer(HEARTBEAT_MILLISECONDS, beat);
  };
  socket.on('pong', hear);
  socket.on('message', hear);
  socket.on('close', () => {
    stop();
  });
  stop = startTimer(HEARTBEAT_MILLISECONDS, beat);
}
