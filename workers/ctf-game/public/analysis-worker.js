import { runPipeline } from './data-pipeline.js';
import { parseVcd, decodeSpi } from './logic-data.js';

self.onmessage = async ({ data }) => {
  try {
    let result;
    if (data.operation === 'pipeline') result = await runPipeline(data.bytes, data.recipe);
    else if (data.operation === 'vcd') result = parseVcd(data.source);
    else if (data.operation === 'spi') result = decodeSpi(parseVcd(data.source), data.options);
    else throw Error('未知分析任务');
    self.postMessage({ result }, result?.bytes ? [result.bytes.buffer] : []);
  } catch (error) { self.postMessage({ error: error.message || '分析失败' }); }
};
