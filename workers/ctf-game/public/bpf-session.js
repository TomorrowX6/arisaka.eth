export function createBpfSession() {
  const worker = new Worker('/bpf-worker.js', { type: 'module' }), pending = new Map();
  let serial = 0, stopped = false;
  function stop(error = new DOMException('已停止', 'AbortError')) {
    if (stopped) return; stopped = true; worker.terminate();
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
  }
  worker.onmessage = ({ data }) => {
    const request = pending.get(data.id); if (!request) return;
    pending.delete(data.id); clearTimeout(request.timer);
    data.error ? request.reject(Error(data.error)) : request.resolve(data.result);
  };
  worker.onerror = event => { event.preventDefault(); stop(Error('BPF Worker 失败，请重置后重试')); };
  worker.onmessageerror = () => stop(Error('BPF Worker 消息无法读取，请重置'));
  return {
    stop,
    send(operation, payload = {}) {
      if (stopped) return Promise.reject(new DOMException('BPF 会话已停止，请重置', 'AbortError'));
      if (pending.size >= 4) return Promise.reject(Error('BPF 请求过多，请等待当前操作'));
      return new Promise((resolve, reject) => {
        const id = ++serial, timer = setTimeout(() => stop(Error('BPF 操作超过 20 秒，已停止；请重置')), 20000);
        pending.set(id, { resolve, reject, timer });
        try { worker.postMessage({ ...payload, operation, id }); }
        catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
      });
    },
  };
}
