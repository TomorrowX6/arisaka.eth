import { $, $$, askText, decorate, menubar, report } from '/ui.js';
import { pickFile } from '/files.js';
import { DOCUMENTS, basename, normalize } from '/filesystem.js';
import { profileKey, updateSettings } from '/preferences.js';
import { parseCallgrind, rgbToHsv, hsvToRgb } from '/profiler.js';

export const developerLayouts = {
  profiler: `<nav id="profiler-menubar" class="native-menubar"></nav><div class="native-toolbar"><button id="profiler-open" data-icon="document-open">打开…</button><button id="profiler-export" data-icon="document-save-as" disabled>导出 CSV…</button><span class="toolbar-separator"></span><select id="profiler-event" aria-label="成本事件"></select><input id="profiler-filter" type="search" aria-label="过滤函数" placeholder="过滤函数…"><label class="setting-check"><input id="profiler-relative" type="checkbox" checked>百分比</label></div><div class="utility-path" id="profiler-path"></div><div class="profiler-workspace"><div class="profiler-functions utility-scroll"><table class="data-table"><thead><tr><th><button data-profile-sort="inclusive">包含</button></th><th><button data-profile-sort="self">自身</button></th><th>调用</th><th><button data-profile-sort="name">函数</button></th></tr></thead><tbody id="profiler-functions"></tbody></table></div><section class="profiler-detail"><header id="profiler-function"></header><div class="native-tabs" role="tablist"><button data-profiler-tab="calls" role="tab" aria-selected="true">调用关系</button><button data-profiler-tab="source" role="tab" aria-selected="false">源码成本</button></div><div id="profiler-calls" class="utility-scroll"></div><div id="profiler-source" class="utility-scroll" hidden></div></section></div><footer class="statusbar" id="profiler-status"></footer>`,
  colors: `<nav id="colors-menubar" class="native-menubar"></nav><div class="native-toolbar"><button id="colors-open" data-icon="document-open">打开图像…</button><button id="colors-eyedropper" data-icon="zoom-in">屏幕取色…</button><span class="toolbar-spacer"></span><button id="colors-export" data-icon="document-save-as">导出调色板…</button></div><div class="color-workspace utility-scroll"><div class="color-selection"><input id="color-picker" type="color" value="#3daee9" aria-label="颜色"><div id="color-preview"></div><input id="color-hex" value="#3daee9" maxlength="7" aria-label="十六进制颜色" spellcheck="false"><button id="color-copy" data-icon="edit-copy">复制</button></div><div class="color-components"><fieldset><legend>RGB</legend>${['R','G','B'].map((label,index)=>`<label>${label}<input data-color-rgb="${index}" type="number" min="0" max="255" step="1" aria-label="${label}"></label>`).join('')}</fieldset><fieldset><legend>HSV</legend>${['H','S','V'].map((label,index)=>`<label>${label}<input data-color-hsv="${index}" type="number" min="0" max="${index?100:360}" step="0.1" aria-label="${label}"></label>`).join('')}</fieldset><fieldset><legend>CMYK</legend><output id="color-cmyk"></output></fieldset></div><div class="color-image"><canvas id="color-canvas" width="1" height="1" aria-label="图像取色" hidden></canvas><span id="color-position"></span></div><div class="native-toolbar"><button id="color-add" data-icon="list-add">添加到调色板</button><button id="color-remove" data-icon="edit-delete">移除颜色</button><button id="color-accent">用作强调色</button></div><div id="color-palette" aria-label="调色板"></div></div><footer class="statusbar" id="color-status"></footer>`,
};

