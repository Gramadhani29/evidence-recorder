// db.js - IndexedDB storage for QA Evidence Recorder
// v2 separates large image payloads from step metadata and adds recoverable trash.
const QA_DB = {
  dbName: 'QAEvidenceDB', dbVersion: 2, _db: null,
  imageFields: ['rawImage', 'beforeImage', 'afterImage', 'thumbnail'],

  async getDB() {
    if (this._db) return this._db;
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, this.dbVersion);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('steps')) {
          const store = db.createObjectStore('steps', { keyPath: 'id' });
          store.createIndex('tc', 'tc'); store.createIndex('stepNumber', 'stepNumber'); store.createIndex('createdAt', 'createdAt');
        }
        if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'tc' });
        if (!db.objectStoreNames.contains('stepImages')) db.createObjectStore('stepImages', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('trash')) {
          const store = db.createObjectStore('trash', { keyPath: 'id' });
          store.createIndex('deletedAt', 'deletedAt'); store.createIndex('tc', 'tc');
        }
        if (!db.objectStoreNames.contains('diagnostics')) {
          const store = db.createObjectStore('diagnostics', { keyPath: 'id', autoIncrement: true });
          store.createIndex('createdAt', 'createdAt');
        }
        // Move v1 image payloads out of metadata during the same atomic upgrade.
        if (e.oldVersion < 2 && db.objectStoreNames.contains('steps')) {
          const tx=e.target.transaction,steps=tx.objectStore('steps'),images=tx.objectStore('stepImages');
          const cursorReq=steps.openCursor();
          cursorReq.onsuccess=event=>{const cursor=event.target.result;if(!cursor)return;const value=cursor.value;const split=this.splitStep(value);if(split.hasImages){images.put(split.images);cursor.update(split.metadata);}cursor.continue();};
        }
      };
      req.onsuccess = e => {
        this._db = e.target.result;
        this._db.onversionchange = () => { this._db.close(); this._db = null; };
        resolve(this._db);
      };
      req.onblocked = () => reject(new Error('Upgrade database tertahan. Tutup halaman extension lain lalu coba lagi.'));
      req.onerror = e => reject(e.target.error);
    });
  },

  splitStep(step) {
    const metadata = { ...step }, images = { id: step.id };
    let hasImages = false;
    for (const field of this.imageFields) {
      if (Object.prototype.hasOwnProperty.call(metadata, field) && metadata[field] != null) {
        images[field] = metadata[field]; hasImages = true;
      }
      delete metadata[field];
    }
    return { metadata, images, hasImages };
  },

  async saveStep(step) {
    const db = await this.getDB();
    const { metadata, images, hasImages } = this.splitStep(step);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(hasImages ? ['steps', 'stepImages'] : ['steps'], 'readwrite');
      tx.objectStore('steps').put(metadata);
      if (hasImages) tx.objectStore('stepImages').put(images);
      tx.oncomplete = () => resolve(step);
      tx.onerror = e => reject(e.target.error || tx.error);
      tx.onabort = () => reject(tx.error || new Error('Transaksi penyimpanan step dibatalkan.'));
    });
  },

  async getSteps(tc) {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const store = db.transaction('steps', 'readonly').objectStore('steps');
      const req = tc ? store.index('tc').getAll(IDBKeyRange.only(tc)) : store.getAll();
      req.onsuccess = () => resolve((req.result || []).sort((a,b) => (a.stepNumber||0)-(b.stepNumber||0) || (a.createdAt||0)-(b.createdAt||0)));
      req.onerror = e => reject(e.target.error);
    });
  },

  async getStepImages(id) {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['steps', 'stepImages'], 'readonly');
      const imageReq = tx.objectStore('stepImages').get(id), legacyReq = tx.objectStore('steps').get(id);
      tx.oncomplete = () => {
        const separate = imageReq.result || {}, legacy = legacyReq.result || {}, result = { id };
        for (const field of this.imageFields) result[field] = separate[field] ?? legacy[field];
        resolve(result);
      };
      tx.onerror = e => reject(e.target.error || tx.error);
    });
  },

  async hydrateStep(step) {
    if (!step || step.rawImage || step.afterImage) return step;
    return { ...step, ...(await this.getStepImages(step.id)) };
  },

  async getStepById(id, hydrate = true) {
    const db = await this.getDB();
    const step = await new Promise((resolve, reject) => {
      const req = db.transaction('steps', 'readonly').objectStore('steps').get(id);
      req.onsuccess = () => resolve(req.result || null); req.onerror = e => reject(e.target.error);
    });
    return hydrate && step ? this.hydrateStep(step) : step;
  },
  async updateStep(step) {
    const db=await this.getDB(), {metadata}=this.splitStep(step);
    return new Promise((resolve,reject)=>{const tx=db.transaction('steps','readwrite');tx.objectStore('steps').put(metadata);tx.oncomplete=()=>resolve(step);tx.onerror=e=>reject(e.target.error||tx.error);});
  },

  async countSteps(tc) {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const req = db.transaction('steps', 'readonly').objectStore('steps').index('tc').count(IDBKeyRange.only(tc));
      req.onsuccess = () => resolve(req.result || 0); req.onerror = e => reject(e.target.error);
    });
  },
  async nextStepNumber(tc) {
    return (await this.getSteps(tc)).reduce((max, step) => Math.max(max, Number(step.stepNumber)||0), 0) + 1;
  },

  async deleteStep(id, recoverable = true) {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['steps', 'stepImages', 'trash'], 'readwrite');
      const steps = tx.objectStore('steps'), images = tx.objectStore('stepImages');
      const stepReq = steps.get(id), imageReq = images.get(id); let deleted = null;
      const remove = () => {
        const step = stepReq.result; if (!step) return;
        deleted = step;
        if (recoverable) tx.objectStore('trash').put({id, tc:step.tc, deletedAt:Date.now(), step, images:imageReq.result||null});
        steps.delete(id); images.delete(id);
      };
      let ready = 0; const whenReady = () => { if (++ready === 2) remove(); };
      stepReq.onsuccess = whenReady; imageReq.onsuccess = whenReady;
      tx.oncomplete = () => resolve(deleted); tx.onerror = e => reject(e.target.error || tx.error);
    });
  },

  async restoreDeleted(ids) {
    const db = await this.getDB(), wanted = Array.isArray(ids) ? ids : [ids];
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['steps','stepImages','trash'], 'readwrite'); let restored = 0;
      for (const id of wanted) {
        const req = tx.objectStore('trash').get(id);
        req.onsuccess = () => { const item=req.result; if(!item)return; tx.objectStore('steps').put(item.step); if(item.images)tx.objectStore('stepImages').put(item.images); tx.objectStore('trash').delete(id); restored++; };
      }
      tx.oncomplete=()=>resolve(restored); tx.onerror=e=>reject(e.target.error||tx.error);
    });
  },

  async purgeTrash(maxAgeMs=24*60*60*1000){
    const db=await this.getDB(),cutoff=Date.now()-maxAgeMs;
    return new Promise((resolve,reject)=>{const tx=db.transaction('trash','readwrite'),req=tx.objectStore('trash').index('deletedAt').openCursor(IDBKeyRange.upperBound(cutoff));let removed=0;req.onsuccess=e=>{const cursor=e.target.result;if(!cursor)return;cursor.delete();removed++;cursor.continue();};tx.oncomplete=()=>resolve(removed);tx.onerror=e=>reject(e.target.error||tx.error);});
  },

  async clearSteps(tc, recoverable = false) {
    const steps = await this.getSteps(tc);
    for (const step of steps) await this.deleteStep(step.id, recoverable);
    return steps.map(step => step.id);
  },

  async reorderSteps(tc, orderedIds) {
    const db = await this.getDB(), current = new Map((await this.getSteps(tc)).map(s=>[s.id,s]));
    if (orderedIds.length!==current.size || orderedIds.some(id=>!current.has(id))) throw new Error('Urutan step tidak lagi sinkron. Muat ulang Review.');
    return new Promise((resolve,reject)=>{ const tx=db.transaction('steps','readwrite'); orderedIds.forEach((id,i)=>tx.objectStore('steps').put({...current.get(id),stepNumber:i+1})); tx.oncomplete=()=>resolve(true); tx.onerror=e=>reject(e.target.error||tx.error); });
  },

  async renameTc(oldTc,newTc) {
    const db=await this.getDB(); if(await this.getSession(newTc) || await this.countSteps(newTc)) throw new Error(`TC "${newTc}" sudah ada.`);
    return new Promise((resolve,reject)=>{
      const tx=db.transaction(['steps','sessions'],'readwrite'), steps=tx.objectStore('steps'), sessions=tx.objectStore('sessions');
      const cursorReq=steps.index('tc').openCursor(IDBKeyRange.only(oldTc));
      cursorReq.onsuccess=e=>{const cursor=e.target.result;if(!cursor)return;cursor.update({...cursor.value,tc:newTc});cursor.continue();};
      const sessionReq=sessions.get(oldTc); sessionReq.onsuccess=()=>{if(sessionReq.result){sessions.put({...sessionReq.result,tc:newTc,updatedAt:Date.now()});sessions.delete(oldTc);}};
      tx.oncomplete=()=>resolve(true);tx.onerror=e=>reject(e.target.error||tx.error);
    });
  },

  async getLibrarySummaries() {
    const [sessions,steps]=await Promise.all([this.getAllSessions(),this.getSteps()]);
    const byTc=new Map(sessions.filter(s=>s?.tc).map(s=>[s.tc,{...s,count:0}]));
    for(const step of steps){if(!step?.tc)continue;const item=byTc.get(step.tc)||{tc:step.tc,status:'draft',active:false,count:0};item.count++;item.latestStepAt=Math.max(item.latestStepAt||0,step.createdAt||0);item.lastUrl||=step.pageUrl||'';item.lastTitle||=step.pageTitle||'';byTc.set(step.tc,item);}
    return [...byTc.values()];
  },

  async saveSession(session){const db=await this.getDB();return new Promise((resolve,reject)=>{const tx=db.transaction('sessions','readwrite');tx.objectStore('sessions').put(session);tx.oncomplete=()=>resolve(session);tx.onerror=e=>reject(e.target.error);});},
  async getSession(tc){const db=await this.getDB();return new Promise((resolve,reject)=>{const req=db.transaction('sessions','readonly').objectStore('sessions').get(tc);req.onsuccess=()=>resolve(req.result||null);req.onerror=e=>reject(e.target.error);});},
  async getAllSessions(){const db=await this.getDB();return new Promise((resolve,reject)=>{const req=db.transaction('sessions','readonly').objectStore('sessions').getAll();req.onsuccess=()=>resolve(req.result||[]);req.onerror=e=>reject(e.target.error);});},
  async clearSessions(){const db=await this.getDB();return new Promise((resolve,reject)=>{const tx=db.transaction('sessions','readwrite');tx.objectStore('sessions').clear();tx.oncomplete=()=>resolve(true);tx.onerror=e=>reject(e.target.error);});},
  async deleteSession(tc){const db=await this.getDB();await this.clearSteps(tc,false);return new Promise((resolve,reject)=>{const tx=db.transaction('sessions','readwrite');tx.objectStore('sessions').delete(tc);tx.oncomplete=()=>resolve(true);tx.onerror=e=>reject(e.target.error);});},

  async log(level,event,details={}) {
    try { const db=await this.getDB(); await new Promise((resolve,reject)=>{const tx=db.transaction('diagnostics','readwrite'),store=tx.objectStore('diagnostics');store.add({level,event,details,createdAt:Date.now()});let seen=0;const cursor=store.index('createdAt').openCursor(null,'prev');cursor.onsuccess=e=>{const item=e.target.result;if(!item)return;if(++seen>500)item.delete();item.continue();};tx.oncomplete=resolve;tx.onerror=e=>reject(e.target.error||tx.error);}); }
    catch(error){console.warn('Diagnostic log failed:',error);}
  },
  async getDiagnostics(limit=100){const db=await this.getDB();return new Promise((resolve,reject)=>{const req=db.transaction('diagnostics','readonly').objectStore('diagnostics').index('createdAt').getAll();req.onsuccess=()=>resolve((req.result||[]).slice(-limit).reverse());req.onerror=e=>reject(e.target.error);});}
};

if(typeof self!=='undefined')self.QA_DB=QA_DB;
if(typeof window!=='undefined')window.QA_DB=QA_DB;
if(typeof module!=='undefined'&&module.exports)module.exports=QA_DB;
