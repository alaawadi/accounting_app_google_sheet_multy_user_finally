/* ============================================================================
   sync.js — طبقة المزامنة مع Google Sheets لتطبيق «دفتر التاجر»

   المبدأ: التخزين الأساسي هو اللوكل ستورج (يعمل بلا إنترنت)، والشيت هو
   نسخة مشتركة تُحدَّث عند توفّر الإنترنت.

    الحالات:
    ▸ بلا جلسة (غير مسجّل)         → التطبيق لا يُفتح أصلاً (بوابة index.html).
    ▸ حساب فعّال بلا متجر            → البيانات محلية، والمزامنة تنتظر إنشاء
                                        متجر أو الانضمام بكود.
    ▸ حساب فعّال مع متجر             → رفع أي تعديل جديد (Outbox) + سحب أي
                                        تعديل من بقية المحاسبين.

   كيف تعمل المزامنة (بدون فقد أي بيانات):
   1) scan   : مقارنة محتوى كل سجل ببصمة محفوظة (hash). ما تغيّر ⇦ يُرفع، وما
              اختفى ⇦ يُرفع كـ«حذف» (tombstone) لا يُمحى من الشيت.
   2) push   : إرسال دفعات صغيرة إلى sync_push. الخادم يكتب بقيد القفل، والسجل
              الأحدث رقماً يفوز (LWW) — والمخالف يعود للعميل ليُطبّقه.
   3) pull   : سحب كل ما هو أحدث من «الختم» المحفوظ لكل نوع بيانات (cursor).
   4) كل سجل يحمل  _rev (رقم التعديل) + _by (من عدّله) + _cr (من أضافه) حتى
      يُخزَّن اسم المحاسب في الشيت مع كل إضافة أو تعديل.

   التبويبات: تبويب واحد «زعيم» ينفّذ المزامنة (lease في التخزين)، والبقية
   تقرأ التغييرات من أحداث storage وتطبّقها في مكانها على الكائنات الحية
   (Object.assign) فلا تضيع مراجع النماذج المفتوحة ولا تتداخل الكتابة.
   ============================================================================ */
