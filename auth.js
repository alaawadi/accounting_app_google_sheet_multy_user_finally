/* ============================================================================
   auth.js — طبقة المصادقة لتطبيق «دفتر التاجر»
   تستخدمها الصفحتان معاً:
   - login.html : إرسال (رقم الهاتف + كلمة المرور) إلى جوجل اب سكربت والتحقق منهما
   - index.html : بوابة دخول إلزامية — لا وصول للتطبيق إلا بجلسة تسجيل دخول سارية
   التصميم:
   1) CONFIG إعدادات مشتركة (رابط الخادم، مدة صلاحية الجلسة).
   2) callApi() يستدعي الخادم بمسارين: fetch عادي أولاً، وإن منعه CORS ينتقل تلقائياً
      إلى مسار احتياطي (نموذج POST داخل iframe + postMessage) لا يحتاج CORS إطلاقاً.
   3) الجلسة (بعد تسجيل الدخول) تُحفظ في localStorage على الجهاز.
   ============================================================================ */
(function (global) {
  'use strict';

  var CONFIG = {
    /* ==========================================================
       >>>  ضع هنا رابط تطبيق الويب بعد نشر Code.gs  <<<
       الشكل: https://script.google.com/macros/s/AKfyc.../exec
       (إن تركته فارغاً ستظهر رسالة «لم يتم إعداد رابط الخادم» في صفحة الدخول)
       ========================================================== */
    GAS_URL: 'https://script.google.com/macros/s/AKfycbyWCXC7_sMqUAdJsuULshmAsxcmBoYWugXFSRi18f4cQob6k0pcW8klGTJswYljyM-K/exec',

    TOKEN_TTL_DAYS: 30,    // صلاحية جلسة الدخول بالأيام (30 يوماً) قبل طلب تسجيل دخول جديد
    TIMEOUT_MS: 15000,     // مهلة الاتصال بالخادم قبل خطأ «تعذر الاتصال»
    AUTH_KEY: 'invoiceapp_auth',
    DEVICE_KEY: 'invoiceapp_device_id'   // معرّف الجهاز (localStorage + كوكي سنة)
  };

  /* أصول مسموح بها لرسائل postMessage القادمة من الخادم في المسار الاحتياطي */
  function isAllowedOrigin(origin) {
    if (!origin) return false;
    if (origin === 'https://script.google.com') return true;
    return /^https:\/\/[a-z0-9\-]+\.googleusercontent\.com$/.test(origin);
  }

  /* --------------------------- إعدادات --------------------------- */
  function config() { return CONFIG; }
  function setGasUrl(url) {
    if (url && typeof url === 'string' && url.trim()) {
      CONFIG.GAS_URL = url.trim();
      return true;
    }
    return false;
  }
  function isConfigured() { return !!CONFIG.GAS_URL; }

  /* ---------------------- تطبيع رقم الهاتف ----------------------
     يزيل كل ما ليس رقماً، ثم الأصفار البادئة و 00 — ليتلاقى رقم الموبايل المحلي
     (059xxxxxxx) مع الدولي (97059xxxxxxx) في الجلسة وفي جدول جوجل. */
  function normalizePhone(v) {
    var d = String(v === null || v === undefined ? '' : v).replace(/\D+/g, '');
    d = d.replace(/^00/, '').replace(/^0+/, '');
    return d;
  }
  function isValidPhone(v) {
    var d = normalizePhone(v);
    return d.length >= 7 && d.length <= 15;
  }

  /* --------------------------- الجلسة --------------------------- */
  function readAuth() {
    try {
      var raw = global.localStorage.getItem(CONFIG.AUTH_KEY);
      if (!raw) return null;
      var o = JSON.parse(raw);
      return (o && typeof o === 'object') ? o : null;
    } catch (e) { return null; }
  }
  function writeAuth(data) {
    try {
      global.localStorage.setItem(CONFIG.AUTH_KEY, JSON.stringify(data));
      return true;
    } catch (e) { return false; }
  }
  function clearAuth() {
    try { global.localStorage.removeItem(CONFIG.AUTH_KEY); } catch (e) { /* تجاهل */ }
  }

  /* --------------------- مسح بيانات التطبيق ---------------------
     يُستدعى عند تسجيل الخروج وقبل فتح جلسة دخول جديدة، فيُزَال من التخزين
     المحلي كل ما هو بيانات حساب: الفواتير والمنتجات والزبائن والانتظار
     وإعدادات وسجل الحركات، وحالة المزامنة، وبيانات الواجهة (meta/navState).
     المفاتيح تُمسَح بكل أشكالها المقرونة بالنطاق (base@رقم) وغير المقرنة،
     فلا يبقى على الجهاز أي أثر لأي حساب سابق ولا خلط مع القادم.
     ما يبقى عمداً: معرّف الجهاز (ربط الجهاز الواحد) وعدّاد حصّة المزامنة
     اليومي — كلاهما خاص بالجهاز لا بالحساب. */
  var WIPE_KEEP = { invoiceapp_auth: 1, invoiceapp_device_id: 1, invoiceapp_sync_budget: 1 };

  function keyBase_(k) {
    var i = String(k).indexOf('@');
    return i < 0 ? String(k) : String(k).slice(0, i);
  }

  function wipeAppData() {
    var i, key, kill = [], sk = [];
    try {
      for (i = 0; i < global.localStorage.length; i++) {
        key = global.localStorage.key(i);
        if (!key || key.indexOf('invoiceapp_') !== 0) continue;
        if (WIPE_KEEP[keyBase_(key)]) continue;
        kill.push(key);
      }
      for (i = 0; i < kill.length; i++) global.localStorage.removeItem(kill[i]);
    } catch (e) { /* تجاهل */ }
    try {
      for (i = 0; i < global.sessionStorage.length; i++) {
        key = global.sessionStorage.key(i);
        if (key && key.indexOf('invoiceapp_') === 0) sk.push(key);
      }
      for (i = 0; i < sk.length; i++) global.sessionStorage.removeItem(sk[i]);
    } catch (e) { /* تجاهل */ }
    return kill.length;
  }

  /* ------------------------ التواريخ ------------------------ */
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function isoOf(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function todayISO() { return isoOf(Date.now()); }

  /* ------------------------ معرّف الجهاز ------------------------
     يُطلب من الخادم لربط الحساب بجهاز واحد — أي جهاز آخر يحاول الدخول يُرفض.
     يُحفظ في localStorage ويُعكَس في كوكي لمدة سنة، فإن ضاع من الاثنين
     يولّد النظام معرّفاً جديداً (وهذا يعادل جهازاً جديداً). */
  var ID_RE = /^[A-Za-z0-9_\-]{8,64}$/;

  function readCookie_(name) {
    try {
      var m = document.cookie.match(new RegExp('(?:^|;\\s*)' + name.replace(/[$()*+./?[\\\]^{|}-]/g, '\\$&') + '=([^;]*)'));
      return m ? decodeURIComponent(m[1]) : '';
    } catch (e) { return ''; }
  }
  function writeCookie_(name, value) {
    try {
      document.cookie = name + '=' + encodeURIComponent(value) +
        '; path=/; max-age=' + (3600 * 24 * 365) + '; SameSite=Lax';
    } catch (e) { /* تجاهل */ }
  }

  function deviceId() {
    var id = '';
    try { id = global.localStorage.getItem(CONFIG.DEVICE_KEY) || ''; } catch (e) { id = ''; }
    if (ID_RE.test(id)) { writeCookie_(CONFIG.DEVICE_KEY, id); return id; }

    id = readCookie_(CONFIG.DEVICE_KEY);
    if (ID_RE.test(id)) {
      try { global.localStorage.setItem(CONFIG.DEVICE_KEY, id); } catch (e) { /* تجاهل */ }
      return id;
    }

    try {
      if (global.crypto && typeof global.crypto.randomUUID === 'function') {
        id = global.crypto.randomUUID();
      } else {
        id = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10) +
             Math.random().toString(36).slice(2, 10);
      }
    } catch (e) {
      id = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    }
    id = String(id).replace(/[^A-Za-z0-9_\-]/g, '').slice(0, 64);
    if (!ID_RE.test(id)) id = ('00000000' + Date.now().toString(36)).slice(-8) + '-dev';

    try { global.localStorage.setItem(CONFIG.DEVICE_KEY, id); } catch (e) { /* تجاهل */ }
    writeCookie_(CONFIG.DEVICE_KEY, id);
    return id;
  }

  /* هل انتهى اشتراك الحساب؟ (يأتي تاريخ النهاية من الخادم مع الدخول والتحقق)
     لا يوجد تاريخ نهاية ⇦ لا يوجد اشتراك محدَّد أصلاً (الخانة فارغة أو صفر أو غير رقمية)
     فلا وصول للحساب مطلقاً حتى تُملأ «الاشتراك_أيام» برقم أكبر من صفر. */
  function subscriptionExpired(auth) {
    if (!auth) return false;
    var end = Number(auth.subEnd) || 0;
    if (!end) return true;
    return Date.now() >= end;
  }

  /* هل الجلسة صالحة؟ (تسجيل دخول ناجح + التوكن لم ينتهِ + الاشتراك سليم) */
  function sessionValid(auth) {
    if (!auth || !auth.token || !auth.phone) return false;
    if (auth.exp && Date.now() > auth.exp) return false;
    if (subscriptionExpired(auth)) return false;
    return true;
  }

  /* حالة الوصول الحالية للتطبيق:
     account → مسجّل الدخول: وصول طالما اشتراكه فعّال (ينتهي ⇦ يُطلب تسجيل الدخول)
     expired → لا توجد جلسة سارية: يجب تسجيل الدخول */
  function accessState() {
    var auth = readAuth();
    if (sessionValid(auth)) return { mode: 'account', auth: auth, trial: null };
    return { mode: 'expired', auth: auth, trial: null };
  }

  /* مسح الجلسة والانتقال لصفحة تسجيل الدخول (بدون تاريخ حتى لا يتكرر).
      قبل المغادرة تُعطى المزامنة فرصة قصيرة لرفع أي تغييرات ما زالت في الطابور
      (index.html يضبط الجسر عبر DT_BEFORE_LOGOUT ويُنتظر 2.5 ثانية كحد أقصى)،
      ثم — وبعد التأكد الدقيق أن كل بيانات هذا الحساب بلغت الشيت فعلاً
      (DT_DATA_SYNCED) — تُمسح بيانات التطبيق من التخزين المحلي فتُستعاد
      عند الدخول من الشيت. ولو لم يتأكد المزامنة (بلا إنترنت، تغيير بعد آخر
      مزامنة، رفع متعثّر) بقي التخزين كما هو فلا يضيع شيء، وبيانات كل حساب
      منفصلة باسم نطاقها فلا تختلط بحساب لاحق. */
  var LOGOUT_FLUSH_MS = 2500;

  function logout(reason) {
    var done = false;
    var flush = null;
    try {
      if (typeof global.DT_BEFORE_LOGOUT === 'function') flush = global.DT_BEFORE_LOGOUT();
    } catch (e) { flush = null; }

    function finish() {
      if (done) return;
      done = true;
      /* لا مسح إلا بشروط مجتمعة:
         1) إثبات مزامنة كامل (DT_DATA_SYNCED يعرّفه index.html عبر
            SyncEngine.verifySynced: طابور رفع فارغ + بصمات مطابقة + متجر
            وآخر اتصال بالخادم + لا صف مرفوض)، و
         2) الاتصال قائماً الآن — فالشيت هو وحده مصدر الحقيقة، وبلا إنترنت
            يبقى التخزين كما هو حتى تعود الشبكة (فإن تحقّقت المزامنة لاحقاً
            عند دخول ما ⇦ يُنظَّف آلياً بعد إثباتها).
         أي شك ⇦ الإجابة false ⇦ تبقى البيانات فلا يضيع شيء. */
      var confirmed = false;
      try {
        confirmed = (typeof global.DT_DATA_SYNCED === 'function') &&
                    global.DT_DATA_SYNCED() === true;
      } catch (e) { confirmed = false; }
      var online = true;
      try { online = !(global.navigator && global.navigator.onLine === false); } catch (e) { online = true; }
      if (confirmed && online) wipeAppData();
      /* إيقاف المزامنة وإفلات قيد الزعامة قبل مسح الجلسة: releaseLease يحتاج
         نطاق الحساب الحالي ليعمل على المفتاح الصحيح، ولو تأخّر حتى بعد
         clearAuth ⇦ nsOf() ترجع فارغاً فيبقى القيد على نطاق المتجر الجامد
         ⇦ أول دورة لحساب لاحق تجد زعيماً أجنبياً فتؤجّل سحبها بضع ثوانٍ. */
      try { if (global.SyncEngine && typeof global.SyncEngine.stop === 'function') global.SyncEngine.stop(); } catch (e) { /* تجاهل */ }
      clearAuth();
      var url = './login.html';
      if (reason) url += '?reason=' + encodeURIComponent(reason);
      try { global.location.replace(url); } catch (e) { global.location.href = url; }
    }

    if (flush && typeof flush.then === 'function') {
      var timer = setTimeout(finish, LOGOUT_FLUSH_MS);
      flush.then(function () { clearTimeout(timer); finish(); },
                  function () { clearTimeout(timer); finish(); });
      return;
    }
    finish();
  }

  /* ----------------- استدعاء الخادم (Apps Script) ----------------- */
  function transportError(code) {
    var err = new Error(code);
    err.isTransport = true;
    return err;
  }

  /* نداء رئيسي: يعيد وعدة تُحلّ بكائن JSON من الخادم ({ok:true|false, ...})
     وتُرفض فقط عند فشل الاتصال (not_configured / timeout / network). */
  function callApi(action, payload) {
    if (!CONFIG.GAS_URL) return Promise.reject(transportError('not_configured'));
    var body = {};
    var src = payload || {};
    for (var k in src) { if (Object.prototype.hasOwnProperty.call(src, k)) body[k] = src[k]; }
    body.action = action;
    if (!body.device) body.device = deviceId();   // معرّف الجهاز يرافق كل نداء
    return postJson_(body)['catch'](function () { return postIframe_(body); });
  }

  /* المسار الأول: fetch بسيط (Content-Type text/plain حتى لا يُرسل preflight) */
  function postJson_(body) {
    return new Promise(function (resolve, reject) {
      if (typeof global.fetch !== 'function') { reject(transportError('network')); return; }
      var done = false;
      var ctrl = (typeof global.AbortController === 'function') ? new global.AbortController() : null;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        try { if (ctrl) ctrl.abort(); } catch (e) { /* تجاهل */ }
        reject(transportError('timeout'));
      }, CONFIG.TIMEOUT_MS);

      var opts = {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(body),
        redirect: 'follow',
        credentials: 'omit'
      };
      if (ctrl) opts.signal = ctrl.signal;

      global.fetch(CONFIG.GAS_URL, opts)
        .then(function (res) {
          if (!res || !res.ok) throw transportError('network');
          return res.text();
        })
        .then(function (text) {
          var json;
          try { json = JSON.parse(text); } catch (e) { throw transportError('bad-response'); }
          if (!json || typeof json.ok === 'undefined') throw transportError('bad-response');
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(json);
        })
        .catch(function (err) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          reject(err && err.isTransport ? err : transportError('network'));
        });
    });
  }

  /* المسار الاحتياطي: نموذج POST داخل iframe مخفي يستقبل من الخادم صفحة صغيرة
     تُرسل النتيجة عبر postMessage — لا يحتاج CORS إطلاقاً (تعمل حتى لو منع
     المتصفح النداء الأول). */
  function postIframe_(body) {
    return new Promise(function (resolve, reject) {
      if (typeof document === 'undefined' || !document.body) { reject(transportError('network')); return; }

      var nonce = 'dt' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      body.transport = 'html';
      body.nonce = nonce;

      var iframe = null, form = null, timer = null, finished = false;

      function cleanup() {
        finished = true;
        clearTimeout(timer);
        global.removeEventListener('message', onMessage);
        try { if (form && form.parentNode) form.parentNode.removeChild(form); } catch (e) { /* تجاهل */ }
        try {
          if (iframe && iframe.parentNode) {
            var f = iframe;
            setTimeout(function () { try { if (f.parentNode) f.parentNode.removeChild(f); } catch (e) {} }, 400);
          }
        } catch (e) { /* تجاهل */ }
      }
      function finishOk(value) { if (finished) return; cleanup(); resolve(value); }
      function finishErr(code) { if (finished) return; cleanup(); reject(transportError(code)); }

      function onMessage(ev) {
        if (!isAllowedOrigin(ev.origin)) return;
        var d = ev.data;
        if (!d || d.__dtAuth !== 1 || d.nonce !== nonce) return;
        var out = {};
        for (var k in d) {
          if (!Object.prototype.hasOwnProperty.call(d, k)) continue;
          if (k === '__dtAuth' || k === 'nonce' || k === 'transport') continue;
          out[k] = d[k];
        }
        if (typeof out.ok === 'undefined') { finishErr('bad-response'); return; }
        finishOk(out);
      }

      global.addEventListener('message', onMessage);
      timer = setTimeout(function () { finishErr('timeout'); }, CONFIG.TIMEOUT_MS + 6000);

      try {
        iframe = document.createElement('iframe');
        iframe.name = nonce;
        iframe.setAttribute('sandbox', 'allow-scripts allow-forms allow-same-origin');
        iframe.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none;';
        document.body.appendChild(iframe);

        form = document.createElement('form');
        form.method = 'POST';
        form.action = CONFIG.GAS_URL;
        form.target = nonce;
        form.style.cssText = 'display:none;';
        var input = document.createElement('input');
        input.type = 'hidden';
        input.name = 'payload';
        input.value = JSON.stringify(body);
        form.appendChild(input);
        document.body.appendChild(form);
        form.submit();
      } catch (e) {
        finishErr('network');
      }
    });
  }

  /* رسائل عربية موحّدة لحالات فشل الاتصال (الأخطاء التطبيقية يأتي مسماها من الخادم) */
  function humanTransportError(err) {
    var code = (err && err.message) || '';
    if (code === 'not_configured') return 'لم يتم إعداد رابط الخادم بعد. أضف رابط Apps Script في ملف auth.js';
    if (code === 'timeout') return 'انتهت مهلة الاتصال بالخادم، تحقق من الإنترنت وحاول مجدداً';
    return 'تعذر الاتصال بالخادم، تحقق من اتصال الإنترنت ثم أعد المحاولة';
  }

  /* ============ فصل بيانات الحسابات على نفس الجهاز ============
     بصمة رقمية واحدة للهاتف (059X و+97059X و97059X حساب واحد) تُلحق بكل مفتاح
     بيانات في localStorage — فيبقى لكل متجر/حساب بياناته مستقلة تماماً على نفس
     الجهاز بلا أي تداخل، ويمكن التنقل بين حسابين والعودة لأي منهما فتجده كما تركه.
     هذه الدوال في auth.js لأنها الأصل المشترك بين index.html وsync.js (يُحمَّلان
     الاثنان بعد auth.js) فلا يختلف تعريف النطاق بين طبقتي التخزين والمزامنة. */
  function phoneCore(v) {
    var d = String(v === null || v === undefined ? '' : v)
      .replace(/[\u0660-\u0669]/g, function (x) { return String(x.charCodeAt(0) - 0x0660); })
      .replace(/[^\d+]/g, '').replace(/\+/g, '');
    if (d.indexOf('970') === 0 || d.indexOf('972') === 0) d = d.slice(3);
    if (d.indexOf('0') === 0) d = d.slice(1);
    return d;
  }
  /* بصمة الحساب الحالي — فارغة تماماً بلا جلسة */
  function dataNs() {
    var a = readAuth();
    var raw = (a && a.phone) ? String(a.phone) : '';
    if (!raw) return '';
    return phoneCore(raw) || raw;
  }
  /* مفتاح محصور داخل نطاق الحساب الحالي: <base>@<البصمة> */
  function scopeKey(base) {
    var ns = dataNs();
    return ns ? (String(base) + '@' + ns) : String(base);
  }

  global.APP_CONFIG = CONFIG;
  global.DTAuth = {
    config: config,
    setGasUrl: setGasUrl,
    isConfigured: isConfigured,
    normalizePhone: normalizePhone,
    isValidPhone: isValidPhone,
    phoneCore: phoneCore,
    dataNs: dataNs,
    scopeKey: scopeKey,
    readAuth: readAuth,
    writeAuth: writeAuth,
    clearAuth: clearAuth,
    wipeAppData: wipeAppData,
    todayISO: todayISO,
    deviceId: deviceId,
    sessionValid: sessionValid,
    subscriptionExpired: subscriptionExpired,
    accessState: accessState,
    logout: logout,
    callApi: callApi,
    humanTransportError: humanTransportError
  };
})(window);
