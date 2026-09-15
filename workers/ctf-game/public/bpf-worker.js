import { BpfMachine } from './bpf-core.js';
import { loadBpf } from './bpf-elf.js';

let program, machine;
self.onmessage = ({ data }) => {
  const { id, operation } = data;
  try {
    let result;
    if (operation === 'load') {
      program = undefined; machine = undefined;
      program = loadBpf(data.bytes);
      let executionError;
      try { machine = new BpfMachine(program, data.packet || new Uint8Array(), data.entry ?? program.entry); }
      catch (error) { executionError = error.message; }
      const { format, entry, entries, instructions, symbols, sections, relocations, warnings } = program;
      result = { program: { format, entry, entries, instructions, symbols, sections, relocations, warnings, codeBytes: program.code.length }, snapshot: machine?.snapshot(), executionError };
    } else {
      if (!machine) throw Error('尚无可执行的 BPF 会话，请重置或打开程序');
      if (operation === 'step') { machine.step(); result = machine.snapshot(); }
      else if (operation === 'run') result = machine.run({ limit: data.limit, breakpoints: data.breakpoints, skipCurrent: data.skipCurrent });
      else if (operation === 'memory') result = machine.inspectMemory(data.name, data.offset, data.length);
      else throw Error('未知 BPF 操作');
    }
    self.postMessage({ id, result });
  } catch (error) { self.postMessage({ id, error: error.message }); }
};