(function (global) {
  'use strict';

  /* ===== تنسيق طبقة المزامنة (شارة الهيدر + لوحة الإعدادات) ===== */
  (function injectStyles() {
    try {
      if (document.getElementById('sync-styles')) return;
      var css = [
        '.sync-pill .sync-glyph{font-family:\'Cairo\',\'Segoe UI\',Tahoma,sans-serif;font-size:12.5px;font-weight:800;letter-spacing:0;line-height:1;}',
        '.sync-pill[data-state="ok"]{color:#8FE4DA;background:rgba(15,107,103,0.24);border-color:rgba(143,228,218,0.30);}',
        '.sync-pill[data-state="busy"]{color:#FFD98A;background:rgba(242,140,15,0.20);border-color:rgba(255,217,138,0.28);}',
        '.sync-pill[data-state="busy"] .sync-glyph{display:inline-block;animation:syncSpin 1.1s linear infinite;}',
        '.sync-pill[data-state="warn"]{color:#FFB4A2;background:rgba(214,69,69,0.18);border-color:rgba(255,138,131,0.28);}',
        '.sync-pill[data-state="offline"]{color:#C7D2DC;background:rgba(255,255,255,0.07);}',
        '.sync-pill[data-state="local"]{color:#9FB0BC;background:rgba(255,255,255,0.06);}',
        '.sync-pill[data-state="idle"]{color:#C7D2DC;}',
        '@keyframes syncSpin{from{transform:rotate(0)}to{transform:rotate(360deg)}}',
        '.sync-panel{margin-top:20px;padding-top:16px;border-top:1px dashed var(--line,#E6DFCF);}',
        '.sync-title{font-family:\'Cairo\',\'Segoe UI\',Tahoma,sans-serif;font-weight:800;font-size:16px;margin-bottom:10px;color:var(--ink,#182229);}',
        '.sync-sub{font-weight:800;font-size:14.5px;color:var(--ink,#182229);margin:4px 0 8px;}',
        '.sync-status{display:flex;align-items:center;gap:8px;font-size:13.5px;font-weight:700;color:var(--ink,#182229);background:#fff;border:1px solid var(--line,#E6DFCF);border-radius:12px;padding:9px 12px;margin-bottom:8px;}',
        '.sync-dot{width:9px;height:9px;border-radius:50%;background:var(--teal,#0F6B67);flex:0 0 auto;}',
        '.sync-status[data-state="syncing"] .sync-dot{background:var(--accent,#F28C0F);animation:syncPulse 1s ease-in-out infinite;}',
        '.sync-status[data-state="offline"] .sync-dot,.sync-status[data-state="error"] .sync-dot,.sync-status[data-state="session"] .sync-dot{background:var(--danger,#D6473F);}',
        '.sync-status[data-state="no_store"] .sync-dot,.sync-status[data-state="idle"] .sync-dot{background:var(--accent,#F28C0F);}',
        '@keyframes syncPulse{0%,100%{opacity:.35}50%{opacity:1}}',
        '.sync-note{font-size:12.5px;color:var(--muted,#736b5c);line-height:1.75;margin:6px 0 10px;}',
        '.sync-warn{font-size:12.5px;color:var(--danger,#D6473F);font-weight:700;margin:6px 0;}',
        '.sync-actions{display:flex;gap:8px;margin:10px 0 4px;}',
        '.sync-sep{height:1px;background:var(--line,#E6DFCF);margin:14px 0;}',
        '.sync-code-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px;color:var(--muted,#736b5c);margin:8px 0 6px;}',
        '.sync-code-row code{direction:ltr;unicode-bidi:isolate;font-weight:800;font-size:15px;letter-spacing:1.5px;color:var(--ink,#182229);background:#fff;border:1px dashed var(--accent,#F28C0F);border-radius:8px;padding:4px 10px;}',
        '.sync-members{display:flex;flex-direction:column;gap:8px;margin-top:8px;}',
        '.sync-member{display:flex;align-items:center;justify-content:space-between;gap:8px;background:#fff;border:1px solid var(--line,#E6DFCF);border-radius:12px;padding:8px 10px;}',
        '.sync-member-main{display:flex;flex-direction:column;gap:2px;min-width:0;}',
        '.sync-member-main strong{font-size:13.5px;color:var(--ink,#182229);}',
        '.sync-member-main span{font-size:11.5px;color:var(--muted,#736b5c);direction:ltr;unicode-bidi:plaintext;}',
        '.sync-member-side{display:flex;align-items:center;gap:6px;flex-shrink:0;}',
        '.sync-chip{font-size:10.5px;font-weight:800;color:var(--accent,#F28C0F);background:rgba(242,140,15,.12);border:1px solid rgba(242,140,15,.3);border-radius:99px;padding:3px 8px;white-space:nowrap;}'
      ].join('');
      var st = document.createElement('style');
      st.id = 'sync-styles';
      st.textContent = css;
      document.head.appendChild(st);
    } catch (e) { /* تجاهل */ }
  })();

  var STATE_KEY = 'invoiceapp_sync_state';
  var AUTH_KEY = 'invoiceapp_auth';

  /* أسماء مفاتيح البيانات في اللوكل ستورج (مجمّدة في index.html ولا تتغير) */
  var ENTITY_KEYS = {
    products:  'invoiceapp_products',
    customers: 'invoiceapp_customers',
    invoices:  'invoiceapp_invoices',
    pending:   'invoiceapp_pending',
    settings:  'invoiceapp_settings',
    stockLog:  'invoiceapp_stocklog'
  };
  var ENTITY_ORDER = ['products', 'customers', 'invoices', 'pending', 'stockLog', 'settings'];
  var ENTITY_LABEL = {
    products: 'المنتجات', customers: 'الزبائن', invoices: 'الفواتير',
    pending: 'المعلّق', stockLog: 'سجل المخزون', settings: 'الإعدادات'
  };

  /* ============ نطاق الحساب (فصل بيانات المتاجر على نفس الجهاز) ============
     نفس تعريف DTAuth.scopeKey: كل مفتاح في localStorage يأخذ لاحقة بصمة رقمية
     للهاتف الحالي (base@<digits>)، فتبقى بيانات كل حساب/متجر مستقلة ولا تتداخل
     حتى بين تبويبين مفتوحين على حسابين مختلفين على نفس المتصفح. */
  function nsOf() {
    try { if (global.DTAuth && typeof global.DTAuth.dataNs === 'function') return global.DTAuth.dataNs() || ''; } catch (e) { /* تجاهل */ }
    return '';
  }
  function scoped(base) { var ns = nsOf(); return ns ? (String(base) + '@' + ns) : String(base); }
  /* هل ينتمي المفتاح إلى نطاق الحساب الحالي؟ (المفاتيح بلا لاحقة رقمية عامة/قديمة) */
  function inMyScope(key) {
    if (typeof key !== 'string') return false;
    var i = key.lastIndexOf('@');
    if (i <= 0) return true;
    var suffix = key.slice(i + 1);
    if (!/^\d+$/.test(suffix)) return true;   /* ليست لاحقة نطاق */
    return suffix === nsOf();
  }

  var POLL_MS = 1000;          /* نبضة الفحص: ثانية واحدة ⇦ تعديل يظهر عند بقية الأجهزة في اللحظة */
  var DEBOUNCE_MS = 150;       /* من أول تعديل إلى بدء الرفع ≈150 مللي ثانية */
  var POLL_IDLE_EVERY = 3;     /* كل3 نبضات ⇦3 ث عند التركيز بلا نشاط حديث */
  var POLL_HIDDEN_EVERY = 30;  /* كل30 نبضة ⇦30 ث عندما يكون التبويب مخفياً */
  var TURBO_MS = 60000;        /* نشاط خلال آخر دقيقة ⇦ نبضة كل ثانية (تناوب عدّاد ميزانية عند النفاد) */
  var FULL_PULL_EVERY = 10;    /* كل10 سحابات ⇦ فحص كامل يتجاهل الإصدارات (شبكة أمان لكل تغيّر لم يُرصد) */
  var DAILY_BUDGET = 15000;    /* سقف نداءات اليوم — ربع الحصة تحت حد Apps Script (20,000) */
  var BUDGET_KEY = 'invoiceapp_sync_budget';  /* {d:'YYYY-MM-DD', n:عدد النداءات اليوم} */
  var LEASE_MS = 15000;       /* مهلة «زعامة» التبويب (تُجدَّد كل 4 ثوانٍ) */
  var LEASE_TICK_MS = 4000;   /* نبض تجديد القيادة أثناء حياة التبويب */
  var STORE_TTL_MS = 300000;  /* تحديث بيانات المتجر كل 5 دقائق */
  var PUSH_BATCH = 15;        /* صفوف لكل كيان في نداء الرفع */
  var PUSH_ENTITIES = 6;      /* أقصى عدد كيانات في نداء رفع واحد */
  var PULL_PAGE = 50;         /* صفوف في نداء سحب واحد */
  var MAX_PAGES = 30;         /* أقصى عدد صفحات سحب في دورة واحدة */

  /* حقول لا تُرفع ولا تُقبل من الشيت: مُشتقّة أو محلية الجهاز
     (تُعاد اشتقاقها محلياً من نفس البيانات فتتطابق كل الأجهزة). */
  var EXCLUDE = {
    invoices: { number: 1 },
    settings: { nextInvoiceNo: 1, lastProductCat: 1, lastProductUnitKey: 1, lastProductBaseKey: 1, currency: 1 }
  };

  var TAB_ID = (function () {
    try {
      if (global.crypto && typeof global.crypto.randomUUID === 'function') {
        return 't_' + global.crypto.randomUUID().slice(0, 8);
      }
    } catch (e) { /* تجاهل */ }
    return 't_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  })();

  var started = false;
  var inProgress = false;
  var lastCycleAt = 0;       /* آخر دورة حقيقية — لتجاهل عودة التركيز أثناء الفحص الحالي */
  var lastActivityAt = 0;    /* آخر تفاعل للمستخدم — لتفعيل النبضة السريعة عند العمل الفعلي */
  var pullCount = 0;         /* عدد نداءات السحب — لجدولة الفحص الكامل الدوري */
  var dirty = {};            /* أنواع البيانات التي تغيّرت محلياً وبانتظار الفحص */
  var fullScan = true;       /* أول تشغيل ⇦ فحص كامل لكل الأنواع */
  var internalWrite = false; /* الكتابة من داخل المحرّك لا تُعيد تعليم التغيّر */
  var timer = null;
  var leaseTimer = null;
  var debounceTimer = null;
  var refreshTimer = null;
  var refreshRetry = 0;
  var statusCache = '';
  /* لاحقة النطاق التي كُتبت فيها «الزعامة» — تحفظ وقت الادّعاء لا وقت الإفلات،
     كي يُفلت التبويب قيده من نطاقه الصحيح ولو تغيّر النطاق بعده (مثلاً بعد
     مسح الجلسة: clearAuth ⇦ nsOf() ترجع فارغاً وتكتب releaseLease في مفتاح
     خاطئ فيبقى القيد قديماً ⇦ أول دورة جديدة تجد زعيماً أجنبياً فتؤجّل). */
  var leaseNs = null;

  /* ============================== أدوات ============================== */
  function err(code) { var e = new Error(code); e.isSync = true; return e; }

  function hash(str) {
    var h1 = 5381, h2 = 52711;
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      h1 = ((h1 << 5) + h1 + c) | 0;
      h2 = ((h2 << 5) + h2 + (c << 1)) | 0;
    }
    return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
  }

  function defaultState() {
    return {
      v: 1, leader: null, store: null, members: [],
      cursors: {}, hashes: {}, outbox: [], blocked: {},
      last: { sync: 0, push: 0, pull: 0, store: 0 },
      status: 'idle', warn: ''
    };
  }
  function loadState() {
    try {
      var raw = localStorage.getItem(scoped(STATE_KEY));
      if (raw) { var o = JSON.parse(raw); if (o && o.v === 1) return o; }
    } catch (e) { /* تجاهل */ }
    return defaultState();
  }
  function saveState(s) {
    try { localStorage.setItem(scoped(STATE_KEY), JSON.stringify(s)); } catch (e) { /* تجاهل */ }
  }

  function accessMode() {
    try {
      if (!global.DTAuth) return 'expired';
      var st = DTAuth.accessState();
      return (st && st.mode) ? st.mode : 'expired';
    } catch (e) { return 'expired'; }
  }
  function currentUser() {
    try {
      var a = DTAuth.readAuth();
      if (a && a.phone) return { phone: a.phone, name: String(a.name || '') };
    } catch (e) { /* تجاهل */ }
    return { phone: '', name: '' };
  }

  function sanitize(entity, obj) {
    var out = {};
    if (!obj || typeof obj !== 'object') return out;
    var ex = EXCLUDE[entity];
    for (var k in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      if (k === '_rev' || k === '_by' || k === '_cr') continue;
      if (ex && ex[k]) continue;
      out[k] = obj[k];
    }
    return out;
  }
  /* تمثيل قانوني (مفتاحاً مرتباً) — حتى لا يُعدَّل البصمة لمجرد اختلاف ترتيب
     الحقول بين جهاز وآخر (وإلا دخلت التبويبات في حلقة كتابة لا تنتهي). */
  function canonical(v) {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'number') return isFinite(v) ? String(v) : 'null';
    if (typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
    if (typeof v !== 'object') return 'null';
    if (Array.isArray(v)) {
      var parts = [];
      for (var i = 0; i < v.length; i++) parts.push(canonical(v[i]));
      return '[' + parts.join(',') + ']';
    }
    var keys = Object.keys(v).sort();
    var out = [];
    for (var j = 0; j < keys.length; j++) out.push(JSON.stringify(keys[j]) + ':' + canonical(v[keys[j]]));
    return '{' + out.join(',') + '}';
  }
  function contentHash(entity, obj) { return hash(canonical(sanitize(entity, obj))); }

  function bumpRev(obj, phone) {
    if (!obj || typeof obj !== 'object') return;
    var now = Date.now();
    var cur = Number(obj._rev) || 0;
    obj._rev = now > cur ? now : cur + 1;
    if (phone) {
      obj._by = phone;
      if (!obj._cr) obj._cr = phone;
    }
  }

  /* ======================== الوصول إلى السجلات ======================== */
  function bridge() { return global.SyncBridge || null; }

  function list(entity) {
    var b = bridge();
    if (!b) return entity === 'settings' ? null : [];
    var v = b.list(entity);
    if (entity === 'settings') return v && typeof v === 'object' ? v : null;
    return Array.isArray(v) ? v : [];
  }
  function getRecord(entity, id) {
    if (entity === 'settings') return id === 'main' ? list('settings') : null;
    var arr = list(entity);
    for (var i = 0; i < arr.length; i++) if (arr[i] && arr[i].id === id) return arr[i];
    return null;
  }
  function insertRecord(entity, obj) {
    var b = bridge(); if (!b) return;
    if (entity === 'settings') { b.insert(entity, obj, 'main'); return; }
    b.insert(entity, obj);
  }
  function removeRecord(entity, id) {
    var b = bridge(); if (!b) return;
    b.remove(entity, id);
  }
  function persist(entity) {
    var b = bridge(); if (!b) return;
    internalWrite = true;
    try { b.persist(entity); } finally { internalWrite = false; }
  }
  function refresh() { try { if (bridge()) bridge().refresh(); } catch (e) { /* تجاهل */ } }

  /* ============================ طابور الرفع ============================ */
  function outboxKey(e, id) { return e + '|' + id; }
  function upsertOutbox(s, entity, id, rev, del) {
    rev = Number(rev) || 0;
    var key = outboxKey(entity, id);
    for (var i = 0; i < s.outbox.length; i++) {
      var o = s.outbox[i];
      if (outboxKey(o.e, o.id) !== key) continue;
      if (Number(o.rev) > rev) return;                    /* الموجود أحدث ⇦ لا نُخفضه */
      if (Number(o.rev) === rev && !!o.del === !!del) return;
      o.rev = rev; o.del = del ? 1 : 0;
      return;
    }
    s.outbox.push({ e: entity, id: id, rev: rev, del: del ? 1 : 0 });
  }
  function dropOutbox(s, entity, id) {
    var key = outboxKey(entity, id);
    s.outbox = s.outbox.filter(function (o) { return outboxKey(o.e, o.id) !== key; });
  }
  function outboxIndex(s) {
    var idx = {};
    for (var i = 0; i < s.outbox.length; i++) idx[outboxKey(s.outbox[i].e, s.outbox[i].id)] = s.outbox[i];
    return idx;
  }

  /* ======================= 1) الفحص المحلي (scan) ======================= */
  function scan() {
    var b = bridge(); if (!b) return;
    var user = currentUser();
    var s = loadState();
    var targets = [];
    if (fullScan) targets = ENTITY_ORDER.slice();
    else for (var k in dirty) if (dirty[k] && ENTITY_KEYS[k]) targets.push(k);
    if (!targets.length) return;

    for (var i = 0; i < targets.length; i++) scanEntity(s, targets[i], user.phone);
    saveState(s);
    dirty = {};
    fullScan = false;
  }

  function scanEntity(s, entity, phone) {
    var recs = list(entity);
    var items = [];
    if (entity === 'settings') { if (recs) items.push({ id: 'main', obj: recs }); }
    else for (var i = 0; i < recs.length; i++) if (recs[i] && recs[i].id) items.push({ id: recs[i].id, obj: recs[i] });

    var map = s.hashes[entity] || {};
    var next = {};
    var touched = false;

    for (var j = 0; j < items.length; j++) {
      var id = items[j].id, obj = items[j].obj;
      var h = contentHash(entity, obj);
      next[id] = h;
      if (map[id] !== h) {
        touched = true;
        bumpRev(obj, phone);                     /* تعديل محلي حقيقي ⇦ رقم جديد */
        upsertOutbox(s, entity, id, Number(obj._rev) || Date.now(), 0);
      }
    }
    /* السجلات الغائبة عن المصفوفة = حذف محلي ⇦ نرفعه كحذف لا كمحو */
    for (var old in map) {
      if (!Object.prototype.hasOwnProperty.call(map, old)) continue;
      if (next[old]) continue;
      touched = true;
      upsertOutbox(s, entity, old, Date.now(), 1);
    }

    /* تنقية قيود الصفوف المرفوضة: تغيّر محتوى السجل أو حذفه ⇦ لم يعد هناك
       ما يمنع الإقرار بالمزامنة — القيد يُشطب ثم يعود إن رُفض ثانيةً. */
    if (s.blocked) {
      for (var bk in s.blocked) {
        if (!Object.prototype.hasOwnProperty.call(s.blocked, bk)) continue;
        if (bk.indexOf(entity + '|') !== 0) continue;
        var bid = bk.slice(entity.length + 1);
        if (next[bid] && s.blocked[bk] === next[bid]) continue;
        delete s.blocked[bk];
      }
    }

    s.hashes[entity] = next;
    if (touched) persist(entity);                /* نحفظ _rev/_by/_cr في اللوكل ستورج */
  }

  /* ================== 2) الرفع إلى الشيت (push) ================== */
  function pushLoop(guard) {
    guard = guard || 0;
    if (guard > 40) return Promise.resolve();
    var s = loadState();
    if (!s.outbox.length) return Promise.resolve();

    /* نجمع كل الكيانات الطالبة في نداء واحد (بدل نداء لكل كيان):
       تعديل واحد يكتمل في طلب أو طلبين مهما تعدّدت جداوله. */
    var groups = {};                 /* entity -> entries */
    var order = [];
    for (var i = 0; i < s.outbox.length; i++) {
      var ob = s.outbox[i];
      if (!ENTITY_KEYS[ob.e]) continue;
      if (!groups[ob.e]) { groups[ob.e] = []; order.push(ob.e); }
      if (groups[ob.e].length >= PUSH_BATCH) continue;
      groups[ob.e].push(ob);
      if (order.length >= PUSH_ENTITIES) break;
    }
    if (!order.length) {                                 /* مفاتيح غير معروفة فقط ⇦ نصفّها */
      s.outbox = s.outbox.filter(function (x) { return !!ENTITY_KEYS[x.e]; });
      saveState(s);
      return pushLoop(guard + 1);
    }

    var user = currentUser();
    var batches = [];
    var metaByEntity = {};

    for (var oi = 0; oi < order.length; oi++) {
      var ent = order[oi];
      var batch = groups[ent];
      var rows = [];
      var meta = [];
      for (var j = 0; j < batch.length; j++) {
        var entry = batch[j];
        var obj = entry.del ? null : getRecord(ent, entry.id);
        if (!entry.del && !obj) {                  /* اختفى قبل الرفع ⇦ حوّله لحذف */
          entry.del = 1; entry.rev = Date.now();
        }
        if (entry.del) {
          rows.push({ id: entry.id, rev: entry.rev, del: 1,
                      data: JSON.stringify({ _rev: entry.rev, _del: 1, _by: user.phone }) });
        } else {
          var rev = Number(obj._rev) || entry.rev;
          rows.push({ id: entry.id, rev: rev, del: 0, data: JSON.stringify(stripExcluded(ent, obj)) });
          entry.rev = rev;
        }
        meta.push({ id: entry.id, rev: entry.rev, del: entry.del });
      }
      batches.push({ entity: ent, rows: rows });
      metaByEntity[ent] = meta;
    }
    saveState(s);       /* نثبّت ما عدّلناه في الطابور قبل الاتصال بالخادم */

    return call('sync_push', { batches: batches }).then(function (r) {
      if (!r.ok) throw err(r.error || 'server');

      var results = r.results || {};
      if (!r.results && r.entity && r.applied) {          /* خادم قديم: شكل مفرد */
        var one = {};
        one[r.entity] = { applied: r.applied, conflicts: r.conflicts, rejected: r.rejected };
        results = one;
      }

      var t = loadState();
      for (var ei = 0; ei < order.length; ei++) {
        var e2 = order[ei];
        var res = results[e2] || {};
        var metas = metaByEntity[e2] || [];
        for (var m = 0; m < metas.length; m++) {
          var mm = metas[m];
          /* نُخرج المدخل فقط إن لم يتحدّث مجدداً أثناء الطلب */
          t.outbox = t.outbox.filter(function (oo) {
            if (oo.e !== e2 || oo.id !== mm.id) return true;
            if (Number(oo.rev) > mm.rev) return true;
            if (!!oo.del !== !!mm.del) return true;
            return false;
          });
        }
        /* نزاع: للخادم سجل أحدث ⇦ نطبّقه عندنا */
        if (Array.isArray(res.conflicts) && res.conflicts.length) applyRows(e2, res.conflicts, t);
        if (Array.isArray(res.rejected) && res.rejected.length) {
          var drop = {};
          for (var q = 0; q < res.rejected.length; q++) drop[res.rejected[q].id] = res.rejected[q].error || 'x';
          t.outbox = t.outbox.filter(function (oo2) { return !(oo2.e === e2 && drop[oo2.id]); });
          t.warn = 'تعذّر رفع ' + (drop[Object.keys(drop)[0]] === 'too_large' ? 'سجل كبير جداً' : 'سجل') +
                   ' من ' + (ENTITY_LABEL[e2] || '');
          /* نقيّد كل صف مرفوض ببصمته الحالية: يخرج من الطابور بعد الرفض
             فتختفي علامته، فلا يجوز بعدها أن يُقال «كل شيء وصل الشيت» ما دام
             السجل موجوداً محلياً بمحتواه نفسه (راجع verifySynced). */
          t.blocked = t.blocked || {};
          for (var rb = 0; rb < metas.length; rb++) {
            var rmeta = metas[rb];
            if (rmeta.del || !drop[rmeta.id]) continue;
            var rrec = getRecord(e2, rmeta.id);
            if (rrec) t.blocked[e2 + '|' + rmeta.id] = contentHash(e2, rrec);
          }
        }
      }
      t.last.push = Date.now();
      saveState(t);
      updateUI();
      return pushLoop(guard + 1);
    });
  }

  /* ================== 3) السحب من الشيت (pull) ================== */
  function pullEntity(entity, page) {
    page = page || 0;
    if (page > MAX_PAGES) return Promise.resolve();
    var s = loadState();
    var since = Number(s.cursors[entity]) || 0;
    return call('sync_pull', { entity: entity, since: since }).then(function (r) {
      if (!r.ok) throw err(r.error || 'server');
      var t = loadState();
      applyRows(entity, r.rows || [], t);
      var cur = Math.max(Number(t.cursors[entity]) || 0, Number(r.cursor) || since);
      t.cursors[entity] = cur;
      t.last.pull = Date.now();
      saveState(t);
      updateUI();
      if (r.more) return pullEntity(entity, page + 1);
    });
  }
  /* سحب كل الكيانات في نداء واحد (الشكل الجديد)، ثم صفحات متابعة لمن زاد عن حد الصفحة.
     هذا ما يجعل الدورة كاملة = طلب سحب + طلب رفع بدل 6 طلبات سحب متتالية. */
  function pullAll() {
    var s = loadState();
    var cursors = {};
    var i;
    for (i = 0; i < ENTITY_ORDER.length; i++) cursors[ENTITY_ORDER[i]] = Number(s.cursors[ENTITY_ORDER[i]]) || 0;

    /* إصدارات كل كيان تخبر الخادم بما تغيّر فعلاً ⇦ يفتح أوراق المتغيّرة فقط
       ويترك الباقي (ومعها زمن النداء). كل FULL_PULL_EVERY سحابة نُسقطها
       ليفحص الخادم كل شيء — شبكة أمان لأي تغيّر لم يُرصد إصداره. */
    var req = { entities: ENTITY_ORDER.slice(), cursors: cursors };
    var full = (pullCount % FULL_PULL_EVERY) === 0;
    pullCount++;
    if (!full && s.vers && typeof s.vers === 'object' && Object.keys(s.vers).length) req.vers = s.vers;

    return call('sync_pull', req).then(function (r) {
      if (!r.ok) throw err(r.error || 'server');
      if (!r.results) return pullAllLegacy(0);          /* خادم قديم ⇦ السحب المفرد المتسلسل */

      var t = loadState();
      var pages = [];
      if (r.vers && typeof r.vers === 'object') t.vers = r.vers;
      for (var j = 0; j < ENTITY_ORDER.length; j++) {
        var e = ENTITY_ORDER[j];
        var res = r.results[e];
        if (!res) continue;
        applyRows(e, res.rows || [], t);
        t.cursors[e] = Math.max(Number(t.cursors[e]) || 0, Number(res.cursor) || cursors[e] || 0);
        if (res.more) pages.push(e);
      }
      t.last.pull = Date.now();
      saveState(t);
      updateUI();

      var k = 0;
      function nextPage() {
        if (k >= pages.length) return Promise.resolve();
        return pullEntity(pages[k++]).then(nextPage);
      }
      return nextPage();
    });
  }
  function pullAllLegacy(i) {                            /* توافق مع خادم لا يعرف entities */
    i = i || 0;
    if (i >= ENTITY_ORDER.length) return Promise.resolve();
    return pullEntity(ENTITY_ORDER[i]).then(function () { return pullAllLegacy(i + 1); });
  }

  /* تطبيق صفوف القادمة من الشيت (أو من تبويب آخر) على الكائنات الحية.
     قاعدة الحل: الأحدث رقماً _rev يفوز، وما هو معلّق للرفع يبقى كما هو. */
  function applyRows(entity, rows, s) {
    if (!Array.isArray(rows) || !rows.length) return false;
    var b = bridge(); if (!b) return false;
    var changed = false;
    var applied = false;   /* طُبّق سجل بعيد حتى لو لم يتغيّر المحتوى المُزامَن (حقول مُشتقّة) */
    s = s || loadState();
    var map = s.hashes[entity] || {};
    var idx = outboxIndex(s);

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i] || {};
      var id = String(row.id || '').trim();
      if (!id) continue;
      var remote = (row.data && typeof row.data === 'object') ? row.data : null;
      var del = !!row.del || !!(remote && remote._del);
      var rrev = remote ? (Number(remote._rev) || 0) : 0;
      var local = getRecord(entity, id);
      var lrev = local ? (Number(local._rev) || 0) : 0;
      var pend = idx[outboxKey(entity, id)];

      if (del) {
        if (!local) { delete map[id]; dropOutbox(s, entity, id); continue; }
        if (pend && Number(pend.rev) > rrev) continue;             /* حذف محلي أحدث ⇦ بقي */
        if (!pend && lrev > rrev) {                                 /* محلي أحدث بلا طابور ⇦ أعِده */
          upsertOutbox(s, entity, id, lrev, 0);
          continue;
        }
        removeRecord(entity, id);
        delete map[id];
        dropOutbox(s, entity, id);
        changed = true;
        continue;
      }
      if (!remote) continue;

      if (local) {
        if (lrev > rrev) {
          if (!pend) upsertOutbox(s, entity, id, lrev, 0);          /* استرجاع طابور ضائع */
          continue;
        }
        if (pend && Number(pend.rev) >= rrev) continue;             /* معلّق للرفع ⇦ لا يُلمس */
        var before = contentHash(entity, local);
        applyRemoteObject(local, remote, entity);
        applied = true;
        var after = contentHash(entity, local);
        map[id] = after;
        dropOutbox(s, entity, id);                       /* المحتوى مطابق للخادم بعد التطبيق */
        if (before !== after) changed = true;
      } else {
        if (pend && Number(pend.rev) > rrev) continue;              /* إضافة محلي أحدث */
        insertRecord(entity, JSON.parse(JSON.stringify(stripExcluded(entity, remote))));
        var rec = getRecord(entity, id);
        if (rec) { map[id] = contentHash(entity, rec); }
        dropOutbox(s, entity, id);
        changed = true;
      }
    }

    s.hashes[entity] = map;
    saveState(s);
    if (changed) persist(entity);
    if (changed || applied) refresh();   /* إعادة رسم لتحديث الأرقام/الحقول المُطبّقة */
    return changed;
  }

  /* حقول مُشتقّة/محلية الجهاز لا تُقبل من الشيت ولا تُرفع إليه (رقم الفاتورة،
     عدّادها، آخر فئة/وحدة استُعملت، العملة) — تُحسب محلياً على كل جهاز.
     تُنسخ في كائن جديد حتى لا نمسح الحقول من السجل الحي في التطبيق. */
  function stripExcluded(entity, obj) {
    var ex = EXCLUDE[entity];
    if (!ex || !obj || typeof obj !== 'object') return obj;
    var out = {};
    for (var k in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      if (ex[k]) continue;
      out[k] = obj[k];
    }
    return out;
  }

  /* تحديث السجل الموجود بنفس المرجع (Object.assign) كي لا تنفصل نماذج مفتوحة —
     مع تجاهل الحقول المُشتقّة وإلا لطمس سحبٌ واحد رقم فاتورة الجهاز بأرقام الشيت. */
  function applyRemoteObject(local, remote, entity) {
    var k;
    var ex = EXCLUDE[entity];
    for (k in local) {
      if (!Object.prototype.hasOwnProperty.call(local, k)) continue;
      if (ex && ex[k]) continue;
      if (!Object.prototype.hasOwnProperty.call(remote, k)) delete local[k];
    }
    for (k in remote) {
      if (!Object.prototype.hasOwnProperty.call(remote, k)) continue;
      if (ex && ex[k]) continue;
      local[k] = remote[k];
    }
  }

  /* ========================= دورة المزامنة ========================= */
  function isLeader(s) {
    var now = Date.now();
    leaseNs = nsOf();
    if (s.leader && s.leader.id === TAB_ID) { s.leader.exp = now + LEASE_MS; saveState(s); return true; }
    if (s.leader && Number(s.leader.exp) > now) return false;
    s.leader = { id: TAB_ID, exp: now + LEASE_MS };
    saveState(s);
    try { fullScan = true; } catch (e) { /* تجاهل */ }
    return true;
  }

  /* تجديد القيادة كل بضع ثوانٍ ما دمنا نحملها — كي لا تنتهي المهلة بين
     دورة وأخرى فيختطف تبويب آخر المزامنة وهو بلا جرم. */
  function renewLease() {
    try {
      leaseNs = nsOf();
      var s = loadState();
      if (!s.leader || s.leader.id !== TAB_ID) return;
      var now = Date.now();
      if (Number(s.leader.exp) > now + Math.floor(LEASE_MS / 2)) return;
      s.leader.exp = now + LEASE_MS;
      saveState(s);
    } catch (e) { /* تجاهل */ }
  }

  /* عند إغلاق/إعادة تحميل الصفحة نُفلت القيادة فوراً، كي لا ينتظر التبويب
     الجديد انتهاء مهلة تبويب ميّت قبل أول مزامنة.
     يُكتب القيد في النطاق نفسه الذي حُجز فيه (leaseNs) لا في النطاق الحالي،
     لأن النطاق قد يكون فُرِغ بمسح الجلسة قبل مغادرة الوثيقة (logout). */
  function releaseLease() {
    try {
      var ns = (leaseNs === null) ? nsOf() : leaseNs;
      var key = ns ? (STATE_KEY + '@' + ns) : STATE_KEY;
      var raw = localStorage.getItem(key);
      if (!raw) { leaseNs = null; return; }
      var s = JSON.parse(raw);
      if (s && s.v === 1 && s.leader && s.leader.id === TAB_ID) {
        s.leader = null;
        localStorage.setItem(key, JSON.stringify(s));
      }
      leaseNs = null;
    } catch (e) { /* تجاهل */ }
  }

  /* ============ الميزانية اليومية لعدد النداءات (حماية حصة Apps Script) ============
     كل نداء (سحب، رفع، حالة المتجر…) يستهلك وحدة واحدة. تُخزَّن في localStorage
     فتُحترم من كل تبويبات الجهاز. عند الانتهاء تهدأ المزامنة حتى الغد بدل أن
     تنفد حصّة السكربت الحقيقية ويتعطّل التطبيق لكل المستخدمين. */
  function budget() {
    var today = new Date().toISOString().slice(0, 10);
    try {
      var raw = JSON.parse(global.localStorage.getItem(BUDGET_KEY) || 'null');
      if (raw && raw.d === today) return { d: today, n: Number(raw.n) || 0 };
    } catch (e) { /* تجاهل */ }
    return { d: today, n: 0 };
  }
  function budgetFull() { return budget().n >= DAILY_BUDGET; }
  function spend() {
    var b = budget();
    if (b.n >= DAILY_BUDGET) return false;
    b.n++;
    try { global.localStorage.setItem(BUDGET_KEY, JSON.stringify(b)); } catch (e) { }
    return true;
  }
  function burnBudget() {             /* الخادم رفض بحصة نفدت ⇦ نتوقف حتى تجديد اليوم */
    var b = budget();
    if (b.n < DAILY_BUDGET) {
      b.n = DAILY_BUDGET;
      try { global.localStorage.setItem(BUDGET_KEY, JSON.stringify(b)); } catch (e) { }
    }
  }

  function call(action, payload) {
    if (!global.DTAuth || !DTAuth.isConfigured()) return Promise.reject(err('not_configured'));
    var body = {};
    if (payload) {
      for (var k in payload) {
        if (Object.prototype.hasOwnProperty.call(payload, k)) body[k] = payload[k];
      }
    }
    /* كل نداء مزامنة يحمل جلسة الدخول: الخادم يتحقق من phone+token قبل أي قراءة
       أو كتابة في شيت المتجر (وإلا رُدّ الطلب بـ session). */
    if (!body.phone || !body.token) {
      var a = null;
      try { a = DTAuth.readAuth(); } catch (e2) { a = null; }
      if (a && a.phone && a.token) {
        if (!body.phone) body.phone = a.phone;
        if (!body.token) body.token = a.token;
      }
    }
    if (!spend()) return Promise.reject(err('quota'));
    return DTAuth.callApi(action, body).then(function (r) {
      if (!r || typeof r.ok === 'undefined') throw err('bad-response');
      if (r.ok === false && (r.error === 'quota' || r.error === 'rate')) burnBudget();
      return r;
    });
  }

  /* =========== سياسة دخول بيانات الجهاز إلى المتجر ===========
     • صاحب متجر في أوّل متجر له (لا متجر من قبل) ⇦ نحتفظ ببيانات هذا الجهاز
       (التي جمعها قبل إنشاء المتجر) ونرفعها إلى شيت متجره.
     • حساب فرعي ينضم إلى متجر، أو تحوّل من متجر إلى آخر ⇦ بيانات الشيت هي
       الأساس وحدها: تُمسح بيانات هذا الجهاز ثم تُسحب بيانات الشيت قبل أي
       فحص محلي. */
  function isStoreOwner(s) {
    var phone = currentUser().phone;
    var role = (s.store && s.store.role) || '';
    if (!role && s.members && s.members.length) {
      for (var i = 0; i < s.members.length; i++) {
        var m = s.members[i];
        if (m && m.phone === phone && m.role) { role = m.role; break; }
      }
    }
    if (!role && s.store && s.store.owner) role = (s.store.owner === phone) ? 'owner' : 'accountant';
    return role === 'owner';
  }

  function currentUserRole() {
    var s = loadState();
    var phone = currentUser().phone;
    var role = (s.store && s.store.role) || '';
    if (!role && s.members && s.members.length) {
      for (var i = 0; i < s.members.length; i++) {
        var m = s.members[i];
        if (m && m.phone === phone && m.role) { role = m.role; break; }
      }
    }
    if (!role && s.store && s.store.owner) role = (s.store.owner === phone) ? 'owner' : 'accountant';
    return role || '';
  }

  /* الاسم العربي لدور العضوية داخل المتجر */
  function roleLabelAr(role) {
    switch (String(role || '')) {
      case 'owner': return 'مالك المتجر';
      case 'pro': return 'محاسب محترف';
      case 'inventory': return 'محاسب جرد';
      case 'cashier': return 'محاسب كاشير';
      case 'accountant': return 'محاسب';
      default: return '';
    }
  }

  function wipeLocalData() {
    var b = bridge();
    if (!b || typeof b.reset !== 'function') return false;
    for (var i = 0; i < ENTITY_ORDER.length; i++) {
      try {
        b.reset(ENTITY_ORDER[i]);
        if (typeof b.persist === 'function') b.persist(ENTITY_ORDER[i]);
      } catch (e) { /* تجاهل */ }
    }
    return true;
  }

  /* يُطبَّق عند تبدّل المتجر (إنشاء/انضمام/كشف الحالة/تغيير). يُرجع true إذا
     جرى المسح — عنده يجب أن يليه سحب من الشيت قبل الفحص المحلي.
     سجل صغير dataOwner يقول لمن بيانات هذا الجهاز: إن كانت متوقفة على شيت
     آخر فلا يجوز حملها إلى متجر جديد (تبقى للشيت الذي أنتمت إليه وحده). */
  function applyStoreEntry(s, prevId, nextId) {
    var changed = (prevId || null) !== (nextId || null);
    if (changed) { s.cursors = {}; s.hashes = {}; s.outbox = []; s.vers = {}; s.blocked = {}; fullScan = true; }
    if (!nextId) return false;                                  /* بلا متجر ⇦ نُبقي ما نحن عليه */

    if (!changed) { fullScan = true; return false; }             /* نفس المتجر ⇦ فحص كامل فقط */

    var phone = currentUser().phone;
    var owned = s.dataOwner && s.dataOwner.store;                /* بيانات الشيت السابق؟ */
    /* نحتفظ فقط بما لم يصل إلى أي شيت بعد (بيانات جمعها الجهاز قبل إنشاء متجر)، أو بما يخص هذا
       المتجر نفسه (غادرتَ وعدتَ) — وإلا فالشيت الجديد وحده هو الأساس. */
    var keep = !prevId && isStoreOwner(s) && (!owned || owned === nextId);

    if (keep) {
      fullScan = true;
      for (var e = 0; e < ENTITY_ORDER.length; e++) dirty[ENTITY_ORDER[e]] = true;
    } else {
      wipeLocalData();
    }
    s.dataOwner = { phone: phone, store: nextId };
    return !keep;
  }

  function ensureStore(s) {
    var now = Date.now();
    if (s.store && s.last && Number(s.last.store) && (now - Number(s.last.store) < STORE_TTL_MS)) {
      return Promise.resolve(s.store);
    }
    return call('store_status', {}).then(function (r) {
      if (!r.ok) throw err(r.error || 'server');
      var t = loadState();
      var prevId = (t.store && t.store.id) || null;
      var prevName = (t.store && t.store.name) || '';
      t.store = r.store || null;
      t.members = r.members || [];
      t.last = t.last || { sync: 0, push: 0, pull: 0, store: 0 };
      t.last.store = now;
      applyStoreEntry(t, prevId, t.store ? t.store.id : null);   /* اكتُشف تبدّل في الخادم ⇦ نطبّق السياسة */
      saveState(t);
      s.store = t.store;
      /* تغيّر اسم المتجر (أو دخول متجر لأول مرة) ⇦ أعد رسم الواجهة ليتحدث اسم المتجر في الهيدر */
      var newName = (t.store && t.store.name) || '';
      if (newName !== prevName || prevId !== (t.store ? t.store.id : null)) {
        try { setTimeout(function () { refresh(); }, 0); } catch (e) { /* تجاهل */ }
      }
      return t.store;
    });
  }

  /* ربط حالة المزامنة بحساب معين: لو دخل حساب آخر على نفس المتصفح تُصفَّر
     البصمات والطابور والمؤشرات كي لا تُرفع بيانات الحساب السابق إلى شيت الجديد. */
  function ensureOwner(s, phone) {
    if (!phone) return s;
    if (s.owner && s.owner !== phone) {
      s.hashes = {}; s.cursors = {}; s.outbox = []; s.vers = {}; s.blocked = {};
      s.store = null; s.members = [];
      s.last = { sync: 0, push: 0, pull: 0, store: 0 };
      s.warn = '';
      fullScan = true;
      saveState(s);
    }
    if (s.owner !== phone) { s.owner = phone; saveState(s); }
    return s;
  }

  function cycle() {
    if (inProgress) return Promise.resolve();
    if (accessMode() !== 'account') { setStatus('disabled'); return Promise.resolve(); }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) { setStatus('offline'); return Promise.resolve(); }
    if (budgetFull()) { setStatus('idle'); return Promise.resolve(); }   /* حصّة اليوم نفدت ⇦ بلا نداءات حتى الغد */

    /* الواجهة لم تكتمل بعد أثناء تحميل الصفحة ⇦ نؤجّل بدل دورة تنتهي
       «بنجاح» دون فحص أي شيء: إذن يتقدّم وقت المزامنة دون مزامنة حقيقية. */
    if (!bridge()) { schedule(400); return Promise.resolve(); }

    var s = loadState();
    if (!isLeader(s)) {                                          /* تبويب آخر يتولّى المزامنة */
      updateUI();
      schedule(Math.ceil(LEASE_MS / 2));                         /* نُعيد الفحص بعد نصف المهلة */
      return Promise.resolve();
    }
    s = ensureOwner(s, currentUser().phone);

    inProgress = true;
    lastCycleAt = Date.now();
    setStatus('syncing');

    return ensureStore(s)
      .then(function (store) {
        if (!store || !store.id) { var e = err('no_store'); throw e; }
        s = loadState();          /* نُعيد القراءة: قد مسحت سياسة الدخول البيانات والمؤشرات للتو */
        /* أول دورة لهذا الحساب/المتجر (بلا بصمات سابقة) ⇦ نسحب محتوى الشيت قبل
           الفحص المحلي: وإلا لاعتُمد «إعدادات فارغة» في جهاز جديد بوصفها تعديلاً
           حقيقياً وطُمِست بها إعدادات المتجر عند بقية المحاسبين. */
        var firstSync = !s.hashes || !Object.keys(s.hashes).length;
        var head = firstSync ? pullAll() : Promise.resolve();
        return head.then(function () { scan(); return pushLoop(); });
      })
      .then(function () { return pullAll(); })
      .then(function () {
        var t = loadState();
        t.last = t.last || { sync: 0, push: 0, pull: 0, store: 0 };
        t.last.sync = Date.now();
        t.warn = '';
        saveState(t);
        setStatus('ok');
        /* دورة ناجحة ⇦ فرصة لتنظيف ما تبقّى من بيانات حسابات أخرى مؤكَّد مزامنتها */
        try { cleanupForeignLeftovers(); } catch (e) { /* تجاهل */ }
      })
      .catch(function (e) {
        var code = (e && e.message) || '';
        if (code === 'no_store') setStatus('no_store');
        else if (code === 'timeout' || code === 'network' || code === 'bad-response') setStatus('offline');
        else if (code === 'session' || code === 'sub_expired' || code === 'blocked') setStatus('session');
        else if (code === 'quota') setStatus('idle');   /* الميزانية اليومية نفدت: هدوء لا خطأ */
        else setStatus('error', code);
      })
      .then(function () { inProgress = false; updateUI(); });
  }

  /* ===================== واجهة الشارة واللوحة ===================== */
  function statusInfo() {
    var s = loadState();
    var st = s.status || 'idle';
    var pending = 0;
    try { pending = (s.outbox || []).length; } catch (e) { pending = 0; }
    var last = (s.last && s.last.sync) ? new Date(s.last.sync) : null;
    return { status: st, pending: pending, store: s.store, members: s.members || [], warn: s.warn || '', last: last };
  }

  function pillMeta() {
    var mode = accessMode();
    var info = statusInfo();
    if (mode !== 'account') {
      return { cls: 'local', glyph: '⌂', title: 'التخزين محلي فقط — لا يوجد رفع للشيت' };
    }
    var st = info.status;
    if (st === 'syncing') return { cls: 'busy', glyph: '⟳', title: 'جارٍ المزامنة…' };
    if (st === 'offline') return { cls: 'warn', glyph: '⤓', title: 'بلا إنترنت — التعديلات محفوظة محلياً وستُرفع عند الاتصال' };
    if (st === 'no_store') return { cls: 'warn', glyph: '⌗', title: 'لا يوجد متجر بعد — أنشئ متجرك من الإعدادات لتفعيل المزامنة' };
    if (st === 'session') return { cls: 'warn', glyph: '!', title: 'الجلسة غير صالحة — سجّل الدخول من جديد' };
    if (st === 'error') return { cls: 'warn', glyph: '!', title: 'تعذّرت المزامنة — اضغط للمزيد من الإعدادات' };
    if (info.pending > 0) return { cls: 'busy', glyph: '↑' + (info.pending > 99 ? '99+' : info.pending), title: info.pending + ' تعديل بانتظار الرفع عند عودة الإنترنت' };
    if (st === 'ok') return { cls: 'ok', glyph: '✓', title: 'متزامن مع جوجل شيت' + (info.last ? ' — آخر مزامنة ' + fmtTime(info.last) : '') };
    return { cls: 'idle', glyph: '·', title: 'المزامنة لم تبدأ بعد' };
  }

  function fmtTime(d) {
    try { return d.getHours() + ':' + ('0' + d.getMinutes()).slice(-2); } catch (e) { return ''; }
  }
  function fmtDate(d) {
    try { return d.toLocaleDateString('ar-EG', { day: 'numeric', month: 'short' }) + ' ' + fmtTime(d); } catch (e) { return ''; }
  }

  function SyncPillHTML() {
    var m = pillMeta();
    return '<button type="button" class="icon-btn sync-pill" data-action="open-sync" ' +
      'id="sync-pill" data-state="' + m.cls + '" aria-label="حالة المزامنة" title="' + attr(m.title) + '" ' +
      'style="position:relative;"><span class="sync-glyph">' + esc(m.glyph) + '</span></button>';
  }

  /* تحديث الشارة دون إعادة رسم الصفحة (حتى لا ينقطع الكتابة في نموذج مفتوح) */
  function updatePill() {
    var el = null;
    try { el = document.getElementById('sync-pill'); } catch (e) { el = null; }
    if (!el) return;
    var m = pillMeta();
    if (statusCache === m.cls + '|' + m.glyph + '|' + m.title) return;
    statusCache = m.cls + '|' + m.glyph + '|' + m.title;
    el.setAttribute('data-state', m.cls);
    el.setAttribute('title', m.title);
    var g = el.querySelector('.sync-glyph');
    if (g) g.textContent = m.glyph;
  }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function attr(s) { return esc(s); }

  function setStatus(st, detail) {
    var s = loadState();
    s.status = st;
    if (detail) s.errorDetail = String(detail).slice(0, 80);
    saveState(s);
    updateUI();
  }

  function updateUI() {
    updatePill();
    updatePanel();
  }

  /* ==================== لوحة المزامنة داخل الإعدادات ==================== */
  var MESSAGES = {
    session: 'انتهت الجلسة — سجّل الدخول من جديد',
    sub_expired: 'انتهى اشتراك الحساب',
    blocked: 'الحساب موقوف',
    no_store: 'أنشئ متجرك أو انضم بكود لتفعيل المزامنة',
    bad_code: 'كود المتجر غير صحيح',
    not_invited: 'لم تتم دعوتك إلى هذا المتجر بعد — اطلب من المالك دعوتك',
    already_in_store: 'أنت تنتمي إلى متجر آخر — غادرته أولاً',
    user_not_found: 'لا يوجد حساب مسجّل بهذا الرقم',
    not_owner: 'هذا الإجراء متاح لمالك المتجر فقط',
    already_member: 'هذا المحاسب منضم بالفعل',
    not_member: 'هذا الحساب غير منضم',
    owner_cannot_leave: 'المالك لا يمكنه مغادرة متجره',
    target_in_store: 'هذا الحساب منتمٍ إلى متجر آخر',
    bad_request: 'طلب غير صالح',
    busy: 'الخادم مشغولاً — أعد المحاولة بعد لحظات',
    not_configured: 'لم يتم إعداد رابط الخادم في ملف auth.js',
    timeout: 'انتهت مهلة الاتصال — تحقق من الإنترنت',
    network: 'تعذّر الاتصال بالخادم',
    bad_response: 'رد غير متوقّع من الخادم',
    server: 'خطأ مؤقت في الخادم — أعد المحاولة'
  };
  function msgOf(code) { return MESSAGES[code] || 'تعذّرت العملية — أعد المحاولة'; }

  function toast(text) {
    try { if (typeof global.showToast === 'function') global.showToast(text); } catch (e) { /* تجاهل */ }
  }

  function ffVal(id, def) {
    /* استعادة قيمة حقل بعد إعادة الرسم — نفس آلية ff() في التطبيق
       (القيم تُحفظ تلقائياً في FORM_FIELDS عند الكتابة) */
    try {
      if (typeof global.ff === 'function') { var v = global.ff(id, ''); if (v !== '' && v !== undefined && v !== null) return v; }
    } catch (e) { /* تجاهل */ }
    return def || '';
  }

  function SyncPanelHTML() {
    var info = statusInfo();
    var mode = accessMode();

    if (mode !== 'account') {
      return '<div id="sync-panel" class="sync-panel">' +
        '<div class="sync-title">☁️ المزامنة مع جوجل شيت</div>' +
        '<div class="sync-note">المزامنة متاحة بعد تسجيل الدخول بحساب فعّل. ' +
        'بياناتك محفوظة على هذا الجهاز ولا تُرفع إلى أي مكان قبل ذلك.</div>' +
        '</div>';
    }

    var html = '<div id="sync-panel" class="sync-panel">';
    html += '<div class="sync-title">☁️ المزامنة مع جوجل شيت</div>';

    /* حالة المزامنة */
    var stateLine = '';
    if (info.status === 'syncing') stateLine = 'جارٍ المزامنة…';
    else if (info.status === 'ok') stateLine = 'متزامن' + (info.last ? ' — آخر مزامنة ' + fmtDate(info.last) : '');
    else if (info.status === 'offline') stateLine = 'بلا إنترنت — التعديلات محفوظة محلياً';
    else if (info.status === 'no_store') stateLine = 'بانتظار إنشاء متجر أو الانضمام بكود';
    else if (info.status === 'session') stateLine = 'الجلسة غير صالحة — سجّل الدخول من جديد';
    else if (info.status === 'error') stateLine = 'تعذّرت المزامنة مؤقتاً';
    else stateLine = 'جاهز للمزامنة';

    html += '<div class="sync-status" data-state="' + esc(info.status) + '">' +
      '<span class="sync-dot"></span><span>' + esc(stateLine) + '</span></div>';
    if (info.pending > 0) {
      html += '<div class="sync-note">' + info.pending + ' تعديل بانتظار الرفع' +
        (info.status === 'offline' ? ' حتى عودة الإنترنت' : '') + '</div>';
    }
    if (info.warn) html += '<div class="sync-warn">⚠ ' + esc(info.warn) + '</div>';
    if (info.status === 'error') html += '<div class="sync-note">كل بياناتك سليمة على الجهاز، وستُرفع تلقائياً عند عودة الاتصال.</div>';

    html += '<div class="sync-actions">' +
      '<button type="button" class="btn btn-primary" data-sync="sync"' + (info.status === 'syncing' ? ' disabled' : '') + '>مزامنة الآن</button>' +
      '</div>';

    /* قسم المتجر */
    var store = info.store;
    if (!store) {
      html += '<div class="sync-sep"></div>';
      html += '<div class="sync-sub">الخطوة الأولى: أنشئ متجرك أو انضم إلى متجر</div>';
      html += '<div class="field"><label>اسم المتجر</label>' +
        '<input type="text" id="sync-store-name" value="' + esc(ffVal('sync-store-name', '')) + '" placeholder="مثال: بقالة النور" maxlength="60"></div>';
      html += '<button type="button" class="btn btn-primary" style="width:100%;margin-bottom:14px;" data-sync="create-store">إنشاء متجر جديد والحصول على كود</button>';
      html += '<div class="field"><label>للانضمام: كود متجر قديم (يدخله المحاسب بعد دعوته برقم هاتفه)</label>' +
        '<input type="text" id="sync-store-code" value="' + esc(ffVal('sync-store-code', '')) + '" placeholder="ST-XXXXX" maxlength="12" autocapitalize="characters" style="text-transform:uppercase;"></div>';
      html += '<button type="button" class="btn" style="width:100%;" data-sync="join-store">انضمام بكود المتجر</button>';
      html += '<div class="sync-note">الانضمام يحتاج معاً: كود المتجر + دعوة مسبقة من المالك برقم هاتفك.</div>';
    } else {
      html += '<div class="sync-sep"></div>';
      html += '<div class="sync-sub">' + esc(store.name || 'متجري') +
        (store.role === 'owner' ? ' — أنت المالك' : (' — ' + (roleLabelAr(store.role) || 'محاسب'))) + '</div>';
      html += '<div class="sync-code-row"><span>كود الانضمام:</span>' +
        '<code id="sync-store-code-value">' + esc(store.code || '') + '</code>' +
        '<button type="button" class="btn btn-ghost" data-sync="copy-code">نسخ</button></div>';
      html += '<div class="sync-note">شارك الكود مع المحاسبين، ثم ادعِهم برقم هاتفهم المسجّل هنا.</div>';

      if (store.role === 'owner') {
        html += '<div class="field" style="margin-top:10px;"><label>دعوة محاسب (رقم هاتفه المسجّل)</label>' +
          '<input type="tel" id="sync-invite-phone" placeholder="059xxxxxxx" inputmode="numeric" maxlength="15"></div>';
        html += '<button type="button" class="btn" style="width:100%;margin-bottom:6px;" data-sync="invite">إرسال دعوة</button>';
      }

      var members = info.members || [];
      if (members.length) {
        html += '<div class="sync-members">';
        for (var i = 0; i < members.length; i++) {
          var m = members[i];
          var me = m.phone === (currentUser().phone || '');
          html += '<div class="sync-member">' +
            '<div class="sync-member-main"><strong>' + esc(m.name || m.phone) + '</strong>' +
            '<span>' + esc(m.phone) + (m.role === 'owner' ? ' · مالك' : (roleLabelAr(m.role) ? ' · ' + roleLabelAr(m.role) : '')) + '</span></div>' +
            '<div class="sync-member-side">' +
            (m.status === 'invited' ? '<span class="sync-chip">دعوة مرسلة</span>' : '') +
            (m.role !== 'owner' && store.role === 'owner'
              ? '<button type="button" class="btn btn-ghost" data-sync="remove" data-phone="' + esc(m.phone) + '">إزالة</button>' : '') +
            (m.role !== 'owner' && me
              ? '<button type="button" class="btn btn-ghost" data-sync="leave">مغادرة</button>' : '') +
            '</div></div>';
        }
        html += '</div>';
      } else if (store.role === 'owner') {
        html += '<div class="sync-note">لم تُدعَ أي محاسب بعد.</div>';
      }
      if (store.role !== 'owner') {
        html += '<button type="button" class="btn btn-ghost" style="width:100%;margin-top:8px;" data-sync="leave">مغادرة المتجر</button>';
      }
    }

    html += '<div class="sync-sep"></div>';
    html += '<div class="sync-note">يعمل التطبيق بلا إنترنت من نسخة اللوكل ستورج، وعند عودة الاتصال تُرفع التعديلات الجديدة وتُسحب تعديلات بقية المحاسبين تلقائياً. كل سجل في الشيت مكتوب فيه من أضافه ومن عدّله.</div>';
    html += '</div>';
    return html;
  }

  /* تحديث اللوحة في مكانه — دون مسح الحقول أثناء الكتابة */
  function updatePanel() {
    var panel = null;
    try { panel = document.getElementById('sync-panel'); } catch (e) { panel = null; }
    if (!panel) return;
    try {
      var active = document.activeElement;
      if (active && panel.contains(active)) return;               /* لا نقاطع الكتابة */
      var vals = {};
      var ids = ['sync-store-name', 'sync-store-code', 'sync-invite-phone'];
      for (var i = 0; i < ids.length; i++) {
        var el = document.getElementById(ids[i]);
        if (el) vals[ids[i]] = el.value;
      }
      var tmp = document.createElement('div');
      tmp.innerHTML = SyncPanelHTML();
      var fresh = tmp.firstChild;
      if (!fresh) return;
      panel.parentNode.replaceChild(fresh, panel);
      for (var j = 0; j < ids.length; j++) {
        var nel = document.getElementById(ids[j]);
        if (nel && vals[ids[j]] !== undefined) nel.value = vals[ids[j]];
      }
    } catch (e) { /* تجاهل */ }
  }

  /* ======================== إجراءات المتجر ======================== */
  function storeAction(action, payload, okMsg) {
    return call(action, payload || {}).then(function (r) {
      if (!r.ok) { toast(msgOf(r.error)); return r; }
      var s = loadState();
      var prevId = (s.store && s.store.id) || null;
      var nextId = (r.store && r.store.id) || null;
      s.store = r.store || null;
      s.members = r.members || [];
      s.last = s.last || { sync: 0, push: 0, pull: 0, store: 0 };
      s.last.store = Date.now();
      /* سياسة الدخول: صاحب أوّل متجر يحتفظ ببيانات تجربته ⇦ تُرفع إليه،
         والحساب الفرعي يُمسح جهازه ⇦ يبقى شيت المتجر وحده أساساً. */
      applyStoreEntry(s, prevId, nextId);
      saveState(s);
      toast(okMsg || 'تم ✓');
      updateUI();
      cycle();
      return r;
    }).catch(function (e) {
      toast(msgOf((e && e.message) || ''));
      return { ok: false, error: (e && e.message) || '' };
    });
  }

  /* تفعيل/تعطيل عضوية موظف (المالك فقط) — يحدّث قائمة الأعضاء محلياً بعد نجاح الخادم */
  function setMemberStatus(target, status) {
    return storeAction('store_member_status',
      { target: String(target || ''), status: String(status || '') },
      status === 'disabled' ? 'تم تعطيل الموظف ✓' : 'تم تفعيل الموظف ✓');
  }

  function onPanelClick(ev) {
    var btn = null;
    try { btn = ev.target.closest ? ev.target.closest('[data-sync]') : null; } catch (e) { btn = null; }
    if (!btn) return;
    var act = btn.getAttribute('data-sync');
    if (!act) return;
    try { ev.preventDefault(); ev.stopPropagation(); } catch (e2) { /* تجاهل */ }

    if (act === 'sync') {
      /* نعرض نافذة «جارٍ المزامنة» إن وُجدت (index.html) ثم نُغلقها عند انتهاء الدورة */
      if (typeof global.showSyncProgressAlert === 'function') global.showSyncProgressAlert();
      else toast('جارٍ المزامنة…');
      Promise.resolve(cycle()).then(function () {
        if (typeof global.hideSyncProgressAlert === 'function') global.hideSyncProgressAlert();
      }, function () {
        if (typeof global.hideSyncProgressAlert === 'function') global.hideSyncProgressAlert();
      });
      return;
    }

    if (act === 'create-store') {
      var nameEl = document.getElementById('sync-store-name');
      var name = nameEl ? nameEl.value.trim() : '';
      if (!name) { toast('اكتب اسم المتجر أولاً'); return; }
      btn.disabled = true;
      storeAction('store_create', { name: name }, 'تم إنشاء المتجر ✓').then(function () { btn.disabled = false; });
      return;
    }
    if (act === 'join-store') {
      var codeEl = document.getElementById('sync-store-code');
      var code = codeEl ? codeEl.value.trim() : '';
      if (!code) { toast('أدخل كود المتجر'); return; }
      btn.disabled = true;
      storeAction('store_join', { code: code }, 'تم الانضمام للمتجر ✓').then(function () { btn.disabled = false; });
      return;
    }
    if (act === 'invite') {
      var phEl = document.getElementById('sync-invite-phone');
      var ph = phEl ? phEl.value.trim() : '';
      if (!ph) { toast('أدخل رقم هاتف المحاسب'); return; }
      btn.disabled = true;
      storeAction('store_invite', { target: ph }, 'تم إرسال الدعوة ✓').then(function () { btn.disabled = false; });
      return;
    }
    if (act === 'remove') {
      var target = btn.getAttribute('data-phone') || '';
      if (!target) return;
      storeAction('store_remove', { target: target }, 'تمت إزالة المحاسب ✓');
      return;
    }
    if (act === 'leave') {
      storeAction('store_leave', {}, 'غادرت المتجر ✓');
      return;
    }
    if (act === 'copy-code') {
      var codeEl2 = document.getElementById('sync-store-code-value');
      var code2 = codeEl2 ? codeEl2.textContent.trim() : '';
      if (!code2) return;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(code2).then(function () { toast('نُسخ الكود ✓'); },
            function () { toast('الكود: ' + code2); });
        } else { toast('الكود: ' + code2); }
      } catch (e3) { toast('الكود: ' + code2); }
      return;
    }
  }

  /* ============ تحديث من تبويب آخر (أحداث storage) ============
     التطبيق في مكانه على الكائنات الحية: لا يُعاد بناء الصفحة، ولا تنفصل
     مراجع النماذج المفتوحة، ولا تُفقد الكتابة الجارية. */
  function keyToEntity(key) {
    if (typeof key === 'string') {
      var i = key.lastIndexOf('@');
      if (i > 0 && /^\d+$/.test(key.slice(i + 1))) key = key.slice(0, i);   /* اقتلع لاحقة النطاق */
    }
    for (var k in ENTITY_KEYS) if (ENTITY_KEYS[k] === key) return k;
    return null;
  }

  function mergeFromStorage(entity) {
    var b = bridge(); if (!b) return;
    var raw = null;
    try { raw = localStorage.getItem(scoped(ENTITY_KEYS[entity])); } catch (e) { raw = null; }
    if (raw === null) return;
    var stored;
    try { stored = JSON.parse(raw); } catch (e2) { return; }
    if (!stored) return;

    var rows = [];
    if (entity === 'settings') {
      rows.push({ id: 'main', data: stored });
    } else if (Array.isArray(stored)) {
      var live = list(entity);
      var have = {};
      for (var i = 0; i < live.length; i++) if (live[i] && live[i].id) have[live[i].id] = 1;
      for (var j = 0; j < stored.length; j++) if (stored[j] && stored[j].id) rows.push({ id: stored[j].id, data: stored[j] });
      for (var id in have) {
        if (!Object.prototype.hasOwnProperty.call(have, id)) continue;
        var still = stored.some(function (o) { return o && o.id === id; });
        if (!still) rows.push({ id: id, del: 1, data: null });
      }
    } else return;

    var s = loadState();
    applyRows(entity, rows, s);
    dirty[entity] = true;                     /* نفحصه في الدورة القادمة إن كنا الزعماء */
    schedule(600);
  }

  function onStorage(ev) {
    var key = ev.key;
    if (key === null) { fullScan = true; return; }
    if (key === AUTH_KEY) { try { schedule(300); } catch (e) { /* تجاهل */ } return; }
    if (key === scoped(STATE_KEY)) { updateUI(); return; }
    var entity = keyToEntity(key);
    if (!entity) return;
    /* تبويب آخر يعمل على حساب/متجر مختلف ⇦ لا نمزج بياناته أبداً مع بياناتنا */
    if (!inMyScope(key)) return;
    mergeFromStorage(entity);
    updateUI();
  }

  /* ======================= التشغيل والمؤقتات ======================= */
  function schedule(ms) {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function () {
      debounceTimer = null;
      cycle();
    }, ms || DEBOUNCE_MS);
  }

  function markDirty(entity) {
    if (internalWrite) return;
    if (!ENTITY_KEYS[entity]) return;
    dirty[entity] = true;
    if (accessMode() !== 'account') return;    /* بلا جلسة: محلي فقط بلا أي نداء */
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    schedule();
  }

  function start() {
    if (started) return;
    started = true;

    try {
      global.addEventListener('storage', onStorage);
      global.addEventListener('online', function () { setStatus('idle'); schedule(150); });
      global.addEventListener('offline', function () { setStatus('offline'); updateUI(); });
      global.addEventListener('pagehide', releaseLease);
      global.addEventListener('beforeunload', releaseLease);
      global.addEventListener('pageshow', function () { updateUI(); schedule(400); });
      /* عاد التبويب أو التركيز بعد غياب ⇦ فحص فوري (ما لم تكن دورة لتوّها).
         أثناء الظهور المتواصل يتكفّل النبض المتكيف أدناه خلال ثانية واحدة. */
      function refreshSoonIfStale() {
        if (Date.now() - lastCycleAt > POLL_MS * 4) schedule(150);
      }
      lastActivityAt = Date.now();
      ['click', 'keydown', 'pointerdown', 'input'].forEach(function (ev) {
        global.addEventListener(ev, function () { lastActivityAt = Date.now(); }, { passive: true });
      });
      global.addEventListener('focus', refreshSoonIfStale);
      document.addEventListener('visibilitychange', function () {
        if (document.hidden) { updateUI(); return; }
        updateUI();
        refreshSoonIfStale();
      });
      document.addEventListener('click', onPanelClick, false);
    } catch (e) { /* تجاهل */ }

    if (accessMode() !== 'account') { setStatus('disabled'); updateUI(); return; }

    /* نبضة كل ثانية، وبوابة تكيّفية تحدّد كم نبضة بين دورة حقيقية:
       تركيز + تفاعل حديث ⇦ كل نبضة (ثانية) — تركيز بلا نشاط دقيقة ⇦ كل3 (3 ث)
       — بلا تركيز ⇦ كل3 (3 ث) — مخفي ⇦ كل30 (30 ث).
       ويتدرّج أبطأ كلما نفدت ميزانية النداءات اليومية فلا تتوقف المزامنة فجأة:
       >50% متبقية ⇦ كل نبضة — 20..50% ⇦ كل3 — <20% ⇦ كل10 — نفدت ⇦ حتى الغد. */
    var idleTicks = 0;
    if (timer) clearInterval(timer);
    timer = setInterval(function () {
      try {
        if (typeof navigator !== 'undefined' && navigator.onLine === false) { setStatus('offline'); return; }

        var left = DAILY_BUDGET ? (1 - budget().n / DAILY_BUDGET) : 1;
        var every = left > 0.5 ? 1 : (left > 0.2 ? 3 : 10);
        try {
          if (document.hidden) every = Math.max(every, POLL_HIDDEN_EVERY);
          else if (document.hasFocus && !document.hasFocus()) every = Math.max(every, POLL_IDLE_EVERY);
          else if (Date.now() - lastActivityAt > TURBO_MS) every = Math.max(every, POLL_IDLE_EVERY);
        } catch (e2) { }

        idleTicks++;
        if (idleTicks < every) return;
        idleTicks = 0;
        updateUI();
        cycle();
      } catch (e) { /* تجاهل */ }
    }, POLL_MS);

    if (leaseTimer) clearInterval(leaseTimer);
    leaseTimer = setInterval(renewLease, LEASE_TICK_MS);

    fullScan = true;
    setTimeout(function () { cycle(); }, 1200);
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    if (leaseTimer) { clearInterval(leaseTimer); leaseTimer = null; }
    releaseLease();
    started = false;
  }

  /* ===== بيانات المتجر الحالية (اسم/كود) — يستعملها الهيدر لعرض اسم المتجر ===== */
  function storeInfo() {
    var s = loadState();
    return (s && s.store && s.store.id) ? s.store : null;
  }
  function storeName() {
    var st = storeInfo();
    return (st && st.name) ? String(st.name) : '';
  }
  function storeCode() {
    var st = storeInfo();
    return (st && st.code) ? String(st.code) : '';
  }

  /* مزامنة فورية يدوية (زر الشارة في الهيدر) — تعرض الشارة ⟳ ثم الحالة النهائية */
  function syncNow() {
    if (accessMode() !== 'account') return Promise.resolve();
    setStatus('syncing');
    return cycle();
  }

  /* ================= إثبات المزامنة قبل أي مسح =================
     لا يُفرَّغ التخزين المحلي إطلاقاً (عند تسجيل الخروج أو عند تنظيف
     بيانات حساب آخر على الجهاز) إلا بعد تأكيد دقيق بلغ كل سجل محلي
     الشيت فعلاً ولم يتغيّر شيء بعده. الشروط مجتمعة، وعند أي شك
     الإجابة false فيبقى التخزين كما هو فلا يضيع شيء:
       1) حالة مزامنة لحساب لها متجر وصاحب وآخر اتصال حقيقي بالخادم.
       2) طابور الرفع (outbox) فارغ تماماً.
       3) بصمة كل سجل محلي مطابقة للبصمة المحفوظة بعد آخر رفع/سحب،
          ولا سجل محلي بلا بصمة (تغيّر بعد آخر مزامنة ⇦ لم يُرفع بعد)،
          ولا بصمة بلا سجل (حذف لم يصل الشيت بعد).
       4) لا صف مرفوض من الخادم (too_large) ما دام موجوداً محلياً بمحتواه. */
  function stateForNs_(ns) {
    try {
      var raw = localStorage.getItem(ns ? (STATE_KEY + '@' + ns) : STATE_KEY);
      if (raw) { var o = JSON.parse(raw); if (o && o.v === 1) return o; }
    } catch (e) { /* تجاهل */ }
    return null;
  }
  /* سجلات نطاق محدّد: من الواجهة الحالية إن كان نطاقنا، وإلا من التخزين
     المحلي الخام باسمه المحصور (بيانات حساب آخر لا تمرّ عبر الجسر). */
  function itemsForNs_(entity, ns, useBridge) {
    if (useBridge) {
      var recs = list(entity);
      var out = [], i;
      if (entity === 'settings') return recs ? [{ id: 'main', obj: recs }] : [];
      for (i = 0; i < recs.length; i++) if (recs[i] && recs[i].id) out.push({ id: recs[i].id, obj: recs[i] });
      return out;
    }
    var raw = null;
    try { raw = localStorage.getItem(ns ? (ENTITY_KEYS[entity] + '@' + ns) : ENTITY_KEYS[entity]); } catch (e) { return null; }
    if (raw === null || raw === undefined || raw === '') return [];
    var v;
    try { v = JSON.parse(raw); } catch (e) { return null; }
    if (entity === 'settings') return (v && typeof v === 'object' && !Array.isArray(v)) ? [{ id: 'main', obj: v }] : [];
    if (!Array.isArray(v)) return null;
    var res = [];
    for (var j = 0; j < v.length; j++) if (v[j] && v[j].id) res.push({ id: v[j].id, obj: v[j] });
    return res;
  }
  function ownerCore_(owner) {
    var s = String(owner || '');
    try {
      if (global.DTAuth && typeof global.DTAuth.phoneCore === 'function') return global.DTAuth.phoneCore(s) || s;
    } catch (e) { /* تجاهل */ }
    return s;
  }
  function verifyScoped_(ns, useBridge) {
    try {
      var s = stateForNs_(ns);
      if (!s) return { ok: false, reason: 'no_state' };
      var owner = s.owner ? String(s.owner) : '';
      if (!owner) return { ok: false, reason: 'no_owner' };
      var core = ownerCore_(owner);
      if (ns) { if (core !== ns) return { ok: false, reason: 'owner_mismatch' }; }
      else if (!core || core === nsOf()) return { ok: false, reason: 'owner_mismatch' };   /* نطاقنا نحن ⇦ لا يُنظَّف هنا */
      if (!s.store || !s.store.id) return { ok: false, reason: 'no_store' };
      var last = s.last || {};
      if (!(Number(last.push) > 0 || Number(last.pull) > 0)) return { ok: false, reason: 'never' };
      if (Array.isArray(s.outbox) && s.outbox.length) return { ok: false, reason: 'pending', pending: s.outbox.length };

      for (var i = 0; i < ENTITY_ORDER.length; i++) {
        var entity = ENTITY_ORDER[i];
        var items = itemsForNs_(entity, ns, useBridge);
        if (items === null) return { ok: false, reason: 'bad_data', entity: entity };
        var hm = (s.hashes && s.hashes[entity]) || {};
        var live = {}, j;
        for (j = 0; j < items.length; j++) live[items[j].id] = items[j].obj;

        if (s.blocked) {
          for (var bk in s.blocked) {
            if (!Object.prototype.hasOwnProperty.call(s.blocked, bk)) continue;
            if (bk.indexOf(entity + '|') !== 0) continue;
            var bid = bk.slice(entity.length + 1);
            var bobj = live[bid];
            if (bobj && s.blocked[bk] === contentHash(entity, bobj)) {
              return { ok: false, reason: 'rejected', entity: entity, id: bid };
            }
          }
        }
        for (j = 0; j < items.length; j++) {
          var h = contentHash(entity, items[j].obj);
          if (hm[items[j].id] !== h) return { ok: false, reason: 'drift', entity: entity, id: items[j].id };
        }
        for (var old in hm) {
          if (!Object.prototype.hasOwnProperty.call(hm, old)) continue;
          if (live[old]) continue;
          return { ok: false, reason: 'removed', entity: entity, id: old };
        }
      }
      return { ok: true, store: String(s.store.id) };
    } catch (e) { return { ok: false, reason: 'error' }; }
  }
  /* إثبات مزامنة حسابنا الحالي (الجسر يعطي السجلات كما هي في الذاكرة) */
  function verifySynced() { return verifyScoped_(nsOf(), true); }

  /* ================= تنظيف ما تبقّى من حسابات أخرى =================
     بيانات حساب سابق على هذا الجهاز تُحذف فقط بعد إثبات مزامنتها نفسها
     بنفس الشروط أعلاه — فلا يُفقد شيء حتى لو مغادر حسابه دون تسجيل خروج.
     تُستدعى بعد دورة مزامنة ناجحة فقط (لأنها تقرأ الشيت بوصفة واحدة). */
  var ACCOUNT_BASE_KEYS = {
    invoiceapp_products: 1, invoiceapp_customers: 1, invoiceapp_invoices: 1,
    invoiceapp_pending: 1, invoiceapp_settings: 1, invoiceapp_stocklog: 1,
    invoiceapp_meta: 1, invoiceapp_navstate: 1, invoiceapp_dismissed_notifs: 1,
    invoiceapp_welcome_seen: 1, invoiceapp_trial_start: 1,
    invoiceapp_trial_welcome_pending: 1, invoiceapp_sub_check_day: 1,
    invoiceapp_sync_state: 1
  };
  function removeScopedKeys_(ns) {
    var n = 0, i, key, kill = [];
    try {
      for (i = 0; i < global.localStorage.length; i++) {
        key = global.localStorage.key(i);
        if (!key || key.indexOf('invoiceapp_') !== 0) continue;
        if (ns) {
          if (key.length <= ns.length + 1) continue;
          if (key.slice(key.length - ns.length - 1) !== '@' + ns) continue;
        } else {
          if (key.indexOf('@') >= 0) continue;          /* المُنطَق يخص حساباً آخر */
          if (!ACCOUNT_BASE_KEYS[key]) continue;        /* جهازية عامة: لا تُمس */
        }
        kill.push(key);
      }
      for (i = 0; i < kill.length; i++) global.localStorage.removeItem(kill[i]);
      n = kill.length;
    } catch (e) { /* تجاهل */ }
    if (ns) {
      try {
        var sk = 'invoiceapp_session@' + ns;
        if (global.sessionStorage.getItem(sk) !== null) { global.sessionStorage.removeItem(sk); n++; }
      } catch (e2) { /* تجاهل */ }
    }
    return n;
  }
  function cleanupForeignLeftovers() {
    var mine = nsOf();
    if (!mine) return 0;                                    /* بلا حساب ⇦ لا تنظيف */
    var found = {}, i;
    try {
      for (i = 0; i < global.localStorage.length; i++) {
        var k = global.localStorage.key(i);
        if (!k || k.indexOf('invoiceapp_') !== 0) continue;
        var at = k.lastIndexOf('@');
        var ns = (at > 10 && at + 1 < k.length) ? k.slice(at + 1) : '';
        if (ns === mine) continue;
        found[ns] = 1;
      }
    } catch (e) { return 0; }
    var removed = 0;
    for (var ns2 in found) {
      if (!Object.prototype.hasOwnProperty.call(found, ns2)) continue;
      if (!verifyScoped_(ns2, false).ok) continue;         /* غير مؤكَّد ⇦ لا يُمس */
      removed += removeScopedKeys_(ns2);
    }
    return removed;
  }

  /* ========================= الواجهة العامة ========================= */
  global.SyncEngine = {
    start: start,
    stop: stop,
    markDirty: markDirty,
    cycle: cycle,
    syncNow: syncNow,
    verifySynced: verifySynced,
    cleanupLeftovers: cleanupForeignLeftovers,
    status: statusInfo,
    panel: SyncPanelHTML,
    refreshUI: updateUI,
    setMemberStatus: setMemberStatus
  };
  global.SyncPillHTML = SyncPillHTML;
  global.SyncPanelHTML = SyncPanelHTML;
  global.SyncUserRole = currentUserRole;
  global.SyncStoreName = storeName;
  global.SyncStoreCode = storeCode;
  global.SyncStoreInfo = storeInfo;

})(window);
