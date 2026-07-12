(() => {
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const logoutBtn = document.getElementById('logout-btn');

  const term = new Terminal({
    cursorBlink: true,
    fontFamily: "'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace",
    fontSize: 14,
    theme: {
      background: '#0a0908',
      foreground: '#e8e2d5',
      cursor: '#f2a541',
      cursorAccent: '#0a0908',
      selectionBackground: '#8a5f22',
      black: '#14120e',
      red: '#e8564a',
      green: '#6fbf73',
      yellow: '#f2a541',
      blue: '#7fa7d6',
      magenta: '#c792ea',
      cyan: '#8fd6c9',
      white: '#e8e2d5',
      brightBlack: '#8f8873',
    },
  });

  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(document.getElementById('terminal'));
  fitAddon.fit();
  term.focus();

  let ws = null;
  let reconnectAttempts = 0;
  let intentionalClose = false;
  const MAX_RECONNECT_DELAY_MS = 10000;

  function setStatus(state, text) {
    statusDot.className = `status-dot ${state}`;
    statusText.textContent = text;
  }

  function sendResize() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    }
  }

  function connect() {
    setStatus('', reconnectAttempts > 0 ? `reconnecting (attempt ${reconnectAttempts})…` : 'connecting…');

    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${protocol}://${location.host}/pty`);

    ws.onopen = () => {
      reconnectAttempts = 0;
      setStatus('connected', 'connected');
      fitAddon.fit();
      sendResize();
      term.focus();
    };

    ws.onmessage = (event) => {
      term.write(event.data);
    };

    ws.onclose = (event) => {
      if (intentionalClose) return;
      setStatus('disconnected', event.reason ? `disconnected: ${event.reason}` : 'disconnected');
      scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose fires right after; let that path handle status + reconnect.
    };
  }

  function scheduleReconnect() {
    reconnectAttempts += 1;
    const delay = Math.min(500 * 2 ** reconnectAttempts, MAX_RECONNECT_DELAY_MS);
    setTimeout(connect, delay);
  }

  term.onData((data) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', data }));
    }
  });

  const resizeObserver = new ResizeObserver(() => {
    fitAddon.fit();
    sendResize();
  });
  resizeObserver.observe(document.getElementById('terminal-container'));

  logoutBtn.addEventListener('click', async () => {
    intentionalClose = true;
    if (ws) ws.close();
    await fetch('/logout', { method: 'POST' });
    location.href = '/login';
  });

  connect();
})();