export function createDeveloperTools(controls) {
  const listen = (id, action, event = 'click') => $('#' + id).addEventListener(event, value => { Promise.resolve().then(() => action(value)).catch(report); });
  return { profiler: createProfiler(), colors: createColors() };

  function createProfiler() {
    let profile, selected = '', sort = 'inclusive', path = '';
    const event = () => Number($('#profiler-event').value) || 0;
    function cost(value) {
      if (!$('#profiler-relative').checked) return value.toLocaleString('en-US');
      return profile.total[event()] ? Number(value * 1000n / profile.total[event()]) / 10 + '%' : '0%';
    }
    function render() {
      const list = $('#profiler-functions'); list.replaceChildren();
      if (!profile) return;
      const filter = $('#profiler-filter').value.toLowerCase();
      const rows = profile.functions.filter(item => (item.name + ' ' + item.file + ' ' + item.object).toLowerCase().includes(filter));
      const index = event();
      rows.sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name) : a[sort][index] === b[sort][index] ? a.name.localeCompare(b.name) : a[sort][index] < b[sort][index] ? 1 : -1);
      for (const item of rows.slice(0, 500)) {
        const row = document.createElement('tr'); row.tabIndex = 0; row.classList.toggle('selected', item.id === selected);
        for (const value of [cost(item.inclusive[index]), cost(item.self[index]), String(item.calls), item.name]) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); }
        row.title = item.file + '\n' + item.object;
        const activate = () => { selected = item.id; render(); };
        row.onclick = activate; row.onkeydown = e => { if (e.key === 'Enter') activate(); }; list.append(row);
      }
      $('#profiler-status').textContent = profile.functions.length + ' 个函数 · ' + profile.edges.length + ' 条调用 · ' + profile.total[index] + ' ' + profile.events[index] + (rows.length > 500 ? ' · 显示前 500 行' : '');
      renderDetail();
    }
    function renderDetail() {
      const item = profile?.functions.find(item => item.id === selected);
      $('#profiler-calls').replaceChildren(); $('#profiler-source').replaceChildren();
      $('#profiler-function').textContent = item ? item.name + '\n' + item.file : '';
      if (!item) return;
      for (const [title, incoming] of [['调用者', true], ['被调用者', false]]) {
        const heading = document.createElement('h3'); heading.textContent = title; $('#profiler-calls').append(heading);
        const edges = profile.edges.filter(edge => (incoming ? edge.to : edge.from) === selected).sort((a,b) => a.costs[event()] > b.costs[event()] ? -1 : 1);
        for (const edge of edges.slice(0, 200)) {
          const target = profile.functions.find(fn => fn.id === (incoming ? edge.from : edge.to));
          const button = document.createElement('button'); button.className = 'profiler-edge';
          for (const text of [target.name, cost(edge.costs[event()]), edge.count + ' ×']) { const span = document.createElement('span'); span.textContent = text; button.append(span); }
          button.onclick = () => { selected = target.id; render(); }; $('#profiler-calls').append(button);
        }
      }
      const table = document.createElement('table'); table.className = 'data-table';
      const header = table.createTHead().insertRow();
      for (const text of [...profile.positions, ...profile.events]) { const cell = document.createElement('th'); cell.textContent = text; header.append(cell); }
      const body = table.createTBody();
      for (const line of item.lines.slice(0, 1000)) { const row = body.insertRow(); for (const text of [...line.position, ...line.costs]) row.insertCell().textContent = String(text); }
      $('#profiler-source').append(table);
    }
    async function open(input) {
      const bytes = await controls.fs.read(input); if (bytes.length > 8 * 1024 * 1024) throw Error('性能数据超过大小限制');
      const parsed = parseCallgrind(new TextDecoder('utf-8', {fatal:true}).decode(bytes));
      profile = parsed; path = input; selected = profile.functions[0].id;
      $('#profiler-event').replaceChildren(...profile.events.map((name,index) => { const option = document.createElement('option'); option.value = String(index); option.textContent = name; return option; }));
      $('#profiler-path').textContent = path; $('#profiler-export').disabled = false;
      controls.windows.setTitle('profiler', basename(path) + ' — KCachegrind'); controls.windows.open('profiler'); render();
    }
    listen('profiler-open', () => pickFile(controls.fs, open));
    listen('profiler-filter', render, 'input'); listen('profiler-event', render, 'change'); listen('profiler-relative', render, 'change');
    for (const button of $$('[data-profile-sort]')) button.onclick = () => { sort = button.dataset.profileSort; render(); };
    for (const button of $$('[data-profiler-tab]')) button.onclick = () => {
      $$('[data-profiler-tab]').forEach(item => item.setAttribute('aria-selected', String(item === button)));
      $('#profiler-calls').hidden = button.dataset.profilerTab !== 'calls'; $('#profiler-source').hidden = button.dataset.profilerTab !== 'source';
    };
    listen('profiler-export', () => {
      if (!profile) return;
      const quote = value => '"' + String(value).replace(/^[=+@-]/, match => "'" + match).replaceAll('"','""') + '"';
      const rows = [['Function','Object','File','Calls',...profile.events.map(e=>e+' self'),...profile.events.map(e=>e+' inclusive')], ...profile.functions.map(fn=>[fn.name,fn.object,fn.file,fn.calls,...fn.self,...fn.inclusive])];
      controls.download('profile.csv',rows.map(row=>row.map(quote).join(',')).join('\r\n'),'text/csv;charset=utf-8');
    });
    menubar($('#profiler-menubar'), { '文件': [{label:'打开…',action:()=>$('#profiler-open').click()}, {label:'导出 CSV…',action:()=>$('#profiler-export').click()}, null, {label:'关闭',action:()=>controls.windows.close('profiler')}], '视图': [{label:'百分比 / 绝对成本',action:()=>{$('#profiler-relative').click();}}] });
    return { open, reset() { profile = null; path = ''; selected = ''; $('#profiler-path').textContent = ''; $('#profiler-function').textContent = ''; $('#profiler-calls').replaceChildren(); $('#profiler-source').replaceChildren(); $('#profiler-status').textContent = ''; $('#profiler-export').disabled = true; render(); } };
  }

  function createColors() {
    const key = 'arisaka/palette/' + profileKey();
    let rgb = [61,174,233], palette = [], bitmap;
    try { const saved = JSON.parse(localStorage.getItem(key)); if (Array.isArray(saved)) palette = [...new Set(saved.filter(value => /^#[\da-f]{6}$/i.test(value)))].slice(0,64); } catch {}
    const toHex = value => '#' + value.map(channel => Math.round(channel).toString(16).padStart(2,'0')).join('');
    function setHex(value) { if (!/^#[\da-f]{6}$/i.test(value)) throw Error('无效十六进制颜色'); rgb = value.slice(1).match(/../g).map(pair => parseInt(pair,16)); render(); }
    function savePalette() { localStorage.setItem(key, JSON.stringify(palette)); render(); }
    function render() {
      const color = toHex(rgb); $('#color-picker').value = color; $('#color-hex').value = color; $('#color-preview').style.background = color;
      for (const input of $$('[data-color-rgb]')) input.value = rgb[Number(input.dataset.colorRgb)];
      const hsv = rgbToHsv(rgb); for (const input of $$('[data-color-hsv]')) input.value = hsv[Number(input.dataset.colorHsv)].toFixed(1);
      const k = 1-Math.max(...rgb)/255, cmyk = rgb.map(channel=>k===1?0:(1-channel/255-k)/(1-k));
      $('#color-cmyk').textContent = [...cmyk,k].map(value=>(value*100).toFixed(1)+'%').join(' / ');
      $('#color-palette').replaceChildren(...palette.map(color => {const button=document.createElement('button');button.type='button';button.style.backgroundColor=color;button.title=color;button.setAttribute('aria-label',color);button.setAttribute('aria-pressed',String(color===toHex(rgb)));button.onclick=()=>setHex(color);return button;}));
      $('#color-status').textContent = color.toUpperCase() + ' · ' + rgb.join(', ');
    }
    async function open(path) {
      const bytes=await controls.fs.read(path);
      const next=await createImageBitmap(new Blob([bytes]));
      if(next.width*next.height>16_000_000){next.close();throw Error('图像超过 1600 万像素');}
      bitmap?.close();bitmap=next;
      const canvas=$('#color-canvas');canvas.width=Math.min(960,bitmap.width);canvas.height=Math.max(1,Math.round(bitmap.height*canvas.width/bitmap.width));
      canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);canvas.hidden=false;
      $('#color-position').textContent=bitmap.width+' × '+bitmap.height;controls.windows.open('colors');
    }
    listen('colors-open',()=>pickFile(controls.fs,open));
    $('#colors-eyedropper').disabled=!('EyeDropper' in window);
    listen('colors-eyedropper',async()=>{try{const color=await new EyeDropper().open();setHex(color.sRGBHex);}catch(error){if(error.name!=='AbortError')throw error;}});
    listen('color-picker',event=>setHex(event.target.value),'input');listen('color-hex',event=>setHex(event.target.value),'change');
    for(const kind of ['rgb','hsv'])for(const input of $$('[data-color-'+kind+']'))input.addEventListener('change',()=>{
      try{const values=$$('[data-color-'+kind+']').map(input=>Number(input.value));if(kind==='rgb'){rgbToHsv(values);rgb=values.map(Math.round);}else rgb=hsvToRgb(values);render();}catch(error){report(error);render();}
    });
    listen('color-copy',()=>navigator.clipboard.writeText(toHex(rgb)));
    listen('color-add',()=>{palette=[toHex(rgb),...palette.filter(value=>value!==toHex(rgb))].slice(0,64);savePalette();});
    listen('color-remove',()=>{palette=palette.filter(value=>value!==toHex(rgb));savePalette();});
    listen('color-accent',()=>updateSettings({accent:toHex(rgb)}));
    listen('colors-export',async()=>{
      const name=await askText('导出调色板','palette.gpl');if(!name)return;
      const text='GIMP Palette\nName: Arisaka\nColumns: 8\n#\n'+palette.map(color=>color.slice(1).match(/../g).map(pair=>String(parseInt(pair,16)).padStart(3)).join(' ')+'\t'+color).join('\n')+'\n';
      const path=await controls.fs.writeFile(normalize(name,DOCUMENTS),text);$('#color-status').textContent=path;
    });
    listen('color-canvas',event=>{
      if(!bitmap)return;const box=event.currentTarget.getBoundingClientRect();
      const x=Math.min(bitmap.width-1,Math.max(0,Math.floor((event.clientX-box.left)/box.width*bitmap.width))),y=Math.min(bitmap.height-1,Math.max(0,Math.floor((event.clientY-box.top)/box.height*bitmap.height)));
      const sample=new OffscreenCanvas(1,1).getContext('2d');sample.drawImage(bitmap,x,y,1,1,0,0,1,1);rgb=[...sample.getImageData(0,0,1,1).data].slice(0,3);render();$('#color-position').textContent=x+', '+y;
    },'pointerdown');
    menubar($('#colors-menubar'),{'文件':[{label:'打开图像…',action:()=>$('#colors-open').click()},{label:'导出调色板…',action:()=>$('#colors-export').click()},null,{label:'关闭',action:()=>controls.windows.close('colors')}],'编辑':[{label:'复制颜色',action:()=>$('#color-copy').click()},{label:'添加到调色板',action:()=>$('#color-add').click()}]});
    render();return {open,reset(){bitmap?.close();bitmap=null;$('#color-canvas').hidden=true;}};
  }
}
