// Dedicated Web Worker ticker to avoid Chromium background-tab throttling of main-thread intervals

let timerId: ReturnType<typeof setInterval> | null = null;
let intervalMs = 5000;

self.onmessage = (event: MessageEvent<{ type: 'start' | 'stop'; intervalMs?: number }>) => {
  const data = event.data;
  if (!data) return;

  if (data.type === 'start') {
    if (typeof data.intervalMs === 'number' && data.intervalMs >= 1000) {
      intervalMs = data.intervalMs;
    }
    if (timerId !== null) {
      clearInterval(timerId);
    }
    timerId = setInterval(() => {
      self.postMessage({ type: 'tick', now: Date.now() });
    }, intervalMs);
    self.postMessage({ type: 'tick', now: Date.now() });
  } else if (data.type === 'stop') {
    if (timerId !== null) {
      clearInterval(timerId);
      timerId = null;
    }
  }
};
