function readMidi(buffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const ascii = (offset, size) => new TextDecoder().decode(bytes.subarray(offset, offset + size));
  if (ascii(0, 4) !== 'MThd') throw new Error('无法读取 MIDI 文件头。');
  const ppqn = view.getUint16(12);
  const tracks = [];
  let cursor = 8 + view.getUint32(4);
  while (cursor < bytes.length) {
    if (ascii(cursor, 4) !== 'MTrk') throw new Error('无法读取 MIDI 音轨。');
    const end = cursor + 8 + view.getUint32(cursor + 4);
    cursor += 8;
    let ticks = 0;
    let status = 0;
    let name = 'Track ' + tracks.length;
    const notes = [];
    const active = new Map();
    const vlq = () => {
      let result = 0;
      let byte;
      do { byte = bytes[cursor++]; result = result * 128 + (byte & 127); } while (byte & 128);
      return result;
    };
    while (cursor < end) {
      ticks += vlq();
      if (bytes[cursor] & 128) status = bytes[cursor++];
      if (status === 0xff) {
        const type = bytes[cursor++];
        const length = vlq();
        if (type === 3) name = ascii(cursor, length);
        cursor += length;
      } else if (status === 0xf0 || status === 0xf7) {
        const length = vlq();
        cursor += length;
      } else {
        const channel = status & 15;
        const kind = status & 0xf0;
        const pitch = bytes[cursor++];
        const velocity = kind === 0xc0 || kind === 0xd0 ? 0 : bytes[cursor++];
        const key = channel + ':' + pitch;
        if (kind === 0x90 && velocity > 0) {
          const note = { pitch, velocity, channel, start: ticks / ppqn * .5, end: ticks / ppqn * .5 + .06 };
          active.set(key, note);
          notes.push(note);
        } else if (kind === 0x80 || kind === 0x90 && velocity === 0) {
          const note = active.get(key);
          if (note) { note.end = ticks / ppqn * .5; active.delete(key); }
        }
      }
    }
    if (notes.length) tracks.push({ name, notes });
  }
  return tracks;
}

