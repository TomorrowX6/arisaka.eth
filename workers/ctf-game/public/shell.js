import { $, $$, decorate, menu, closeMenu, report } from '/ui.js';
import { icon } from '/desktop.js';
import { applications, findApplications } from '/applications.js';
import { activeProfile, listProfiles, profileKey, getSettings, updateSettings, authenticateProfile, activateProfile, preferenceEvents } from '/preferences.js';
import { createSettings, prepareSettings } from '/settings.js';
import { HOME } from '/filesystem.js';
import { matchesShortcut } from '/desktop-config.js';

const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
function readStore(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch { return fallback; } }

export function prepareShell() {
  $$('[data-place]').forEach((node) => { node.dataset.place = node.dataset.place.replace('/home/user', HOME); });
  $('#file-location').value = HOME;
  $('#files-home').textContent = activeProfile().username;
  prepareSettings();
  $('#launcher').innerHTML = `<header><button id="launcher-user" type="button"><span class="user-avatar"></span><span class="profile-name"></span></button><span id="player-label" class="mono"></span></header><div class="launcher-search"><span data-icon="edit-find"></span><input id="launcher-search" type="search" aria-label="搜索应用程序" placeholder="搜索…" autocomplete="off"></div><div class="launcher-content"><nav id="launcher-categories" aria-label="应用分类"></nav><div id="launcher-apps" role="list" aria-label="应用程序"></div></div><footer><button id="launcher-settings" type="button" data-launch="settings" data-icon="systemsettings">系统设置</button><span></span><button id="launcher-lock" type="button" data-icon="system-lock-screen" title="锁定 (Meta+L)" aria-label="锁定"></button><button id="launcher-power" type="button" data-icon="system-shutdown" aria-label="电源与会话"></button><button id="restart-button" type="button" title="新建游戏存档">新游戏</button></footer>`;
  const pager = document.createElement('nav'); pager.id='desktop-pager';pager.setAttribute('aria-label','虚拟桌面');$('#tasks').before(pager);
  $('.system-tray').innerHTML = `<button id="tray-clipboard" type="button" class="tray-button" data-icon="edit-paste" aria-label="剪贴板" title="剪贴板"></button><button id="tray-volume" type="button" class="tray-button" data-icon="audio-volume-high" aria-label="音量" title="音量"></button><button id="tray-network" type="button" class="tray-button" data-icon="network-wired" aria-label="网络" title="网络"><span class="connection"><i></i><span id="connection-label"></span></span></button><button id="tray-notifications" type="button" class="tray-button" data-icon="notifications" aria-label="通知" title="通知"><span id="notification-count" hidden></span></button><button id="tray-clock" class="clock" type="button" aria-label="日期与时间"><time id="clock-time"></time><span id="clock-date"></span></button><button id="show-desktop" type="button" aria-label="显示桌面" title="显示桌面 (Meta+D)"></button>`;
  const shell=document.createElement('div');shell.id='shell-overlays';
  shell.innerHTML=`<section id="krunner" class="krunner" role="dialog" aria-label="KRunner" hidden><form id="runner-form"><span class="runner-mark">❯❯</span><input id="runner-search" type="search" placeholder="搜索应用、打开文件…" aria-label="运行命令" autocomplete="off" spellcheck="false"><button id="runner-close" type="button" aria-label="关闭">×</button></form><div id="runner-results"></div></section><section id="tray-popup" class="tray-popup" hidden></section><section id="desktop-overview" role="dialog" aria-label="桌面概览" hidden><header><h1>桌面概览</h1><button id="overview-close" type="button" aria-label="关闭概览">×</button></header><div id="overview-desktops"></div></section>`;
  $('#desktop').append(shell);
  const lock=document.createElement('section');lock.id='screen-lock';lock.hidden=true;lock.setAttribute('role','dialog');lock.setAttribute('aria-modal','true');lock.setAttribute('aria-label','屏幕锁定');
  lock.innerHTML=`<div class="lock-clock"><time id="lock-time"></time><span id="lock-date"></span></div><form id="unlock-form"><span id="lock-avatar" class="profile-avatar"></span><h1 id="lock-name"></h1><label id="unlock-password-label" class="sr-only" for="unlock-password">密码</label><div class="unlock-controls"><input id="unlock-password" type="password" autocomplete="current-password" placeholder="密码" aria-label="密码"><button id="unlock-button" type="submit" class="button primary">解锁</button></div><p id="unlock-message" role="status"></p></form><nav id="lock-users" aria-label="切换用户"></nav><button id="lock-power" type="button" data-icon="system-shutdown">电源</button>`;
  document.body.append(lock);decorate();
  const desktopSettings=document.createElement('button');desktopSettings.type='button';desktopSettings.dataset.launch='settings';desktopSettings.innerHTML='<span class="app-icon"></span><span>系统设置</span>';$('.desktop-icons').append(desktopSettings);
}

