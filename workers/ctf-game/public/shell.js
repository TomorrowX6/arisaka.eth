import { $, $$, decorate, menu, closeMenu, report } from '/ui.js';
import { icon } from '/desktop.js';
import { applications, findApplications } from '/applications.js';
import { activeProfile, listProfiles, profileKey, getSettings, updateSettings, authenticateProfile, activateProfile, preferenceEvents } from '/preferences.js';
import { createSettings, prepareSettings } from '/settings.js';
import { HOME } from '/filesystem.js';
import { matchesShortcut } from '/desktop-config.js';
import { showSurface, hideSurface, isSurfaceOpen } from '/motion.js';
import { createWindowPreview } from '/previews.js';

const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
function readStore(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch { return fallback; } }

export function prepareShell() {
  $$('[data-place]').forEach((node) => { node.dataset.place = node.dataset.place.replace('/home/user', HOME); });
  $('#file-location').value = HOME;
  $('#files-home').textContent = activeProfile().username;
  prepareSettings();
  $('#launcher').setAttribute('role','dialog');
  $('#launcher').innerHTML = `<header class="launcher-header"><button id="launcher-user" type="button" title="用户设置"><span class="user-avatar" aria-hidden="true"></span><span class="profile-name"></span></button><div class="launcher-search"><span data-icon="edit-find"></span><input id="launcher-search" type="search" aria-label="搜索应用程序" aria-controls="launcher-apps" placeholder="搜索…" autocomplete="off" spellcheck="false"></div><span id="player-label" hidden></span></header><div class="launcher-content"><nav id="launcher-categories" role="tablist" aria-orientation="vertical" aria-label="应用分类"></nav><div class="launcher-view"><div id="launcher-section" class="launcher-section"></div><div id="launcher-apps" role="tabpanel" aria-label="应用程序"></div><span id="launcher-result-count" class="sr-only" aria-live="polite"></span></div></div><footer><button id="launcher-settings" type="button" data-launch="settings" data-icon="systemsettings">系统设置</button><span class="launcher-footer-spacer"></span><button id="launcher-lock" type="button" data-icon="system-lock-screen" title="锁定 (Meta+L)">锁定</button><button id="launcher-power" type="button" data-icon="system-shutdown" aria-label="电源与会话" aria-haspopup="menu" aria-expanded="false">电源与会话</button><button id="restart-button" type="button" hidden>新建存档…</button></footer>`;
  $('#launcher-button').setAttribute('aria-haspopup','dialog');
  $('#launcher-button').setAttribute('aria-controls','launcher');
  $('#launcher-button').setAttribute('aria-expanded','false');
  const pager = document.createElement('nav'); pager.id='desktop-pager';pager.setAttribute('aria-label','虚拟桌面');$('#tasks').before(pager);
  $('.system-tray').innerHTML = `<button id="tray-clipboard" type="button" class="tray-button" data-icon="edit-paste" aria-label="剪贴板" title="剪贴板"></button><button id="tray-volume" type="button" class="tray-button" data-icon="audio-volume-high" aria-label="音量" title="音量"></button><button id="tray-network" type="button" class="tray-button" data-icon="network-wired" aria-label="网络" title="网络"><span class="connection"><i></i><span id="connection-label"></span></span></button><button id="tray-notifications" type="button" class="tray-button" data-icon="notifications" aria-label="通知" title="通知"><span id="notification-count" hidden></span></button><button id="tray-clock" class="clock" type="button" aria-label="日期与时间"><time id="clock-time"></time><span id="clock-date"></span></button><button id="show-desktop" type="button" aria-label="显示桌面" title="显示桌面 (Meta+D)"></button>`;
  const shell=document.createElement('div');shell.id='shell-overlays';
  shell.innerHTML=`<section id="krunner" class="krunner" role="dialog" aria-label="KRunner" hidden><form id="runner-form"><span class="runner-mark" aria-hidden="true">${icon('launch')}</span><input id="runner-search" type="search" placeholder="搜索应用、打开文件…" aria-label="运行命令" aria-controls="runner-results" autocomplete="off" spellcheck="false"><button id="runner-close" type="button" data-icon="window-close" aria-label="关闭"></button></form><div id="runner-results"></div></section><section id="tray-popup" class="tray-popup" role="dialog" hidden></section><section id="task-preview" class="task-preview" role="dialog" aria-label="窗口预览" hidden><header><span class="app-icon" aria-hidden="true"></span><span id="task-preview-title"></span><button id="task-preview-close" type="button" data-preview-close data-icon="window-close" aria-label="关闭窗口"></button></header><button id="task-preview-activate" class="task-preview-image" type="button" data-preview-activate aria-label="激活窗口"></button><footer><span id="task-preview-desktop"></span><span id="task-preview-state"></span></footer></section><section id="desktop-overview" role="dialog" aria-label="桌面概览" hidden><header><h1>桌面概览</h1><button id="overview-close" type="button" data-icon="window-close" aria-label="关闭概览"></button></header><div id="overview-desktops"></div></section>`;
  $('#desktop').append(shell);
  const lock=document.createElement('section');lock.id='screen-lock';lock.hidden=true;lock.setAttribute('role','dialog');lock.setAttribute('aria-modal','true');lock.setAttribute('aria-label','屏幕锁定');
  lock.innerHTML=`<div class="lock-wallpaper" aria-hidden="true"></div><div class="lock-clock"><time id="lock-time"></time><span id="lock-date"></span></div><form id="unlock-form"><span id="lock-avatar" class="profile-avatar" aria-hidden="true"></span><h1 id="lock-name"></h1><label id="unlock-password-label" class="sr-only" for="unlock-password">密码</label><div class="unlock-controls"><input id="unlock-password" type="password" autocomplete="current-password" placeholder="密码" aria-label="密码"><button id="unlock-button" type="submit" class="button primary">解锁</button></div><p id="unlock-message" role="status"></p></form><nav id="lock-users" aria-label="切换用户"></nav><button id="lock-power" type="button" data-icon="system-shutdown" aria-haspopup="menu" aria-expanded="false">电源与会话</button>`;
  $('.lock-wallpaper',lock).innerHTML=$('.wallpaper')?.innerHTML||'';$('.lock-wallpaper',lock).classList.add('wallpaper');
  document.body.append(lock);decorate();
  const desktopSettings=document.createElement('button');desktopSettings.type='button';desktopSettings.dataset.launch='settings';desktopSettings.innerHTML='<span class="app-icon"></span><span>系统设置</span>';$('.desktop-icons').append(desktopSettings);
}

