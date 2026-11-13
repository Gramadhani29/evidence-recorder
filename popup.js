const tcInput=document.getElementById('tcInput');
const clearPreviousCheckbox=document.getElementById('clearPreviousCheckbox');
const startBtn=document.getElementById('startBtn');
const createOnlyBtn=document.getElementById('createOnlyBtn');
const pauseBtn=document.getElementById('pauseBtn');
const finishBtn=document.getElementById('finishBtn');
const manualCaptureBtn=document.getElementById('manualCaptureBtn');
const badge=document.getElementById('badge');
const recordingSection=document.getElementById('recordingSection');
const setupSection=document.getElementById('setupSection');
const activeTcName=document.getElementById('activeTcName');
const activeCountBadge=document.getElementById('activeCountBadge');
const statusMsg=document.getElementById('statusMsg');
const sessionList=document.getElementById('sessionList');
const clearAllTcBtn=document.getElementById('clearAllTcBtn');
const downloadDiagnosticsBtn=document.getElementById('downloadDiagnosticsBtn');
let currentTab=null;
const callBg=(type,payload={})=>chrome.runtime.sendMessage({type,...payload});
const validTc=tc=>/^[a-zA-Z0-9_-]{1,60}$/.test(tc);
function esc(s=''){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function renderSessions(items=[]){
  sessionList.innerHTML='';
  if(!items.length){sessionList.innerHTML='<div class="session-meta">Belum ada sesi TC.</div>';return;}
  for(const s of items){
    const el=document.createElement('div'); el.className='session-item';
    const st=s.status||'draft'; const canContinue=st!=='active';
    el.innerHTML=`<div class="session-row"><span class="session-tc">${esc(s.tc)}</span><span class="status-pill status-${esc(st)}">${esc(st)}</span></div>
      <div class="session-meta">${s.count||0} screenshot${s.lastTitle?' • '+esc(s.lastTitle):''}</div>
      <div class="session-actions">
        <button class="btn btn-primary resume" ${canContinue?'':'disabled'}>▶ Tab Ini</button>
        <button class="btn btn-accent openweb" ${s.lastUrl?'':'disabled'}>🌐 Buka Web</button>
        <button class="btn btn-secondary review">🔍 Review</button>
        <button class="btn btn-secondary session-delete" title="Hapus TC ini">🗑</button>
      </div>`;
    el.querySelector('.resume').addEventListener('click',async()=>{
      if(!currentTab||!/^https?:/.test(currentTab.url||'')){statusMsg.textContent='Buka tab web HTTP/HTTPS lalu pilih "Tab Ini".';return;}
      const r=await callBg('RESUME_TC',{tc:s.tc,tabId:currentTab.id}); if(!r?.ok)statusMsg.textContent='Gagal: '+(r?.error||'Resume gagal'); else window.close();
    });
    el.querySelector('.openweb').addEventListener('click',async()=>{const r=await callBg('OPEN_WEB_RESUME',{tc:s.tc}); if(!r?.ok)statusMsg.textContent='Gagal: '+(r?.error||'Tidak bisa membuka web'); else window.close();});
    el.querySelector('.review').addEventListener('click',async()=>{await callBg('OPEN_REVIEW',{tc:s.tc}); window.close();});
    el.querySelector('.session-delete').addEventListener('click',async()=>{
      if(!confirm(`Hapus TC \"${s.tc}\" beserta seluruh screenshot/evidence-nya?`)) return;
      const r=await callBg('DELETE_TC',{tc:s.tc});
      if(!r?.ok) statusMsg.textContent='Gagal: '+(r?.error||'Tidak bisa menghapus TC');
      else { statusMsg.textContent=`✓ ${s.tc} dihapus.`; await refresh(); }
    });
    sessionList.appendChild(el);
  }
}
async function refresh(){
  try{
    [currentTab]=await chrome.tabs.query({active:true,currentWindow:true});
    const webOk=!!currentTab&&/^https?:/.test(currentTab.url||'');
    const data=await callBg('STATUS',{tabId:webOk?currentTab.id:null});
    const s=data?.session; const active=!!s?.active;
    if(active){
      badge.className='badge badge-rec'; badge.innerHTML='<span class="pulse-dot"></span> Merekam';
      recordingSection.style.display='block'; setupSection.style.display='none';
      activeTcName.textContent=s.tc; activeCountBadge.textContent=`${s.count||0} screenshot`;
      const capture=s.lastCapture;
      statusMsg.textContent=capture?.status==='error'
        ? `Capture terakhir gagal: ${capture.error||'kesalahan tidak dikenal'}`
        : capture?.status==='skipped'
          ? `Screenshot duplikat dilewati (${capture.reason||'duplikat'}).`
          : 'TC aktif. Pause jika ingin pindah pekerjaan sementara, atau Selesai TC untuk langsung membuat TC berikutnya.';
    }else{
      badge.className='badge badge-idle'; badge.textContent='Siap'; recordingSection.style.display='none'; setupSection.style.display='block';
      startBtn.disabled=!webOk;
      if(!tcInput.value&&data?.savedTc)tcInput.value=data.savedTc;
      statusMsg.textContent=webOk?'Siap membuat atau melanjutkan TC di tab web ini.':'Kamu tetap bisa membuat TC. Untuk mulai/lanjut recording, gunakan "Buka Web" atau pindah ke tab web.';
    }
    renderSessions(data?.sessions||[]);
  }catch(e){statusMsg.textContent='Status error: '+e.message;}
}
startBtn.addEventListener('click',async()=>{
  const tc=tcInput.value.trim(); if(!validTc(tc)){statusMsg.textContent='TC ID tidak valid.';tcInput.focus();return;}
  const r=await callBg('START',{tabId:currentTab.id,tc,clearPrevious:clearPreviousCheckbox.checked});
  if(!r?.ok)statusMsg.textContent='Gagal: '+(r?.error||'Start gagal'); else await refresh();
});
createOnlyBtn.addEventListener('click',async()=>{
  const tc=tcInput.value.trim(); if(!validTc(tc)){statusMsg.textContent='TC ID tidak valid.';tcInput.focus();return;}
  const lastUrl=/^https?:/.test(currentTab?.url||'')?currentTab.url:'';
  const r=await callBg('CREATE_TC',{tc,lastUrl,lastTitle:currentTab?.title||''});
  if(!r?.ok)statusMsg.textContent='Gagal: '+(r?.error||'Tidak bisa membuat TC'); else {statusMsg.textContent=`✓ ${tc} disimpan. Kamu bisa langsung buat TC berikutnya.`;tcInput.value='';await refresh();}
});
pauseBtn?.addEventListener('click',async()=>{const r=await callBg('PAUSE',{tabId:currentTab.id}); if(!r?.ok)statusMsg.textContent='Gagal: '+(r?.error||'Pause gagal'); else await refresh();});
finishBtn?.addEventListener('click',async()=>{const r=await callBg('FINISH',{tabId:currentTab.id}); if(!r?.ok)statusMsg.textContent='Gagal: '+(r?.error||'Finish gagal'); else {tcInput.value='';statusMsg.textContent='✓ TC selesai. Masukkan TC berikutnya.';await refresh();}});
manualCaptureBtn?.addEventListener('click',async()=>{manualCaptureBtn.disabled=true;statusMsg.textContent='Mengambil screenshot...';const r=await callBg('MANUAL_CAPTURE',{tabId:currentTab.id});manualCaptureBtn.disabled=false;if(!r?.ok)statusMsg.textContent='Gagal: '+(r?.error||'Capture gagal');else statusMsg.textContent=`✓ Screenshot manual tersimpan sebagai Step ${r.stepNumber}.`;});
refresh(); setInterval(refresh,1500);

clearAllTcBtn?.addEventListener('click',async()=>{
  if(!confirm('Hapus SEMUA TC beserta seluruh screenshot/evidence yang tersimpan?')) return;
  if(!confirm('Konfirmasi terakhir: seluruh daftar TC dan evidence akan dikosongkan. Lanjutkan?')) return;
  const r=await callBg('DELETE_ALL_TC');
  if(!r?.ok) statusMsg.textContent='Gagal: '+(r?.error||'Tidak bisa menghapus semua TC');
  else { tcInput.value=''; statusMsg.textContent='✓ Semua TC dan evidence telah dihapus.'; await refresh(); }
});

downloadDiagnosticsBtn?.addEventListener('click',async()=>{
  const r=await callBg('GET_DIAGNOSTICS',{limit:500});
  if(!r?.ok){statusMsg.textContent='Gagal mengambil log: '+(r?.error||'Unknown error');return;}
  const blob=new Blob([JSON.stringify({exportedAt:new Date().toISOString(),items:r.items},null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob);
  try{await chrome.downloads.download({url,filename:`QA-Evidence/diagnostics-${Date.now()}.json`,saveAs:false,conflictAction:'uniquify'});statusMsg.textContent=`✓ ${r.items.length} log diagnostik diunduh.`;}
  finally{setTimeout(()=>URL.revokeObjectURL(url),1000);}
});
