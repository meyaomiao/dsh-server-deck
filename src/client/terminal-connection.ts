/** Minimal client-only handoff from the Cordis entry to TerminalPane. */
export interface TerminalConnection {
  openWebSocket(path: string): WebSocket;
}

let openWebSocket: ((path: string) => WebSocket) | undefined;

export function installTerminalConnection(connection?: Partial<TerminalConnection>): () => void {
  const open = typeof connection?.openWebSocket === 'function'
    ? connection.openWebSocket.bind(connection)
    : undefined;
  openWebSocket = open;
  return () => {
    if (openWebSocket === open) openWebSocket = undefined;
  };
}

export function openTerminalWebSocket(url: string): WebSocket {
  if (openWebSocket === undefined) throw new Error('宿主鉴权连接不可用,请升级至 DSH 0.2.1-rc.5 或更新版本');
  const target = new URL(url);
  // Connection resolves the deployment base; only forward this plugin's logical route.
  return openWebSocket(`/server-deck/ws/pty${target.search}`);
}
