import { $, $$, askSave, decorate, report } from '/ui.js';
import { parseColorScheme, serializeColorScheme, shortcutActions, shortcutBinding, normalizeShortcut, validateShortcuts } from '/desktop-config.js';
import { themes, wallpapers, defaults, getSettings, saveSettings, applyAppearance, activeProfile, listProfiles, profileKey, createProfile, editProfile, removeProfile, activateProfile, preferenceEvents } from '/preferences.js';

const sections = [
  ['quick', '常用设置', 'preferences-system'], ['appearance', '全局主题与颜色', 'preferences-desktop-theme'],
  ['wallpaper', '壁纸', 'image'], ['fonts', '字体', 'preferences-desktop-font'],
  ['panel', '面板与任务管理器', 'view-list-details'], ['desktops', '虚拟桌面', 'view-grid'],
  ['windows', '窗口管理', 'view-split-left-right'], ['users', '用户', 'user-home'],
  ['region', '日期与时间', 'clock'], ['sound', '声音', 'audio-volume-high'],
  ['notifications', '通知', 'notifications'], ['lock', '屏幕锁定', 'system-lock-screen'],
  ['accessibility', '辅助功能', 'preferences-desktop-accessibility'], ['shortcuts', '快捷键', 'input-keyboard'],
  ['about', '关于此系统', 'help-about'],
];
const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const option = (value, label, current) => `<option value="${escape(value)}"${value === current ? ' selected' : ''}>${escape(label)}</option>`;
const check = (key, label, value) => `<label class="setting-check"><input type="checkbox" data-setting="${key}"${value ? ' checked' : ''}><span>${label}</span></label>`;
const row = (label, control) => `<div class="setting-row"><span class="setting-label">${label}</span><div class="setting-control">${control}</div></div>`;
const select = (key, values, current) => `<select data-setting="${key}" aria-label="${escape(sections.find((item) => item[0] === key)?.[1] || key)}">${values.map(([value, label]) => option(value, label, current)).join('')}</select>`;
const range = (key, min, max, value, suffix = '') => `<input type="range" data-setting="${key}" min="${min}" max="${max}" value="${value}" aria-label="${key}"><output data-for="${key}">${value}${suffix}</output>`;

export function prepareSettings() {
  const node = document.createElement('section');
  node.id = 'settings-window'; node.className = 'window'; node.dataset.window = 'settings';
  node.dataset.title = '系统设置'; node.dataset.width = '1020'; node.dataset.height = '690'; node.hidden = true;
  node.innerHTML = `<div class="window-body systemsettings-app"><div class="settings-layout">
    <aside class="settings-sidebar"><div class="settings-search"><input id="settings-search" type="search" placeholder="搜索设置…" aria-label="搜索设置"></div><nav id="settings-sections" aria-label="设置分类"></nav></aside>
    <div class="settings-main"><header class="settings-heading"><button id="settings-back" type="button" data-icon="application-menu" aria-label="设置分类"></button><h1 id="settings-title">常用设置</h1></header><div id="settings-content"></div><footer class="settings-footer"><button id="settings-defaults" type="button" data-icon="edit-undo">默认值</button><span id="settings-state" role="status"></span><button id="settings-reset" type="button">重置</button><button id="settings-apply" type="button" class="button primary" data-icon="dialog-ok-apply" disabled>应用</button></footer></div>
  </div></div>`;
  $('#desktop').append(node);
}

