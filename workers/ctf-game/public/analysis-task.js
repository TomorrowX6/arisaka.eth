export function createAnalysisTask() {
  let worker, pending, timer;
  const stop = () => {
    clearTimeout(timer); worker?.terminate(); worker = undefined;
    const reject = pending; pending = undefined;
    if (reject) reject(new DOMException('已停止', 'AbortError'));
  };
  const run = payload => {
    stop();
    return new Promise((resolve, reject) => {
      pending = reject; worker = new Worker('/analysis-worker.js', { type: 'module' });
      const finish = (error, value) => { pending = undefined; stop(); error ? reject(error) : resolve(value); };
      worker.onmessage = ({ data }) => finish(data.error ? Error(data.error) : null, data.result);
      worker.onerror = event => { event.preventDefault(); finish(Error('分析 Worker 失败，请重试')); };
      timer = setTimeout(() => finish(Error('分析超过 20 秒，已停止')), 20000);
      worker.postMessage(payload);
    });
  };
  return { run, stop };
}
