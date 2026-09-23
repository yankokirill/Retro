// WebSocket-адаптер: строки ядра клиента ↔ сокет, переподключение с экспоненциальной задержкой
// (REQ-023, protocol.md § 6). Логики синхронизации здесь нет — она в @retro/client-core.

import type { SyncClient } from "@retro/client-core";

export interface SocketLike {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

export interface ConnectOptions {
  readonly client: SyncClient;
  readonly url: string;
  readonly createSocket: (url: string) => SocketLike;
  readonly setTimer: (fn: () => void, ms: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
  readonly onChange?: () => void;
  readonly backoff?: { readonly baseMs: number; readonly maxMs: number };
}

export interface Connection {
  send(strings: readonly string[]): void;
  close(): void;
}

export function buildWsUrl(location: { protocol: string; host: string }, boardId: string): string {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.host}/api/boards/${encodeURIComponent(boardId)}/ws`;
}

export function connectSync(opts: ConnectOptions): Connection {
  const { client } = opts;
  const baseMs = opts.backoff?.baseMs ?? 500;
  const maxMs = opts.backoff?.maxMs ?? 30000;
  let socket: SocketLike | null = null;
  let isOpen = false;
  let closed = false;
  let failures = 0;
  let timer: unknown = null;

  const notify = () => opts.onChange?.();

  function open(): void {
    const current = opts.createSocket(opts.url);
    socket = current;
    current.onopen = () => {
      if (socket !== current) return;
      isOpen = true;
      for (const line of client.connected()) current.send(line);
      notify();
    };
    current.onmessage = (event) => {
      if (socket !== current) return;
      try {
        for (const line of client.receive(event.data)) current.send(line);
        if (client.inspect().status === "welcomed") failures = 0;
      } catch {
        // Ошибка протокола: рвём соединение, дальше — обычное переподключение.
        current.close();
      }
      notify();
    };
    current.onclose = () => {
      if (socket !== current) return;
      isOpen = false;
      socket = null;
      client.disconnected();
      notify();
      if (closed) return;
      const delay = Math.min(maxMs, baseMs * 2 ** failures);
      failures += 1;
      timer = opts.setTimer(() => {
        timer = null;
        if (!closed) open();
      }, delay);
    };
    current.onerror = () => {};
  }

  open();

  return {
    send(strings) {
      if (!isOpen || socket === null) return;
      for (const line of strings) socket.send(line);
    },
    close() {
      closed = true;
      if (timer !== null) {
        opts.clearTimer(timer);
        timer = null;
      }
      const current = socket;
      socket = null;
      isOpen = false;
      current?.close();
      client.disconnected();
    },
  };
}
