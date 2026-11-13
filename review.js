// review.js - Interactive QA Evidence Reviewer, Multi-Box & Blur Editor

(function() {
  'use strict';

  // State
  let tc = 'TC-SAMPLE';
  let steps = [];
  let currentIndex = 0;
  let zoomMode = 'fit';
  let toolMode = 'select'; // 'select' | 'box' | 'text' | 'blur'
  let currentMarkColor = '#ff1616';
  let currentLineWidth = 3;
  let selectedShapeId = null;
  let evidenceView = 'after'; // 'before' | 'after' for grouped form evidence
  let tcLibrary = [];
  let tcSearchQuery = '';
  let pendingUndo = null;
  let renderToken = 0;
  const objectUrls = new Set();

  // Dragging / Resizing / Drawing State
  let isDragging = false;
  let isResizing = false;
  let isDrawing = false;
  let activeHandle = null;
  let dragStartX = 0;
  let dragStartY = 0;
  let initialBox = null;
  let drawStartX = 0;
  let drawStartY = 0;
  let isDraggingLabel = false;
  let isDraggingText = false;
  let initialLabel = null;

  // DOM Elements
  const tcInput = document.getElementById('tcInput');
  const currentStepNum = document.getElementById('currentStepNum');
  const totalStepsNum = document.getElementById('totalStepsNum');
  const sidebarBadgeCount = document.getElementById('sidebarBadgeCount');
  const stepsList = document.getElementById('stepsList');
  const clearAllBtn = document.getElementById('clearAllBtn');
  const tcLibraryCount = document.getElementById('tcLibraryCount');
  const tcLibraryList = document.getElementById('tcLibraryList');
  const tcSearchInput = document.getElementById('tcSearchInput');
  const refreshTcLibraryBtn = document.getElementById('refreshTcLibraryBtn');

  const downloadAllBtn = document.getElementById('downloadAllBtn');
  const downloadZipBtn = document.getElementById('downloadZipBtn');
  const downloadCurrentBtn = document.getElementById('downloadCurrentBtn');

  const toolSelectBtn = document.getElementById('toolSelectBtn');
  const toolBoxBtn = document.getElementById('toolBoxBtn');
  const toolTextBtn = document.getElementById('toolTextBtn');
  const toolBlurBtn = document.getElementById('toolBlurBtn');
  const resetMarkBtn = document.getElementById('resetMarkBtn');

  const shapePropsGroup = document.getElementById('shapePropsGroup');
  const shapeTextContainer = document.getElementById('shapeTextContainer');
  const shapeTextInput = document.getElementById('shapeTextInput');
  const shapeColorPicker = document.getElementById('shapeColorPicker');
  const shapeLineWidthGroup = document.getElementById('shapeLineWidthGroup');
  const lineWidthSelect = document.getElementById('lineWidthSelect');
  const colorSwatches = document.querySelectorAll('.color-swatch');
  const deleteShapeBtn = document.getElementById('deleteShapeBtn');

  const evidenceViewControls = document.getElementById('evidenceViewControls');
  const viewBeforeBtn = document.getElementById('viewBeforeBtn');
  const viewAfterBtn = document.getElementById('viewAfterBtn');

  const zoomOutBtn = document.getElementById('zoomOutBtn');
  const zoomInBtn = document.getElementById('zoomInBtn');
  const zoomFitBtn = document.getElementById('zoomFitBtn');
  const zoom100Btn = document.getElementById('zoom100Btn');
  const zoomLabel = document.getElementById('zoomLabel');

  const viewportContainer = document.getElementById('viewportContainer');
  const canvasStage = document.getElementById('canvasStage');
  const stageImage = document.getElementById('stageImage');
  const annotationsContainer = document.getElementById('annotationsContainer');
  const drawingDraftBox = document.getElementById('drawingDraftBox');
  const emptyState = document.getElementById('emptyState');

  const prevStepBtn = document.getElementById('prevStepBtn');
  const nextStepBtn = document.getElementById('nextStepBtn');
  const stepLabelInput = document.getElementById('stepLabelInput');
  const deleteStepBtn = document.getElementById('deleteStepBtn');

  const progressModal = document.getElementById('progressModal');
  const modalTitle = document.getElementById('modalTitle');
  const progressBar = document.getElementById('progressBar');
  const progressMessage = document.getElementById('progressMessage');
  const toast = document.getElementById('toast');
  const undoBar = document.getElementById('undoBar');
  const undoMessage = document.getElementById('undoMessage');
  const undoDeleteBtn = document.getElementById('undoDeleteBtn');

  const safeName = t => (t || 'TC').replace(/[^A-Za-z0-9_-]/g, '_');
  const pad = (n, len = 3) => String(n).padStart(len, '0');
  const callBg = (type, payload={}) => chrome.runtime.sendMessage({type,...payload});

  function imageUrl(value) {
    if (!value) return '';
    if (typeof value === 'string') return value;
    const url=URL.createObjectURL(value);objectUrls.add(url);return url;
  }
  function stepImage(step,field){return step?.[field] ?? step?._images?.[field] ?? null;}
  async function ensureStepImages(index){
    const step=steps[index];if(!step)return null;if(step._images)return step;
    const hadLegacy=!!(step.rawImage||step.beforeImage||step.afterImage||step.thumbnail);
    const images=await QA_DB.getStepImages(step.id);
    if(hadLegacy)await QA_DB.saveStep(step);
    for(const field of QA_DB.imageFields)delete step[field];
    Object.defineProperty(step,'_images',{value:images,writable:true,configurable:true,enumerable:false});
    return step;
  }
  window.addEventListener('beforeunload',()=>{for(const url of objectUrls)URL.revokeObjectURL(url);});

  const thumbObserver = new IntersectionObserver(entries=>{
    for(const entry of entries){if(!entry.isIntersecting)continue;const img=entry.target;thumbObserver.unobserve(img);
      QA_DB.getStepImages(img.dataset.stepId).then(images=>{const value=images.thumbnail||images.rawImage||images.afterImage;if(value&&img.isConnected)img.src=imageUrl(value);}).catch(e=>console.warn('Thumbnail gagal dimuat',e));
    }
  },{rootMargin:'300px'});

  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.remove('show'), 2200);
  }

  // =========================================================================
  // NORMALIZATION & INIT
  // =========================================================================
  function normalizeStep(step) {
    if (!step) return step;
    if (!Array.isArray(step.annotations)) {
      step.annotations = [];
      if (step.mark) {
        step.annotations.push({
          id: `box_${Date.now()}_0`,
          type: 'box',
          x: step.mark.x,
          y: step.mark.y,
          w: step.mark.w,
          h: step.mark.h,
          color: step.mark.color || '#ff1616',
          lineWidth: step.mark.lineWidth || 3,
          text: '',
          labelDx: 0,
          labelDy: -28
        });
      }
    }
    for (const ann of step.annotations || []) {
      if (ann.type === 'box') {
        if (typeof ann.labelDx !== 'number') ann.labelDx = 0;
        if (typeof ann.labelDy !== 'number') ann.labelDy = -28;
      }
      if (ann.type === 'text') {
        if (!ann.text) ann.text = 'Teks';
        if (!ann.color) ann.color = '#ff1616';
        if (!ann.fontSize) ann.fontSize = 18;
      }
    }
    return step;
  }

  async function init() {
    const params = new URLSearchParams(window.location.search);
    const paramTc = params.get('tc');
    const stored = await chrome.storage.local.get('lastTc');

    await refreshTcLibrary(false);
    const availableIds = new Set(tcLibrary.map(x => x.tc));
    if (paramTc && availableIds.has(paramTc)) tc = paramTc;
    else if (stored?.lastTc && availableIds.has(stored.lastTc)) tc = stored.lastTc;
    else if (tcLibrary.length) tc = tcLibrary[0].tc;
    else tc = paramTc || stored?.lastTc || 'TC-SAMPLE';

    tcInput.value = tc;
    await loadSteps();
    renderTcLibrary();
    setupEventListeners();
  }

  async function refreshTcLibrary(render = true) {
    try {
      tcLibrary = (await QA_DB.getLibrarySummaries()).sort((a, b) =>
        (b.updatedAt || b.finishedAt || b.latestStepAt || b.startedAt || b.createdAt || 0) -
        (a.updatedAt || a.finishedAt || a.latestStepAt || a.startedAt || a.createdAt || 0)
      );
    } catch (e) {
      console.error('Failed to load TC library:', e);
      tcLibrary = [];
    }
    if (render) renderTcLibrary();
  }

  function statusLabel(item) {
    if (item.active || item.status === 'active') return 'Active';
    if (item.status === 'paused') return 'Paused';
    if (item.status === 'completed') return 'Completed';
    return 'Draft';
  }

  function renderTcLibrary() {
    if (!tcLibraryList) return;
    tcLibraryCount.textContent = tcLibrary.length;
    const q = tcSearchQuery.trim().toLowerCase();
    const list = tcLibrary.filter(item => !q || item.tc.toLowerCase().includes(q) || (item.lastTitle || '').toLowerCase().includes(q));
    tcLibraryList.innerHTML = '';
    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'tc-library-empty';
      empty.textContent = q ? 'Tidak ada TC yang cocok dengan pencarian.' : 'Belum ada TC. Buat TC dari popup extension.';
      tcLibraryList.appendChild(empty);
      return;
    }
    for (const item of list) {
      const card = document.createElement('div');
      card.className = `tc-review-card ${item.tc === tc ? 'active' : ''}`;
      card.dataset.tc = item.tc;
      const status = statusLabel(item);
      const statusClass = status.toLowerCase();
      const time = item.updatedAt || item.finishedAt || item.latestStepAt || item.startedAt || item.createdAt;
      const timeText = time ? new Date(time).toLocaleString([], { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' }) : '';
      card.innerHTML = `
        <div class="tc-review-card-top">
          <span class="tc-review-id"></span>
          <span class="tc-review-status ${statusClass}">${status}</span>
        </div>
        <div class="tc-review-meta"><span>${item.count || 0} screenshot</span><span class="dot">•</span><span>${timeText}</span></div>
        <div class="tc-review-url"></div>
      `;
      card.querySelector('.tc-review-id').textContent = item.tc;
      card.querySelector('.tc-review-url').textContent = item.lastTitle || item.lastUrl || 'Belum ada halaman web';
      card.title = item.lastUrl || item.tc;
      card.addEventListener('click', () => selectTc(item.tc));
      tcLibraryList.appendChild(card);
    }
  }

  async function selectTc(nextTc) {
    if (!nextTc || nextTc === tc) return;
    await saveCurrentStep();
    tc = nextTc;
    tcInput.value = tc;
    currentIndex = 0;
    selectedShapeId = null;
    evidenceView = 'after';
    const url = new URL(window.location.href);
    url.searchParams.set('tc', tc);
    history.replaceState(null, '', url);
    await chrome.storage.local.set({ lastTc: tc });
    await loadSteps();
    renderTcLibrary();
  }

  async function loadSteps() {
    try {
      steps = await QA_DB.getSteps(tc);
    } catch (e) {
      console.error('Failed to load steps:', e);
      steps = [];
    }

    steps.forEach(normalizeStep);
    if (currentIndex >= steps.length) currentIndex = Math.max(0, steps.length - 1);
    updateSidebar();
    renderActiveStep();
  }

  // =========================================================================
  // SIDEBAR RENDERING
  // =========================================================================
  function updateSidebar() {
    sidebarBadgeCount.textContent = steps.length;
    currentStepNum.textContent = steps.length ? currentIndex + 1 : 0;
    totalStepsNum.textContent = steps.length;

    stepsList.innerHTML = '';

    if (steps.length === 0) {
      emptyState.style.display = 'flex';
      canvasStage.style.display = 'none';
      prevStepBtn.disabled = true;
      nextStepBtn.disabled = true;
      deleteStepBtn.disabled = true;
      downloadCurrentBtn.disabled = true;
      downloadAllBtn.disabled = true;
      downloadZipBtn.disabled = true;
      stepLabelInput.value = '';
      stepLabelInput.disabled = true;
      updateShapeToolbar();
      return;
    }

    emptyState.style.display = 'none';
    canvasStage.style.display = 'inline-block';
    prevStepBtn.disabled = currentIndex === 0;
    nextStepBtn.disabled = currentIndex === steps.length - 1;
    deleteStepBtn.disabled = false;
    downloadCurrentBtn.disabled = false;
    downloadAllBtn.disabled = false;
    downloadZipBtn.disabled = false;
    stepLabelInput.disabled = false;

    steps.forEach((step, idx) => {
      const card = document.createElement('div');
      card.className = `step-card ${idx === currentIndex ? 'active' : ''}`;
      card.dataset.index = idx;

      // Miniature thumbnail
      const thumb = document.createElement('div');
      thumb.className = 'step-thumb-container';

      const img = document.createElement('img');
      img.className = 'step-thumb-img';
      img.loading = 'lazy';img.alt = `Thumbnail step ${idx+1}`;img.dataset.stepId=step.id;thumbObserver.observe(img);
      thumb.appendChild(img);

      // Render miniature overlays on thumbnail
      const imgW = step.imageWidth || 1;
      const imgH = step.imageHeight || 1;
      (step.annotations || []).forEach(ann => {
        const rx = (ann.x / imgW) * 100;
        const ry = (ann.y / imgH) * 100;
        const rw = (ann.w / imgW) * 100;
        const rh = (ann.h / imgH) * 100;

        if (ann.type === 'blur') {
          const blurEl = document.createElement('div');
          blurEl.className = 'step-thumb-blur';
          blurEl.style.cssText = `left:${rx}%;top:${ry}%;width:${rw}%;height:${rh}%;`;
          thumb.appendChild(blurEl);
        } else if (ann.type === 'text') {
          const txtEl = document.createElement('div');
          txtEl.className = 'step-thumb-text';
          txtEl.style.cssText = `left:${rx}%;top:${ry}%;color:${ann.color || '#ff1616'};`;
          txtEl.textContent = ann.text || 'Teks';
          thumb.appendChild(txtEl);
        } else {
          const markEl = document.createElement('div');
          markEl.className = 'step-thumb-mark';
          markEl.style.cssText = `left:${rx}%;top:${ry}%;width:${rw}%;height:${rh}%;border-color:${ann.color || '#ff1616'};`;
          thumb.appendChild(markEl);
        }
      });

      card.appendChild(thumb);

      // Card Details
      const info = document.createElement('div');
      info.className = 'step-card-info';

      const header = document.createElement('div');
      header.className = 'step-card-header';
      header.innerHTML = `
        <span class="step-num-badge">Step ${pad(idx + 1)}</span>
        <div class="step-card-actions">
          <button class="card-action-btn move-up" title="Geser ke atas" ${idx === 0 ? 'disabled' : ''}>▲</button>
          <button class="card-action-btn move-down" title="Geser ke bawah" ${idx === steps.length - 1 ? 'disabled' : ''}>▼</button>
          <button class="card-action-btn delete-btn" title="Hapus step ini">✕</button>
        </div>
      `;
      info.appendChild(header);

      const label = document.createElement('div');
      label.className = 'step-card-label';
      label.textContent = step.label || `Langkah ${idx + 1}`;
      label.title = step.label || `Langkah ${idx + 1}`;
      info.appendChild(label);

      const footer = document.createElement('div');
      footer.className = 'step-card-footer';
      const timeStr = step.createdAt ? new Date(step.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
      const numAnnotations = (step.annotations || []).length;
      footer.innerHTML = `
        <span class="step-time">${timeStr}</span>
        <span class="mark-status-tag ${numAnnotations > 0 ? 'tag-has-mark' : 'tag-no-mark'}">
          ${numAnnotations > 0 ? `${numAnnotations} Shape` : 'Tanpa Shape'}
        </span>
      `;
      info.appendChild(footer);

      card.appendChild(info);

      card.addEventListener('click', (e) => {
        if (e.target.closest('.card-action-btn')) return;
        selectStep(idx);
      });

      card.querySelector('.move-up')?.addEventListener('click', (e) => {
        e.stopPropagation();
        moveStep(idx, -1);
      });

      card.querySelector('.move-down')?.addEventListener('click', (e) => {
        e.stopPropagation();
        moveStep(idx, 1);
      });

      card.querySelector('.delete-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteStep(idx);
      });

      stepsList.appendChild(card);
    });

    const activeCard = stepsList.querySelector('.step-card.active');
    if (activeCard) {
      activeCard.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  function updateActiveCardMetadata(){
    const step=steps[currentIndex],card=stepsList.querySelector(`.step-card[data-index="${currentIndex}"]`);if(!step||!card)return;
    const count=(step.annotations||[]).length,tag=card.querySelector('.mark-status-tag');
    if(tag){tag.classList.toggle('tag-has-mark',count>0);tag.classList.toggle('tag-no-mark',count===0);tag.textContent=count?`${count} Shape`:'Tanpa Shape';}
    const label=card.querySelector('.step-card-label');if(label){label.textContent=step.label||`Langkah ${currentIndex+1}`;label.title=label.textContent;}
  }

  // =========================================================================
  // ACTIVE STEP RENDERING & ANNOTATIONS
  // =========================================================================
  async function renderActiveStep() {
    if (steps.length === 0 || !steps[currentIndex]) return;
    const token=++renderToken,index=currentIndex;
    const step = await ensureStepImages(index);if(token!==renderToken||index!==currentIndex||!step)return;
    stepLabelInput.value = step.label || `Langkah ${currentIndex + 1}`;

    const grouped = step.evidenceMode === 'before-after' && !!stepImage(step,'beforeImage');
    evidenceViewControls.style.display = grouped ? 'flex' : 'none';
    if (!grouped) evidenceView = 'after';
    viewBeforeBtn?.classList.toggle('active', evidenceView === 'before');
    viewAfterBtn?.classList.toggle('active', evidenceView === 'after');

    stageImage.onload = () => {
      if (!step.imageWidth || !step.imageHeight) {
        step.imageWidth = stageImage.naturalWidth;
        step.imageHeight = stageImage.naturalHeight;
      }
      applyZoom();
      renderAnnotations();
    };
    const source=(evidenceView==='before'&&stepImage(step,'beforeImage'))?stepImage(step,'beforeImage'):(stepImage(step,'afterImage')||stepImage(step,'rawImage'));
    stageImage.src = imageUrl(source);
  }

  function getScale() {
    if (!stageImage.naturalWidth) return 1;
    return stageImage.clientWidth / stageImage.naturalWidth;
  }

  function getLabelOffset(ann) {
    return {
      dx: typeof ann.labelDx === 'number' ? ann.labelDx : 0,
      dy: typeof ann.labelDy === 'number' ? ann.labelDy : -28
    };
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function renderAnnotations() {
    const step = steps[currentIndex];
    annotationsContainer.innerHTML = '';
    if (!step) return;
    const renderList = evidenceView === 'before' && step.beforeAnnotations ? step.beforeAnnotations : (step.annotations || []);

    const scale = getScale();

    if (selectedShapeId && !renderList.find(a => a.id === selectedShapeId)) {
      selectedShapeId = null;
    }

    renderList.forEach(ann => {
      const isSelected = ann.id === selectedShapeId;
      const screenX = Math.round(ann.x * scale);
      const screenY = Math.round(ann.y * scale);
      const screenW = Math.round((ann.w || 0) * scale);
      const screenH = Math.round((ann.h || 0) * scale);

      if (ann.type === 'text') {
        const textEl = document.createElement('div');
        textEl.className = `annotation-free-text ${isSelected ? 'selected' : ''}`;
        textEl.dataset.id = ann.id;
        textEl.style.left = `${screenX}px`;
        textEl.style.top = `${screenY}px`;
        textEl.style.color = ann.color || '#ff1616';
        textEl.style.fontSize = `${Math.max(12, Math.round((ann.fontSize || 18) * scale))}px`;
        textEl.textContent = ann.text && ann.text.trim() ? ann.text.trim() : 'Teks';
        textEl.title = 'Drag untuk memindahkan free text';
        textEl.addEventListener('mousedown', (e) => {
          if (toolMode !== 'select' || evidenceView === 'before') return;
          e.stopPropagation();
          selectShape(ann.id);
          isDraggingText = true;
          dragStartX = e.clientX;
          dragStartY = e.clientY;
          initialBox = { x: ann.x, y: ann.y };
          textEl.classList.add('dragging');
        });
        annotationsContainer.appendChild(textEl);
        return;
      }

      const el = document.createElement('div');
      el.className = `annotation-box ${ann.type === 'blur' ? 'type-blur' : 'type-box'} ${isSelected ? 'selected' : ''}`;
      el.dataset.id = ann.id;
      el.style.left = `${screenX}px`;
      el.style.top = `${screenY}px`;
      el.style.width = `${screenW}px`;
      el.style.height = `${screenH}px`;

      if (ann.type === 'box') {
        const color = ann.color || '#ff1616';
        const lw = Math.max(2, Math.round((ann.lineWidth || 3) * scale));
        el.style.borderColor = color;
        el.style.borderWidth = `${lw}px`;

        const fill = document.createElement('div');
        fill.className = 'box-fill';
        el.appendChild(fill);

        if (ann.text && ann.text.trim()) {
          const tag = document.createElement('div');
          const offset = getLabelOffset(ann);
          tag.className = `box-text-tag ${isSelected ? 'selected' : ''}`;
          tag.style.background = color;
          tag.style.left = `${Math.round((ann.x + offset.dx) * scale)}px`;
          tag.style.top = `${Math.round((ann.y + offset.dy) * scale)}px`;
          tag.textContent = ann.text.trim();
          tag.title = 'Drag untuk memindahkan label teks';
          tag.addEventListener('mousedown', (e) => {
            if (toolMode !== 'select' || evidenceView === 'before') return;
            e.stopPropagation();
            selectShape(ann.id);
            isDraggingLabel = true;
            dragStartX = e.clientX;
            dragStartY = e.clientY;
            initialLabel = { ...offset };
            tag.classList.add('dragging');
          });
          annotationsContainer.appendChild(tag);
        }
      } else if (ann.type === 'blur') {
        const blurLabel = document.createElement('div');
        blurLabel.className = 'blur-label';
        blurLabel.textContent = 'Blur';
        el.appendChild(blurLabel);
      }

      if (isSelected && ann.type !== 'text') {
        const handles = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
        handles.forEach(pos => {
          const h = document.createElement('div');
          h.className = `handle handle-${pos}`;
          h.dataset.handle = pos;
          if (ann.type === 'box') {
            h.style.borderColor = ann.color || '#ff1616';
          }
          el.appendChild(h);
        });
      }

      el.addEventListener('mousedown', (e) => {
        if (toolMode !== 'select' || evidenceView === 'before') return;
        e.stopPropagation();
        selectShape(ann.id);

        const handle = e.target.closest('.handle');
        if (handle) {
          isResizing = true;
          activeHandle = handle.dataset.handle;
        } else {
          isDragging = true;
        }

        dragStartX = e.clientX;
        dragStartY = e.clientY;
        initialBox = { ...ann };
      });

      annotationsContainer.appendChild(el);
    });

    updateShapeToolbar();
  }


  function selectShape(id) {
    selectedShapeId = id;
    renderAnnotations();
  }

  function updateShapeToolbar() {
    const step = steps[currentIndex];
    const ann = step?.annotations?.find(a => a.id === selectedShapeId);

    if (!ann) {
      shapePropsGroup.style.display = 'none';
      return;
    }

    shapePropsGroup.style.display = 'flex';

    if (ann.type === 'box') {
      shapeTextContainer.style.display = 'flex';
      shapeColorPicker.style.display = 'flex';
      shapeLineWidthGroup.style.display = 'flex';
      shapeTextInput.placeholder = 'Tulis label kotak...';
      shapeTextInput.value = ann.text || '';
      currentMarkColor = ann.color || '#ff1616';
      currentLineWidth = ann.lineWidth || 3;
      lineWidthSelect.value = String(currentLineWidth);
      colorSwatches.forEach(swatch => swatch.classList.toggle('active', swatch.dataset.color === currentMarkColor));
    } else if (ann.type === 'text') {
      shapeTextContainer.style.display = 'flex';
      shapeColorPicker.style.display = 'flex';
      shapeLineWidthGroup.style.display = 'none';
      shapeTextInput.placeholder = 'Tulis free text...';
      shapeTextInput.value = ann.text || '';
      currentMarkColor = ann.color || '#ff1616';
      colorSwatches.forEach(swatch => swatch.classList.toggle('active', swatch.dataset.color === currentMarkColor));
    } else if (ann.type === 'blur') {
      shapeTextContainer.style.display = 'none';
      shapeColorPicker.style.display = 'none';
      shapeLineWidthGroup.style.display = 'none';
    }
  }

  // =========================================================================
  // ZOOM & SIZING
  // =========================================================================
  function applyZoom() {
    if (!stageImage.naturalWidth) return;

    if (zoomMode === 'fit') {
      const padSpace = 48;
      const availW = viewportContainer.clientWidth - padSpace;
      const availH = viewportContainer.clientHeight - padSpace;
      const scaleW = availW / stageImage.naturalWidth;
      const scaleH = availH / stageImage.naturalHeight;
      const scale = Math.min(1, scaleW, scaleH);

      stageImage.style.width = `${Math.round(stageImage.naturalWidth * scale)}px`;
      stageImage.style.height = `${Math.round(stageImage.naturalHeight * scale)}px`;
      zoomLabel.textContent = `${Math.round(scale * 100)}%`;
    } else if (zoomMode === '100') {
      stageImage.style.width = `${stageImage.naturalWidth}px`;
      stageImage.style.height = `${stageImage.naturalHeight}px`;
      zoomLabel.textContent = '100%';
    } else if (typeof zoomMode === 'number') {
      stageImage.style.width = `${Math.round(stageImage.naturalWidth * zoomMode)}px`;
      stageImage.style.height = `${Math.round(stageImage.naturalHeight * zoomMode)}px`;
      zoomLabel.textContent = `${Math.round(zoomMode * 100)}%`;
    }

    renderAnnotations();
  }

  window.addEventListener('resize', () => {
    if (zoomMode === 'fit') applyZoom();
  });

  // =========================================================================
  // STEP ACTIONS (SELECT, MOVE, DELETE)
  // =========================================================================
  function selectStep(index) {
    if (index < 0 || index >= steps.length) return;
    saveCurrentStep();
    const previous=currentIndex;
    currentIndex = index;
    selectedShapeId = null;
    stepsList.querySelector(`.step-card[data-index="${previous}"]`)?.classList.remove('active');
    const activeCard=stepsList.querySelector(`.step-card[data-index="${currentIndex}"]`);activeCard?.classList.add('active');activeCard?.scrollIntoView({block:'nearest',behavior:'smooth'});
    currentStepNum.textContent=currentIndex+1;prevStepBtn.disabled=currentIndex===0;nextStepBtn.disabled=currentIndex===steps.length-1;
    renderActiveStep();
  }

  async function saveCurrentStep() {
    const step = steps[currentIndex];
    if (!step) return;
    step.label = stepLabelInput.value.trim() || `Langkah ${currentIndex + 1}`;
    await QA_DB.updateStep(step);
  }

  async function moveStep(index, direction) {
    const target = index + direction;
    if (target < 0 || target >= steps.length) return;

    const temp = steps[index];
    steps[index] = steps[target];
    steps[target] = temp;

    steps.forEach((s, i) => {
      s.stepNumber = i + 1;
    });

    const result=await callBg('REORDER_STEPS',{tc,ids:steps.map(s=>s.id)});
    if(!result?.ok){await loadSteps();alert('Gagal mengubah urutan: '+(result?.error||'Unknown error'));return;}

    currentIndex = target;
    updateSidebar();
    renderActiveStep();
    showToast('Urutan langkah diperbarui');
  }

  async function deleteStep(index) {
    const step = steps[index];
    if (!step) return;
    if (!confirm(`Hapus Step ${pad(index + 1)} ("${step.label || 'Langkah'}")?`)) return;

    const result=await callBg('DELETE_STEP',{id:step.id});
    if(!result?.ok){alert('Gagal menghapus: '+(result?.error||'Unknown error'));return;}
    steps.splice(index, 1);

    steps.forEach((s, i) => {
      s.stepNumber = i + 1;
    });
    if (currentIndex >= steps.length) {
      currentIndex = Math.max(0, steps.length - 1);
    }

    updateSidebar();
    renderActiveStep();
    await refreshTcLibrary();
    offerUndo(result.deletedIds,tc,'Langkah dipindahkan ke sampah.');
  }

  function offerUndo(ids,undoTc,message){
    if(!ids?.length)return;
    if(pendingUndo?.timer)clearTimeout(pendingUndo.timer);
    pendingUndo={ids,tc:undoTc};undoMessage.textContent=message;undoBar.hidden=false;
    pendingUndo.timer=setTimeout(()=>{undoBar.hidden=true;pendingUndo=null;},10000);
  }

  async function undoDelete(){
    if(!pendingUndo)return;const item=pendingUndo;clearTimeout(item.timer);pendingUndo=null;undoBar.hidden=true;
    const result=await callBg('UNDO_DELETE',{ids:item.ids,tc:item.tc});
    if(!result?.ok){alert('Undo gagal: '+(result?.error||'Unknown error'));return;}
    if(tc===item.tc)await loadSteps();await refreshTcLibrary();showToast(`${result.restored||0} evidence dipulihkan`);
  }

  // =========================================================================
  // TOOL MODES & EVENT LISTENERS
  // =========================================================================
  function setToolMode(mode) {
    toolMode = mode;
    toolSelectBtn.classList.toggle('active', mode === 'select');
    toolBoxBtn.classList.toggle('active', mode === 'box');
    toolTextBtn.classList.toggle('active', mode === 'text');
    toolBlurBtn.classList.toggle('active', mode === 'blur');
    canvasStage.style.cursor = mode === 'select' ? 'default' : 'crosshair';
  }

  function setupEventListeners() {
    undoDeleteBtn?.addEventListener('click',undoDelete);
    tcSearchInput?.addEventListener('input', () => { tcSearchQuery = tcSearchInput.value; renderTcLibrary(); });
    refreshTcLibraryBtn?.addEventListener('click', async () => { await refreshTcLibrary(); showToast('Daftar TC diperbarui'); });
    toolSelectBtn.addEventListener('click', () => setToolMode('select'));
    toolBoxBtn.addEventListener('click', () => setToolMode('box'));
    toolTextBtn.addEventListener('click', () => setToolMode('text'));
    toolBlurBtn.addEventListener('click', () => setToolMode('blur'));

    // Shape Text Input
    shapeTextInput.addEventListener('input', () => {
      const step = steps[currentIndex];
      const ann = step?.annotations?.find(a => a.id === selectedShapeId);
      if (ann && (ann.type === 'box' || ann.type === 'text')) {
        ann.text = shapeTextInput.value;
        renderAnnotations();
        QA_DB.updateStep(step);
        updateActiveCardMetadata();
      }
    });

    // Delete Shape
    deleteShapeBtn.addEventListener('click', () => {
      const step = steps[currentIndex];
      if (!step || !selectedShapeId) return;
      step.annotations = (step.annotations || []).filter(a => a.id !== selectedShapeId);
      selectedShapeId = step.annotations.length > 0 ? step.annotations[0].id : null;
      renderAnnotations();
      QA_DB.updateStep(step);
      updateActiveCardMetadata();
      showToast('Shape dihapus');
    });

    // Reset to Original Mark
    resetMarkBtn.addEventListener('click', () => {
      const step = steps[currentIndex];
      if (!step || !step.originalMark) {
        showToast('Tidak ada mark deteksi awal');
        return;
      }
      step.annotations = [{
        id: `box_${Date.now()}_orig`,
        type: 'box',
        ...step.originalMark,
        color: currentMarkColor,
        lineWidth: currentLineWidth,
        text: ''
      }];
      selectedShapeId = step.annotations[0].id;
      renderAnnotations();
      QA_DB.updateStep(step);
      updateActiveCardMetadata();
      showToast('Posisi mark dikembalikan ke deteksi awal');
    });

    // Color Swatches
    colorSwatches.forEach(swatch => {
      swatch.addEventListener('click', () => {
        currentMarkColor = swatch.dataset.color;
        colorSwatches.forEach(s => s.classList.toggle('active', s === swatch));
        const step = steps[currentIndex];
        const ann = step?.annotations?.find(a => a.id === selectedShapeId);
        if (ann && (ann.type === 'box' || ann.type === 'text')) {
          ann.color = currentMarkColor;
          renderAnnotations();
          QA_DB.updateStep(step);
          updateActiveCardMetadata();
        }
      });
    });

    // Line Width Select
    lineWidthSelect.addEventListener('change', () => {
      currentLineWidth = parseInt(lineWidthSelect.value, 10) || 3;
      const step = steps[currentIndex];
      const ann = step?.annotations?.find(a => a.id === selectedShapeId);
      if (ann && ann.type === 'box') {
        ann.lineWidth = currentLineWidth;
        renderAnnotations();
        QA_DB.updateStep(step);
      }
    });

    viewBeforeBtn?.addEventListener('click', () => {
      evidenceView = 'before';
      selectedShapeId = null;
      renderActiveStep();
    });
    viewAfterBtn?.addEventListener('click', () => {
      evidenceView = 'after';
      selectedShapeId = null;
      renderActiveStep();
    });

    // Zoom Controls
    zoomFitBtn.addEventListener('click', () => {
      zoomMode = 'fit';
      applyZoom();
    });
    zoom100Btn.addEventListener('click', () => {
      zoomMode = '100';
      applyZoom();
    });
    zoomInBtn.addEventListener('click', () => {
      const currentScale = getScale();
      zoomMode = Math.min(2.5, currentScale + 0.15);
      applyZoom();
    });
    zoomOutBtn.addEventListener('click', () => {
      const currentScale = getScale();
      zoomMode = Math.max(0.2, currentScale - 0.15);
      applyZoom();
    });

    // Step Nav
    prevStepBtn.addEventListener('click', () => selectStep(currentIndex - 1));
    nextStepBtn.addEventListener('click', () => selectStep(currentIndex + 1));
    deleteStepBtn.addEventListener('click', () => deleteStep(currentIndex));

    // Step Label
    stepLabelInput.addEventListener('input', () => {
      const step = steps[currentIndex];
      if (step) {
        step.label = stepLabelInput.value;
        QA_DB.updateStep(step);
        const activeCard = stepsList.querySelector(`.step-card[data-index="${currentIndex}"] .step-card-label`);
        if (activeCard) activeCard.textContent = step.label;
      }
    });

    // TC ID input: rename TC consistently across steps + session record
    tcInput.addEventListener('change', async () => {
      const oldTc = tc;
      const newTc = tcInput.value.trim();
      if (!/^[a-zA-Z0-9_-]{1,60}$/.test(newTc)) {
        alert('TC ID hanya boleh huruf, angka, tanda minus (-), atau underscore (_).');
        tcInput.value = tc;
        return;
      }
      if (newTc === oldTc) return;
      const result=await callBg('RENAME_TC',{oldTc,newTc});
      if(!result?.ok){alert('Gagal mengganti TC ID: '+(result?.error||'Unknown error'));tcInput.value=oldTc;return;}
      for(const step of steps)step.tc=newTc;
      tc = newTc;
      await chrome.storage.local.set({ lastTc:newTc });
      const url = new URL(window.location.href); url.searchParams.set('tc', newTc); history.replaceState(null,'',url);
      await refreshTcLibrary();
      showToast(`TC ID diubah menjadi "${newTc}"`);
    });

    // Clear All
    clearAllBtn.addEventListener('click', async () => {
      if (!confirm(`Hapus semua ${steps.length} screenshot untuk "${tc}"? Kamu dapat Undo selama 10 detik.`)) return;
      const result=await callBg('CLEAR_STEPS',{tc});
      if(!result?.ok){alert('Gagal menghapus: '+(result?.error||'Unknown error'));return;}
      steps = [];
      currentIndex = 0;
      updateSidebar();
      renderActiveStep();
      await refreshTcLibrary();
      offerUndo(result.deletedIds,tc,'Semua evidence dipindahkan ke sampah.');
    });

    // Downloads
    downloadCurrentBtn.addEventListener('click', downloadCurrentStep);
    downloadAllBtn.addEventListener('click', downloadAllSteps);
    downloadZipBtn.addEventListener('click', downloadAsZip);

    // Keyboard Shortcuts
    window.addEventListener('keydown', handleKeyboardShortcuts);

    // MOUSE INTERACTION ON STAGE
    setupStageMouseEvents();
  }

  function setupStageMouseEvents() {
    canvasStage.addEventListener('mousedown', (e) => {
      const step = steps[currentIndex];
      if (!step) return;

      if (toolMode === 'box' || toolMode === 'blur') {
        isDrawing = true;
        const rect = canvasStage.getBoundingClientRect();
        drawStartX = e.clientX - rect.left;
        drawStartY = e.clientY - rect.top;

        drawingDraftBox.style.display = 'block';
        drawingDraftBox.style.left = `${drawStartX}px`;
        drawingDraftBox.style.top = `${drawStartY}px`;
        drawingDraftBox.style.width = '0px';
        drawingDraftBox.style.height = '0px';
        drawingDraftBox.className = `drawing-draft-box ${toolMode === 'blur' ? 'mode-blur' : ''}`;
        if (toolMode === 'box') {
          drawingDraftBox.style.borderColor = currentMarkColor;
        }
      } else if (toolMode === 'text') {
        const rect = canvasStage.getBoundingClientRect();
        const scale = getScale();
        const newId = `text_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        const x = Math.round((e.clientX - rect.left) / scale);
        const y = Math.round((e.clientY - rect.top) / scale);
        if (!Array.isArray(step.annotations)) step.annotations = [];
        step.annotations.push({
          id: newId,
          type: 'text',
          x,
          y,
          color: currentMarkColor,
          fontSize: 18,
          text: 'Teks'
        });
        selectedShapeId = newId;
        QA_DB.updateStep(step);
        renderAnnotations();
        updateActiveCardMetadata();
        setToolMode('select');
        setTimeout(() => { shapeTextInput.focus(); shapeTextInput.select(); }, 50);
        showToast('Free text ditambahkan');
      } else if (toolMode === 'select') {
        // If clicked on stage background (not on an annotation), deselect active shape
        const clickedAnnotation = e.target.closest('.annotation-box, .annotation-free-text, .box-text-tag');
        if (!clickedAnnotation && selectedShapeId !== null) {
          selectedShapeId = null;
          renderAnnotations();
        }
      }
    });

    viewportContainer.addEventListener('mousedown', (e) => {
      if (toolMode === 'select' && (e.target === viewportContainer || !e.target.closest('.annotation-box, .annotation-free-text, .box-text-tag'))) {
        if (selectedShapeId !== null) {
          selectedShapeId = null;
          renderAnnotations();
        }
      }
    });

    window.addEventListener('mousemove', (e) => {
      const step = steps[currentIndex];
      if (!step) return;
      const ann = step.annotations?.find(a => a.id === selectedShapeId);
      const scale = getScale();

      if (isDraggingLabel && ann && ann.type === 'box' && initialLabel) {
        const deltaX_screen = e.clientX - dragStartX;
        const deltaY_screen = e.clientY - dragStartY;
        ann.labelDx = Math.round(initialLabel.dx + (deltaX_screen / scale));
        ann.labelDy = Math.round(initialLabel.dy + (deltaY_screen / scale));
        renderAnnotations();
      } else if (isDraggingText && ann && ann.type === 'text' && initialBox) {
        const deltaX_screen = e.clientX - dragStartX;
        const deltaY_screen = e.clientY - dragStartY;
        const deltaX_img = Math.round(deltaX_screen / scale);
        const deltaY_img = Math.round(deltaY_screen / scale);
        const imgW = step.imageWidth || stageImage.naturalWidth;
        const imgH = step.imageHeight || stageImage.naturalHeight;
        ann.x = clamp(initialBox.x + deltaX_img, 0, imgW - 10);
        ann.y = clamp(initialBox.y + deltaY_img, 0, imgH - 10);
        renderAnnotations();
      } else if (isDragging && initialBox && ann) {
        const deltaX_screen = e.clientX - dragStartX;
        const deltaY_screen = e.clientY - dragStartY;

        const deltaX_img = Math.round(deltaX_screen / scale);
        const deltaY_img = Math.round(deltaY_screen / scale);

        const imgW = step.imageWidth || stageImage.naturalWidth;
        const imgH = step.imageHeight || stageImage.naturalHeight;

        ann.x = Math.max(0, Math.min(imgW - initialBox.w, initialBox.x + deltaX_img));
        ann.y = Math.max(0, Math.min(imgH - initialBox.h, initialBox.y + deltaY_img));

        renderAnnotations();
      } else if (isResizing && initialBox && activeHandle && ann) {
        const deltaX_screen = e.clientX - dragStartX;
        const deltaY_screen = e.clientY - dragStartY;

        const deltaX_img = Math.round(deltaX_screen / scale);
        const deltaY_img = Math.round(deltaY_screen / scale);

        const imgW = step.imageWidth || stageImage.naturalWidth;
        const imgH = step.imageHeight || stageImage.naturalHeight;

        let { x, y, w, h } = initialBox;

        if (activeHandle.includes('e')) {
          w = Math.max(12, Math.min(imgW - x, initialBox.w + deltaX_img));
        }
        if (activeHandle.includes('s')) {
          h = Math.max(12, Math.min(imgH - y, initialBox.h + deltaY_img));
        }
        if (activeHandle.includes('w')) {
          const maxLeftShift = initialBox.x;
          const shift = Math.min(initialBox.w - 12, Math.max(-maxLeftShift, deltaX_img));
          x = initialBox.x + shift;
          w = initialBox.w - shift;
        }
        if (activeHandle.includes('n')) {
          const maxTopShift = initialBox.y;
          const shift = Math.min(initialBox.h - 12, Math.max(-maxTopShift, deltaY_img));
          y = initialBox.y + shift;
          h = initialBox.h - shift;
        }

        ann.x = Math.round(x);
        ann.y = Math.round(y);
        ann.w = Math.round(w);
        ann.h = Math.round(h);

        renderAnnotations();
      } else if (isDrawing) {
        const rect = canvasStage.getBoundingClientRect();
        const curX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
        const curY = Math.max(0, Math.min(rect.height, e.clientY - rect.top));

        const boxX = Math.min(drawStartX, curX);
        const boxY = Math.min(drawStartY, curY);
        const boxW = Math.abs(curX - drawStartX);
        const boxH = Math.abs(curY - drawStartY);

        drawingDraftBox.style.left = `${boxX}px`;
        drawingDraftBox.style.top = `${boxY}px`;
        drawingDraftBox.style.width = `${boxW}px`;
        drawingDraftBox.style.height = `${boxH}px`;
      }
    });

    window.addEventListener('mouseup', () => {
      const step = steps[currentIndex];

      if (isDragging || isResizing || isDraggingLabel || isDraggingText) {
        isDragging = false;
        isResizing = false;
        isDraggingLabel = false;
        isDraggingText = false;
        activeHandle = null;
        initialBox = null;
        initialLabel = null;
        if (step) {
          QA_DB.updateStep(step);
          updateActiveCardMetadata();
        }
      }

      if (isDrawing) {
        isDrawing = false;
        drawingDraftBox.style.display = 'none';

        const scale = getScale();
        const draftLeft = parseFloat(drawingDraftBox.style.left);
        const draftTop = parseFloat(drawingDraftBox.style.top);
        const draftW = parseFloat(drawingDraftBox.style.width);
        const draftH = parseFloat(drawingDraftBox.style.height);

        if (draftW > 10 && draftH > 10 && step) {
          if (!Array.isArray(step.annotations)) step.annotations = [];

          const newId = `${toolMode}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
          let newShape;

          if (toolMode === 'blur') {
            newShape = {
              id: newId,
              type: 'blur',
              x: Math.round(draftLeft / scale),
              y: Math.round(draftTop / scale),
              w: Math.round(draftW / scale),
              h: Math.round(draftH / scale)
            };
            showToast('Area blur / sensor dibuat');
          } else {
            newShape = {
              id: newId,
              type: 'box',
              x: Math.round(draftLeft / scale),
              y: Math.round(draftTop / scale),
              w: Math.round(draftW / scale),
              h: Math.round(draftH / scale),
              color: currentMarkColor,
              lineWidth: currentLineWidth,
              text: '',
              labelDx: 0,
              labelDy: -28
            };
            showToast('Kotak baru berhasil dibuat');
          }

          step.annotations.push(newShape);
          selectedShapeId = newId;

          QA_DB.updateStep(step);
          renderAnnotations();
          updateActiveCardMetadata();
          setToolMode('select');

          // If box created, focus text input so user can quickly type a label
          if (newShape.type === 'box') {
            setTimeout(() => {
              shapeTextInput.focus();
            }, 50);
          }
        }
      }
    });
  }

  function handleKeyboardShortcuts(e) {
    if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;

    const step = steps[currentIndex];
    const ann = step?.annotations?.find(a => a.id === selectedShapeId);

    if (e.key === 'ArrowLeft' && !e.altKey) {
      if (currentIndex > 0) selectStep(currentIndex - 1);
    } else if (e.key === 'ArrowRight' && !e.altKey) {
      if (currentIndex < steps.length - 1) selectStep(currentIndex + 1);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (ann) {
        step.annotations = step.annotations.filter(a => a.id !== ann.id);
        selectedShapeId = step.annotations.length > 0 ? step.annotations[0].id : null;
        renderAnnotations();
        QA_DB.updateStep(step);
        updateActiveCardMetadata();
        showToast('Shape dihapus');
      }
    } else if (e.key === 'v' || e.key === 'V') {
      setToolMode('select');
    } else if (e.key === 'k' || e.key === 'K') {
      setToolMode('box');
    } else if (e.key === 't' || e.key === 'T') {
      setToolMode('text');
    } else if (e.key === 'b' || e.key === 'B') {
      setToolMode('blur');
    }

    // Nudging selected shape position with arrow keys
    if (ann && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key) && (e.altKey || !['ArrowLeft', 'ArrowRight'].includes(e.key))) {
      e.preventDefault();
      const nudge = e.shiftKey ? 10 : 1;
      const imgW = step.imageWidth || stageImage.naturalWidth;
      const imgH = step.imageHeight || stageImage.naturalHeight;
      const annW = ann.type === 'text' ? 10 : (ann.w || 10);
      const annH = ann.type === 'text' ? 10 : (ann.h || 10);

      if (e.key === 'ArrowUp') ann.y = Math.max(0, ann.y - nudge);
      if (e.key === 'ArrowDown') ann.y = Math.min(imgH - annH, ann.y + nudge);
      if (e.key === 'ArrowLeft') ann.x = Math.max(0, ann.x - nudge);
      if (e.key === 'ArrowRight') ann.x = Math.min(imgW - annW, ann.x + nudge);

      renderAnnotations();
      QA_DB.updateStep(step);
      updateActiveCardMetadata();
    }
  }

  // =========================================================================
  // IMAGE EXPORT WITH NATIVE BLUR & TEXT BADGES
  // =========================================================================
  async function loadImage(src) {
    const img = new Image();
    img.src = imageUrl(src);
    await new Promise((resolve,reject) => { img.onload = resolve; img.onerror=()=>reject(new Error('Gambar evidence gagal dimuat.')); });
    return img;
  }

  async function hydrateForExport(step){
    if(step?._images)return step;
    const images=await QA_DB.getStepImages(step.id);
    Object.defineProperty(step,'_images',{value:images,writable:true,configurable:true,enumerable:false});
    return step;
  }

  function drawRoundedRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawAnnotationsOnCanvas(ctx, baseImg, annotations, offsetX = 0, offsetY = 0, scale = 1) {
    const list = annotations || [];

    for (const ann of list) {
      if (ann.type === 'blur') {
        const x = offsetX + ann.x * scale;
        const y = offsetY + ann.y * scale;
        const w = ann.w * scale;
        const h = ann.h * scale;
        if (w <= 0 || h <= 0) continue;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, w, h);
        ctx.clip();
        ctx.filter = 'blur(14px)';
        ctx.drawImage(baseImg, offsetX, offsetY, baseImg.naturalWidth * scale, baseImg.naturalHeight * scale);
        ctx.restore();
        ctx.filter = 'none';
        ctx.fillStyle = 'rgba(255,255,255,0.06)';
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = 'rgba(255,255,255,0.78)';
        ctx.lineWidth = Math.max(1, 1.5 * scale);
        ctx.setLineDash([6 * scale, 4 * scale]);
        ctx.strokeRect(x, y, w, h);
        ctx.setLineDash([]);
      }
    }

    for (const ann of list) {
      if (ann.type === 'box') {
        const x = offsetX + ann.x * scale;
        const y = offsetY + ann.y * scale;
        const w = ann.w * scale;
        const h = ann.h * scale;
        const strokeColor = ann.color || '#ff1616';
        const lw = Math.max(2, (ann.lineWidth || 3) * scale);
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = lw;
        ctx.strokeRect(x, y, w, h);

        if (ann.text && ann.text.trim()) {
          const displayText = ann.text.trim();
          const fontSize = Math.max(13, Math.round(15 * scale));
          ctx.font = `bold ${fontSize}px sans-serif`;
          const textMetrics = ctx.measureText(displayText);
          const padX = Math.round(fontSize * 0.55);
          const padY = Math.round(fontSize * 0.35);
          const badgeW = textMetrics.width + padX * 2;
          const badgeH = fontSize + padY * 2;
          const offset = getLabelOffset(ann);
          const badgeX = offsetX + (ann.x + offset.dx) * scale;
          const badgeY = offsetY + (ann.y + offset.dy) * scale;

          ctx.fillStyle = strokeColor;
          drawRoundedRect(ctx, badgeX, badgeY, badgeW, badgeH, 5);
          ctx.fill();
          ctx.fillStyle = '#ffffff';
          ctx.textBaseline = 'middle';
          ctx.fillText(displayText, badgeX + padX, badgeY + badgeH / 2);
        }
      } else if (ann.type === 'text') {
        const x = offsetX + ann.x * scale;
        const y = offsetY + ann.y * scale;
        const fontSize = Math.max(14, Math.round((ann.fontSize || 18) * scale));
        const text = ann.text && ann.text.trim() ? ann.text.trim() : 'Teks';
        ctx.font = `bold ${fontSize}px sans-serif`;
        const padX = Math.round(fontSize * 0.35);
        const padY = Math.round(fontSize * 0.25);
        const metrics = ctx.measureText(text);
        const w = metrics.width + padX * 2;
        const h = fontSize + padY * 2;
        ctx.fillStyle = ann.color || '#ff1616';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, x + padX, y + h / 2);
      }
    }
  }


  async function renderBeforeAfterBlob(step) {
    await hydrateForExport(step);
    const before = await loadImage(stepImage(step,'beforeImage'));
    const after = await loadImage(stepImage(step,'afterImage') || stepImage(step,'rawImage'));
    const gap = 24;
    const headerH = 42;
    const panelW = Math.max(before.naturalWidth, after.naturalWidth);
    const panelH = Math.max(before.naturalHeight, after.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = panelW * 2 + gap;
    canvas.height = panelH + headerH;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#111827';
    ctx.font = 'bold 20px sans-serif';
    ctx.fillText('BEFORE', 12, 28);
    ctx.fillText('AFTER', panelW + gap + 12, 28);
    ctx.drawImage(before, 0, headerH);
    ctx.drawImage(after, panelW + gap, headerH);
    drawAnnotationsOnCanvas(ctx, before, step.beforeAnnotations || [], 0, headerH, 1);
    drawAnnotationsOnCanvas(ctx, after, step.annotations || [], panelW + gap, headerH, 1);
    return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  }

  async function renderAnnotatedBlob(step) {
    await hydrateForExport(step);
    if (step.evidenceMode === 'before-after' && stepImage(step,'beforeImage')) {
      return renderBeforeAfterBlob(step);
    }
    const img = new Image();
    img.src = imageUrl(stepImage(step,'rawImage') || stepImage(step,'afterImage'));
    await new Promise((resolve,reject) => { img.onload = resolve; img.onerror=()=>reject(new Error('Gambar evidence gagal dimuat.')); });

    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');

    // 1. Draw base clean screenshot
    ctx.drawImage(img, 0, 0);

    const annotations = step.annotations || (step.mark ? [step.mark] : []);
    drawAnnotationsOnCanvas(ctx, img, annotations, 0, 0, 1);

    return new Promise(resolve => {
      canvas.toBlob(blob => resolve(blob), 'image/png');
    });
  }

  async function renderAnnotatedDataUrl(step) {
    const blob = await renderAnnotatedBlob(step);
    return new Promise(resolve => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    });
  }

  // =========================================================================
  // DOWNLOAD FUNCTIONS
  // =========================================================================
  async function downloadCurrentStep() {
    const step = steps[currentIndex];
    if (!step) return;

    try {
      showToast('Menyiapkan file gambar...');
      const dataUrl = await renderAnnotatedDataUrl(step);
      const filename = `QA-Evidence/${safeName(tc)}/${safeName(tc)}_Step-${pad(currentIndex + 1)}.png`;

      await chrome.downloads.download({
        url: dataUrl,
        filename,
        saveAs: false,
        conflictAction: 'uniquify'
      });
      showToast(`✓ Unduh Step ${pad(currentIndex + 1)} berhasil!`);
    } catch (e) {
      alert('Gagal mengunduh: ' + e.message);
    }
  }

  async function downloadAllSteps() {
    if (steps.length === 0) return;

    progressModal.style.display = 'flex';
    modalTitle.textContent = 'Mengunduh Semua Screenshot PNG';
    progressBar.style.width = '0%';
    progressMessage.textContent = `Menyiapkan 1 dari ${steps.length} file...`;

    try {
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        progressMessage.textContent = `Memproses & mengunduh Step ${pad(i + 1)} dari ${steps.length}...`;
        progressBar.style.width = `${Math.round(((i + 1) / steps.length) * 100)}%`;

        const dataUrl = await renderAnnotatedDataUrl(step);
        const filename = `QA-Evidence/${safeName(tc)}/${safeName(tc)}_Step-${pad(i + 1)}.png`;

        await chrome.downloads.download({
          url: dataUrl,
          filename,
          saveAs: false,
          conflictAction: 'uniquify'
        });

        await new Promise(r => setTimeout(r, 220));
      }

      progressMessage.textContent = `✓ Selesai! Semua ${steps.length} file berhasil tersimpan di Downloads/QA-Evidence/${safeName(tc)}/`;
      setTimeout(() => {
        progressModal.style.display = 'none';
        showToast(`✓ Berhasil mengunduh semua screenshot (${steps.length} file)`);
      }, 1400);
    } catch (e) {
      progressModal.style.display = 'none';
      alert('Kesalahan saat mengunduh batch: ' + e.message);
    }
  }

  async function downloadAsZip() {
    if (steps.length === 0) return;

    progressModal.style.display = 'flex';
    modalTitle.textContent = 'Membuat Paket ZIP Evidence';
    progressBar.style.width = '0%';
    progressMessage.textContent = 'Menyiapkan arsip ZIP...';

    try {
      const zip = new SimpleZip();

      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        progressBar.style.width = `${Math.round(((i + 1) / steps.length) * 85)}%`;
        progressMessage.textContent = `Mengemas Step ${pad(i + 1)} dari ${steps.length}...`;

        const blob = await renderAnnotatedBlob(step);
        const arrayBuffer = await blob.arrayBuffer();
        const filePath = `QA-Evidence/${safeName(tc)}/${safeName(tc)}_Step-${pad(i + 1)}.png`;

        zip.addFile(filePath, new Uint8Array(arrayBuffer));
      }

      progressMessage.textContent = 'Menghasilkan file ZIP...';
      progressBar.style.width = '95%';

      const zipBytes = zip.generate();
      const zipBlob = new Blob([zipBytes], { type: 'application/zip' });
      const zipUrl = URL.createObjectURL(zipBlob);

      progressBar.style.width = '100%';
      progressMessage.textContent = 'Mengunduh file ZIP...';

      const zipFilename = `QA-Evidence_${safeName(tc)}.zip`;
      await chrome.downloads.download({
        url: zipUrl,
        filename: zipFilename,
        saveAs: false,
        conflictAction: 'uniquify'
      });

      setTimeout(() => {
        progressModal.style.display = 'none';
        URL.revokeObjectURL(zipUrl);
        showToast(`✓ File ZIP "${zipFilename}" berhasil diunduh!`);
      }, 1000);
    } catch (e) {
      progressModal.style.display = 'none';
      alert('Gagal membuat ZIP: ' + e.message);
    }
  }

  init();
})();
