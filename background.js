importScripts('db.js', 'qa-core.js');

const sessions = new Map();
const captureQueues = new Map();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const validTc = tc => /^[A-Za-z0-9_-]{1,60}$/.test(tc);
const safeName = t => t.replace(/[^A-Za-z0-9_-]/g, '_');
const sendTab = (id, message) => chrome.tabs.sendMessage(id, message);
let lastTrashPurge=0;
const logEvent = (level,event,details={}) => {
  const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info';
  console[method](`[QA Recorder] ${event}`, details);
  return QA_DB.log(level,event,details);
};

async function getSession(tabId) {
  if (sessions.has(tabId)) return sessions.get(tabId);
  const key = `active_session_${tabId}`;
  const data = await chrome.storage.local.get(key);
  if (data?.[key]) { sessions.set(tabId, data[key]); return data[key]; }
  return null;
}
async function persistSession(tabId,s) {
  s.updatedAt = Date.now();
  if (tabId != null) {
    sessions.set(tabId,s);
    await chrome.storage.local.set({[`active_session_${tabId}`]:s,lastTc:s.tc});
  } else {
    await chrome.storage.local.set({lastTc:s.tc});
  }
  try { await QA_DB.saveSession(s); } catch(e) { await logEvent('error','session-persist-failed',{tc:s.tc,tabId,error:e.message}); throw e; }
}
async function detachSession(tabId) {
  sessions.delete(tabId); captureQueues.delete(tabId);
  await chrome.storage.local.remove(`active_session_${tabId}`);
}
async function attachTcToTab(tc, tabId) {
  if(!validTc(tc)) throw Error('TC ID tidak valid.');
  const tab=await chrome.tabs.get(tabId);
  if(!tab.url?.startsWith('http')) throw Error('Buka tab web HTTP/HTTPS untuk melanjutkan TC.');
  const old=await getSession(tabId);
  if(old?.active && old.tc!==tc) throw Error(`Tab sedang merekam ${old.tc}. Pause/Selesai dulu.`);
  const saved=await QA_DB.getSession(tc);
  const count=await QA_DB.countSteps(tc);
  const sess={...(saved||{}),tc,count,active:true,status:'active',tabId,windowId:tab.windowId,lastUrl:tab.url,lastTitle:tab.title||'',startedAt:saved?.startedAt||Date.now(),resumedAt:Date.now()};
  await persistSession(tabId,sess);
  await setScript(tabId,true);
  chrome.action.setBadgeText({text:count?String(count):'REC'});
  chrome.action.setBadgeBackgroundColor({color:'#dc2626'});
  return sess;
}
async function removeSession(tabId) {
  await detachSession(tabId);
}
async function setScript(tabId,enabled) {
  if (enabled) {
    try { await chrome.scripting.executeScript({target:{tabId,allFrames:true},files:['content.js']}); }
    catch(e){ console.warn('Script execution notice:',e.message); }
  }
  try { return await sendTab(tabId,{type:'SET_RECORDING',enabled}); } catch { return {}; }
}
async function status(tabId) {
  if(Date.now()-lastTrashPurge>60*60*1000){lastTrashPurge=Date.now();QA_DB.purgeTrash().then(count=>count&&logEvent('info','trash-purged',{count})).catch(e=>logEvent('warn','trash-purge-failed',{error:e.message}));}
  const session = tabId ? await getSession(tabId) : null;
  const lastTc = (await chrome.storage.local.get('lastTc')).lastTc || '';
  let savedCount = 0;
  if(lastTc){ try{ savedCount=await QA_DB.countSteps(lastTc); }catch(e){ await logEvent('warn','status-count-failed',{tc:lastTc,error:e.message}); } }
  const allSessions = await QA_DB.getAllSessions().catch(()=>[]);
  for (const item of allSessions) {
    try { item.count = await QA_DB.countSteps(item.tc); } catch(e) { item.count = item.count||0; await logEvent('warn','session-count-failed',{tc:item.tc,error:e.message}); }
  }
  allSessions.sort((a,b)=>(b.updatedAt||b.startedAt||0)-(a.updatedAt||a.startedAt||0));
  return {session,savedTc:lastTc,savedCount,sessions:allSessions.slice(0,12)};
}
function enqueue(tabId,task){
  const prev=captureQueues.get(tabId)||Promise.resolve();
  const next=prev.catch(()=>{}).then(task);
  captureQueues.set(tabId,next);
  next.then(()=>{if(captureQueues.get(tabId)===next)captureQueues.delete(tabId);},()=>{if(captureQueues.get(tabId)===next)captureQueues.delete(tabId);});
  return next;
}
const enqueueTc=(tc,task)=>enqueue(`tc:${tc}`,task);
async function captureVisible(tabId,waitMs=0){
  if(waitMs) await sleep(waitMs);
  const s=await getSession(tabId); if(!s?.active)throw Object.assign(Error('Sesi tidak lagi aktif.'),{code:'SESSION_INACTIVE'});
  const tab=await chrome.tabs.get(tabId);
  if(!tab.active||tab.windowId!==s.windowId)throw Object.assign(Error('Capture dilewati karena tab recorder tidak aktif.'),{code:'TAB_NOT_ACTIVE'});
  if(!tab.url?.startsWith('http'))throw Object.assign(Error('Capture hanya tersedia pada halaman HTTP/HTTPS.'),{code:'UNSUPPORTED_URL'});
  // Capture exactly what the browser currently renders.
  // Automatic masking is disabled; privacy censoring is manual in Review.
  let rawDataUrl;
  rawDataUrl=await chrome.tabs.captureVisibleTab(tab.windowId,{format:'png'});
  if(!rawDataUrl)throw Object.assign(Error('Browser tidak menghasilkan data screenshot.'),{code:'EMPTY_CAPTURE'});
  const response=await fetch(rawDataUrl);
  const rawImage=await response.blob();
  const bitmap=await createImageBitmap(rawImage);
  const imgW=bitmap.width,imgH=bitmap.height;
  let thumbnail=null;
  try {
    const thumbW=Math.min(320,bitmap.width),thumbH=Math.max(1,Math.round(bitmap.height*(thumbW/bitmap.width)));
    const canvas=new OffscreenCanvas(thumbW,thumbH);canvas.getContext('2d').drawImage(bitmap,0,0,thumbW,thumbH);
    thumbnail=await canvas.convertToBlob({type:'image/jpeg',quality:.72});
  } catch(e) { await logEvent('warn','thumbnail-failed',{tabId,error:e.message}); }
  bitmap.close?.();
  return {rawImage,thumbnail,fingerprint:QA_CORE.imageFingerprint(rawDataUrl),imgW,imgH,tab};
}
function rectToAnnotation(r,imgW,imgH,text=''){
  if(!r||!r.viewportW||!r.viewportH)return null;
  const sx=imgW/r.viewportW, sy=imgH/r.viewportH, pad=2*Math.min(sx,sy);
  const x=Math.max(2,Math.round(r.x*sx-pad));
  const y=Math.max(2,Math.round(r.y*sy-pad));
  const w=Math.max(4,Math.min(imgW-x-2,Math.round(r.w*sx+pad*2)));
  const h=Math.max(4,Math.min(imgH-y-2,Math.round(r.h*sy+pad*2)));
  return {id:`box_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,type:'box',x,y,w,h,color:'#ff1616',lineWidth:Math.max(3,Math.round(3*Math.min(sx,sy))),text};
}
async function saveCheckpoint(tabId,msg){
  const s=await getSession(tabId); if(!s?.active)throw Error('Sesi tidak aktif.');
  const early=QA_CORE.shouldSkipCapture(s.lastCapture,{checkpointId:msg.checkpointId,interactionId:msg.interactionId,phase:msg.phase});
  if(early.skip){await logEvent('info','capture-duplicate-skipped',{tc:s.tc,reason:early.reason,checkpointId:msg.checkpointId});return {ok:true,skipped:true,reason:early.reason};}
  const shot=await captureVisible(tabId,Number(msg.waitMs)||0);
  const candidate={checkpointId:msg.checkpointId,interactionId:msg.interactionId,phase:msg.phase,fingerprint:shot.fingerprint,at:Date.now()};
  const duplicate=QA_CORE.shouldSkipCapture(s.lastCapture,candidate,candidate.at);
  if(duplicate.skip){s.lastCapture={...candidate,status:'skipped',reason:duplicate.reason};await persistSession(tabId,s);await logEvent('info','capture-duplicate-skipped',{tc:s.tc,reason:duplicate.reason,checkpointId:msg.checkpointId});return {ok:true,skipped:true,reason:duplicate.reason};}
  s.lastUrl=shot.tab.url||s.lastUrl||''; s.lastTitle=shot.tab.title||s.lastTitle||'';
  const annotations=(msg.rects||[]).map(r=>rectToAnnotation(r,shot.imgW,shot.imgH,'')).filter(Boolean);
  const n=await QA_DB.nextStepNumber(s.tc);
  const step={
    id:`${safeName(s.tc)}_${Date.now()}_${n}`,
    tc:s.tc,stepNumber:n,rawImage:shot.rawImage,thumbnail:shot.thumbnail,imageWidth:shot.imgW,imageHeight:shot.imgH,
    label:msg.label||`Checkpoint ${n}`,checkpointKind:msg.checkpointKind||'checkpoint',
    pageTitle:shot.tab.title||'',pageUrl:shot.tab.url||msg.pageUrl||'',annotations,
    mark:annotations[0]||null,originalMark:annotations[0]?{...annotations[0]}:null,
    evidenceMode:'checkpoint',checkpointId:msg.checkpointId,interactionId:msg.interactionId||'',capturePhase:msg.phase||'',createdAt:Date.now()
  };
  await QA_DB.saveStep(step);
  s.count=await QA_DB.countSteps(s.tc);s.lastCapture={...candidate,status:'saved',stepId:step.id}; await persistSession(tabId,s);
  chrome.action.setBadgeText({text:String(n)}); chrome.action.setBadgeBackgroundColor({color:'#0284c7'});
  await logEvent('info','capture-saved',{tc:s.tc,stepId:step.id,stepNumber:n,kind:step.checkpointKind});
  return {ok:true,saved:true,stepId:step.id,stepNumber:n};
}
async function saveManualStep(tabId){
  const s=await getSession(tabId); if(!s?.active)throw Error('Sesi tidak aktif.');
  const shot=await captureVisible(tabId,20); const n=await QA_DB.nextStepNumber(s.tc);
  const id=`${safeName(s.tc)}_${Date.now()}_${n}`;
  await QA_DB.saveStep({id,tc:s.tc,stepNumber:n,rawImage:shot.rawImage,thumbnail:shot.thumbnail,imageWidth:shot.imgW,imageHeight:shot.imgH,label:'Tangkapan Layar Manual',pageTitle:shot.tab.title||'',pageUrl:shot.tab.url||'',annotations:[],mark:null,originalMark:null,evidenceMode:'manual',createdAt:Date.now()});
  s.count=await QA_DB.countSteps(s.tc);s.lastCapture={fingerprint:shot.fingerprint,at:Date.now(),status:'saved',stepId:id,phase:'manual'};await persistSession(tabId,s);chrome.action.setBadgeText({text:String(n)});
  await logEvent('info','manual-capture-saved',{tc:s.tc,stepId:id,stepNumber:n});return {ok:true,saved:true,stepId:id,stepNumber:n};
}
async function reconcileTc(tc){
  const count=await QA_DB.countSteps(tc);
  let activeFound=false;
  for(const [tabId,s] of sessions.entries()){
    if(s?.tc!==tc)continue;
    activeFound=true;s.count=count;await persistSession(tabId,s);
  }
  if(!activeFound){const saved=await QA_DB.getSession(tc);if(saved){saved.count=count;await QA_DB.saveSession(saved);}}
  return count;
}
async function renumberTc(tc){
  const current=await QA_DB.getSteps(tc);
  await QA_DB.reorderSteps(tc,current.map(step=>step.id));
  return reconcileTc(tc);
}

chrome.runtime.onMessage.addListener((msg,sender,respond)=>{
  (async()=>{
    if(msg.type==='STATUS')return status(msg.tabId);
    if(msg.type==='START'){
      if(!validTc(msg.tc))throw Error('TC ID hanya huruf, angka, - atau _ (1–60 karakter).');
      const tab=await chrome.tabs.get(msg.tabId); if(!tab.url?.startsWith('http'))throw Error('Gunakan pada tab HTTP/HTTPS biasa.');
      const existing=await getSession(msg.tabId); if(existing?.active)throw Error('Tab sudah sedang merekam.');
      if(msg.clearPrevious)await QA_DB.clearSteps(msg.tc,false);
      const count=msg.clearPrevious?0:await QA_DB.countSteps(msg.tc);
      const previous=await QA_DB.getSession(msg.tc);
      const s={...(previous||{}),active:true,status:'active',tc:msg.tc,count,windowId:tab.windowId,tabId:msg.tabId,lastUrl:tab.url,lastTitle:tab.title||'',startedAt:previous?.startedAt||Date.now(),updatedAt:Date.now()};
      await persistSession(msg.tabId,s); await setScript(msg.tabId,true);
      chrome.action.setBadgeText({text:count?String(count):'REC'}); chrome.action.setBadgeBackgroundColor({color:'#dc2626'});
      return {ok:true,count};
    }
    if(msg.type==='PAUSE'){
      const s=await getSession(msg.tabId); if(!s) throw Error('Tidak ada sesi aktif di tab ini.');
      const tab=await chrome.tabs.get(msg.tabId).catch(()=>null);
      s.active=false; s.status='paused'; s.lastUrl=tab?.url||s.lastUrl||''; s.lastTitle=tab?.title||s.lastTitle||''; s.tabId=null; s.windowId=null;
      try{await setScript(msg.tabId,false);}catch{}
      await persistSession(null,s); await detachSession(msg.tabId);
      chrome.action.setBadgeText({text:'Ⅱ'}); chrome.action.setBadgeBackgroundColor({color:'#f59e0b'});
      return {ok:true,tc:s.tc};
    }
    if(msg.type==='FINISH'){
      const s=await getSession(msg.tabId); const tc=s?.tc||msg.tc;
      if(!tc) throw Error('TC tidak ditemukan.');
      const tab=await chrome.tabs.get(msg.tabId).catch(()=>null);
      const saved=s||await QA_DB.getSession(tc)||{tc};
      saved.active=false; saved.status='completed'; saved.lastUrl=tab?.url||saved.lastUrl||''; saved.lastTitle=tab?.title||saved.lastTitle||''; saved.tabId=null; saved.windowId=null; saved.finishedAt=Date.now();
      try{await setScript(msg.tabId,false);}catch{}
      await persistSession(null,saved); await detachSession(msg.tabId);
      chrome.action.setBadgeText({text:''});
      return {ok:true,tc};
    }
    if(msg.type==='CREATE_TC'){
      if(!validTc(msg.tc)) throw Error('TC ID hanya huruf, angka, - atau _ (1–60 karakter).');
      const existing=await QA_DB.getSession(msg.tc);
      const count=await QA_DB.countSteps(msg.tc);
      const draft={...(existing||{}),tc:msg.tc,count,active:false,status:existing?.status==='completed'?'completed':'draft',lastUrl:msg.lastUrl||existing?.lastUrl||'',lastTitle:msg.lastTitle||existing?.lastTitle||'',createdAt:existing?.createdAt||Date.now()};
      await persistSession(null,draft);
      return {ok:true,session:draft};
    }
    if(msg.type==='DELETE_TC'){
      if(!validTc(msg.tc)) throw Error('TC ID tidak valid.');
      // Stop any active tab currently attached to this TC before deleting it.
      for (const [tabId, sess] of [...sessions.entries()]) {
        if (sess?.tc === msg.tc) {
          try { await setScript(tabId,false); } catch {}
          await detachSession(tabId);
        }
      }
      await QA_DB.deleteSession(msg.tc);
      const last=(await chrome.storage.local.get('lastTc')).lastTc||'';
      if(last===msg.tc) await chrome.storage.local.remove('lastTc');
      chrome.action.setBadgeText({text:''});
      return {ok:true};
    }
    if(msg.type==='DELETE_ALL_TC'){
      // Stop all active recorders first, then clear evidence + session records.
      for (const [tabId] of [...sessions.entries()]) {
        try { await setScript(tabId,false); } catch {}
        await detachSession(tabId);
      }
      captureQueues.clear();
      await QA_DB.clearSteps();
      await QA_DB.clearSessions();
      const stored=await chrome.storage.local.get(null);
      const removeKeys=Object.keys(stored).filter(k=>k==='lastTc'||k.startsWith('active_session_')||k.startsWith('pending_resume_'));
      if(removeKeys.length) await chrome.storage.local.remove(removeKeys);
      chrome.action.setBadgeText({text:''});
      return {ok:true};
    }
    if(msg.type==='DELETE_STEP'){
      const step=await QA_DB.getStepById(msg.id,false);if(!step)throw Error('Step sudah tidak ditemukan.');
      return await enqueueTc(step.tc,async()=>{await QA_DB.deleteStep(msg.id,true);await renumberTc(step.tc);await logEvent('info','step-moved-to-trash',{tc:step.tc,stepId:msg.id});return {ok:true,tc:step.tc,deletedIds:[msg.id]};});
    }
    if(msg.type==='CLEAR_STEPS'){
      if(!validTc(msg.tc))throw Error('TC ID tidak valid.');
      return await enqueueTc(msg.tc,async()=>{const deletedIds=await QA_DB.clearSteps(msg.tc,true);await reconcileTc(msg.tc);await logEvent('info','tc-steps-moved-to-trash',{tc:msg.tc,count:deletedIds.length});return {ok:true,tc:msg.tc,deletedIds};});
    }
    if(msg.type==='UNDO_DELETE'){
      return await enqueueTc(msg.tc||'__trash__',async()=>{const restored=await QA_DB.restoreDeleted(msg.ids||[]);if(msg.tc)await renumberTc(msg.tc);await logEvent('info','trash-restored',{tc:msg.tc||'',restored});return {ok:true,restored};});
    }
    if(msg.type==='REORDER_STEPS'){
      if(!validTc(msg.tc))throw Error('TC ID tidak valid.');
      return await enqueueTc(msg.tc,async()=>{await QA_DB.reorderSteps(msg.tc,msg.ids||[]);await reconcileTc(msg.tc);return {ok:true};});
    }
    if(msg.type==='RENAME_TC'){
      if(!validTc(msg.oldTc)||!validTc(msg.newTc))throw Error('TC ID tidak valid.');
      return await enqueueTc(msg.oldTc,async()=>{await QA_DB.renameTc(msg.oldTc,msg.newTc);for(const [tabId,s] of sessions.entries())if(s?.tc===msg.oldTc){s.tc=msg.newTc;await persistSession(tabId,s);}const stored=await chrome.storage.local.get('lastTc');if(stored.lastTc===msg.oldTc)await chrome.storage.local.set({lastTc:msg.newTc});await logEvent('info','tc-renamed',{oldTc:msg.oldTc,newTc:msg.newTc});return {ok:true};});
    }
    if(msg.type==='GET_DIAGNOSTICS')return {ok:true,items:await QA_DB.getDiagnostics(Number(msg.limit)||100)};
    if(msg.type==='RESUME_TC'){
      const sess=await attachTcToTab(msg.tc,msg.tabId);
      return {ok:true,session:sess};
    }
    if(msg.type==='OPEN_WEB_RESUME'){
      const saved=await QA_DB.getSession(msg.tc); if(!saved) throw Error('Sesi TC tidak ditemukan.');
      const url=saved.lastUrl||msg.fallbackUrl;
      if(!url||!/^https?:/.test(url)) throw Error('TC ini belum memiliki URL web terakhir.');
      const tab=await chrome.tabs.create({url,active:true});
      await chrome.storage.local.set({[`pending_resume_${tab.id}`]:msg.tc});
      return {ok:true,tabId:tab.id};
    }
    if(msg.type==='STOP') return {ok:false,error:'Gunakan FINISH atau PAUSE.'};
    if(msg.type==='OPEN_REVIEW'){
      const tc=msg.tc||(await chrome.storage.local.get('lastTc')).lastTc||'';
      await chrome.tabs.create({url:chrome.runtime.getURL(tc?`review.html?tc=${encodeURIComponent(tc)}`:'review.html')});
      return {ok:true};
    }
    const tabId=sender.tab?.id||msg.tabId;
    if(msg.type==='CHECKPOINT_READY'){
      if(!tabId)return {ok:false};
      const session=await getSession(tabId);if(!session?.active)throw Error('Sesi tidak aktif.');
      return await enqueueTc(session.tc,()=>saveCheckpoint(tabId,msg));
    }
    if(msg.type==='MANUAL_CAPTURE'){
      if(!tabId)return {ok:false};
      const session=await getSession(tabId);if(!session?.active)throw Error('Sesi tidak aktif.');
      return await enqueueTc(session.tc,()=>saveManualStep(tabId));
    }
    return {ok:false,error:'Pesan tidak dikenali'};
  })().then(respond).catch(async e=>{
    await logEvent('error','message-failed',{type:msg.type,error:e.message,tabId:sender.tab?.id||msg.tabId||null});
    const tabId=sender.tab?.id||msg.tabId;
    if(tabId){const s=await getSession(tabId).catch(()=>null);if(s){s.lastCapture={status:'error',error:e.message,at:Date.now()};await persistSession(tabId,s).catch(()=>{});}}
    respond({ok:false,error:e.message,code:e.code||'ERROR'});
  });
  return true;
});

chrome.tabs.onRemoved.addListener(async id=>{
  const s=await getSession(id);
  if(s?.active){ s.active=false; s.status='paused'; s.tabId=null; s.windowId=null; await persistSession(null,s); }
  await detachSession(id);
});
chrome.tabs.onUpdated.addListener(async(id,change,tab)=>{
  if(change.status==='complete'){
    const key=`pending_resume_${id}`; const data=await chrome.storage.local.get(key); const tc=data?.[key];
    if(tc){ await chrome.storage.local.remove(key); try{await attachTcToTab(tc,id);}catch(e){console.warn('Auto resume failed',e.message);} }
  }
  const s=await getSession(id); if(!s?.active)return;
  if(tab.url?.startsWith('http')){ s.lastUrl=tab.url; s.lastTitle=tab.title||s.lastTitle||''; await persistSession(id,s); }
  if(change.status==='complete'&&tab.url?.startsWith('http')){
    try{await setScript(id,true);}catch{}
    // Full navigation is a meaningful final result. Capture after page settles.
    if(Date.now()-s.startedAt>1200){
      enqueueTc(s.tc,()=>saveCheckpoint(id,{checkpointId:`nav_${id}_${Date.now()}`,interactionId:`nav_${id}`,phase:'result',checkpointKind:'navigation-result',label:'Result — halaman baru ditampilkan',rects:[],pageUrl:tab.url,waitMs:550})).catch(e=>logEvent('warn','navigation-capture-failed',{tabId:id,tc:s.tc,error:e.message}));
    }
  }
});

self.addEventListener('unhandledrejection',event=>{
  logEvent('error','unhandled-rejection',{error:event.reason?.message||String(event.reason)});
});