export function createShell(controls) {
  const { windows } = controls;
  let settings=getSettings(), launcherCategory='收藏', popup='', lockUser=profileKey(), locked=false, timer;
  const recentKey='arisaka/recent-apps/'+profileKey(), notificationKey='arisaka/notifications/'+profileKey(), clipboardKey='arisaka/clipboard/'+profileKey();
  let recent=readStore(recentKey,[]), notifications=readStore(notificationKey,[]), clipboard=readStore(clipboardKey,[]);
  const settingsApp=createSettings({...controls,apps:applications,lock:()=>lock(),notify});
  function save(key,value){try{localStorage.setItem(key,JSON.stringify(value));}catch{}}
  function renderUser(){const user=activeProfile();$('.user-avatar').textContent=user.avatar||user.name.slice(0,1);$('.user-avatar').style.backgroundColor=user.color||'#3daee9';$('.profile-name').textContent=user.name;}
  function appButton(app,compact=false){const button=document.createElement('button');button.type='button';button.dataset.launch=app.id;button.className=compact?'runner-result':'launcher-app';button.innerHTML='<span class="app-icon">'+icon(app.id)+'</span><span><strong>'+escape(app.name)+'</strong><small>'+escape(app.description||'')+'</small></span>';return button;}
  function renderLauncher(){
    const query=$('#launcher-search').value;
    let apps=findApplications(query);
    if(!query){if(launcherCategory==='收藏')apps=apps.filter((app)=>settings.pinnedApps.includes(app.id));else if(launcherCategory==='最近使用')apps=recent.map((id)=>apps.find((app)=>app.id===id)).filter(Boolean);else if(launcherCategory!=='所有应用')apps=apps.filter((app)=>app.category===launcherCategory);}
    $('#launcher-apps').replaceChildren(...apps.map((app)=>appButton(app)));
    if(!apps.length){const empty=document.createElement('p');empty.className='empty-state';empty.textContent='没有匹配的应用';$('#launcher-apps').append(empty);}
    $$('[data-launcher-category]').forEach((button)=>button.classList.toggle('selected',button.dataset.launcherCategory===launcherCategory));
  }
  for(const category of ['收藏','所有应用','最近使用','系统','开发','办公','多媒体','图形','工具']){const button=document.createElement('button');button.type='button';button.textContent=category;button.dataset.launcherCategory=category;button.addEventListener('click',()=>{launcherCategory=category;$('#launcher-search').value='';renderLauncher();});$('#launcher-categories').append(button);}
  function toggleLauncher(){if(locked)return;closePopup();$('#krunner').hidden=true;$('#launcher').hidden=!$('#launcher').hidden;$('#launcher-button').setAttribute('aria-expanded',String(!$('#launcher').hidden));if(!$('#launcher').hidden){renderLauncher();$('#launcher-search').focus();}}
  $('#launcher-button').addEventListener('click',toggleLauncher);
  $('#launcher-search').addEventListener('input',renderLauncher);
  $('#launcher-search').addEventListener('keydown',(event)=>{if(event.key==='Enter')$('#launcher-apps [data-launch]')?.click();if(event.key==='ArrowDown'){event.preventDefault();$('#launcher-apps button')?.focus();}});
  $('#launcher-user').addEventListener('click',()=>settingsApp.open('users'));
  $('#launcher-lock').addEventListener('click',()=>lock());
  window.addEventListener('plasma:launch',(event)=>{if(applications.find((app)=>app.id===event.detail&&!app.hidden)){recent=[event.detail,...recent.filter((id)=>id!==event.detail)].slice(0,10);save(recentKey,recent);}$('#krunner').hidden=true;});
  window.addEventListener('plasma:pin',(event)=>{updateSettings({pinnedApps:settings.pinnedApps.includes(event.detail)?settings.pinnedApps.filter((id)=>id!==event.detail):[...settings.pinnedApps,event.detail]});});
  function showRunner(){if(locked)return;$('#launcher').hidden=true;closePopup();$('#krunner').hidden=false;$('#runner-search').value='';runnerResults();$('#runner-search').focus();}
  function runnerResults(){const query=$('#runner-search').value.trim();const apps=findApplications(query).slice(0,8);$('#runner-results').replaceChildren(...apps.map((app)=>appButton(app,true)));if(query.startsWith('/')||query.startsWith('~')){const button=document.createElement('button');button.className='runner-result';button.type='button';button.textContent=query;button.addEventListener('click',()=>{controls.system.openFile(query).catch(report);$('#krunner').hidden=true;});$('#runner-results').prepend(button);}}
  $('#runner-search').addEventListener('input',runnerResults);
  $('#runner-form').addEventListener('submit',(event)=>{event.preventDefault();$('#runner-results button')?.click();});
  $('#runner-search').addEventListener('keydown',(event)=>{if(event.key==='ArrowDown'){event.preventDefault();$('#runner-results button')?.focus();}});
  $('#runner-close').addEventListener('click',()=>$('#krunner').hidden=true);
  function keyboardList(event){if(!['ArrowDown','ArrowUp'].includes(event.key))return;const list=event.target.closest('#launcher-apps,#runner-results');if(!list)return;const buttons=$$('button',list);event.preventDefault();buttons[(buttons.indexOf(document.activeElement)+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();}
  document.addEventListener('keydown',keyboardList);
  let calendarMonth=new Date();
  function zonedDate(){const parts=new Intl.DateTimeFormat('en-CA',{timeZone:settings.timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());return new Date(Number(parts.find((p)=>p.type==='year').value),Number(parts.find((p)=>p.type==='month').value)-1,Number(parts.find((p)=>p.type==='day').value));}
  function closePopup(){popup='';$('#tray-popup').hidden=true;$$('.system-tray button').forEach((button)=>button.setAttribute('aria-expanded','false'));}
  function openPopup(kind,anchor){if(locked)return;if(popup===kind){closePopup();return;}popup=kind;$('#launcher').hidden=true;const box=$('#tray-popup');box.hidden=false;box.dataset.popup=kind;anchor?.setAttribute('aria-expanded','true');renderPopup();positionPopup(anchor);}
  function positionPopup(anchor){const box=$('#tray-popup'),rect=(anchor||$('#tray-clock')).getBoundingClientRect();const x=settings.panelPosition==='left'?rect.right+10:settings.panelPosition==='right'?rect.left-box.offsetWidth-10:Math.min(rect.right-box.offsetWidth,innerWidth-box.offsetWidth-8);const y=settings.panelPosition==='top'?rect.bottom+10:settings.panelPosition==='bottom'?rect.top-box.offsetHeight-10:Math.min(rect.top,innerHeight-box.offsetHeight-8);box.style.left=Math.max(8,x)+'px';box.style.top=Math.max(8,y)+'px';}
  function calendar(){const year=calendarMonth.getFullYear(),month=calendarMonth.getMonth(),today=zonedDate();const offset=(new Date(year,month,1).getDay()-settings.weekStart+7)%7;const days=new Date(year,month+1,0).getDate();const labels=['日','一','二','三','四','五','六'];return `<header><button id="calendar-prev" type="button" aria-label="上个月">‹</button><strong>${year} 年 ${month+1} 月</strong><button id="calendar-next" type="button" aria-label="下个月">›</button></header><div class="calendar-grid">${Array.from({length:7},(_,i)=>`<span class="calendar-weekday">${labels[(i+settings.weekStart)%7]}</span>`).join('')}${Array.from({length:offset},()=>'<span></span>').join('')}${Array.from({length:days},(_,i)=>`<button type="button" class="calendar-day${year===today.getFullYear()&&month===today.getMonth()&&i+1===today.getDate()?' today':''}" data-calendar-day="${i+1}">${i+1}</button>`).join('')}</div><footer><button id="calendar-today" type="button">今天</button><button id="calendar-settings" type="button">日期与时间…</button></footer>`;}
  function renderPopup(){
    const box=$('#tray-popup');
    if(popup==='calendar'){
      box.innerHTML=calendar();$('#calendar-prev').onclick=()=>{calendarMonth=new Date(calendarMonth.getFullYear(),calendarMonth.getMonth()-1,1);renderPopup();};$('#calendar-next').onclick=()=>{calendarMonth=new Date(calendarMonth.getFullYear(),calendarMonth.getMonth()+1,1);renderPopup();};$('#calendar-today').onclick=()=>{calendarMonth=zonedDate();renderPopup();};$('#calendar-settings').onclick=()=>{closePopup();settingsApp.open('region');};
      $$('[data-calendar-day]',box).forEach((button)=>button.onclick=()=>{$$('[data-calendar-day]',box).forEach((item)=>item.classList.toggle('selected',item===button));});
    }
    if(popup==='volume'){
      box.innerHTML=`<header><strong>音量</strong><button id="volume-settings" type="button" data-icon="systemsettings" aria-label="声音设置"></button></header><div class="volume-control"><button id="volume-mute" type="button" aria-pressed="${settings.muted}" data-icon="${settings.muted?'audio-volume-muted':'audio-volume-high'}" aria-label="静音"></button><input id="master-volume" type="range" min="0" max="100" value="${settings.volume}" aria-label="主音量"><output id="volume-value">${settings.volume}%</output></div><p class="tray-muted">${settings.muted?'已静音':'音频输出'}</p>`;
      $('#master-volume').oninput=(event)=>{$('#volume-value').textContent=event.target.value+'%';updateSettings({volume:Number(event.target.value),muted:false});};$('#volume-mute').onclick=()=>{updateSettings({muted:!settings.muted});renderPopup();};$('#volume-settings').onclick=()=>{closePopup();settingsApp.open('sound');};
    }
    if(popup==='notifications'){
      box.innerHTML=`<header><strong>通知</strong><button id="notifications-clear" type="button">清空</button></header><label class="tray-toggle"><input id="notifications-dnd" type="checkbox"${settings.doNotDisturb?' checked':''}>请勿打扰</label><div class="notification-list">${notifications.length?notifications.map((item)=>`<article><header><strong>${escape(item.title)}</strong><time>${new Date(item.time).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',timeZone:settings.timeZone})}</time></header><p>${escape(item.body)}</p></article>`).join(''):'<p class="empty-state">没有通知</p>'}</div>`;
      $('#notifications-clear').onclick=()=>{notifications=[];save(notificationKey,notifications);renderNotificationCount();renderPopup();};$('#notifications-dnd').onchange=(event)=>updateSettings({doNotDisturb:event.target.checked});
    }
    if(popup==='clipboard'){
      box.innerHTML=`<header><strong>剪贴板</strong><button id="clipboard-clear" type="button">清空</button></header><div class="clipboard-list">${clipboard.length?clipboard.map((text,index)=>`<button type="button" data-clipboard-index="${index}">${escape(text.slice(0,240))}</button>`).join(''):'<p class="empty-state">剪贴板为空</p>'}</div><form id="clipboard-form"><input id="clipboard-input" aria-label="剪贴板内容" placeholder="粘贴文本…" maxlength="8000"><button type="submit">添加</button></form>`;
      $('#clipboard-clear').onclick=()=>{clipboard=[];save(clipboardKey,clipboard);renderPopup();};$('#clipboard-form').onsubmit=(event)=>{event.preventDefault();addClipboard($('#clipboard-input').value);renderPopup();};$$('[data-clipboard-index]',box).forEach((button)=>button.onclick=()=>{navigator.clipboard.writeText(clipboard[Number(button.dataset.clipboardIndex)]).then(()=>controls.toast('已复制')).catch(report);});
    }
    if(popup==='network'){
      box.innerHTML=`<header><strong>网络</strong><span class="network-state">${navigator.onLine?'已连接':'离线'}</span></header><dl class="network-details"><dt>地址</dt><dd>${escape(location.host)}</dd><dt>连接</dt><dd>${location.protocol==='https:'?'TLS':'本地'}</dd><dt>会话</dt><dd id="network-check-result">—</dd></dl><button id="network-check" type="button">检查连接</button>`;
      $('#network-check').onclick=async()=>{const start=performance.now();try{const response=await fetch('/api/health',{cache:'no-store',signal:AbortSignal.timeout(5000)});if(!response.ok)throw new Error('连接失败');if(popup==='network')$('#network-check-result').textContent=Math.round(performance.now()-start)+' ms';}catch{if(popup==='network')$('#network-check-result').textContent='连接失败';}};
    }
    decorate(box);
  }
  for(const [id,kind]of [['tray-clock','calendar'],['tray-volume','volume'],['tray-notifications','notifications'],['tray-clipboard','clipboard'],['tray-network','network']])$('#'+id).addEventListener('click',(event)=>{if(kind==='calendar')calendarMonth=zonedDate();openPopup(kind,event.currentTarget);});
  function renderNotificationCount(){$('#notification-count').textContent=String(notifications.length);$('#notification-count').hidden=!notifications.length;}
  function notify(title,body){const entry={title:String(title).slice(0,100),body:String(body).slice(0,3000),time:Date.now()};notifications=[entry,...notifications].slice(0,40);save(notificationKey,notifications);renderNotificationCount();if(settings.notifications&&!settings.doNotDisturb&&!locked)controls.toast(entry.body);if(popup==='notifications')renderPopup();}
  function addClipboard(text){if(typeof text!=='string'||!text.trim()||text.length>8000)return;clipboard=[text,...clipboard.filter((item)=>item!==text)].slice(0,16);save(clipboardKey,clipboard);}
  document.addEventListener('copy',()=>{if(document.activeElement?.matches('input[type="password"]'))return;const selected=getSelection()?.toString();if(selected)addClipboard(selected);});
  window.addEventListener('plasma:clipboard',(event)=>addClipboard(event.detail));
  function updateAudio(){document.querySelectorAll('audio,video').forEach((media)=>{media.volume=settings.volume/100;media.muted=settings.muted;});}
  document.addEventListener('play',updateAudio,true);
  function renderPager(){const pager=$('#desktop-pager');pager.replaceChildren();for(let index=0;index<settings.desktopCount;index++){const button=document.createElement('button');button.type='button';button.title=settings.desktopNames[index]||'桌面 '+(index+1);button.setAttribute('aria-label',button.title);button.setAttribute('aria-pressed',String(windows.currentDesktop()===index));button.textContent=String(index+1);button.addEventListener('click',()=>windows.switchDesktop(index));pager.append(button);}}
  function overview(){if(locked)return;$('#launcher').hidden=true;closePopup();const overlay=$('#desktop-overview');overlay.hidden=false;const list=$('#overview-desktops');list.replaceChildren();for(let index=0;index<settings.desktopCount;index++){const desk=document.createElement('section');desk.className='overview-desktop'+(index===windows.currentDesktop()?' selected':'');const heading=document.createElement('button');heading.type='button';heading.textContent=settings.desktopNames[index]||'桌面 '+(index+1);heading.addEventListener('click',()=>{windows.switchDesktop(index);overlay.hidden=true;});desk.append(heading);const grid=document.createElement('div');grid.className='overview-windows';for(const item of windows.list().filter((item)=>item.opened&&item.desktop===index)){const button=document.createElement('button');button.type='button';button.className='overview-window';button.draggable=true;button.innerHTML='<span class="app-icon">'+icon(item.icon)+'</span><span>'+escape(item.title)+'</span>';const preview=document.createElement('div');preview.className='overview-window-preview';const clone=item.node.querySelector('.window-body').cloneNode(true);clone.querySelectorAll('[id]').forEach((node)=>node.removeAttribute('id'));clone.querySelectorAll('[data-launch]').forEach((node)=>node.removeAttribute('data-launch'));clone.inert=true;preview.append(clone);button.append(preview);button.addEventListener('click',()=>{overlay.hidden=true;windows.open(item.id);});button.addEventListener('dragstart',(event)=>event.dataTransfer.setData('text/x-arisaka-window',item.id));grid.append(button);}desk.append(grid);desk.addEventListener('dragover',(event)=>event.preventDefault());desk.addEventListener('drop',(event)=>{event.preventDefault();windows.moveTo(event.dataTransfer.getData('text/x-arisaka-window'),index);overview();});list.append(desk);}}
  $('#overview-close').onclick=()=>$('#desktop-overview').hidden=true;
  $('#desktop-pager').addEventListener('dblclick',overview);
  window.addEventListener('plasma:desktop',renderPager);
  let powerMode='lock';
  function renderLock(){
    const user=listProfiles().find((user)=>user.id===lockUser)||activeProfile();
    $('#lock-name').textContent=powerMode==='off'?'Arisaka':user.name;
    $('#lock-avatar').textContent=user.avatar||user.name.slice(0,1);$('#lock-avatar').style.backgroundColor=user.color||'#3daee9';
    $('#unlock-password').hidden=powerMode==='off'||!user.protected;$('#unlock-password').required=powerMode!=='off'&&user.protected;
    $('#unlock-password').value='';$('#unlock-message').textContent='';$('#unlock-button').textContent=powerMode==='off'?'启动':'解锁';
    $('#lock-users').replaceChildren();$('#lock-users').hidden=powerMode==='off';
    for(const entry of listProfiles()){const button=document.createElement('button');button.type='button';button.textContent=entry.name;button.classList.toggle('selected',entry.id===lockUser);button.addEventListener('click',()=>{lockUser=entry.id;renderLock();});$('#lock-users').append(button);}
    if(!$('#unlock-password').hidden)$('#unlock-password').focus();else $('#unlock-button').focus();
  }
  function lock(mode='lock'){
    locked=true;powerMode=mode;lockUser=profileKey();$('#desktop').inert=true;$('#desktop').setAttribute('aria-hidden','true');$('#screen-lock').hidden=false;
    $('#launcher').hidden=true;$('#krunner').hidden=true;$('#desktop-overview').hidden=true;closePopup();closeMenu();
    sessionStorage.removeItem('arisaka/unlocked/'+profileKey());sessionStorage.setItem('arisaka/locked/'+profileKey(),'1');renderLock();clock();
  }
  function unlock(){locked=false;$('#screen-lock').hidden=true;$('#desktop').inert=false;$('#desktop').removeAttribute('aria-hidden');sessionStorage.setItem('arisaka/unlocked/'+profileKey(),'1');sessionStorage.removeItem('arisaka/locked/'+profileKey());lastActivity=Date.now();}
  $('#unlock-form').addEventListener('submit',async(event)=>{
    event.preventDefault();if(powerMode==='off'){powerMode='lock';renderLock();return;}
    const button=$('#unlock-button');button.disabled=true;
    try{const password=$('#unlock-password').value;if(lockUser!==profileKey()){await activateProfile(lockUser,password);return;}if(!await authenticateProfile(lockUser,password))throw new Error('密码错误');unlock();}
    catch(error){$('#unlock-message').textContent=error.message;$('#unlock-password').value='';$('#unlock-password').focus();}
    finally{button.disabled=false;}
  });
  function powerMenu(anchor){menu([
    {label:'锁定',icon:'system-lock-screen',shortcut:'Meta+L',action:()=>lock()},
    {label:'切换用户',icon:'user-home',action:()=>lock()},
    {label:'注销',icon:'system-log-out',action:()=>{windows.list().forEach((item)=>windows.close(item.id));lock();}},null,
    {label:'重新启动桌面',icon:'view-refresh',action:()=>{windows.persist();location.reload();}},
    {label:'关机',icon:'system-shutdown',action:()=>{windows.persist();lock('off');}},
  ],anchor);}
  $('#launcher-power').addEventListener('click',(event)=>powerMenu(event.currentTarget));
  $('#lock-power').addEventListener('click',(event)=>powerMenu(event.currentTarget));
  function clock(){const now=new Date();const time=new Intl.DateTimeFormat('zh-CN',{timeZone:settings.timeZone,hour:'2-digit',minute:'2-digit',...(settings.showSeconds?{second:'2-digit'}:{}),hour12:!settings.hour24}).format(now);$('#clock-time').textContent=time;$('#clock-date').textContent=new Intl.DateTimeFormat('zh-CN',{timeZone:settings.timeZone,month:'2-digit',day:'2-digit'}).format(now);$('#tray-clock').title=new Intl.DateTimeFormat('zh-CN',{timeZone:settings.timeZone,dateStyle:'full',timeStyle:'long'}).format(now);$('#lock-time').textContent=time;$('#lock-date').textContent=new Intl.DateTimeFormat('zh-CN',{timeZone:settings.timeZone,dateStyle:'full'}).format(now);}
  let lastActivity=Date.now(),metaUsed=false;
  for(const type of ['pointerdown','keydown','pointermove'])document.addEventListener(type,()=>{lastActivity=Date.now();},{passive:true});
  document.addEventListener('keydown',(event)=>{
    if(event.key==='Meta')metaUsed=false;else if(event.metaKey)metaUsed=true;
    if(locked)return;
    if(event.key==='Escape'){closePopup();$('#launcher').hidden=true;$('#krunner').hidden=true;$('#desktop-overview').hidden=true;}
    if (event.key === 'Meta') return;
    for (const [id, action] of [
      ['runner', showRunner], ['launcher', toggleLauncher], ['lock', () => lock()], ['files', () => windows.open('files')],
      ['overview', overview], ['clipboard', () => openPopup('clipboard', $('#tray-clipboard'))],
      ['console', () => windows.open('console')], ['screenshot', () => windows.open('screenshot')],
    ]) if (matchesShortcut(event, settings, id)) { event.preventDefault(); action(); return; }
  });
  document.addEventListener('keyup',event=>{if(event.key==='Meta'&&!metaUsed&&!locked&&matchesShortcut(event,settings,'launcher'))toggleLauncher();});
  document.addEventListener('pointerdown',(event)=>{if(!event.target.closest('#launcher,#launcher-button'))$('#launcher').hidden=true;if(!event.target.closest('#tray-popup,.system-tray'))closePopup();if(!event.target.closest('#krunner'))$('#krunner').hidden=true;});
  $('#desktop').addEventListener('contextmenu',(event)=>{
    if(event.target.closest('.window,.plasma-panel,#launcher,#shell-overlays,.desktop-icons'))return;
    event.preventDefault();menu([
      {label:'配置桌面和壁纸…',icon:'preferences-desktop-wallpaper',action:()=>settingsApp.open('wallpaper')},
      {label:'桌面概览',icon:'view-grid',action:overview},
      {label:'运行命令…',icon:'konsole',shortcut:'Alt+Space',action:showRunner},null,
      {label:'打开终端',icon:'konsole',action:()=>windows.open('console')},
      {label:'系统设置',icon:'systemsettings',action:()=>settingsApp.open()},
      {label:document.fullscreenElement?'退出全屏':'全屏',action:()=>document.fullscreenElement?document.exitFullscreen():document.documentElement.requestFullscreen()},null,
      {label:'锁定',icon:'system-lock-screen',action:()=>lock()},
    ],undefined,{x:event.clientX,y:event.clientY});
  });
  $('.plasma-panel').addEventListener('contextmenu',(event)=>{if(event.target.closest('.task-button'))return;event.preventDefault();menu([{label:'配置面板…',icon:'systemsettings',action:()=>settingsApp.open('panel')},{label:'桌面概览',action:overview}],undefined,{x:event.clientX,y:event.clientY});});
  preferenceEvents.addEventListener('appearance',(event)=>{settings=event.detail;renderPager();renderLauncher();clock();updateAudio();$('#tray-volume').dataset.icon=settings.muted?'audio-volume-muted':'audio-volume-high';$('#tray-volume .action-icon').style.backgroundImage=`url("/icons/${settings.muted?'audio-volume-muted':'audio-volume-high'}.svg")`;});
  preferenceEvents.addEventListener('users',renderUser);
  window.addEventListener('resize',()=>{closePopup();});
  window.addEventListener('online',()=>{$('.connection').classList.remove('offline');$('#connection-label').textContent='';});
  window.addEventListener('offline',()=>{$('.connection').classList.add('offline');$('#connection-label').textContent='离线';notify('网络','连接已断开');});
  timer=setInterval(()=>{clock();if(!locked&&settings.lockMinutes>0&&Date.now()-lastActivity>settings.lockMinutes*60000)lock();},1000);
  window.addEventListener('pagehide',()=>clearInterval(timer));
  renderUser();renderLauncher();renderPager();renderNotificationCount();clock();updateAudio();
  return {lock,notify,addClipboard,overview,settings:settingsApp,showRunner,ready(){windows.restoreSession();if(sessionStorage.getItem('arisaka/locked/'+profileKey())==='1'||settings.lockOnStart&&!sessionStorage.getItem('arisaka/unlocked/'+profileKey()))lock();}};
}
