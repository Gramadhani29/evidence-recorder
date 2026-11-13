(() => {
  if (window.__qaCheckpointRecorderInstalled) return;
  window.__qaCheckpointRecorderInstalled = true;

  let enabled = false;
  let seq = 0;
  let currentAction = null;
  let dirtyGroup = null;
  let activeFieldSession = null; // Hybrid click validation: before/after field state
  let firstFieldGroupCaptured = new WeakSet();
  let lastCheckpointKey = '';
  let lastCheckpointAt = 0;
  let masks = [];
  let mutationTimer = null;
  let resultCandidates = new Set();
  let baselineVisible = new WeakSet();
  const FRAME_CHANNEL = '__qa_evidence_recorder_frame_v2__';

  const FIELD = 'input:not([type="button"]):not([type="submit"]):not([type="reset"]),textarea,select,[contenteditable="true"],[contenteditable=""]';
  const ACTIONABLE = 'button,a,[role="button"],[role="menuitem"],[role="tab"],[role="checkbox"],[role="radio"],[role="switch"],summary,[aria-expanded],[aria-controls],input[type="submit"],input[type="button"],input[type="checkbox"],input[type="radio"]';
  const RESULT = '[role="menu"],[role="listbox"],[role="alert"],[role="alertdialog"],[role="dialog"],[aria-modal="true"],dialog,.dropdown-menu,.popover,.menu,.toast,.snackbar,.alert,.notification,[role="tabpanel"],table,[role="grid"],.results,.search-result,.result-list,.site-navigation__dropdown-slot,.site-navigation__dropdown';
  const IGNORE = '[data-qa-recorder-mask],script,style,link,meta,noscript';

  function visible(el) {
    if (!(el instanceof Element) || el.matches(IGNORE)) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity || 1) > 0.03;
  }

  function rectOf(el) {
    if (!visible(el)) return null;
    const r = el.getBoundingClientRect();
    return {
      x: Math.max(0, r.left),
      y: Math.max(0, r.top),
      w: Math.max(0, Math.min(innerWidth, r.right) - Math.max(0, r.left)),
      h: Math.max(0, Math.min(innerHeight, r.bottom) - Math.max(0, r.top)),
      viewportW: innerWidth,
      viewportH: innerHeight,
      dpr: devicePixelRatio
    };
  }

  function cleanText(v, max = 70) {
    let t = String(v || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (t.length > max) t = t.slice(0, max - 3) + '...';
    return t;
  }

  function labelOf(el) {
    if (!(el instanceof Element)) return 'Elemen';
    const text = cleanText(el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || el.innerText || el.getAttribute('name') || el.id || '');
    return text ? `${el.tagName.toUpperCase()}: "${text}"` : el.tagName.toUpperCase();
  }

  function fieldVisualTarget(el) {
    if (!(el instanceof Element)) return el;
    // OSS fields are native inputs inside a styled wrapper DIV. Evidence should
    // outline the visual control the tester sees, not only the transparent input.
    let node = el.parentElement;
    for (let i = 0; node && i < 4; node = node.parentElement, i++) {
      const r = node.getBoundingClientRect();
      const cs = getComputedStyle(node);
      const looksLikeControl = r.width >= el.getBoundingClientRect().width &&
        r.height >= 32 && r.height <= 90 &&
        (cs.borderStyle !== 'none' || cs.borderRadius !== '0px' || cs.backgroundColor !== 'rgba(0, 0, 0, 0)');
      if (looksLikeControl) return node;
    }
    return el;
  }

  function groupOfField(el) {
    const explicit = el.closest('form,[role="form"],[role="dialog"],[aria-modal="true"],dialog,.modal,.dialog');
    if (explicit) return explicit;

    // OSS login does not necessarily use a <form>. Walk upward and find the
    // nearest logical block containing multiple editable fields plus an action.
    let node = el.parentElement;
    let fallback = el.parentElement;
    for (let i = 0; node && i < 8; node = node.parentElement, i++) {
      const fields = [...node.querySelectorAll(FIELD)].filter(visible);
      const hasAction = !!node.querySelector('button,input[type="submit"],[role="button"],.altcha-main');
      if (fields.length >= 2 && hasAction) return node;
      if (fields.length >= 2) fallback = node;
    }
    return fallback;
  }

  function visibleFields(group) {
    if (!(group instanceof Element)) return [];
    return [...group.querySelectorAll(FIELD)]
      .filter(el => visible(el) && !el.matches('input[type="hidden"]'))
      .slice(0, 6);
  }

  function evidenceTarget(el) {
    if (!(el instanceof Element)) return el;
    // ALTCHA uses a hidden/native checkbox plus a custom visual switch.
    const altcha = el.closest('.altcha-switch,.altcha-checkbox-wrap,.altcha-main');
    if (altcha) {
      const switchEl = altcha.matches('.altcha-switch') ? altcha : altcha.querySelector('.altcha-switch');
      if (switchEl && visible(switchEl)) return switchEl;
    }
    if (el.matches(FIELD)) return fieldVisualTarget(el);
    return el;
  }

  function primaryButtons(group) {
    if (!(group instanceof Element)) return [];
    const all = [...group.querySelectorAll('button,input[type="submit"],[role="button"]')].filter(visible);
    const scored = all.map(el => {
      const txt = cleanText(el.innerText || el.value || el.getAttribute('aria-label') || '', 50).toLowerCase();
      let s = 0;
      if (/masuk|login|submit|simpan|lanjut|next|cari|search|verifikasi|verify|konfirmasi|confirm|kirim|send|buat|proses|setuju|yes|ok/.test(txt)) s += 50;
      if (el.matches('input[type="submit"]')) s += 30;
      const r = el.getBoundingClientRect();
      s += Math.min(20, (r.width * r.height) / 6000);
      return { el, s };
    }).sort((a,b) => b.s - a.s);
    return scored.map(x => x.el).slice(0, 2);
  }

  function dedupeRects(rects) {
    const out = [];
    for (const r of rects.filter(Boolean)) {
      if (!out.some(x => Math.abs(x.x-r.x)<3 && Math.abs(x.y-r.y)<3 && Math.abs(x.w-r.w)<3 && Math.abs(x.h-r.h)<3)) out.push(r);
    }
    return out;
  }

  function showRecorderNotice(message, isError = false) {
    if (window !== window.top) return;
    let el = document.getElementById('__qa_recorder_notice');
    if (!el) {
      el = document.createElement('div'); el.id = '__qa_recorder_notice';
      Object.assign(el.style,{position:'fixed',right:'16px',bottom:'16px',zIndex:'2147483647',padding:'10px 14px',borderRadius:'8px',font:'13px system-ui',boxShadow:'0 4px 18px #0005',color:'#fff',pointerEvents:'none'});
      document.documentElement.appendChild(el);
    }
    el.style.background=isError?'#b91c1c':'#0369a1';el.textContent=message;el.style.display='block';
    clearTimeout(el._timer);el._timer=setTimeout(()=>{el.style.display='none';},3500);
  }

  function sendPayloadToBackground(payload) {
    chrome.runtime.sendMessage(payload, response => {
      const error=chrome.runtime.lastError?.message;
      if(error||!response?.ok)showRecorderNotice(`Evidence gagal: ${error||response?.error||'kesalahan tidak dikenal'}`,true);
    });
  }

  function relayCheckpoint(payload) {
    if (window === window.top) sendPayloadToBackground(payload);
    else window.parent.postMessage({channel:FRAME_CHANNEL,payload}, '*');
  }

  addEventListener('message', event => {
    if (!enabled || event.data?.channel !== FRAME_CHANNEL || !event.data.payload) return;
    const frame=[...document.querySelectorAll('iframe,frame')].find(item=>item.contentWindow===event.source);
    if(!frame)return;
    const frameRect=frame.getBoundingClientRect(),payload=event.data.payload;
    const sourceW=payload.sourceViewportW||frame.clientWidth||frameRect.width,sourceH=payload.sourceViewportH||frame.clientHeight||frameRect.height;
    const scaleX=frameRect.width/sourceW,scaleY=frameRect.height/sourceH;
    payload.rects=(payload.rects||[]).map(rect=>({...rect,x:frameRect.left+rect.x*scaleX,y:frameRect.top+rect.y*scaleY,w:rect.w*scaleX,h:rect.h*scaleY,viewportW:innerWidth,viewportH:innerHeight}));
    payload.sourceViewportW=innerWidth;payload.sourceViewportH=innerHeight;
    relayCheckpoint(payload);
  });

  function sendCheckpoint(kind, label, elements, opts = {}) {
    if (!enabled) return;
    const rects = dedupeRects((elements || []).map(evidenceTarget).map(rectOf));
    const key = `${kind}|${label}|${rects.map(r => `${Math.round(r.x)}:${Math.round(r.y)}:${Math.round(r.w)}:${Math.round(r.h)}`).join(',')}`;
    const now = Date.now();
    if (key === lastCheckpointKey && now - lastCheckpointAt < 1500) return;
    lastCheckpointKey = key;
    lastCheckpointAt = now;
    relayCheckpoint({
      type: 'CHECKPOINT_READY',
      checkpointId: `cp_${Date.now()}_${++seq}`,
      checkpointKind: kind,
      label,
      rects,
      pageUrl: location.href,
      waitMs: opts.waitMs ?? 40,
      interactionId: opts.interactionId || '',
      phase: opts.phase || 'checkpoint',
      sourceViewportW: innerWidth,
      sourceViewportH: innerHeight
    });
  }

  function captureInitialFormState(field) {
    const group = groupOfField(field);
    if (!group || firstFieldGroupCaptured.has(group)) return;
    firstFieldGroupCaptured.add(group);
    const fields = visibleFields(group);
    // Initial checkpoint = one screenshot for all fields in this logical form block.
    sendCheckpoint('form-before', 'Form — sebelum data diisi', fields.length ? fields : [field], { waitMs: 60 });
  }

  function fieldName(field) {
    if (!(field instanceof Element)) return 'Field';
    return cleanText(
      field.getAttribute('aria-label') ||
      field.getAttribute('placeholder') ||
      field.getAttribute('name') ||
      field.id ||
      field.closest('label')?.innerText ||
      'Field', 48
    );
  }

  function fieldValue(field) {
    if (!(field instanceof Element)) return '';
    if ('value' in field) return String(field.value ?? '');
    return String(field.textContent ?? '');
  }

  function sameField(a, b) {
    return a instanceof Element && b instanceof Element && a === b;
  }

  function startFieldSession(field) {
    if (!(field instanceof Element)) return;
    activeFieldSession = {
      field,
      visual: evidenceTarget(field),
      initialValue: fieldValue(field),
      lastValue: fieldValue(field),
      dirty: false,
      startedAt: Date.now()
    };
  }

  // Called on the NEXT pointerdown. This is the reliable signal that the tester
  // has finished editing the previous field. One screenshot can therefore show
  // the previous field AFTER entry and the next clicked target BEFORE its action.
  function finishFieldIntoNextTarget(nextTarget, interactionId = '') {
    const s = activeFieldSession;
    if (!s || !(s.field instanceof Element)) return false;
    const current = fieldValue(s.field);
    const changed = s.dirty || current !== s.initialValue;
    if (!changed) {
      activeFieldSession = null;
      return false;
    }

    const next = nextTarget instanceof Element ? nextTarget : null;
    const elems = [s.field];
    if (next && !sameField(s.field, next)) elems.push(next);
    const prevName = fieldName(s.field);
    const nextName = next ? (next.matches(FIELD) ? fieldName(next) : cleanText(next.innerText || next.getAttribute('aria-label') || next.getAttribute('title') || next.tagName, 48)) : '';
    const label = nextName
      ? `After — ${prevName}; lanjut ke ${nextName}`
      : `After — ${prevName}`;
    sendCheckpoint('click-field-after', label, elems, { waitMs: 0, interactionId, phase:'action' });
    activeFieldSession = null;
    return true;
  }

  function immediateClickCheckpoint(target, opts = {}) {
    if (!(target instanceof Element)) return;
    const txt = cleanText(target.innerText || target.getAttribute('aria-label') || target.getAttribute('title') || target.getAttribute('placeholder') || target.getAttribute('name') || '', 60);
    sendCheckpoint('click-validation', txt ? `Click — ${txt}` : `Click — ${labelOf(target)}`, [target], { ...opts, waitMs: opts.waitMs ?? 0, phase:opts.phase||'action' });
  }

  function genericContentTarget(ev) {
    const path = typeof ev.composedPath === 'function' ? ev.composedPath() : [];
    const els = path.filter(x => x instanceof Element);
    for (const el of els.slice(0, 8)) {
      if (!visible(el) || el === document.body || el === document.documentElement) continue;
      if (el.matches('svg,path,use')) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 12 || r.height < 12) continue;
      if (r.width > innerWidth * 0.9 || r.height > innerHeight * 0.75) continue;
      const txt = cleanText(el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '', 80);
      const hasVisualContent = txt || el.matches('img,[data-testid],[class]');
      if (hasVisualContent) return el;
    }
    return null;
  }

  function markDirty(field) {
    const group = groupOfField(field);
    if (!group) return;
    if (!dirtyGroup || dirtyGroup.group !== group) dirtyGroup = { group, fields: new Set(), changedAt: Date.now() };
    dirtyGroup.fields.add(field);
    dirtyGroup.changedAt = Date.now();
    if (activeFieldSession && sameField(activeFieldSession.field, field)) {
      activeFieldSession.dirty = true;
      activeFieldSession.lastValue = fieldValue(field);
    }
  }

  function hasReactClick(el) {
    // React stores current props on DOM nodes using an internal __reactProps$*
    // key. This is intentionally only a fallback for project-specific custom
    // cards that have onClick but no semantic button/role/tabindex.
    try {
      for (const key of Object.keys(el)) {
        if (!key.startsWith('__reactProps$')) continue;
        const props = el[key];
        if (props && (typeof props.onClick === 'function' || typeof props.onPointerDown === 'function' || typeof props.onMouseDown === 'function')) return true;
      }
    } catch {}
    return false;
  }

  function pointerBoundaryTarget(ev) {
    const path = typeof ev.composedPath === 'function' ? ev.composedPath() : [];
    const els = path.filter(x => x instanceof Element);

    // Best signal first: the exact DOM node where React registered the click.
    for (const el of els.slice(0, 12)) {
      if (!visible(el) || el === document.documentElement || el === document.body) continue;
      if (!hasReactClick(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= innerWidth * 0.92 && r.height <= innerHeight * 0.85) return el;
    }

    // Generic fallback for accessible/CSS-clickable containers. Cursor is
    // inherited, so prefer the outermost contiguous pointer boundary.
    let best = null;
    for (const el of els.slice(0, 10)) {
      if (!visible(el) || el === document.documentElement || el === document.body) continue;
      const cs = getComputedStyle(el);
      const tabindex = el.getAttribute('tabindex');
      const clickableHint = cs.cursor === 'pointer' || (tabindex !== null && Number(tabindex) >= 0);
      if (!clickableHint) {
        if (best) break;
        continue;
      }
      const r = el.getBoundingClientRect();
      if (r.width > innerWidth * 0.92 || r.height > innerHeight * 0.85) continue;
      best = el;
    }
    return best;
  }

  function actionTarget(target, ev = null) {
    if (!(target instanceof Element)) return null;
    // ALTCHA clicks frequently land on label/toggle DIV rather than the native checkbox.
    const altchaWrap = target.closest('.altcha-checkbox-wrap');
    if (altchaWrap) {
      return altchaWrap.querySelector('input[type="checkbox"]') || altchaWrap.querySelector('.altcha-switch') || altchaWrap;
    }
    const semantic = target.closest(ACTIONABLE);
    if (semantic) return semantic;
    return ev ? pointerBoundaryTarget(ev) : null;
  }

  function isGenericNavigation(el) {
    if (!(el instanceof Element)) return false;
    // Real links are valid tester actions even inside header/nav. They must be
    // captured before full/cross-origin navigation unloads the current page.
    if (el.matches('a[href]')) return false;
    // A submenu item is also a real evidence action.
    if (el.closest('.site-navigation__dropdown,[role="menu"],[role="listbox"]')) return false;
    const txt = cleanText(el.innerText || el.getAttribute('aria-label') || '', 40).toLowerCase();
    const nav = !!el.closest('nav,[role="navigation"],header');
    return nav && !/login|masuk|submit|simpan|cari|search|verifikasi|verify|lanjut|next|daftar|register|kembali|back/.test(txt);
  }

  function preActionCheckpoint(action, interactionId = '') {
    if (!(action instanceof Element)) return;
    let txt = cleanText(action.innerText || action.value || action.getAttribute('aria-label') || action.getAttribute('title') || '', 60);
    if (!txt && action.matches('input[type="checkbox"]')) {
      const lab = action.id ? document.querySelector(`label[for="${CSS.escape(action.id)}"]`) : null;
      txt = cleanText(lab?.innerText || action.closest('.altcha-checkbox-wrap')?.innerText || '', 60);
    }
    const role = action.getAttribute('role') || '';
    const specialControl = ['checkbox','switch','radio'].includes(role) || action.matches('input[type="checkbox"],input[type="radio"]');
    const group = action.closest('form,[role="form"],[role="dialog"],[aria-modal="true"],dialog,.modal,.dialog');

    // Top-level navbar dropdown trigger is captured AFTER React opens the menu,
    // but the red box remains on the trigger itself (Panduan / Informasi).
    if (action.matches('.site-navigation__link--button[aria-controls],[aria-haspopup="menu"][aria-controls]')) return;
    if (isGenericNavigation(action)) return;

    let elements = [action];
    const isSubmenuItem = !!action.closest('.site-navigation__dropdown,[role="menu"],[role="listbox"]');
    let label = isSubmenuItem
      ? (txt ? `Action — pilih ${txt}` : `Action — pilih ${labelOf(action)}`)
      : (txt ? `Checkpoint — ${txt}` : `Checkpoint — ${labelOf(action)}`);

    // If the action follows data entry, show the next action against the completed form state.
    if (dirtyGroup && group && dirtyGroup.group === group) {
      const dialogLike = !!group.matches('[role="dialog"],[aria-modal="true"],dialog,.modal,.dialog');
      if (dialogLike) {
        // In popup/modal evidence, include the edited field(s) + primary action like the user's manual evidence.
        elements = [...dirtyGroup.fields].filter(visible).slice(-2).concat([action]);
      } else {
        // Main form checkpoint should emphasize the next required action (captcha/login/etc.), not every field again.
        elements = [action];
      }
      dirtyGroup = null;
    } else if (specialControl) {
      elements = [action];
    }

    sendCheckpoint('pre-action', label, elements, { waitMs: 0, interactionId, phase:'action' });
  }

  function snapshotBaseline() {
    baselineVisible = new WeakSet();
    for (const el of document.querySelectorAll(RESULT)) if (visible(el)) baselineVisible.add(el);
  }

  function beginAction(action, interactionId = '') {
    if (!enabled || !(action instanceof Element)) return;
    currentAction = {
      id: `act_${Date.now()}_${++seq}`,
      el: action,
      label: labelOf(action),
      href: location.href,
      startedAt: Date.now(),
      interactionId
    };
    resultCandidates.clear();
    snapshotBaseline();
  }

  function controlledResultFor(trigger) {
    if (!(trigger instanceof Element)) return null;
    const expanded = trigger.getAttribute('aria-expanded');
    const controls = trigger.getAttribute('aria-controls');
    if (expanded !== 'true' || !controls) return null;
    const slot = document.getElementById(controls);
    if (!slot) return null;
    const inner = slot.querySelector('[role="menu"],[role="listbox"],.site-navigation__dropdown,.dropdown-menu,.menu,.popover');
    return (inner && visible(inner)) ? inner : (visible(slot) ? slot : null);
  }

  function watchControlledPopup(trigger) {
    if (!(trigger instanceof Element) || !trigger.hasAttribute('aria-controls')) return;
    const actionId = currentAction?.id;
    const started = performance.now();
    let lastRect = null;
    let stableFrames = 0;

    const tick = () => {
      if (!enabled || !currentAction || currentAction.id !== actionId) return;
      if (performance.now() - started > 1400) return;

      const controlled = controlledResultFor(trigger);
      if (controlled) {
        const r = controlled.getBoundingClientRect();
        const nowRect = [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join(':');
        if (nowRect === lastRect) stableFrames += 1;
        else { lastRect = nowRect; stableFrames = 0; }

        if (stableFrames >= 2) {
          const triggerText = cleanText(trigger.innerText || trigger.getAttribute('aria-label') || '', 50);
          // Evidence shows the resulting open dropdown, but the red box marks
          // the exact action performed by the tester, matching the manual QA flow.
          sendCheckpoint(
            'action-dropdown-open',
            triggerText ? `Action — buka ${triggerText}` : 'Action — buka dropdown/menu',
            [trigger],
            { waitMs: 40, interactionId:currentAction.interactionId, phase:'result' }
          );
          currentAction = null;
          resultCandidates.clear();
          return;
        }
      }

      setTimeout(() => requestAnimationFrame(tick), 45);
    };

    requestAnimationFrame(tick);
  }

  function candidateKind(el) {
    if (el.matches('[role="menu"],[role="listbox"],.dropdown-menu,.popover,.menu,.site-navigation__dropdown,.site-navigation__dropdown-slot')) return 'dropdown';
    if (el.matches('[role="alert"],.toast,.snackbar,.alert,.notification')) return 'message';
    if (el.matches('[role="dialog"],[aria-modal="true"],dialog,.modal,.dialog')) return 'dialog';
    if (el.matches('[role="tabpanel"]')) return 'tab-result';
    if (el.matches('table,[role="grid"],.results,.search-result,.result-list')) return 'data-result';
    return 'result';
  }

  function meaningfulNewResult(el) {
    if (!(el instanceof Element) || !visible(el) || baselineVisible.has(el)) return false;
    const cls = String(el.className || '');
    if (/spinner|loading|skeleton|ripple|wave|tooltip/i.test(cls)) return false;
    const kind = candidateKind(el);
    if (kind === 'dialog') {
      // Input/dialog workflows are captured when their fields/action reach a meaningful checkpoint.
      // Informational dialogs without editable fields can be captured immediately.
      if (visibleFields(el).length > 0) return false;
    }
    return true;
  }

  function flushResults() {
    mutationTimer = null;
    if (!enabled || !currentAction) return;
    const candidates = [...resultCandidates].filter(meaningfulNewResult);
    if (!candidates.length) return;

    const priority = { dropdown: 100, message: 90, 'data-result': 80, 'tab-result': 75, dialog: 70, result: 30 };
    candidates.sort((a,b) => (priority[candidateKind(b)]||0) - (priority[candidateKind(a)]||0));
    const best = candidates[0];
    const kind = candidateKind(best);
    // Controlled navbar/menu openings are handled by watchControlledPopup(),
    // which highlights the trigger instead of the entire dropdown container.
    if (kind === 'dropdown' && currentAction?.el?.hasAttribute('aria-controls')) return;
    let elements = [best];
    let label = `Result — ${kind}`;

    if (kind === 'message') label = 'Result — pesan/notifikasi';
    if (kind === 'dropdown') label = 'Result — dropdown/menu ditampilkan';
    if (kind === 'data-result') label = 'Result — data/hasil diperbarui';
    if (kind === 'tab-result') label = 'Result — konten tab ditampilkan';

    sendCheckpoint(`result-${kind}`, label, elements, { waitMs: 140, interactionId:currentAction.interactionId, phase:'result' });
    currentAction = null;
    resultCandidates.clear();
  }

  const observer = new MutationObserver(mutations => {
    if (!enabled || !currentAction) return;
    let useful = false;
    for (const m of mutations) {
      if (m.type === 'childList') {
        for (const node of m.addedNodes) {
          if (!(node instanceof Element) || node.matches(IGNORE) || node.closest('[data-qa-recorder-mask]')) continue;
          if (node.matches?.(RESULT)) { resultCandidates.add(node); useful = true; }
          for (const el of node.querySelectorAll?.(RESULT) || []) { resultCandidates.add(el); useful = true; }
        }
        // Table/list replacement may mutate children without adding the table itself.
        const parent = m.target instanceof Element ? m.target.closest('table,[role="grid"],.results,.search-result,.result-list,[role="tabpanel"]') : null;
        if (parent) { resultCandidates.add(parent); useful = true; }
      } else if (m.type === 'attributes') {
        const el = m.target instanceof Element ? m.target : null;
        if (!el) continue;

        // ARIA-controlled popup/dropdown. OSS navbar keeps the dropdown in the DOM
        // and only flips aria-expanded / parent open class, so no node is added.
        if (m.attributeName === 'aria-expanded' && el.getAttribute('aria-expanded') === 'true') {
          const controlled = controlledResultFor(el);
          if (controlled) { resultCandidates.add(controlled); useful = true; }
        }

        // OSS custom navbar also toggles site-navigation__item--open on the parent.
        if (m.attributeName === 'class' && el.matches('.site-navigation__item--dropdown.site-navigation__item--open')) {
          const trigger = el.querySelector('[aria-expanded="true"][aria-controls]');
          const controlled = controlledResultFor(trigger);
          if (controlled) { resultCandidates.add(controlled); useful = true; }
        }

        if (el.matches(RESULT) || el.closest(RESULT)) {
          resultCandidates.add(el.matches(RESULT) ? el : el.closest(RESULT));
          useful = true;
        }
      } else if (m.type === 'characterData') {
        const el = m.target.parentElement?.closest('table,[role="grid"],.results,.search-result,.result-list,[role="alert"],.toast,.snackbar,.notification');
        if (el) { resultCandidates.add(el); useful = true; }
      }
    }
    if (useful) {
      clearTimeout(mutationTimer);
      mutationTimer = setTimeout(flushResults, 320);
    }
  });

  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class','style','hidden','open','aria-hidden','aria-expanded','aria-selected','disabled','aria-disabled'],
    characterData: true
  });

  document.addEventListener('focusin', e => {
    if (!enabled || !(e.target instanceof Element) || !e.target.matches(FIELD)) return;
    // Keyboard/programmatic focus fallback. Pointer users are handled in pointerdown.
    if (!activeFieldSession || !sameField(activeFieldSession.field, e.target)) {
      immediateClickCheckpoint(evidenceTarget(e.target));
      startFieldSession(e.target);
    }
  }, true);

  document.addEventListener('input', e => {
    if (!enabled || !(e.target instanceof Element) || !e.target.matches(FIELD)) return;
    markDirty(e.target);
  }, true);

  document.addEventListener('change', e => {
    if (!enabled || !(e.target instanceof Element) || !e.target.matches(FIELD)) return;
    markDirty(e.target);
  }, true);

  document.addEventListener('pointerdown', e => {
    if (!enabled || !e.isTrusted || !(e.target instanceof Element)) return;

    // 1) Resolve the exact field/action/content the mouse is pointing at.
    const field = e.target.closest(FIELD);
    const action = field ? null : actionTarget(e.target, e);
    const fallbackContent = (!field && !action) ? genericContentTarget(e) : null;
    const clicked = field || action || fallbackContent;
    if (!clicked) return;
    const interactionId=`int_${Date.now()}_${++seq}`;

    // 2) Field workflow: moving to another target is the AFTER signal for the
    // previous field and the BEFORE signal for the new target in one screenshot.
    if (field) {
      if (activeFieldSession && !sameField(activeFieldSession.field, field)) {
        const merged = finishFieldIntoNextTarget(field,interactionId);
        // The merged screenshot already boxes the next field, so do not create a
        // second identical "before" screenshot for it.
        startFieldSession(field);
        if (!merged) immediateClickCheckpoint(evidenceTarget(field),{interactionId});
      } else if (!activeFieldSession) {
        immediateClickCheckpoint(evidenceTarget(field),{interactionId});
        startFieldSession(field);
      }
      captureInitialFormState(field); // grouped form safety net / metadata flow
      return;
    }

    // 3) If we are leaving an edited field for a button/card/link, combine the
    // completed field + the clicked action into one evidence screenshot.
    const mergedFieldAfter = finishFieldIntoNextTarget(clicked,interactionId);

    // 4) Click validation is the mandatory safety net. For controlled dropdown
    // triggers we wait until the dropdown is visible so the screenshot has useful
    // context, while the red box still marks the trigger itself.
    if (!action && !mergedFieldAfter) immediateClickCheckpoint(clicked,{interactionId});

    // Generic content may have no application result to observe; click evidence is enough.
    if (!action) return;

    // 5) Result validation runs independently as the second validator.
    if(!mergedFieldAfter)preActionCheckpoint(action,interactionId);
    beginAction(action,interactionId);
    if (action.hasAttribute('aria-controls')) watchControlledPopup(action);
  }, true);

  // SPA route detection. A new page is a result itself, with no red box required.
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;
  function routeChanged() {
    if (!enabled || !currentAction) return;
    const action = currentAction;
    setTimeout(() => {
      relayCheckpoint({
        type: 'CHECKPOINT_READY',
        checkpointId: `cp_${Date.now()}_${++seq}`,
        checkpointKind: 'navigation-result',
        label: `Result — halaman/route baru setelah ${action.label}`,
        rects: [],
        pageUrl: location.href,
        waitMs: 500,
        interactionId: action.interactionId,
        phase: 'result',
        sourceViewportW: innerWidth,
        sourceViewportH: innerHeight
      });
      currentAction = null;
    }, 180);
  }
  history.pushState = function(...args) { const r = originalPushState.apply(this,args); routeChanged(); return r; };
  history.replaceState = function(...args) { const r = originalReplaceState.apply(this,args); routeChanged(); return r; };
  addEventListener('popstate', routeChanged);

  // Automatic masking intentionally disabled. Use manual Blur in Review when needed.


  chrome.runtime.onMessage.addListener((msg,_sender,respond) => {
    if (msg.type === 'SET_RECORDING') {
      enabled = !!msg.enabled;
      currentAction = null;
      dirtyGroup = null;
      activeFieldSession = null;
      resultCandidates.clear();
      lastCheckpointKey = '';
      lastCheckpointAt = 0;
      respond({ok:true});
    } else if (msg.type === 'GET_RECORDING') {
      respond({enabled});
    }
  });
})();