export function createShell(controls) {
  const { windows } = controls;
  let settings=getSettings(), launcherCategory='收藏', popup='', popupAnchor=null, lockUser=profileKey(), locked=false, timer;
  let previewId='', hoveredTaskId='', previewOpenTimer, previewCloseTimer, windowRefresh, panelRefresh;
  let overviewFocus=null, runnerFocus=null, lockFocus=null, suppressPreviewFocus=false;
  const recentKey='arisaka/recent-apps/'+profileKey(), notificationKey='arisaka/notifications/'+profileKey(), clipboardKey='arisaka/clipboard/'+profileKey();
  let recent=readStore(recentKey,[]), notifications=readStore(notificationKey,[]), clipboard=readStore(clipboardKey,[]);
  const settingsApp=createSettings({...controls,apps:applications,lock:()=>lock(),notify});
  function save(key,value){try{localStorage.setItem(key,JSON.stringify(value));}catch{}}
  function renderUser(){const user=activeProfile();$('.user-avatar').textContent=user.avatar||user.name.slice(0,1);$('.user-avatar').style.backgroundColor=user.color||'#3daee9';$('.profile-name').textContent=user.name;$('#launcher-user').setAttribute('aria-label',user.name+' — 用户设置');}
  function appButton(app,compact=false){const button=document.createElement('button');button.type='button';button.dataset.launch=app.id;button.className=compact?'runner-result':'launcher-app';button.title=app.name+(app.description?' — '+app.description:'');button.innerHTML='<span class="app-icon" aria-hidden="true">'+icon(app.id)+'</span><span class="launcher-app-label"><strong>'+escape(app.name)+'</strong><small>'+escape(app.description||'')+'</small></span>';return button;}
  function surfaceOptions(){return {origin:settings.panelPosition};}
  function syncPanel(){
    $('.plasma-panel').classList.toggle('has-popup',Boolean(popup)||isSurfaceOpen($('#launcher'))||isSurfaceOpen($('#task-preview')));
  }
  function closeLauncher(restoreFocus=false){
    const wasOpen=isSurfaceOpen($('#launcher'));
    hideSurface($('#launcher'),surfaceOptions());
    $('#launcher-button').setAttribute('aria-expanded','false');
    if(restoreFocus&&wasOpen)$('#launcher-button').focus({preventScroll:true});
    syncPanel();
  }
  function closeRunner(restoreFocus=false){
    const wasOpen=isSurfaceOpen($('#krunner'));
    hideSurface($('#krunner'),{origin:'top'});
    if(restoreFocus&&wasOpen){
      const target=runnerFocus?.isConnected&&!runnerFocus.closest('[hidden],[inert]')&&!runnerFocus.disabled?runnerFocus:$('#launcher-button');
      target.focus({preventScroll:true});
    }
  }
  // Measure while hidden so a surface is positioned before its entrance begins.
  function positionSurface(box,anchor,alignment='end'){
    const rect=anchor.getBoundingClientRect(),edge=settings.panelPosition,gap=8;
    const vertical=edge==='left'||edge==='right';
    box.style.maxWidth=Math.max(0,vertical?(edge==='left'?innerWidth-rect.right:rect.left)-gap*2:innerWidth-gap*2)+'px';
    box.style.maxHeight=Math.max(0,vertical?innerHeight-gap*2:(edge==='top'?innerHeight-rect.bottom:rect.top)-gap*2)+'px';
    box.dataset.measuring='true';
    const width=box.offsetWidth,height=box.offsetHeight;
    delete box.dataset.measuring;
    let x,y;
    if(vertical){x=edge==='left'?rect.right+gap:rect.left-width-gap;y=alignment==='start'?rect.top:alignment==='center'?rect.top+(rect.height-height)/2:rect.bottom-height;}
    else{x=alignment==='start'?rect.left:alignment==='center'?rect.left+(rect.width-width)/2:rect.right-width;y=edge==='top'?rect.bottom+gap:rect.top-height-gap;}
    Object.assign(box.style,{left:Math.max(gap,Math.min(x,innerWidth-width-gap))+'px',top:Math.max(gap,Math.min(y,innerHeight-height-gap))+'px',right:'auto',bottom:'auto'});
  }
  function renderLauncher(){
    const query=$('#launcher-search').value.trim(),list=$('#launcher-apps');
    const focusedApp=list.contains(document.activeElement)?document.activeElement.dataset.launch:null;
    let apps=findApplications(query);
    if(!query){if(launcherCategory==='收藏')apps=settings.pinnedApps.map((id)=>apps.find((app)=>app.id===id)).filter(Boolean);else if(launcherCategory==='最近使用')apps=recent.map((id)=>apps.find((app)=>app.id===id)).filter(Boolean);else{if(launcherCategory!=='所有应用')apps=apps.filter((app)=>app.category===launcherCategory);apps.sort((a,b)=>a.name.localeCompare(b.name,'zh-CN'));}}
    list.dataset.view=!query&&launcherCategory==='收藏'?'grid':'list';
    list.replaceChildren(...apps.map((app)=>appButton(app)));
    list.scrollTop=0;
    $('#launcher-section').textContent=query?'搜索结果':launcherCategory;
    $('#launcher-section').hidden=list.dataset.view==='grid';
    $('#launcher-result-count').textContent=apps.length+' 个应用程序';
    if(!apps.length){const empty=document.createElement('p');empty.className='empty-state';empty.textContent=query?'没有匹配的应用程序':launcherCategory==='最近使用'?'尚无最近使用的应用程序':launcherCategory==='收藏'?'尚无收藏的应用程序':'没有应用程序';list.append(empty);}
    $$('[data-launcher-category]').forEach((button)=>{const selected=!query&&button.dataset.launcherCategory===launcherCategory;button.classList.toggle('selected',selected);button.setAttribute('aria-selected',String(selected));button.tabIndex=button.dataset.launcherCategory===launcherCategory?0:-1;if(selected)list.setAttribute('aria-labelledby',button.id);});
    if(query){list.removeAttribute('aria-labelledby');list.setAttribute('aria-label','搜索结果');}
    if(focusedApp)(list.querySelector('[data-launch="'+focusedApp+'"]')||list.querySelector('button')||$('#launcher-search')).focus({preventScroll:true});
  }
  const categories=[['收藏','view-grid'],['所有应用','view-list-icons'],['最近使用','clock'],['系统','preferences-system'],['开发','binary'],['办公','folder-documents'],['多媒体','audio'],['图形','image'],['工具','systemsettings']];
  for(const [index,[category,categoryIcon]]of categories.entries()){
    const button=document.createElement('button');button.type='button';button.id='launcher-category-'+index;button.dataset.launcherCategory=category;button.dataset.icon=categoryIcon;button.setAttribute('role','tab');button.setAttribute('aria-controls','launcher-apps');
    button.innerHTML='<span>'+escape(category)+'</span>';
    button.addEventListener('click',()=>{launcherCategory=category;$('#launcher-search').value='';renderLauncher();});$('#launcher-categories').append(button);
  }
  decorate($('#launcher-categories'));
  function toggleLauncher(){
    if(locked)return;
    if(isSurfaceOpen($('#launcher'))){closeLauncher(true);return;}
    closePopup();closeRunner();closeTaskPreview();closeOverview();closeMenu();
    $('#launcher-search').value='';renderLauncher();
    $('.plasma-panel').classList.add('has-popup');positionSurface($('#launcher'),$('#launcher-button'),'start');
    showSurface($('#launcher'),surfaceOptions());$('#launcher-button').setAttribute('aria-expanded','true');syncPanel();$('#launcher-search').focus({preventScroll:true});
  }
  $('#launcher-button').addEventListener('click',toggleLauncher);
  $('#launcher-search').addEventListener('input',renderLauncher);
  $('#launcher-search').addEventListener('keydown',(event)=>{if(event.key==='Enter'){event.preventDefault();$('#launcher-apps [data-launch]')?.click();}if(event.key==='ArrowDown'){event.preventDefault();$('#launcher-apps button')?.focus();}if(event.key==='Escape'&&event.currentTarget.value){event.preventDefault();event.stopPropagation();event.currentTarget.value='';renderLauncher();}});
  $('#launcher-categories').addEventListener('keydown',(event)=>{
    const buttons=$$('button',$('#launcher-categories')),index=buttons.indexOf(event.target);
    if(index<0)return;
    if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length;buttons[next].click();buttons[next].focus();}
    if(event.key==='ArrowRight'){event.preventDefault();$('#launcher-apps button')?.focus();}
  });
  $('#launcher-apps').addEventListener('contextmenu',(event)=>{const button=event.target.closest('[data-launch]');if(!button)return;event.preventDefault();const id=button.dataset.launch;menu([{label:'打开',action:()=>windows.open(id)},{label:settings.pinnedApps.includes(id)?'从收藏中移除':'添加到收藏',icon:'view-grid',action:()=>window.dispatchEvent(new CustomEvent('plasma:pin',{detail:id}))}],button,{x:event.clientX,y:event.clientY});});
  $('#launcher-user').addEventListener('click',()=>{closeLauncher();settingsApp.open('users');});
  $('#launcher-lock').addEventListener('click',()=>lock());
  window.addEventListener('plasma:launch',(event)=>{if(applications.find((app)=>app.id===event.detail&&!app.hidden)){recent=[event.detail,...recent.filter((id)=>id!==event.detail)].slice(0,10);save(recentKey,recent);}closeLauncher();closeRunner();closeTaskPreview();});
  window.addEventListener('plasma:pin',(event)=>{updateSettings({pinnedApps:settings.pinnedApps.includes(event.detail)?settings.pinnedApps.filter((id)=>id!==event.detail):[...settings.pinnedApps,event.detail]});});
  function showRunner(){
    if(locked)return;
    const runner=$('#krunner');
    if(!isSurfaceOpen(runner)&&!runner.contains(document.activeElement))runnerFocus=document.activeElement;
    closeLauncher();closePopup();closeTaskPreview();closeOverview();$('#runner-search').value='';runnerResults();showSurface(runner,{origin:'top'});$('#runner-search').focus({preventScroll:true});
  }
  function runnerResults(){const query=$('#runner-search').value.trim();const apps=findApplications(query).slice(0,8);$('#runner-results').replaceChildren(...apps.map((app)=>appButton(app,true)));if(query.startsWith('/')||query.startsWith('~')){const button=document.createElement('button');button.className='runner-result';button.type='button';button.textContent=query;button.addEventListener('click',()=>{controls.system.openFile(query).catch(report);closeRunner();});$('#runner-results').prepend(button);}else if(query&&!apps.length){const empty=document.createElement('p');empty.className='empty-state';empty.textContent='没有匹配的结果';$('#runner-results').append(empty);}}
  $('#runner-search').addEventListener('input',runnerResults);
  $('#runner-form').addEventListener('submit',(event)=>{event.preventDefault();$('#runner-results button')?.click();});
  $('#runner-search').addEventListener('keydown',(event)=>{if(event.key==='ArrowDown'){event.preventDefault();$('#runner-results button')?.focus();}});
  $('#runner-close').addEventListener('click',()=>closeRunner(true));
  function keyboardList(event){
    if(event.altKey||event.ctrlKey||event.metaKey||!['ArrowDown','ArrowUp','ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    const list=event.target.closest('#launcher-apps,#runner-results');if(!list)return;
    const buttons=$$('button',list),index=buttons.indexOf(document.activeElement);if(index<0)return;
    const grid=list.dataset.view==='grid',columns=grid?Math.max(1,buttons.filter((button)=>button.offsetTop===buttons[0].offsetTop).length):1;
    if(event.key==='ArrowLeft'&&(!grid||index%columns===0)&&list.id==='launcher-apps'){event.preventDefault();$('#launcher-categories button[tabindex="0"]')?.focus();return;}
    if(event.key==='ArrowUp'&&index<columns){event.preventDefault();$(list.id==='launcher-apps'?'#launcher-search':'#runner-search').focus();return;}
    if(!grid&&['ArrowLeft','ArrowRight'].includes(event.key))return;
    event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:index+({ArrowDown:columns,ArrowUp:-columns,ArrowLeft:-1,ArrowRight:1}[event.key]);buttons[Math.max(0,Math.min(next,buttons.length-1))]?.focus();
  }
  document.addEventListener('keydown',keyboardList);
  const taskList=$('#tasks'),taskPreview=$('#task-preview');
  const taskButton=(id)=>$$('[data-task]',taskList).find((button)=>button.dataset.task===id);
  function updateTaskButtons(){
    $$('[data-task]',taskList).forEach((button)=>{
      if(button.classList.contains('running')){button.removeAttribute('title');button.setAttribute('aria-haspopup','dialog');button.setAttribute('aria-controls','task-preview');button.setAttribute('aria-expanded',String(button.dataset.task===previewId&&isSurfaceOpen(taskPreview)));}
      else{button.removeAttribute('aria-haspopup');button.removeAttribute('aria-controls');button.removeAttribute('aria-expanded');}
    });
  }
  function closeTaskPreview(restoreFocus=false){
    clearTimeout(previewOpenTimer);clearTimeout(previewCloseTimer);
    const previous=previewId;previewId='';
    hideSurface(taskPreview,surfaceOptions());updateTaskButtons();syncPanel();
    if(restoreFocus&&previous){suppressPreviewFocus=true;taskButton(previous)?.focus({preventScroll:true});queueMicrotask(()=>{suppressPreviewFocus=false;});}
  }
  function renderTaskPreview(item){
    taskPreview.dataset.task=item.id;
    $('#task-preview-title').textContent=item.title;
    $('#task-preview-title').title=item.title;
    $('#task-preview header .app-icon').innerHTML=icon(item.icon);
    $('#task-preview-close').setAttribute('aria-label','关闭 '+item.title);
    $('#task-preview-activate').setAttribute('aria-label','激活 '+item.title);
    $('#task-preview-desktop').textContent=settings.desktopNames[item.desktop]||'桌面 '+(item.desktop+1);
    $('#task-preview-state').textContent=item.minimized?'已最小化':'';
    const vertical=['left','right'].includes(settings.panelPosition),panel=$('.plasma-panel').getBoundingClientRect();
    const width=Math.max(80,Math.min(264,innerWidth-42-(vertical?panel.width+16:0)));
    $('#task-preview-activate').replaceChildren(createWindowPreview(item.node,{width,height:Math.round(width*9/16)}));
  }
  function showTaskPreview(id,enter=false){
    clearTimeout(previewOpenTimer);clearTimeout(previewCloseTimer);
    if(locked||popup||isSurfaceOpen($('#launcher'))||isSurfaceOpen($('#desktop-overview')))return;
    const item=windows.list().find((entry)=>entry.id===id&&entry.opened),anchor=taskButton(id);
    if(!item||!anchor){closeTaskPreview();return;}
    previewId=id;renderTaskPreview(item);$('.plasma-panel').classList.add('has-popup');positionSurface(taskPreview,anchor,'center');
    showSurface(taskPreview,surfaceOptions());updateTaskButtons();syncPanel();
    if(enter)$('#task-preview-activate').focus({preventScroll:true});
  }
  function queueTaskPreview(id){
    clearTimeout(previewOpenTimer);clearTimeout(previewCloseTimer);
    if(previewId===id&&isSurfaceOpen(taskPreview))return;
    // PlasmaCore.ToolTipArea uses a 700 ms initial hover delay.
    previewOpenTimer=setTimeout(()=>{if(hoveredTaskId===id)showTaskPreview(id);},isSurfaceOpen(taskPreview)?120:700);
  }
  function leaveTaskPreview(){
    clearTimeout(previewOpenTimer);clearTimeout(previewCloseTimer);
    previewCloseTimer=setTimeout(()=>{
      if(taskPreview.matches(':hover')||taskPreview.contains(document.activeElement)||hoveredTaskId===previewId&&previewId)return;
      const anchor=taskButton(previewId);if(anchor===document.activeElement&&anchor.matches(':focus-visible'))return;
      closeTaskPreview();
    },220);
  }
  taskList.addEventListener('pointerover',(event)=>{
    if(event.pointerType==='touch')return;
    const button=event.target.closest('[data-task]');if(!button||button.contains(event.relatedTarget))return;
    hoveredTaskId=button.dataset.task;
    if(button.classList.contains('running'))queueTaskPreview(hoveredTaskId);else closeTaskPreview();
  });
  taskList.addEventListener('pointerout',(event)=>{
    const button=event.target.closest('[data-task]');if(!button||button.contains(event.relatedTarget))return;
    hoveredTaskId='';if(taskPreview.contains(event.relatedTarget)){clearTimeout(previewCloseTimer);return;}leaveTaskPreview();
  });
  taskList.addEventListener('focusin',(event)=>{const button=event.target.closest('[data-task]');if(button?.classList.contains('running')&&!suppressPreviewFocus)showTaskPreview(button.dataset.task);});
  taskList.addEventListener('focusout',leaveTaskPreview);
  taskList.addEventListener('click',()=>closeTaskPreview());
  taskList.addEventListener('contextmenu',()=>closeTaskPreview());
  taskList.addEventListener('scroll',()=>{
    const focused=taskList.contains(document.activeElement)?document.activeElement.closest('[data-task]'):null;
    const focusedPreview=focused?.dataset.task===previewId&&isSurfaceOpen(taskPreview);
    closeTaskPreview();
    if(focusedPreview){showTaskPreview(focused.dataset.task);return;}
    const hovered=$('[data-task]:hover',taskList);hoveredTaskId=hovered?.dataset.task||'';
    if(hovered?.classList.contains('running'))queueTaskPreview(hoveredTaskId);
  },{passive:true});
  taskList.addEventListener('keydown',(event)=>{
    const button=event.target.closest('[data-task]');if(!button)return;
    const towardsDesktop={bottom:'ArrowUp',top:'ArrowDown',left:'ArrowRight',right:'ArrowLeft'}[settings.panelPosition];
    if(event.key===towardsDesktop&&button.classList.contains('running')){event.preventDefault();showTaskPreview(button.dataset.task,true);}
  });
  taskPreview.addEventListener('pointerenter',()=>{clearTimeout(previewOpenTimer);clearTimeout(previewCloseTimer);});
  taskPreview.addEventListener('pointerleave',(event)=>{if(event.relatedTarget?.closest?.('[data-task]')?.dataset.task!==previewId)leaveTaskPreview();});
  taskPreview.addEventListener('focusin',()=>clearTimeout(previewCloseTimer));
  taskPreview.addEventListener('focusout',leaveTaskPreview);
  taskPreview.addEventListener('click',(event)=>{
    const id=previewId;if(!id)return;
    if(event.target.closest('[data-preview-close]')){closeTaskPreview();windows.close(id);}
    else if(event.target.closest('[data-preview-activate]')){closeTaskPreview();windows.open(id);}
  });
  function updatePanelState(){
    const panel=$('.plasma-panel'),edge=settings.panelPosition;
    // Window scale/translate effects still paint the old geometry at the start
    // of a restore. Offsets describe the target layout in the desktop viewport.
    const rect={top:panel.offsetTop,bottom:panel.offsetTop+panel.offsetHeight,left:panel.offsetLeft,right:panel.offsetLeft+panel.offsetWidth};
    panel.classList.toggle('touching-window',windows.list().some((item)=>{
      if(!item.opened||item.minimized||item.desktop!==windows.currentDesktop())return false;
      if(item.node.classList.contains('maximized'))return true;
      const top=item.node.offsetTop,left=item.node.offsetLeft;
      return edge==='bottom'?top+item.node.offsetHeight>=rect.top-17:edge==='top'?top<=rect.bottom+17:edge==='left'?left<=rect.right+17:left+item.node.offsetWidth>=rect.left-17;
    }));
  }
  document.addEventListener('pointermove',()=>{
    if(!panelRefresh&&$('.window.dragging,.window.resizing'))panelRefresh=requestAnimationFrame(()=>{panelRefresh=0;updatePanelState();});
  },{passive:true});
  document.addEventListener('pointerup',updatePanelState,{passive:true});
  document.addEventListener('pointercancel',updatePanelState,{passive:true});
  window.addEventListener('plasma:windows',()=>{
    cancelAnimationFrame(windowRefresh);
    windowRefresh=requestAnimationFrame(()=>{
      renderPager();updatePanelState();updateTaskButtons();
      if(previewId&&isSurfaceOpen(taskPreview)){
        const item=windows.list().find((entry)=>entry.id===previewId&&entry.opened),anchor=taskButton(previewId);
        if(!item||!anchor)closeTaskPreview();else{renderTaskPreview(item);positionSurface(taskPreview,anchor,'center');}
      }
      if(isSurfaceOpen($('#desktop-overview')))renderOverview();
    });
  });
  let calendarMonth=new Date(),calendarSelected=new Date();
  function zonedDate(){const parts=new Intl.DateTimeFormat('en-CA',{timeZone:settings.timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());return new Date(Number(parts.find((p)=>p.type==='year').value),Number(parts.find((p)=>p.type==='month').value)-1,Number(parts.find((p)=>p.type==='day').value));}
  function closePopup(restoreFocus=false){const anchor=popupAnchor,wasOpen=Boolean(popup);popup='';popupAnchor=null;hideSurface($('#tray-popup'),surfaceOptions());$$('.system-tray button[aria-expanded]').forEach((button)=>button.setAttribute('aria-expanded','false'));if(restoreFocus&&wasOpen)anchor?.focus({preventScroll:true});syncPanel();}
  function openPopup(kind,anchor){
    if(locked)return;if(popup===kind&&isSurfaceOpen($('#tray-popup'))){closePopup(true);return;}
    closePopup();closeLauncher();closeRunner();closeTaskPreview();closeOverview();closeMenu();
    popup=kind;popupAnchor=anchor;const box=$('#tray-popup');box.dataset.popup=kind;
    box.setAttribute('aria-label',({calendar:'日期与时间',volume:'音量',notifications:'通知',clipboard:'剪贴板',network:'网络'})[kind]);
    anchor?.setAttribute('aria-expanded','true');$('.plasma-panel').classList.add('has-popup');renderPopup();positionPopup();showSurface(box,surfaceOptions());syncPanel();
    box.querySelector(kind==='calendar'?'.calendar-day[aria-pressed="true"]':'input:not([type="checkbox"]),button')?.focus({preventScroll:true});
  }
  function positionPopup(){positionSurface($('#tray-popup'),popupAnchor||$('#tray-clock'));}
  function dateKey(date){return [date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('-');}
  function calendar(){
    const year=calendarMonth.getFullYear(),month=calendarMonth.getMonth(),today=dateKey(zonedDate()),selected=dateKey(calendarSelected);
    const offset=(new Date(year,month,1).getDay()-settings.weekStart+7)%7,labels=['日','一','二','三','四','五','六'];
    const days=Array.from({length:42},(_,index)=>{const date=new Date(year,month,1-offset+index),key=dateKey(date);return `<button type="button" class="calendar-day${key===today?' today':''}${key===selected?' selected':''}${date.getMonth()!==month?' outside-month':''}" data-calendar-day="${date.getDate()}" data-calendar-date="${key}" aria-label="${date.toLocaleDateString('zh-CN',{dateStyle:'full'})}" aria-pressed="${key===selected}"${key===today?' aria-current="date"':''} tabindex="${key===selected?0:-1}">${date.getDate()}</button>`;}).join('');
    return `<header class="calendar-header"><button id="calendar-prev" type="button" data-icon="go-previous" aria-label="上个月"></button><strong>${year} 年 ${month+1} 月</strong><button id="calendar-next" type="button" data-icon="go-next" aria-label="下个月"></button></header><div class="calendar-grid" aria-label="${year} 年 ${month+1} 月">${Array.from({length:7},(_,index)=>`<span class="calendar-weekday">${labels[(index+settings.weekStart)%7]}</span>`).join('')}${days}</div><p class="calendar-selection" aria-live="polite">${calendarSelected.toLocaleDateString('zh-CN',{dateStyle:'full'})}</p><footer><button id="calendar-today" type="button">今天</button><button id="calendar-settings" type="button" data-icon="systemsettings">日期与时间…</button></footer>`;
  }
  function renderPopup(){
    const box=$('#tray-popup');
    if(popup==='calendar'){
      box.innerHTML=calendar();
      function selectDate(date,focus=true){calendarSelected=date;calendarMonth=new Date(date.getFullYear(),date.getMonth(),1);renderPopup();if(focus)$('[data-calendar-date="'+dateKey(date)+'"]',box)?.focus({preventScroll:true});}
      function changeMonth(offset){const month=new Date(calendarMonth.getFullYear(),calendarMonth.getMonth()+offset,1);selectDate(new Date(month.getFullYear(),month.getMonth(),Math.min(calendarSelected.getDate(),new Date(month.getFullYear(),month.getMonth()+1,0).getDate())));}
      $('#calendar-prev').onclick=()=>changeMonth(-1);$('#calendar-next').onclick=()=>changeMonth(1);$('#calendar-today').onclick=()=>selectDate(zonedDate());$('#calendar-settings').onclick=()=>{closePopup();settingsApp.open('region');};
      $$('[data-calendar-date]',box).forEach((button)=>{button.onclick=()=>selectDate(new Date(...button.dataset.calendarDate.split('-').map((value,index)=>Number(value)-(index===1?1:0))));button.onkeydown=(event)=>{const offset={ArrowLeft:-1,ArrowRight:1,ArrowUp:-7,ArrowDown:7}[event.key];if(offset!==undefined){event.preventDefault();selectDate(new Date(calendarSelected.getFullYear(),calendarSelected.getMonth(),calendarSelected.getDate()+offset));}else if(event.key==='PageUp'||event.key==='PageDown'){event.preventDefault();changeMonth(event.key==='PageUp'?-1:1);}else if(event.key==='Home'||event.key==='End'){event.preventDefault();const start=(calendarSelected.getDay()-settings.weekStart+7)%7;selectDate(new Date(calendarSelected.getFullYear(),calendarSelected.getMonth(),calendarSelected.getDate()-start+(event.key==='End'?6:0)));}};});
    }
    if(popup==='volume'){
      box.innerHTML=`<header><strong>音量</strong><button id="volume-settings" type="button" data-icon="systemsettings" aria-label="声音设置" title="声音设置"></button></header><div class="tray-section-label">音频输出</div><div class="volume-control"><button id="volume-mute" type="button" aria-pressed="${settings.muted}" data-icon="${settings.muted?'audio-volume-muted':'audio-volume-high'}" aria-label="${settings.muted?'取消静音':'静音'}"></button><input id="master-volume" type="range" min="0" max="100" value="${settings.volume}" aria-label="主音量"><output id="volume-value">${settings.volume}%</output></div><p class="tray-muted volume-status">${settings.muted?'已静音':'系统音量'}</p>`;
      $('#master-volume').oninput=(event)=>{$('#volume-value').textContent=event.target.value+'%';updateSettings({volume:Number(event.target.value),muted:false});};$('#volume-mute').onclick=()=>{updateSettings({muted:!settings.muted});renderPopup();};$('#volume-settings').onclick=()=>{closePopup();settingsApp.open('sound');};
    }
    if(popup==='notifications'){
      box.innerHTML=`<header><strong>通知</strong><button id="notifications-clear" type="button" data-icon="edit-clear"${notifications.length?'':' disabled'}>清空</button></header><label class="tray-toggle"><input id="notifications-dnd" type="checkbox"${settings.doNotDisturb?' checked':''}>请勿打扰</label><div class="notification-list">${notifications.length?notifications.map((item)=>`<article><header><strong>${escape(item.title)}</strong><time>${new Date(item.time).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',timeZone:settings.timeZone})}</time></header><p>${escape(item.body)}</p></article>`).join(''):'<div class="tray-empty"><span data-icon="notifications" aria-hidden="true"></span><p>没有通知</p></div>'}</div>`;
      $('#notifications-clear').onclick=()=>{notifications=[];save(notificationKey,notifications);renderNotificationCount();renderPopup();};$('#notifications-dnd').onchange=(event)=>updateSettings({doNotDisturb:event.target.checked});
    }
    if(popup==='clipboard'){
      box.innerHTML=`<header><strong>剪贴板</strong><button id="clipboard-clear" type="button" data-icon="edit-clear"${clipboard.length?'':' disabled'}>清空</button></header><div class="clipboard-list">${clipboard.length?clipboard.map((text,index)=>`<button type="button" data-clipboard-index="${index}">${escape(text.slice(0,240))}</button>`).join(''):'<div class="tray-empty"><span data-icon="edit-paste" aria-hidden="true"></span><p>剪贴板为空</p></div>'}</div><form id="clipboard-form"><input id="clipboard-input" aria-label="剪贴板内容" placeholder="粘贴文本…" maxlength="8000"><button type="submit">添加</button></form>`;
      $('#clipboard-clear').onclick=()=>{clipboard=[];save(clipboardKey,clipboard);renderPopup();};$('#clipboard-form').onsubmit=(event)=>{event.preventDefault();addClipboard($('#clipboard-input').value);renderPopup();};$$('[data-clipboard-index]',box).forEach((button)=>button.onclick=()=>{navigator.clipboard.writeText(clipboard[Number(button.dataset.clipboardIndex)]).then(()=>controls.toast('已复制')).catch(report);});
    }
    if(popup==='network'){
      box.innerHTML=`<header><strong>网络</strong><span class="network-state">${navigator.onLine?'已连接':'离线'}</span></header><dl class="network-details"><dt>地址</dt><dd>${escape(location.host)}</dd><dt>连接</dt><dd>${location.protocol==='https:'?'TLS':'本地'}</dd><dt>会话</dt><dd id="network-check-result">—</dd></dl><button id="network-check" type="button">检查连接</button>`;
      $('#network-check').onclick=async()=>{const start=performance.now();try{const response=await fetch('/api/health',{cache:'no-store',signal:AbortSignal.timeout(5000)});if(!response.ok)throw new Error('连接失败');if(popup==='network')$('#network-check-result').textContent=Math.round(performance.now()-start)+' ms';}catch{if(popup==='network')$('#network-check-result').textContent='连接失败';}};
    }
    decorate(box);
    if(popupAnchor)positionPopup();
  }
  for(const [id,kind]of [['tray-clock','calendar'],['tray-volume','volume'],['tray-notifications','notifications'],['tray-clipboard','clipboard'],['tray-network','network']]){const button=$('#'+id);button.setAttribute('aria-haspopup','dialog');button.setAttribute('aria-expanded','false');button.setAttribute('aria-controls','tray-popup');button.addEventListener('click',(event)=>{if(kind==='calendar'){calendarMonth=zonedDate();calendarSelected=zonedDate();}openPopup(kind,event.currentTarget);});}
  function renderNotificationCount(){$('#notification-count').textContent=String(notifications.length);$('#notification-count').hidden=!notifications.length;}
  function notify(title,body){const entry={title:String(title).slice(0,100),body:String(body).slice(0,3000),time:Date.now()};notifications=[entry,...notifications].slice(0,40);save(notificationKey,notifications);renderNotificationCount();if(settings.notifications&&!settings.doNotDisturb&&!locked)controls.toast(entry.body);if(popup==='notifications')renderPopup();}
  function addClipboard(text){if(typeof text!=='string'||!text.trim()||text.length>8000)return;clipboard=[text,...clipboard.filter((item)=>item!==text)].slice(0,16);save(clipboardKey,clipboard);}
  document.addEventListener('copy',()=>{if(document.activeElement?.matches('input[type="password"]'))return;const selected=getSelection()?.toString();if(selected)addClipboard(selected);});
  window.addEventListener('plasma:clipboard',(event)=>addClipboard(event.detail));
  function updateAudio(){document.querySelectorAll('audio,video').forEach((media)=>{media.volume=settings.volume/100;media.muted=settings.muted;});}
  document.addEventListener('play',updateAudio,true);
  function renderPager(){
    const pager=$('#desktop-pager');pager.replaceChildren();
    for(let index=0;index<settings.desktopCount;index++){
      const button=document.createElement('button');button.type='button';button.title=settings.desktopNames[index]||'桌面 '+(index+1);button.setAttribute('aria-label',button.title);button.setAttribute('aria-pressed',String(windows.currentDesktop()===index));
      button.innerHTML='<span class="pager-number">'+(index+1)+'</span>';
      button.addEventListener('click',()=>windows.switchDesktop(index));pager.append(button);
    }
  }
  function closeOverview(restoreFocus=false){const wasOpen=isSurfaceOpen($('#desktop-overview'));hideSurface($('#desktop-overview'),{effect:'window',origin:'center'});if(restoreFocus&&wasOpen&&overviewFocus?.isConnected)overviewFocus.focus({preventScroll:true});}
  function renderOverview(){
    const list=$('#overview-desktops'),focused=document.activeElement?.dataset.overviewOpen;
    const columns=Math.max(1,Math.min(settings.desktopCount,Math.floor((innerWidth-48)/400)));
    const desktopWidth=(innerWidth-(innerWidth<640?32:64)-(columns-1)*24)/columns;
    list.style.gridTemplateColumns='repeat('+columns+', minmax(0, 1fr))';list.replaceChildren();
    for(let index=0;index<settings.desktopCount;index++){
      const desk=document.createElement('section');desk.className='overview-desktop'+(index===windows.currentDesktop()?' selected':'');desk.dataset.desktop=String(index);
      const heading=document.createElement('button');heading.type='button';heading.className='overview-desktop-heading';heading.textContent=settings.desktopNames[index]||'桌面 '+(index+1);heading.setAttribute('aria-pressed',String(index===windows.currentDesktop()));heading.addEventListener('click',()=>{closeOverview();windows.switchDesktop(index);});desk.append(heading);
      const grid=document.createElement('div');grid.className='overview-windows';const rowCount=desktopWidth>=480?2:1;grid.style.gridTemplateColumns='repeat('+rowCount+', minmax(0, 1fr))';
      for(const item of windows.list().filter((entry)=>entry.opened&&entry.desktop===index)){
        const card=document.createElement('article');card.className='overview-window';card.draggable=true;
        const button=document.createElement('button');button.type='button';button.className='overview-window-open';button.dataset.overviewOpen=item.id;button.setAttribute('aria-label','激活 '+item.title);
        const label=document.createElement('span');label.className='overview-window-title';label.innerHTML='<span class="app-icon" aria-hidden="true">'+icon(item.icon)+'</span><span>'+escape(item.title)+'</span>';button.append(label);
        const width=Math.max(100,Math.floor((desktopWidth-32-(rowCount-1)*12)/rowCount));button.append(createWindowPreview(item.node,{width,height:Math.round(width*.6)}));
        button.addEventListener('click',()=>{closeOverview();windows.open(item.id);});
        const close=document.createElement('button');close.type='button';close.className='overview-window-close';close.dataset.icon='window-close';close.setAttribute('aria-label','关闭 '+item.title);close.addEventListener('click',()=>windows.close(item.id));card.append(button,close);
        card.addEventListener('dragstart',(event)=>{event.dataTransfer.setData('text/x-arisaka-window',item.id);event.dataTransfer.effectAllowed='move';});grid.append(card);
      }
      if(!grid.children.length){const empty=document.createElement('div');empty.className='overview-empty';empty.textContent='没有打开的窗口';grid.append(empty);}
      desk.append(grid);desk.addEventListener('dragover',(event)=>{if([...event.dataTransfer.types].includes('text/x-arisaka-window')){event.preventDefault();desk.classList.add('drop-target');}});desk.addEventListener('dragleave',(event)=>{if(!desk.contains(event.relatedTarget))desk.classList.remove('drop-target');});desk.addEventListener('drop',(event)=>{event.preventDefault();desk.classList.remove('drop-target');windows.moveTo(event.dataTransfer.getData('text/x-arisaka-window'),index);renderOverview();});list.append(desk);
    }
    decorate(list);if(focused)$$('[data-overview-open]',list).find((button)=>button.dataset.overviewOpen===focused)?.focus({preventScroll:true});
  }
  function overview(){if(locked)return;if(isSurfaceOpen($('#desktop-overview'))){closeOverview(true);return;}overviewFocus=document.activeElement;closeLauncher();closePopup();closeRunner();closeTaskPreview();closeMenu();renderOverview();showSurface($('#desktop-overview'),{effect:'window',origin:'center'});$('#overview-desktops .selected .overview-desktop-heading')?.focus({preventScroll:true});}
  $('#overview-close').onclick=()=>closeOverview(true);
  $('#desktop-pager').addEventListener('dblclick',overview);
  window.addEventListener('plasma:desktop',()=>{renderPager();updatePanelState();closeTaskPreview();});
  let powerMode='lock';
  function renderLock(){
    const user=listProfiles().find((user)=>user.id===lockUser)||activeProfile();
    $('#lock-name').textContent=powerMode==='off'?'Arisaka':user.name;
    $('#lock-avatar').textContent=user.avatar||user.name.slice(0,1);$('#lock-avatar').style.backgroundColor=user.color||'#3daee9';
    $('#unlock-password').hidden=powerMode==='off'||!user.protected;$('#unlock-password').required=powerMode!=='off'&&user.protected;
    $('#unlock-password').value='';$('#unlock-password').removeAttribute('aria-invalid');$('#unlock-message').textContent='';$('#unlock-button').textContent=powerMode==='off'?'启动':'解锁';
    $('#lock-users').replaceChildren();$('#lock-users').hidden=powerMode==='off'||listProfiles().length<2;
    for(const entry of listProfiles()){const button=document.createElement('button');button.type='button';button.innerHTML='<span class="lock-user-avatar" aria-hidden="true">'+escape(entry.avatar||entry.name.slice(0,1))+'</span><span>'+escape(entry.name)+'</span>';button.firstElementChild.style.backgroundColor=entry.color||'#3daee9';button.classList.toggle('selected',entry.id===lockUser);button.setAttribute('aria-pressed',String(entry.id===lockUser));button.addEventListener('click',()=>{lockUser=entry.id;renderLock();});$('#lock-users').append(button);}
    if(!$('#unlock-password').hidden)$('#unlock-password').focus();else $('#unlock-button').focus();
  }
  function lock(mode='lock'){
    if(!locked)lockFocus=document.activeElement;
    closeLauncher();closeRunner();closeOverview();closeTaskPreview();closePopup();closeMenu();
    locked=true;powerMode=mode;lockUser=profileKey();$('#desktop').inert=true;$('#desktop').setAttribute('aria-hidden','true');showSurface($('#screen-lock'),{effect:'lock',origin:'center'});
    sessionStorage.removeItem('arisaka/unlocked/'+profileKey());sessionStorage.setItem('arisaka/locked/'+profileKey(),'1');renderLock();clock();
  }
  function unlock(){locked=false;hideSurface($('#screen-lock'),{effect:'lock',origin:'center'});$('#desktop').inert=false;$('#desktop').removeAttribute('aria-hidden');sessionStorage.setItem('arisaka/unlocked/'+profileKey(),'1');sessionStorage.removeItem('arisaka/locked/'+profileKey());lastActivity=Date.now();const focus=lockFocus?.isConnected&&!lockFocus.closest('[inert],[hidden]')?lockFocus:$('#launcher-button');focus.focus({preventScroll:true});}
  $('#unlock-form').addEventListener('submit',async(event)=>{
    event.preventDefault();if(powerMode==='off'){powerMode='lock';renderLock();return;}
    const button=$('#unlock-button');button.disabled=true;
    try{const password=$('#unlock-password').value;if(lockUser!==profileKey()){await activateProfile(lockUser,password);return;}if(!await authenticateProfile(lockUser,password))throw new Error('密码错误');unlock();}
    catch(error){$('#unlock-message').textContent=error.message;$('#unlock-password').value='';$('#unlock-password').setAttribute('aria-invalid','true');$('#unlock-password').focus();}
    finally{button.disabled=false;}
  });
  function powerMenu(anchor){menu([
    {label:'锁定',icon:'system-lock-screen',shortcut:'Meta+L',action:()=>lock()},
    {label:'切换用户',icon:'user-home',action:()=>lock()},
    {label:'注销',icon:'system-log-out',action:()=>{for(const item of windows.list().filter((entry)=>entry.opened)){windows.close(item.id);if(windows.isOpen(item.id))return;}lock();}},null,
    {label:'重新启动桌面',icon:'view-refresh',action:()=>{windows.persist();location.reload();}},
    {label:'关机',icon:'system-shutdown',action:()=>{windows.persist();lock('off');}},
    ...(!locked?[null,{label:'新建存档…',icon:'document-new',action:()=>{closeLauncher();$('#restart-button').click();}}]:[]),
  ],anchor);}
  $('#launcher-power').addEventListener('click',(event)=>powerMenu(event.currentTarget));
  $('#lock-power').addEventListener('click',(event)=>powerMenu(event.currentTarget));
  function clock(){const now=new Date();const time=new Intl.DateTimeFormat('zh-CN',{timeZone:settings.timeZone,hour:'2-digit',minute:'2-digit',...(settings.showSeconds?{second:'2-digit'}:{}),hour12:!settings.hour24}).format(now);$('#clock-time').textContent=time;$('#clock-date').textContent=new Intl.DateTimeFormat('zh-CN',{timeZone:settings.timeZone,month:'2-digit',day:'2-digit'}).format(now);$('#tray-clock').title=new Intl.DateTimeFormat('zh-CN',{timeZone:settings.timeZone,dateStyle:'full',timeStyle:'long'}).format(now);$('#lock-time').textContent=time;$('#lock-date').textContent=new Intl.DateTimeFormat('zh-CN',{timeZone:settings.timeZone,dateStyle:'full'}).format(now);}
  let lastActivity=Date.now(),metaUsed=false;
  for(const type of ['pointerdown','keydown','pointermove'])document.addEventListener(type,()=>{lastActivity=Date.now();},{passive:true});
  document.addEventListener('keydown',(event)=>{
    if(event.key==='Meta')metaUsed=false;else if(event.metaKey)metaUsed=true;
    if(locked){
      if(event.key==='Escape')closeMenu();
      if(event.key==='Tab'&&!event.target.closest('.native-menu')){const fields=$$('button:not(:disabled),input:not(:disabled)',$('#screen-lock')).filter((node)=>node.getClientRects().length);const index=fields.indexOf(document.activeElement);if(event.shiftKey&&index<=0){event.preventDefault();fields.at(-1)?.focus();}else if(!event.shiftKey&&(index<0||index===fields.length-1)){event.preventDefault();fields[0]?.focus();}}
      return;
    }
    if(event.target.closest('.native-menu'))return;
    if(event.key==='Escape'){
      if(isSurfaceOpen(taskPreview))closeTaskPreview(true);else if(popup)closePopup(true);else if(isSurfaceOpen($('#launcher')))closeLauncher(true);else if(isSurfaceOpen($('#krunner')))closeRunner(true);else if(isSurfaceOpen($('#desktop-overview')))closeOverview(true);
      return;
    }
    if (event.key === 'Meta') return;
    for (const [id, action] of [
      ['runner', showRunner], ['launcher', toggleLauncher], ['lock', () => lock()], ['files', () => windows.open('files')],
      ['overview', overview], ['clipboard', () => openPopup('clipboard', $('#tray-clipboard'))],
      ['console', () => windows.open('console')], ['screenshot', () => windows.open('screenshot')],
    ]) if (matchesShortcut(event, settings, id)) { event.preventDefault(); action(); return; }
  });
  document.addEventListener('keyup',event=>{if(event.key==='Meta'&&!metaUsed&&!locked&&matchesShortcut(event,settings,'launcher'))toggleLauncher();});
  document.addEventListener('pointerdown',(event)=>{if(!event.target.closest('#launcher,#launcher-button,.native-menu'))closeLauncher();if(!event.target.closest('#tray-popup,.system-tray,.native-menu'))closePopup();if(!event.target.closest('#krunner,.native-menu'))closeRunner();if(!event.target.closest('#task-preview,.task-button'))closeTaskPreview();});
  $('#desktop-overview').addEventListener('pointerdown',(event)=>{if(event.target===$('#desktop-overview'))closeOverview(true);});
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
  preferenceEvents.addEventListener('appearance',(event)=>{settings=event.detail;renderPager();renderLauncher();clock();updateAudio();updatePanelState();updateTaskButtons();$('#tray-volume').dataset.icon=settings.muted?'audio-volume-muted':'audio-volume-high';$('#tray-volume .action-icon').style.backgroundImage=`url("/icons/${settings.muted?'audio-volume-muted':'audio-volume-high'}.svg")`;if(isSurfaceOpen($('#launcher')))positionSurface($('#launcher'),$('#launcher-button'),'start');if(popup)positionPopup();if(previewId&&isSurfaceOpen(taskPreview))showTaskPreview(previewId);if(isSurfaceOpen($('#desktop-overview')))renderOverview();});
  preferenceEvents.addEventListener('users',renderUser);
  window.addEventListener('resize',()=>{updatePanelState();if(popup)positionPopup();if(isSurfaceOpen($('#launcher')))positionSurface($('#launcher'),$('#launcher-button'),'start');if(previewId&&isSurfaceOpen(taskPreview))showTaskPreview(previewId);if(isSurfaceOpen($('#desktop-overview')))renderOverview();});
  window.addEventListener('online',()=>{$('.connection').classList.remove('offline');$('#connection-label').textContent='';});
  window.addEventListener('offline',()=>{$('.connection').classList.add('offline');$('#connection-label').textContent='离线';notify('网络','连接已断开');});
  timer=setInterval(()=>{clock();if(!locked&&settings.lockMinutes>0&&Date.now()-lastActivity>settings.lockMinutes*60000)lock();},1000);
  window.addEventListener('pagehide',()=>{clearInterval(timer);clearTimeout(previewOpenTimer);clearTimeout(previewCloseTimer);cancelAnimationFrame(windowRefresh);cancelAnimationFrame(panelRefresh);});
  renderUser();renderLauncher();renderPager();renderNotificationCount();clock();updateAudio();updateTaskButtons();updatePanelState();
  return {lock,notify,addClipboard,overview,settings:settingsApp,showRunner,ready(){windows.restoreSession();if(sessionStorage.getItem('arisaka/locked/'+profileKey())==='1'||settings.lockOnStart&&!sessionStorage.getItem('arisaka/unlocked/'+profileKey()))lock();}};
}