export function createSettings(controls) {
  let category = 'quick', draft = getSettings(), dirty = false, closing = false;
  const content = $('#settings-content');
  const currentSection = () => sections.find(([id]) => id === category);
  function markChanged() {
    dirty = JSON.stringify(draft) !== JSON.stringify(getSettings());
    $('#settings-apply').disabled = !dirty; $('#settings-reset').disabled = !dirty;
    $('#settings-state').textContent = dirty ? '有未应用的更改' : '';
    try { validateShortcuts(draft); } catch (error) { $('#settings-state').textContent = error.message; $('#settings-apply').disabled = true; }
    applyAppearance(draft);
  }
  function themeCards() {
    return `<div class="theme-grid">${themes.map((theme) => `<button type="button" class="theme-card${draft.theme === theme.id ? ' selected' : ''}" data-theme-choice="${theme.id}" aria-pressed="${draft.theme === theme.id}"><span class="theme-preview" data-preview-theme="${theme.id}"><i></i><b><i></i><i></i><i></i></b></span><span>${theme.name}</span></button>`).join('')}</div>`;
  }
  function renderUsers() {
    content.innerHTML = `<div class="settings-page"><div class="user-cards">${listProfiles().map((user) => `<button class="user-card" type="button" data-user="${user.id}"><span class="profile-avatar" data-avatar="${user.id}">${escape(user.avatar || user.name.slice(0, 1))}</span><strong>${escape(user.name)}</strong><span>${escape(user.username)}</span><small>${user.id === profileKey() ? '当前用户' : user.protected ? '密码保护' : '标准用户'}</small></button>`).join('')}</div><button type="button" id="user-add" data-icon="list-add">添加用户…</button></div>`;
    for (const user of listProfiles()) $(`[data-avatar="${user.id}"]`, content).style.backgroundColor = user.color || '#3daee9';
    $$('[data-user]', content).forEach((button) => button.addEventListener('click', () => userDialog(button.dataset.user)));
    $('#user-add').addEventListener('click', () => userDialog());
  }
  function render() {
    $('#settings-title').textContent = currentSection()[1];
    $$('[data-settings-page]').forEach((button) => { button.classList.toggle('selected', button.dataset.settingsPage === category); button.setAttribute('aria-current', button.dataset.settingsPage === category ? 'page' : 'false'); });
    if (category === 'users') { renderUsers(); decorate(content); return; }
    let body = '';
    if (category === 'quick') body = themeCards() + `<h2>工作区</h2>` + row('文件与文件夹', select('singleClick', [['false', '双击打开'], ['true', '单击打开']], String(draft.singleClick))) + check('animations', '启用动画', draft.animations) + check('showDesktopIcons', '在桌面显示应用图标', draft.showDesktopIcons) + `<div class="settings-links"><button type="button" data-settings-link="wallpaper">更换壁纸…</button><button type="button" data-settings-link="users">用户设置…</button></div>`;
    if (category === 'appearance') body = themeCards() + `<h2>强调色</h2><div class="accent-palette">${['#3daee9','#1abc9c','#27ae60','#fdbc4b','#f67400','#da4453','#9b59b6','#bd93f9'].map((value) => `<button type="button" data-accent="${value}" aria-label="${value}" aria-pressed="${value === draft.accent}"></button>`).join('')}<input type="color" data-setting="accent" value="${draft.accent}" aria-label="自定义强调色"></div><h2>自定义配色</h2><div class="custom-colors">${[['bg','视图背景'],['panel','窗口背景'],['ink','文本'],['muted','次要文本'],['line','边框']].map(([key,label]) => `<label>${label}<input type="color" data-custom-color="${key}" value="${draft.customColors[key] || ({ bg:'#232629',panel:'#31363b',ink:'#eff0f1',muted:'#a1a9b1',line:'#4d5257' })[key]}"></label>`).join('')}</div><div class="settings-links"><button id="theme-import" type="button">导入配色…</button><button id="theme-export" type="button">导出配色…</button></div>`;
    if (category === 'wallpaper') body = `<div class="wallpaper-grid">${wallpapers.filter((wallpaper) => wallpaper.id !== 'custom' || draft.wallpaperImage).map((wallpaper) => `<button type="button" class="wallpaper-card${draft.wallpaper === wallpaper.id ? ' selected' : ''}" data-wallpaper-choice="${wallpaper.id}" aria-pressed="${draft.wallpaper === wallpaper.id}"><span class="wallpaper-preview" data-preview-wallpaper="${wallpaper.id}"></span><span>${wallpaper.name}</span></button>`).join('')}</div>` + row('位置',select('wallpaperMode',[['cover','缩放并裁剪'],['contain','保持比例'],['repeat','平铺']],draft.wallpaperMode)) + row('背景颜色',`<input type="color" data-setting="wallpaperColor" value="${draft.wallpaperColor}" aria-label="背景颜色">`) + `<button id="wallpaper-import" type="button" data-icon="document-open">添加图片…</button>`;
    if (category === 'fonts') body = row('常规字体',select('fontFamily',[['Noto Sans','Noto Sans'],['sans-serif','系统无衬线字体'],['serif','系统衬线字体']],draft.fontFamily)) + row('字号',range('fontSize',10,20,draft.fontSize,' pt')) + row('等宽字体',select('monoFont',[['Hack','Hack'],['Noto Sans Mono','Noto Sans Mono'],['monospace','系统等宽字体']],draft.monoFont)) + row('等宽字号',range('monoSize',10,24,draft.monoSize,' pt')) + row('界面缩放',range('scale',85,150,draft.scale,'%')) + `<div class="font-preview"><p>Aa Bb Cc 0123456789 字体预览</p><pre>const bytes = new Uint8Array(256);\n0123456789abcdef  [] {} () &lt;&gt;</pre></div>`;
    if (category === 'panel') body = row('位置',select('panelPosition',[['bottom','底部'],['top','顶部'],['left','左侧'],['right','右侧']],draft.panelPosition)) + row('厚度',range('panelSize',38,72,draft.panelSize,' px')) + check('panelFloating','浮动面板',draft.panelFloating) + check('panelAutoHide','自动隐藏',draft.panelAutoHide) + check('taskCurrentDesktop','仅显示当前桌面的任务',draft.taskCurrentDesktop) + `<h2>固定的应用程序</h2><div class="pinned-settings">${controls.apps.filter((app) => !app.hidden).map((app) => `<label class="setting-check"><input type="checkbox" data-pinned-app="${app.id}"${draft.pinnedApps.includes(app.id) ? ' checked' : ''}><span>${escape(app.name)}</span></label>`).join('')}</div>`;
    if (category === 'desktops') body = row('桌面数量',`<input type="number" min="1" max="8" data-setting="desktopCount" value="${draft.desktopCount}" aria-label="桌面数量">`) + `<div class="desktop-name-list">${Array.from({length:draft.desktopCount},(_,i) => row(String(i+1),`<input data-desktop-name="${i}" value="${escape(draft.desktopNames[i] || '桌面 '+(i+1))}" maxlength="32" aria-label="桌面 ${i+1} 名称">`)).join('')}</div>`;
    if (category === 'windows') body = row('双击标题栏',select('titlebarDoubleClick',[['maximize','最大化 / 还原'],['shade','卷起 / 展开'],['none','无操作']],draft.titlebarDoubleClick)) + check('focusFollowsMouse','焦点跟随鼠标',draft.focusFollowsMouse) + check('snapWindows','拖到屏幕边缘时平铺',draft.snapWindows) + check('rememberWindows','恢复上次会话的窗口布局',draft.rememberWindows) + `<h2>窗口快捷键</h2><dl class="shortcut-list"><dt>Alt + F4</dt><dd>关闭窗口</dd><dt>Alt + Tab</dt><dd>切换窗口</dd><dt>Meta + ← / →</dt><dd>平铺窗口</dd><dt>Meta + ↑</dt><dd>最大化 / 还原</dd><dt>Meta + ↓</dt><dd>最小化</dd></dl>`;
    if (category === 'region') body = row('时区',select('timeZone',[['Asia/Shanghai','中国标准时间 · UTC+8'],['Asia/Tokyo','日本标准时间 · UTC+9'],['UTC','协调世界时 · UTC'],['Europe/London','伦敦'],['Europe/Berlin','柏林'],['America/New_York','纽约'],['America/Los_Angeles','洛杉矶']],draft.timeZone)) + check('hour24','24 小时制',draft.hour24) + check('showSeconds','显示秒',draft.showSeconds) + row('每周的第一天',select('weekStart',[['1','星期一'],['0','星期日']],String(draft.weekStart))) + `<div class="clock-preview">${new Intl.DateTimeFormat('zh-CN',{timeZone:draft.timeZone,dateStyle:'full',timeStyle:'medium',hour12:!draft.hour24}).format(new Date())}</div>`;
    if (category === 'sound') body = row('主音量',range('volume',0,100,draft.volume,'%')) + check('muted','静音',draft.muted) + `<button id="sound-test" type="button" data-icon="media-playback-start">测试声音</button>`;
    if (category === 'notifications') body = check('notifications','启用通知',draft.notifications) + check('doNotDisturb','请勿打扰',draft.doNotDisturb) + `<button id="notification-test" type="button">发送测试通知</button>`;
    if (category === 'lock') body = row('空闲后自动锁定',select('lockMinutes',[[0,'从不'],[1,'1 分钟'],[5,'5 分钟'],[10,'10 分钟'],[15,'15 分钟'],[30,'30 分钟'],[60,'60 分钟']].map(([v,n]) => [String(v),n]),String(draft.lockMinutes))) + check('lockOnStart','打开新会话时锁定屏幕',draft.lockOnStart) + `<div class="settings-links"><button id="settings-lock-now" type="button" data-icon="system-lock-screen">立即锁定</button><button type="button" data-settings-link="users">更改用户密码…</button></div>`;
    if (category === 'accessibility') body = check('animations','启用动画',draft.animations) + check('reducedTransparency','减少透明效果',draft.reducedTransparency) + row('界面缩放',range('scale',85,150,draft.scale,'%')) + row('光标大小',range('cursorSize',16,48,draft.cursorSize,' px')) + check('nightLight','夜间色温',draft.nightLight) + row('色温强度',range('nightWarmth',0,70,draft.nightWarmth,'%')) + `<button type="button" data-theme-choice="contrast">使用高对比度配色</button>`;
    if (category === 'shortcuts') body = `<div class="shortcut-settings">${shortcutActions.map(([id,label])=>`<label><span>${escape(label)}</span><input data-shortcut="${id}" value="${escape(shortcutBinding(draft,id))}" aria-label="${escape(label)} 快捷键" spellcheck="false" maxlength="100"></label>`).join('')}</div><div class="settings-links"><button type="button" id="shortcuts-defaults">恢复默认快捷键</button></div>`;
    if (category === 'about') body = `<div class="about-system"><span class="about-mark">❯❯</span><h2>Arisaka</h2><p>Plasma 6</p><dl><dt>桌面用户</dt><dd>${escape(activeProfile().username)}</dd><dt>内置应用</dt><dd>${controls.apps.filter((app) => !app.hidden).length}</dd><dt>显示尺寸</dt><dd>${innerWidth} × ${innerHeight}</dd><dt>图形后端</dt><dd>Canvas / WebGL</dd><dt>脚本引擎</dt><dd>JavaScript · WebAssembly</dd><dt>时区</dt><dd>${escape(draft.timeZone)}</dd></dl></div>`;
    content.innerHTML = `<div class="settings-page">${body}</div>`;
    bind(); decorate(content);
  }
  function bind() {
    $$('[data-shortcut]', content).forEach(input => input.addEventListener('change', () => {
      try { draft.shortcuts[input.dataset.shortcut] = normalizeShortcut(input.value); input.value = draft.shortcuts[input.dataset.shortcut]; input.setCustomValidity(''); markChanged(); }
      catch (error) { input.setCustomValidity(error.message); input.reportValidity(); $('#settings-apply').disabled = true; }
    }));
    $('#shortcuts-defaults', content)?.addEventListener('click', () => { draft.shortcuts = {}; markChanged(); render(); });
    $$('[data-setting]', content).forEach((input) => input.addEventListener('input', () => {
      const key = input.dataset.setting;
      draft[key] = input.type === 'checkbox' ? input.checked : typeof defaults[key] === 'number' ? Number(input.value) : typeof defaults[key] === 'boolean' ? input.value === 'true' : input.value;
      const output = $(`[data-for="${key}"]`, content); if (output) output.textContent = input.value + (key === 'volume' || key === 'scale' || key === 'nightWarmth' ? '%' : key === 'panelSize' || key === 'cursorSize' ? ' px' : ' pt');
      markChanged(); if (key === 'desktopCount' || key === 'timeZone') render();
    }));
    $$('[data-theme-choice]',content).forEach((button) => button.addEventListener('click',()=>{draft.theme=button.dataset.themeChoice; draft.accent=themes.find((theme)=>theme.id===draft.theme).colors[3]; markChanged(); render();}));
    $$('[data-accent]',content).forEach((button)=>{button.style.backgroundColor=button.dataset.accent; button.addEventListener('click',()=>{draft.accent=button.dataset.accent; markChanged(); render();});});
    $$('[data-custom-color]',content).forEach((input)=>input.addEventListener('input',()=>{draft.customColors[input.dataset.customColor]=input.value; draft.theme='custom'; markChanged();}));
    $$('[data-wallpaper-choice]',content).forEach((button)=>button.addEventListener('click',()=>{draft.wallpaper=button.dataset.wallpaperChoice; markChanged(); render();}));
    for (const wallpaper of wallpapers) { const preview=$(`[data-preview-wallpaper="${wallpaper.id}"]`,content); if(preview){preview.style.backgroundColor=wallpaper.color; if(wallpaper.file)preview.style.backgroundImage=`url("${wallpaper.file}")`; else if(wallpaper.id==='custom')preview.style.backgroundImage=`url("${draft.wallpaperImage}")`; } }
    $$('[data-pinned-app]',content).forEach((input)=>input.addEventListener('change',()=>{draft.pinnedApps=input.checked?[...draft.pinnedApps,input.dataset.pinnedApp]:draft.pinnedApps.filter((id)=>id!==input.dataset.pinnedApp);markChanged();}));
    $$('[data-desktop-name]',content).forEach((input)=>input.addEventListener('input',()=>{draft.desktopNames[Number(input.dataset.desktopName)]=input.value;markChanged();}));
    $$('[data-settings-link]',content).forEach((button)=>button.addEventListener('click',()=>navigate(button.dataset.settingsLink)));
    $('#settings-lock-now',content)?.addEventListener('click',controls.lock);
    $('#notification-test',content)?.addEventListener('click',()=>controls.notify('系统设置','通知测试'));
    $('#sound-test',content)?.addEventListener('click',()=>{const context=new AudioContext();const oscillator=context.createOscillator();const gain=context.createGain();oscillator.frequency.value=523.25;gain.gain.value=draft.muted?0:draft.volume/100*.12;oscillator.connect(gain);gain.connect(context.destination);oscillator.start();gain.gain.exponentialRampToValueAtTime(.0001,context.currentTime+.4);oscillator.stop(context.currentTime+.4);oscillator.onended=()=>context.close();});
    $('#wallpaper-import',content)?.addEventListener('click',()=>importFile('image/png,image/jpeg,image/webp',async(file)=>{if(file.size>1_450_000)throw new Error('图片最大 1.4 MB');const reader=new FileReader();reader.onload=()=>{draft.wallpaperImage=String(reader.result);draft.wallpaper='custom';markChanged();render();};reader.readAsDataURL(file);}));
    $('#theme-import',content)?.addEventListener('click',()=>importFile('.colors,.json,text/plain,application/json',async(file)=>{
      if(file.size>65536)throw new Error('文件过大');
      const text=await file.text();const data=text.trim().startsWith('{')?JSON.parse(text):parseColorScheme(text);const value=data.colors || data;
      for(const key of ['bg','panel','raised','sidebar','ink','muted','line'])if(typeof value[key]==='string'&&/^#[\da-f]{6}$/i.test(value[key]))draft.customColors[key]=value[key];
      if(/^#[\da-f]{6}$/i.test(value.accent))draft.accent=value.accent;draft.theme='custom';markChanged();render();
    }));
    $('#theme-export',content)?.addEventListener('click',()=>{
      const style=getComputedStyle(document.documentElement);const colors=Object.fromEntries(['bg','panel','raised','sidebar','ink','muted','line','accent'].map(key=>[key,style.getPropertyValue('--'+key).trim()]));
      controls.download('Arisaka.colors',serializeColorScheme(colors),'text/plain;charset=utf-8');
    });
  }
  function importFile(accept, action) {const input=document.createElement('input');input.type='file';input.accept=accept;input.addEventListener('change',()=>{if(input.files[0])Promise.resolve(action(input.files[0])).catch(report);});input.click();}
  function navigate(id) {if(!sections.some(([key])=>key===id))return;category=id;$('#settings-window').classList.remove('show-settings-sidebar');render();}
  function userDialog(id) {
    const user = listProfiles().find((item) => item.id === id);
    const dialog=document.createElement('dialog');dialog.className='native-dialog profile-dialog';
    dialog.innerHTML=`<form method="dialog"><h2>${user?'用户设置':'添加用户'}</h2><label>用户名<input name="username" required pattern="[a-z_][a-z0-9_-]{0,23}" maxlength="24" value="${escape(user?.username||'')}"${user?' readonly':''}></label><label>显示名称<input name="name" maxlength="40" value="${escape(user?.name||'')}"></label><label>头像文字<input name="avatar" maxlength="4" value="${escape(user?.avatar||'')}"></label><label>头像颜色<input name="color" type="color" value="${escape(user?.color||'#3daee9')}"></label>${user?.protected?'<label>当前密码<input name="current" type="password" autocomplete="current-password"></label>':''}<label>${user?'新密码':'密码'}<input name="password" type="password" autocomplete="new-password"></label>${user?'<label class="setting-check"><input name="removePassword" type="checkbox">移除密码</label>':''}<p class="profile-error error-text" role="status"></p><div class="button-row">${user&&user.id!==profileKey()?'<button type="button" data-delete>删除用户</button><button type="button" data-switch>切换用户</button>':''}<button type="button" data-cancel>取消</button><button type="submit" class="button primary">保存</button></div></form>`;
    document.body.append(dialog);dialog.addEventListener('close',()=>dialog.remove(),{once:true});$('[data-cancel]',dialog).onclick=()=>dialog.close();
    const form=$('form',dialog); const error=(value)=>{$('.profile-error',dialog).textContent=value.message;};
    const busy=async(action)=>{const buttons=$$('button',dialog);buttons.forEach((button)=>button.disabled=true);try{await action();}catch(value){error(value);}finally{buttons.forEach((button)=>button.disabled=false);}};
    form.addEventListener('submit',(event)=>{event.preventDefault();void busy(async()=>{const fields=Object.fromEntries(new FormData(form));if(user){const patch={name:fields.name,avatar:fields.avatar,color:fields.color};if(fields.password||fields.removePassword)patch.password=fields.removePassword?'':fields.password;await editProfile(id,patch,fields.current);}else await createProfile(fields);dialog.close();renderUsers();});});
    $('[data-switch]',dialog)?.addEventListener('click',()=>busy(()=>activateProfile(id,form.elements.current?.value||'')));
    $('[data-delete]',dialog)?.addEventListener('click',()=>busy(async()=>{await removeProfile(id,form.elements.current?.value||'');dialog.close();renderUsers();}));
    dialog.showModal();form.elements[user?.protected?'current':'username'].focus();
  }
  for(const [id,label,icon]of sections){const button=document.createElement('button');button.type='button';button.dataset.settingsPage=id;button.dataset.icon=icon;button.textContent=label;button.addEventListener('click',()=>navigate(id));$('#settings-sections').append(button);}
  $('#settings-search').addEventListener('input',(event)=>{const query=event.target.value.toLowerCase();$$('[data-settings-page]').forEach((button)=>button.hidden=!button.textContent.toLowerCase().includes(query));});
  $('#settings-back').addEventListener('click',()=>$('#settings-window').classList.toggle('show-settings-sidebar'));
  $('#settings-apply').addEventListener('click',()=>{try{saveSettings(draft);draft=getSettings();dirty=false;markChanged();controls.toast('设置已应用');}catch(error){report(error);}});
  $('#settings-reset').addEventListener('click',()=>{draft=getSettings();markChanged();render();});
  $('#settings-defaults').addEventListener('click',()=>{draft=structuredClone(defaults);markChanged();render();});
  $('#settings-window').addEventListener('window:close',()=>{draft=getSettings();dirty=false;applyAppearance();});
  $('#settings-window').addEventListener('window:beforeclose', event => {
    if (!dirty) return;
    event.preventDefault(); if (closing) return; closing = true;
    void askSave('系统设置').then(choice => {
      if (choice === 'cancel') return;
      if (choice === 'save') saveSettings(draft);
      dirty = false; controls.windows.close('settings');
    }).catch(report).finally(() => { closing = false; });
  });
  $('#settings-window').addEventListener('window:open',()=>{if(!dirty)draft=getSettings();render();markChanged();});
  preferenceEvents.addEventListener('users',()=>{if(category==='users')renderUsers();});
  decorate($('#settings-window'));render();markChanged();
  return { open(id='quick'){navigate(id);controls.windows.open('settings');} };
}
