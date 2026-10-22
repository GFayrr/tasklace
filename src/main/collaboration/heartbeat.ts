import type { WebSocket } from 'ws';
import { HEARTBEAT_MILLISECONDS } from '../../core/limits';
import type { StartTimer } from './secure-connection';

export type HeartbeatSocket = Pick<WebSocket, 'ping' | 'terminate' | 'on'>;

/** Pings the other end of an open socket at a steady pace and cuts the socket when nothing came back since the previous ping, as when the other computer was switched off without closing the connection. */
export function watchHeartbeat(socket: HeartbeatSocket, startTimer: StartTimer): void {
  let heard = true;
  let stop: () => void;
  /** Notes that the other end answered or sent something. */
  const hear = (): void => {
    heard = true;
  };
  /** Cuts a socket silent since the previous ping, or pings it again. */
  const beat = (): void => {
    if (!heard) {
      socket.terminate();
      return;
    }
    heard = false;
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