export function mountMidi(node, buffer, controls) {
  const q = (selector) => node.querySelector(selector);
  const tracks = readMidi(buffer);
  for (const [index, track] of tracks.entries()) {
    const option = document.createElement('option');
    option.value = index;
    option.textContent = track.name;
    q('#midi-track').append(option);
  }
  const canvas = q('.midi-canvas');
  const ctx = canvas.getContext('2d');
  const laneWidth = canvas.width / 4;
  const keys = [...node.querySelectorAll('[data-lane]')];
  let audio;
  let animation;
  let playing = false;
  let startAt = 0;
  let speed = .5;
  let hits = new Set();
  let notes = tracks[0].notes;
  let flash = ['', '', '', ''];
  let flashTimers = [];
  let generation = 0;

  const elapsed = () => playing ? (audio.currentTime - startAt) * speed : -1.5 * speed;
  const score = () => { q('#midi-score').textContent = String(hits.size).padStart(2, '0') + ' / ' + notes.length; };
  function draw() {
    const time = elapsed();
    ctx.fillStyle = '#130e1b';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (let lane = 0; lane < 4; lane++) {
      if (flash[lane]) {
        ctx.fillStyle = flash[lane];
        ctx.fillRect(lane * laneWidth, 0, laneWidth, canvas.height);
      }
      ctx.strokeStyle = '#3b2b49';
      ctx.beginPath();
      ctx.moveTo(lane * laneWidth, 0);
      ctx.lineTo(lane * laneWidth, canvas.height);
      ctx.stroke();
    }
    const target = canvas.height - 38;
    ctx.strokeStyle = '#af819f';
    ctx.beginPath();
    ctx.moveTo(0, target);
    ctx.lineTo(canvas.width, target);
    ctx.stroke();
    ctx.font = '11px monospace';
    ctx.textAlign = 'center';
    for (let lane = 0; lane < 4; lane++) {
      ctx.fillStyle = '#9878ad';
      ctx.fillText(['D', 'F', 'J', 'K'][lane], lane * laneWidth + laneWidth / 2, canvas.height - 14);
    }
    notes.forEach((note, index) => {
      const distance = (note.start - time) / speed;
      const y = target - distance * 112;
      if (y < -12 || y > canvas.height || hits.has(index)) return;
      const lane = note.pitch % 4;
      const x = lane * laneWidth + 22;
      ctx.fillStyle = note.channel === 2 ? '#c7a1b4' : '#997dad';
      ctx.fillRect(x, y - 5, laneWidth - 44, 10);
      ctx.fillStyle = '#cab6d4';
      ctx.font = '9px monospace';
      ctx.fillText(['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][note.pitch % 12] + (Math.floor(note.pitch / 12) - 1), x + (laneWidth - 44) / 2, y - 10);
    });
    if (playing && time > notes.at(-1).end + .7) {
      const total = hits.size;
      stop();
      q('#midi-state').textContent = String(total) + ' / ' + notes.length;
    } else if (playing) {
      animation = requestAnimationFrame(draw);
    }
  }
  function stop() {
    generation++;
    playing = false;
    cancelAnimationFrame(animation);
    const previous = audio;
    audio = undefined;
    if (previous && previous.state !== 'closed') previous.close().catch(() => {});
    q('#midi-play').textContent = '播放 ▷';
    q('#midi-track').disabled = q('#midi-speed').disabled = false;
    q('#midi-state').textContent = '';
  }
  async function play() {
    if (playing) { stop(); draw(); return; }
    const token = ++generation;
    const context = new AudioContext();
    audio = context;
    await context.resume();
    if (controls.signal.aborted || token !== generation) { if (context.state !== 'closed') await context.close(); return; }
    playing = true;
    notes = tracks[Number(q('#midi-track').value)].notes;
    speed = Number(q('#midi-speed').value);
    hits = new Set();
    score();
    startAt = context.currentTime + 1.8;
    for (const note of notes) {
      const oscillator = context.createOscillator();
      const volume = context.createGain();
      const start = startAt + note.start / speed;
      const end = startAt + note.end / speed;
      oscillator.type = note.channel === 2 ? 'sine' : 'triangle';
      oscillator.frequency.value = 440 * Math.pow(2, (note.pitch - 69) / 12);
      volume.gain.setValueAtTime(0, start);
      volume.gain.linearRampToValueAtTime(note.velocity / 127 * .12, start + .006);
      volume.gain.setValueAtTime(note.velocity / 127 * .12, Math.max(start + .007, end - .012));
      volume.gain.linearRampToValueAtTime(0, end + .025);
      oscillator.connect(volume);
      volume.connect(context.destination);
      oscillator.start(start);
      oscillator.stop(end + .03);
    }
    q('#midi-play').textContent = '停止 □';
    q('#midi-track').disabled = q('#midi-speed').disabled = true;
    q('#midi-state').textContent = '';
    draw();
  }
  function tap(lane) {
    keys[lane].classList.add('hit');
    clearTimeout(flashTimers[lane]);
    let hit = false;
    if (playing) {
      const now = elapsed();
      let closest = -1;
      let distance = .18;
      notes.forEach((note, index) => {
        const diff = Math.abs(note.start - now) / speed;
        if (note.pitch % 4 === lane && !hits.has(index) && diff < distance) { closest = index; distance = diff; }
      });
      if (closest >= 0) { hits.add(closest); hit = true; score(); }
    }
    flash[lane] = hit ? '#26483585' : '#4e2c4860';
    flashTimers[lane] = setTimeout(() => {
      keys[lane].classList.remove('hit');
      flash[lane] = '';
      if (!playing) draw();
    }, 130);
    if (!playing) draw();
  }
  q('#midi-play').addEventListener('click', () => play().catch((error) => { stop(); controls.toast(error.message); }), { signal: controls.signal });
  q('#midi-track').addEventListener('change', () => {
    notes = tracks[Number(q('#midi-track').value)].notes;
    hits = new Set();
    score();
    draw();
  }, { signal: controls.signal });
  q('#midi-speed').addEventListener('change', () => { speed = Number(q('#midi-speed').value); draw(); }, { signal: controls.signal });
  keys.forEach((button, lane) => button.addEventListener('pointerdown', (event) => { event.preventDefault(); tap(lane); }, { signal: controls.signal }));
  document.addEventListener('keydown', (event) => {
    if (event.repeat || event.ctrlKey || event.altKey || event.metaKey || /INPUT|TEXTAREA|SELECT/.test(event.target.tagName) || document.querySelector('dialog[open]')) return;
    const lane = ['d', 'f', 'j', 'k'].indexOf(event.key.toLowerCase());
    if (lane < 0) return;
    event.preventDefault();
    tap(lane);
  }, { signal: controls.signal });
  score();
  draw();
  return () => { stop(); flashTimers.forEach(clearTimeout); };
}
