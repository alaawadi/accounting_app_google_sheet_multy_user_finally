/**
 * ============================================================================
 *  دفتر التاجر — خادم تسجيل الدخول (Google Apps Script + Google Sheet)
 * ============================================================================
 *
 *  طريقة التركيب (مرة واحدة):
 *  1) أنشئ جدول Google Sheet جديد (أو استعمل جدولك الحالي).
 *  2) القائمة: Extensions ← Apps Script، ثم احذف المحتوى القديم والصق هذا الملف.
 *  3) شغّل الدالة setup() مرة واحدة (Run) واقبل الصلاحيات — إن لم تكن مربوطة بجدول
 *     اضغط Spreadsheet ID وضع معرّف جدولك يدوياً في الخانة التي ستطبعها.
 *  4) Deploy ← New deployment ← نوعه Web app:
 *        Execute as : Me
 *        Who has access : Anyone
 *     ثم انسخ الرابط المنتهي بـ /exec وضعه في ملف auth.js (GAS_URL).
 *  5) أضف مستخدمين في ورقة «المستخدمون»: رقم الهاتف + كلمة المرور (نص صريح أو SHA-256).
 *
 *  نموذج العمل:
 *  - لا توجد أي فترة تجربة مجانية: التطبيق لا يُفتح إلا بعد تسجيل دخول ناجح.
 *  - تسجيل الدخول: يتحقق الخادم من (الهاتف + كلمة المرور) مقابل ورقة «المستخدمون»،
 *    ثم يعيد تووقن جلسة صالح للاستمرار في الوصول.
 *  - أول تسجيل دخول ناجح يقيّد الحساب بالجهاز في خانة «الجهاز»، وأي جهاز آخر يحاول
 *    الدخول بالحساب نفسه يُرفض بخطأ other_device (تظهر له رسالة في صفحة الدخول).
 *    لإعادة ربط الحساب بجهاز جديد: امسح خانة «الجهاز» من صف المستخدم.
 *  - عمود «IP» محفوظ لكنه فارغ: خدمة Apps Script لا تعيد IP المُستدعي، ولم يُطلب من
 *    العميل إرساله. إن أضفت إرساله لاحقاً (payload.ip) يتفعّل منع تغيير الـ IP تلقائياً.
 *  - اشتراك الحساب الفعّال: خانتا «الاشتراك_أيام» + «بدأ_الاشتراك» في ورقة المستخدمين.
 *    الخانة الفارغة ⇦ اشتراك منتهٍ (يُمنع الدخول ويُخرج من التطبيق تلقائياً ويحوَّل
 *    لصفحة تسجيل الدخول ولو كانت كلمة المرور صحيحة). وإذا حددت الأيام دون التاريخ
 *    يبدأ الاحتساب من يوم كتابة الخانة. للتجديد: زد الأيام أو غيّر «بدأ_الاشتراك».
 *    ولتشخيص أي حساب شغّل من محرر Apps Script: diagnoseSub('059XXXXXXXX')
 *    فتطبع القيم الخام كما يقرأها الخادم (العمود 11 و 12) والسبب الدقيق للرفض.
 *
 *  ملاحظات أمنية:
 *  - كلمة المرور تُخزَّن داخل الجدول كـ SHA-256 (مع ملح ثابت) — يُشتق الملح من رقم
 *    الهاتف، فلا يفيد تسريب الجدول وحده في كشف كلمة مرور مستخدم آخر.
 *  - إن وُجدت كلمة مرور مكتوبة نصاً في الجدول فتُقبل مرة واحدة ثم تُحوَّل تلقائياً
 *    إلى SHA-256 عند أول دخول ناجح.
 *  - توجد حماية من التخمين: 8 محاولات خاطئة ثم قفل 15 دقيقة لكل رقم.
 *  - جلسة الدخول = تووقن موقّع HMAC-SHA256 بسرّ محفوظ في Script Properties.
 * ============================================================================
 */

var SHEET_NAME     = 'المستخدمون';
var TOKEN_TTL_DAYS = 30;   // صلاحية جلسة الدخول بالأيام (30 يوماً)
var MAX_ATTEMPTS   = 8;    // محاولات خاطئة متتالية قبل القفل
var LOCK_MINUTES   = 15;   // مدة القفل بعد تجاوز المحاولات
var PEPPER         = 'DaftarTajer|Auth|v1'; // ملح ثابت لتشفير كلمات المرور

/* أعمدة ورقة «المستخدمون» (ترتيب ثابت — لا تعتمد على أسماء الأعمدة) */
var COL = {
  PHONE: 1,        // رقم الهاتف
  PASS: 2,         // كلمة المرور (SHA-256)
  NAME: 3,         // الاسم (اختياري)
  STATUS: 4,       // الحالة: active / blocked
  TRIAL_START: 5,  // (عمود قديم — لم يعد مستخدماً بعد إلغاء التجربة المجانية)
  FIRST_LOGIN: 6,  // أول دخول
  LAST_LOGIN: 7,   // آخر دخول
  LOGIN_COUNT: 8,  // عدد الدخولات
  DEVICE: 9,       // الجهاز المقيَّد بالحساب (أول دخول ناجح)
  IP: 10,          // آخر IP (فارغ ما لم يُرسله العميل)
  SUB_DAYS: 11,    // مدة الاشتراك بالأيام (خانة فارغة = اشتراك منتهٍ)
  SUB_START: 12,   // بداية احتساب الاشتراك yyyy-MM-dd (يحددها المطوّر)
  STORE: 13,       // معرّف المتجر الذي ينتمي إليه الحساب (يُملأ عند إنشاء/انضمام متجر)
  ROLE: 14         // الصلاحية: admin ⇦ أدمن الداشبورد (الخانة الفارغة = مستخدم عادي)
};

/* =========================== التهيئة (تُشغَّل مرة واحدة) =========================== */
function setup() {
  var props = PropertiesService.getScriptProperties();
  var ss = getSpreadsheet_(true);
  if (!ss) {
    Logger.log('لم يُربط أي جدول. افتح هذا السكربت من داخل جدول Google Sheet (Extensions ← Apps Script)');
    Logger.log('أو ضع معرّف الجدول: Script Properties ← مفتاح SPREADSHEET_ID');
    return;
  }
  props.setProperty('SPREADSHEET_ID', ss.getId());

  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) sh = ss.insertSheet(SHEET_NAME);
  if (sh.getLastRow() === 0) {
    sh.appendRow(['الهاتف', 'كلمة_المرور', 'الاسم', 'الحالة', 'بدأت_التجربة', 'أول_دخول', 'آخر_دخول', 'عدد_الدخول', 'الجهاز', 'IP', 'الاشتراك_أيام', 'بدأ_الاشتراك', 'المتجر', 'الصلاحية']);
    sh.getRange(1, 1, 1, COL.ROLE).setFontWeight('bold').setBackground('#DCEEEC');
  }
  sh.getRange(1, COL.PHONE).setNumberFormat('@');          // الهاتف نص حتى لا تُحذف الأصفار
  sh.getRange(2, COL.PHONE, Math.max(sh.getMaxRows() - 1, 1)).setNumberFormat('@');
  sh.getRange(1, COL.TRIAL_START, Math.max(sh.getMaxRows(), 1)).setNumberFormat('@');
  sh.getRange(2, COL.DEVICE, Math.max(sh.getMaxRows() - 1, 1)).setNumberFormat('@');
  sh.getRange(1, COL.SUB_START, Math.max(sh.getMaxRows(), 1)).setNumberFormat('@');
  sh.getRange(1, COL.STORE, Math.max(sh.getMaxRows(), 1)).setNumberFormat('@');
  sh.getRange(1, COL.ROLE, Math.max(sh.getMaxRows(), 1)).setNumberFormat('@');
  sh.setFrozenRows(1);
  resolveColumns_(sh);            // يقرأ مواقع الأعمدة من رؤوسها قبل أي كتابة
  ensureSchema_(sh);            // يضيف عمودي الجهاز و IP للجداول التي أُنشئت قبل هذا التحديث
  ensureDataSheets_(ss);        // أوراق المزامنة: المنتجات/الفواتير/الزبائن/المعلّق/سجل المخزون/الإعدادات
  ensureStoresSheets_(ss);      // ورقتا المتاجر وأعضاء المتجر

  if (!props.getProperty('AUTH_SECRET')) {
    props.setProperty('AUTH_SECRET', randomSecret_());
  }

  Logger.log('تمت التهيئة بنجاح ✓');
  Logger.log('SPREADSHEET_ID = ' + ss.getId());
  Logger.log('ورقة المستخدمين: «' + SHEET_NAME + '» — أضف فيها رقم الهاتف وكلمة المرور.');
    Logger.log('أوراق المزامنة: المنتجات، الفواتير، الزبائن، المعلّق، سجل_المخزون، الإعدادات (لكل متجر صفوفه خاصة).');
  Logger.log('لإعادة ربط حساب بجهاز آخر: امسح خانة «الجهاز» من صف المستخدم في ورقة المستخدمين.');
  Logger.log('خطوة تالية: Deploy ← New deployment ← Web app (Execute as: Me / Anyone) ثم ضع الرابط في auth.js');
}

/* ================================ doGet (فحص) ================================ */
function doGet(e) {
  /* code: علامة نسخة السكربت — افتح رابط /exec في المتصفح:
     "code":"v5" ⇦ هذه هي النسخة الحالية (بلا تجربة مجانية — تسجيل دخول إلزامي)
     "code":"v4" أو أقل ⇦ النشر ما زال قديماً: أنشئ New version ثم أعد الفحص. */
  var out = { ok: true, service: 'daftar-tajer-auth', code: 'v5', subscription: true, deviceBinding: true, sync: true, freeTrial: false, time: new Date().toISOString() };
  try {
    var sh = getUserSheet_();
    out.sheet = !!sh;
    out.users = sh ? Math.max(sh.getLastRow() - 1, 0) : 0;
  } catch (err) {
    out.sheet = false;
    out.error = String(err && err.message ? err.message : err);
  }
  return respond_(out, null);
}

/* ================================ doPost ================================ */
function doPost(e) {
  var payload = {};
  try {
    payload = readPayload_(e);
  } catch (err) {
    return respond_({ ok: false, error: 'bad-request' }, payload);
  }

  try {
    var action = String(payload.action || '').toLowerCase();
    if (action === 'login')  return respond_(handleLogin_(payload), payload);
    if (action === 'verify') return respond_(handleVerify_(payload), payload);

    /* -------- المزامنة ومتجر المحاسبين (يحتاج جلسة دخول صالحة) -------- */
    if (action === 'sync_pull')  return respond_(handleSyncPull_(payload), payload);
    if (action === 'sync_push')  return respond_(handleSyncPush_(payload), payload);
    if (action === 'store_status')  return respond_(handleStoreStatus_(payload), payload);
    if (action === 'store_create')  return respond_(handleStoreCreate_(payload), payload);
    if (action === 'store_join')    return respond_(handleStoreJoin_(payload), payload);
    if (action === 'store_invite')  return respond_(handleStoreInvite_(payload), payload);
    if (action === 'store_remove')  return respond_(handleStoreRemove_(payload), payload);
    if (action === 'store_leave')   return respond_(handleStoreLeave_(payload), payload);
    if (action === 'store_member_status') return respond_(handleStoreMemberStatus_(payload), payload);

    /* -------- لوحة الأدمن (تحتاج جلسة دخول + عمود «الصلاحية» = admin) -------- */
    if (action === 'admin_list')   return respond_(handleAdminList_(payload), payload);
    if (action === 'admin_assign') return respond_(handleAdminAssign_(payload), payload);
    if (action === 'admin_create') return respond_(handleAdminCreate_(payload), payload);
    if (action === 'admin_update') return respond_(handleAdminUpdate_(payload), payload);

    return respond_({ ok: false, error: 'bad-request' }, payload);
  } catch (err) {
    // لا نُسقِط تفاصيل الخطأ داخل الشبكة
    Logger.log('doPost error: ' + err);
    return respond_({ ok: false, error: 'server' }, payload);
  }
}

function readPayload_(e) {
  if (e && e.postData && e.postData.contents) return JSON.parse(e.postData.contents);
  if (e && e.parameter && e.parameter.payload) return JSON.parse(e.parameter.payload);
  if (e && e.parameter) return e.parameter;
  return {};
}

/* ------------------------- تسجيل الدخول ------------------------- */
function handleLogin_(payload) {
  var phone = normalizePhone_(payload.phone);
  var pass  = String(payload.pass || payload.password || '');

  if (phone.length < 7 || pass.length < 4) return { ok: false, error: 'invalid' };

  /* حماية من التخمين: عدّاد محاولات لكل رقم */
  var lim = checkAttempts_(phone);
  if (lim.locked) return { ok: false, error: 'locked', waitMin: lim.waitMin };

  var sheet = getUserSheet_();
  if (!sheet) return { ok: false, error: 'server' };

  var user = findUser_(sheet, phone);
  if (!user) {
    bumpAttempts_(lim.key, lim.state);
    return { ok: false, error: 'invalid' };
  }

  var stored = String(user.pass === null || user.pass === undefined ? '' : user.pass).trim();
  var hashed = hashPassword_(phone, pass);
  var match = (stored === hashed) || (stored.length > 0 && stored === pass);
  if (!match) {
    bumpAttempts_(lim.key, lim.state);
    return { ok: false, error: 'invalid' };
  }

  /* ترقية كلمة المرور المكتوبة نصياً إلى SHA-256 */
  if (stored !== hashed) {
    try { sheet.getRange(user.row, COL.PASS).setValue(hashed); } catch (err) { /* تجاهل */ }
  }

  if (isBlocked_(user)) return { ok: false, error: 'blocked' };

  /* موظف/محاسب معطَّل من صاحب المتجر ⇦ يُمنع تسجيل الدخول نهائياً */
  if (memberStatusFor_(user) === 'disabled') return { ok: false, error: 'member_disabled' };

  /* ربط الحساب بجهاز واحد:
     - أول دخول ناجح يقيّد الحساب بهذا الجهاز في خانة «الجهاز».
     - بعده يُرفض أي جهاز آخر يحاول الدخول بالحساب نفسه (other_device).
     - إن أرسل العميل IP وكان للحساب IP مسجّل، فالاختلاف بينهما يُرفض أيضاً. */
  var device   = String(payload.device || '').trim();
  var bound    = String(user.device || '').trim();
  var ip       = String(payload.ip || '').trim();
  var boundIp  = String(user.ip || '').trim();

  /* لا دخول من جهاز بلا هوية: لا يمكن تقييده بالجهاز الأول */
  if (!device) return { ok: false, error: 'no_device' };
  if (bound && device !== bound) return { ok: false, error: 'other_device' };
  if (boundIp && ip && ip !== boundIp) return { ok: false, error: 'other_device' };
  if (!bound) {
    try { sheet.getRange(user.row, COL.DEVICE).setValue(device.slice(0, 64)); } catch (err) { /* تجاهل */ }
  }
  if (ip) {
    try { sheet.getRange(user.row, COL.IP).setValue(ip.slice(0, 64)); } catch (err) { /* تجاهل */ }
  }

  /* اشتراك الحساب الفعّال: انتهى ⇦ يُمنع الدخول ولو كانت كلمة المرور صحيحة */
  ensureSubStart_(sheet, user);
  var sub = subInfo_(user);
  if (!sub) return { ok: false, error: 'sub_expired', subLeft: 0, subDays: 0, subDebug: subDebug_(user) };

  var now = new Date();
  try {
    sheet.getRange(user.row, COL.LAST_LOGIN).setValue(now);
    sheet.getRange(user.row, COL.LOGIN_COUNT).setValue((user.count || 0) + 1);
    if (!user.firstLogin) sheet.getRange(user.row, COL.FIRST_LOGIN).setValue(now);
  } catch (err) { /* تجاهل */ }

  /* نظّف عدّاد المحاولات بعد نجاح الدخول */
  try { PropertiesService.getScriptProperties().deleteProperty(lim.key); } catch (err) { /* تجاهل */ }

  var t = makeToken_(phone);
  return {
    ok: true,
    phone: phone,
    name: String(user.name || ''),
    role: isAdmin_(user) ? 'admin' : '',
    token: t.token,
    exp: t.exp,
    subEnd: sub.endMs,
    subLeft: sub.daysLeft,
    subStart: sub.startISO,
    subDays: sub.days
  };
}

/* ------------------- التحقق من الجلسة (بدون كلمة مرور) ------------------- */
function handleVerify_(payload) {
  var phone = normalizePhone_(payload.phone);
  if (!phone || !checkToken_(phone, payload.token)) return { ok: false, error: 'session' };

  var sheet = getUserSheet_();
  if (!sheet) return { ok: false, error: 'server' };

  var user = findUser_(sheet, phone);
  if (!user) return { ok: false, error: 'session' };
  if (isBlocked_(user)) return { ok: false, error: 'blocked' };

  /* موظف معطَّل من صاحب المتجر ⇦ يُطرد فوراً من التطبيق (خروج تلقائي) */
  if (memberStatusFor_(user) === 'disabled') return { ok: false, error: 'member_disabled' };

  /* الحساب مقيد بجهاز آخر؟ (يُطرد فوراً من التطبيق إن سرق أحد توكنه) */
  var bound2 = String(user.device || '').trim();
  if (bound2 && String(payload.device || '').trim() !== bound2) return { ok: false, error: 'other_device' };

  /* انتهى الاشتراك ⇦ يُخرج من التطبيق ويحوَّل لصفحة تسجيل الدخول */
  ensureSubStart_(sheet, user);
  var subv = subInfo_(user);
  if (!subv) return { ok: false, error: 'sub_expired', subLeft: 0, subDays: 0, subDebug: subDebug_(user) };

  return {
    ok: true,
    phone: phone,
    role: isAdmin_(user) ? 'admin' : '',
    subEnd: subv.endMs,
    subLeft: subv.daysLeft,
    subStart: subv.startISO,
    subDays: subv.days
  };
}

/* ================================ أدوات ================================ */

function getSpreadsheet_(createIfMissing) {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('SPREADSHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss && createIfMissing) return null;
  return ss;
}

function getUserSheet_() {
  var ss = getSpreadsheet_(false);
  if (!ss) throw new Error('SPREADSHEET_ID is not set');
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) throw new Error('sheet not found: ' + SHEET_NAME);
  if (!SCHEMA_DONE) { resolveColumns_(sh); ensureSchema_(sh); SCHEMA_DONE = true; }   // يُشغَّل مرة لكل نداء
  return sh;
}
var SCHEMA_DONE = false;
var COL_DONE = false;

/* تحديد مواقع الأعمدة من رؤوسها (يُشغَّل مرة لكل نداء):
   الترتيب الافتراضي في COL هو المرجع، لكن إن وُجد العمود باسمه في موضع آخر —
   مثلاً بعد إضافة عمود جديد قبلهما — نستعمل موضعه الحقيقي بدل قراءة خانة فارغة. */
function resolveColumns_(sh) {
  if (COL_DONE) return;
  COL_DONE = true;
  try {
    var n = sh.getLastColumn();
    if (n < 1) return;
    var raw = sh.getRange(1, 1, 1, n).getValues()[0];
    var heads = [];
    for (var i = 0; i < raw.length; i++) heads.push(normHead_(raw[i]));
    var want = {
      PHONE:       ['الهاتف', 'رقم الهاتف', 'الموبايل', 'phone'],
      PASS:        ['كلمة_المرور', 'باسورد', 'password', 'pass'],
      NAME:        ['الاسم', 'name'],
      STATUS:      ['الحالة', 'status'],
      TRIAL_START: ['بدأت_التجربة', 'بداية_التجربة', 'trial_start'],
      FIRST_LOGIN: ['أول_دخول', 'first_login'],
      LAST_LOGIN:  ['آخر_دخول', 'last_login'],
      LOGIN_COUNT: ['عدد_الدخول', 'عدد_الدخولولات', 'logins'],
      DEVICE:      ['الجهاز', 'device'],
      IP:          ['IP', 'آي_بي', 'اي_بي'],
      SUB_DAYS:    ['الاشتراك_أيام', 'اشتراك_أيام', 'أيام_الاشتراك', 'مدة_الاشتراك', 'عدد_أيام_الاشتراك'],
      SUB_START:   ['بدأ_الاشتراك', 'بدء_الاشتراك', 'بداية_الاشتراك', 'تاريخ_الاشتراك', 'تاريخ_البداية', 'تاريخ_البدايه'],
      STORE:       ['المتجر', 'store', 'store_id', 'معرّف_المتجر', 'معرف_المتجر'],
      ROLE:        ['الصلاحية', 'صلاحية', 'نوع_الحساب', 'role', 'permission']
    };
    var found = {};
    for (var key in want) {
      if (!Object.prototype.hasOwnProperty.call(want, key)) continue;
      var col = findCol_(heads, want[key]);
      if (col > 0) found[key] = col;
    }
    for (var k2 in found) {
      if (Object.prototype.hasOwnProperty.call(found, k2)) COL[k2] = found[k2];
    }
  } catch (err) { /* نبقى على الترتيب الافتراضي */ }
}

/* تطبيع عنوان العمود: إزالة المسافات/الشرطات/التشكيل وتوحيد الألف والياء والتاء */
function normHead_(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/[\u00A0\u200B-\u200F\u202A-\u202E\uFEFF]/g, '')
    .replace(/[\s_\-\.]+/g, '')
    .replace(/[\u064B-\u0652\u0670\u0640]/g, '')
    .replace(/[\u0623\u0625\u0622]/g, '\u0627')
    .replace(/\u0649/g, '\u064A')
    .replace(/\u0629/g, '\u0647')
    .replace(/\u0640/g, '')
    .toLowerCase();
}

/* إيجاد رقم العمود: أولًا بالاسم الأساسي، ثم بالبدائل */
function findCol_(heads, names) {
  for (var pass = 0; pass < 2; pass++) {
    for (var i = 0; i < names.length; i++) {
      if (pass === 0 && i !== 0) continue;
      if (pass === 1 && i === 0) continue;
      var w = normHead_(names[i]);
      for (var c = 0; c < heads.length; c++) if (heads[c] && heads[c] === w) return c + 1;
    }
  }
  return 0;
}

/* يضيف رؤوس الأعمدة الجديدة للجداول القديمة (تُشغَّل مرة لكل نداء) */
function ensureSchema_(sh) {
  try {
    var wide = Math.max(COL.SUB_DAYS, COL.SUB_START, COL.STORE, COL.ROLE);
    var head = sh.getRange(1, 1, 1, wide).getValues()[0];
    var wanted = [
      [COL.DEVICE, 'الجهاز'],
      [COL.IP, 'IP'],
      [COL.SUB_DAYS, 'الاشتراك_أيام'],
      [COL.SUB_START, 'بدأ_الاشتراك'],
      [COL.STORE, 'المتجر'],
      [COL.ROLE, 'الصلاحية']
    ];
    var changed = false;
    for (var i = 0; i < wanted.length; i++) {
      if (String(head[wanted[i][0] - 1] || '').trim()) continue;
      sh.getRange(1, wanted[i][0]).setValue(wanted[i][1]);
      changed = true;
    }
    if (changed) {
      sh.getRange(1, 1, 1, wide).setFontWeight('bold').setBackground('#DCEEEC');
      sh.getRange(2, COL.DEVICE, Math.max(sh.getMaxRows() - 1, 1)).setNumberFormat('@');
      sh.getRange(2, COL.IP, Math.max(sh.getMaxRows() - 1, 1)).setNumberFormat('@');
      sh.getRange(2, COL.SUB_START, Math.max(sh.getMaxRows() - 1, 1)).setNumberFormat('@');
      sh.getRange(2, COL.STORE, Math.max(sh.getMaxRows() - 1, 1)).setNumberFormat('@');
      sh.getRange(2, COL.ROLE, Math.max(sh.getMaxRows() - 1, 1)).setNumberFormat('@');
    }
  } catch (err) { /* لا نُفشل الدخول بسبب تنسيق */ }
}

/* قراءة تاريخ عمود «بدأ_الاشتراك» (وأعمدة التواريخ الأخرى):
   - خلية تاريخية من الشيت ⇦ كائن Date ⇦ تُحوَّل إلى yyyy-MM-dd.
   - نص بصيغ شائعة ⇦ yyyy-MM-dd أو yyyy/MM/dd أو d/M/yyyy أو dd-MM-yyyy أو d/M/yy
     (العمود مُنسَّق كنص @ لذا ما يكتبه المطوّر يبقى نصاً بصيغة الجهاز).
   - الصف الأخير الغامض (د/ش أيهما؟) يُحسم حسب لغة الجدول: dd/mm/yyyy افتراضياً
     (لغات مثل العربية وأوروبا)، وmm/dd/yyyy لغات مثل en_US.
   - أي تاريخ مستقبلي يُرفض ⇦ يُحسب من اليوم. تُرجع null عند الرجوع. */
function toStartISO_(v) {
  if (v === null || v === undefined) return null;
  if (Object.prototype.toString.call(v) === '[object Date]') {
    var d = v;
    if (isNaN(d.getTime())) return null;
    return validPast_(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }
  var s = String(v).replace(/[\u00A0\u2000-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g, ' ').trim();
  if (!s) return null;
  var m = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})(?!\d)/);
  if (m) return validPast_(Number(m[1]), Number(m[2]), Number(m[3]));
  m = s.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})(?!\d)/);
  if (m) {
    var a = Number(m[1]), b = Number(m[2]), y = Number(m[3]);
    if (a > 12) return validPast_(y, b, a);                 /* a لا شك أنه يوم */
    if (b > 12) return validPast_(y, a, b);                 /* b يوم ⇦ a شهر */
    return monthFirst_() ? validPast_(y, a, b) : validPast_(y, b, a);   /* غامض ⇦ حسب لغة الجدول */
  }
  m = s.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2})(?!\d)/);
  if (m) {
    var a2 = Number(m[1]), b2 = Number(m[2]), y2 = 2000 + Number(m[3]);
    if (a2 > 12) return validPast_(y2, b2, a2);
    if (b2 > 12) return validPast_(y2, a2, b2);
    return monthFirst_() ? validPast_(y2, a2, b2) : validPast_(y2, b2, a2);
  }
  return null;
}

/* تاريخ حقيقي صالح ولا يكون في المستقبل — وإلا null */
function validPast_(y, mo, d) {
  if (!(y >= 1970 && y <= 2200 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
  var dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  var iso = y + '-' + ('0' + mo).slice(-2) + '-' + ('0' + d).slice(-2);
  if (iso > today_()) return null;
  return iso;
}

/* هل لغة الجدول month-first (مثل en_US)؟ الافتراضي day-first dd/mm/yyyy */
var MONTH_FIRST = null;
function monthFirst_() {
  if (MONTH_FIRST !== null) return MONTH_FIRST;
  MONTH_FIRST = false;
  try {
    var loc = String(SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetLocale() || '');
    MONTH_FIRST = /^(en_US|en_PR|en_AS|en_UM|en_VI|en_PH|fil_PH|tl_PH|en_JM)/.test(loc);
  } catch (err) { /* بلا صلاحية ⇦ الافتراضي day-first */ }
  return MONTH_FIRST;
}

/* يكتب «بدأ_الاشتراك» تلقائياً إن كان المطوّر حدّد الأيام ولم يحدّد التاريخ بعد */
function ensureSubStart_(sheet, user) {
  if (String(user.subStart === null || user.subStart === undefined ? '' : user.subStart).trim()) return;
  var days = toDays_(user.subDays);
  if (!isFinite(days)) return;
  try { sheet.getRange(user.row, COL.SUB_START).setValue(today_()); } catch (err) { /* تجاهل */ }
  user.subStart = today_();
}

/* حالة اشتراك الحساب الفعّال:
   - «الاشتراك_أيام» فارغة أو غير صالحة ⇦ اشتراك منتهٍ (لا وصول ولو بكلمة مرور صحيحة).
   - «بدأ_الاشتراك» فارغة ⇦ تبدأ من اليوم (تُكتب تلقائياً عند أول دخول).
   يعيد null عند الانتهاء، أو { days, startISO, endMs, daysLeft }. */
function subInfo_(user) {
  var days = toDays_(user.subDays);
  if (!isFinite(days)) return null;
  var start = toStartISO_(user.subStart) || today_();
  var endMs = Date.parse(start + 'T00:00:00') + days * 86400000;
  if (!isFinite(endMs) || Date.now() >= endMs) return null;
  return { days: days, startISO: start, endMs: endMs, daysLeft: Math.ceil((endMs - Date.now()) / 86400000) };
}

/* قراءة خانة «الاشتراك_أيام» بشكل متساهل:
   - يزيل المسافات والعلامات غير المرئية (RTL / LRM / NBSP / ZWSP / ‎‏ …).
   - يحوّل الأرقام العربية ٣٠ والهندية ۳۰ إلى 30.
   - يقبل النص الذي يحوي رقماً واحداً فقط («30 يوم» مثلاً) ويرفض ما يحوي أكثر من رقم
     (مثل التواريخ 2026-08-01) وما هو فارغ أو صفراً أو رقماً سالباً.
   يعيد NaN عند الرفض، ولهذا تُعدّ الخانة اشتراكاً منتهياً. */
function toDays_(v) {
  if (v === null || v === undefined) return NaN;
  /* تاريخ داخل خانة الأيام ⇦ العمود غير صحيح، لا نُحوّله إلى عدد أيام */
  if (Object.prototype.toString.call(v) === '[object Date]') return NaN;
  if (typeof v === 'number') return (isFinite(v) && v > 0) ? Math.floor(v) : NaN;
  var s = String(v).replace(/[\u00A0\u2000-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g, ' ');
  s = s.replace(/[\u0660-\u0669]/g, function (d) { return String(d.charCodeAt(0) - 0x0660); })
       .replace(/[\u06F0-\u06F9]/g, function (d) { return String(d.charCodeAt(0) - 0x06F0); });
  var nums = s.match(/[-+]?\d+(?:\.\d+)?/g);
  if (!nums || nums.length !== 1) return NaN;
  if (/^[-+]/.test(nums[0])) return NaN;   /* -5 أو +5 ليست مدة صحيحة */
  var n = Math.floor(Number(nums[0]));
  return (isFinite(n) && n > 0) ? n : NaN;
}

/* مثل toDays_ لكن يقبل صفر ⇦ صفر أيام يعني اشتراكاً منتهياً والحالة موقوفة
   (يُستعمل في مسارات الداشبورد: admin_create / admin_update فقط). */
function toAdminDays_(v) {
  if (v === null || v === undefined) return NaN;
  if (Object.prototype.toString.call(v) === '[object Date]') return NaN;
  if (typeof v === 'number') return (isFinite(v) && v >= 0) ? Math.floor(v) : NaN;
  var s = String(v).replace(/[\u00A0\u2000-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g, ' ');
  s = s.replace(/[\u0660-\u0669]/g, function (d) { return String(d.charCodeAt(0) - 0x0660); })
       .replace(/[\u06F0-\u06F9]/g, function (d) { return String(d.charCodeAt(0) - 0x06F0); });
  var nums = s.match(/[-+]?\d+(?:\.\d+)?/g);
  if (!nums || nums.length !== 1) return NaN;
  if (/^[-+]/.test(nums[0])) return NaN;
  var n = Math.floor(Number(nums[0]));
  return (isFinite(n) && n >= 0) ? n : NaN;
}

/* نص الخانة الخام كما يراها الخادم (للتشخيص) — القيم التاريخية تُطبع yyyy-MM-dd */
function rawToText_(v) {
  if (v === null || v === undefined) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    if (isNaN(v.getTime())) return '';
    try { return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd'); }
    catch (err) { return String(v.toISOString()).slice(0, 10); }
  }
  return String(v);
}

/* نوع القيمة كما تصل من الشيت: number / string / date / null / undefined */
function typeName_(v) {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (Object.prototype.toString.call(v) === '[object Date]') return 'date';
  return typeof v;
}

/* تفاصيل فشل الاشتراك — تُرسَل مع الخطأ إلى صفحة الدخول حتى تظهر سببه بالضبط
   (خانة غير رقمية؟ عمود غلط؟ مدة منتهية فعلاً؟ صف مكرر؟) بدل رسالة عامة. */
function subDebug_(user) {
  var days  = toDays_(user.subDays);
  var start = toStartISO_(user.subStart) || (isFinite(days) ? today_() : '');
  var dbg = {
    row: user.row,
    rows: (user.allRows && user.allRows.length) ? user.allRows : [user.row],
    colDays: COL.SUB_DAYS,
    daysRaw: rawToText_(user.subDays),
    daysType: typeName_(user.subDays),
    days: isFinite(days) ? days : 0,
    colStart: COL.SUB_START,
    startRaw: rawToText_(user.subStart),
    startType: typeName_(user.subStart),
    startISO: start,
    today: today_(),
    reason: 'ok'
  };
  if (!isFinite(days)) dbg.reason = 'days';
  else if (!start) { dbg.reason = 'start'; }
  else {
    var endMs = Date.parse(start + 'T00:00:00') + days * 86400000;
    if (!isFinite(endMs)) dbg.reason = 'start';
    else {
      var d = new Date(endMs);
      dbg.endISO = d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
      dbg.left = Math.ceil((endMs - Date.now()) / 86400000);
      if (Date.now() >= endMs) dbg.reason = 'ended';
    }
  }
  if (dbg.reason === 'ok') dbg.reason = 'unknown';
  return dbg;
}

function normalizePhone_(v) {
  var d = String(v === null || v === undefined ? '' : v).replace(/\D+/g, '');
  return d.replace(/^00/, '').replace(/^0+/, '');
}

function isBlocked_(user) {
  var st = String(user.status || '').trim().toLowerCase();
  return (st === 'blocked' || st === '0' || st === 'موقوف');
}

/* هل هذا الحساب أدمن (مسؤول الداشبورد)؟ القيمة في عمود «الصلاحية» من ورقة المستخدمين */
function isAdmin_(user) {
  if (!user) return false;
  var r = String(user.role || '').trim().toLowerCase();
  return (r === 'admin' || r === 'أدمن' || r === 'ادمن' || r === 'مدير');
}

function today_() {
  var d = new Date();
  return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
}

function findUser_(sheet, phone) {
  var last = sheet.getLastRow();
  if (last < 2) return null;
  var width = Math.max(COL.SUB_DAYS, COL.SUB_START, COL.STORE, COL.ROLE);
  var values = sheet.getRange(2, 1, last - 1, width).getValues();
  var found = null;
  var allRows = [];
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    if (normalizePhone_(row[COL.PHONE - 1]) !== phone) continue;
    allRows.push(i + 2);
    if (found) continue;              /* الأول هو المستخدم — والباقي يُبلَّغ عنه في التشخيص */
    found = {
      row: i + 2,
      phone: phone,
      pass: row[COL.PASS - 1],
      name: row[COL.NAME - 1],
      status: row[COL.STATUS - 1],
      trialStart: toStartISO_(row[COL.TRIAL_START - 1]),
      firstLogin: row[COL.FIRST_LOGIN - 1],
      lastLogin: row[COL.LAST_LOGIN - 1],
      count: Number(row[COL.LOGIN_COUNT - 1]) || 0,
      device: row[COL.DEVICE - 1],
      ip: row[COL.IP - 1],
      subDays: row[COL.SUB_DAYS - 1],
      subStart: row[COL.SUB_START - 1],
      store: row[COL.STORE - 1],
      role: String(row[COL.ROLE - 1] === null || row[COL.ROLE - 1] === undefined ? '' : row[COL.ROLE - 1]).trim().toLowerCase(),
      allRows: allRows
    };
  }
  if (found) found.allRows = allRows;
  return found;
}

/* ========================== تشخيص اشتراك حساب ==========================
   شغّلها من محرر Apps Script مع رقم الحساب لترى بالضبط ما يقرأه الخادم:
     diagnoseSub('0591234567')
   تطبع: رؤوس الأعمدة بأرقامها، الصفوف المطابقة للرقم، القيم الخام ونوعها
   في خانتي «الاشتراك_أيام» و«بدأ_الاشتراك»، والنتيجة المحسوبة للاشتراك. */
function diagnoseSub(phoneRaw) {
  var phone = normalizePhone_(phoneRaw);
  var sheet = getUserSheet_();
  if (!sheet) { Logger.log('لا توجد ورقة «' + SHEET_NAME + '»'); return; }

  var cols = Math.max(sheet.getLastColumn(), COL.SUB_DAYS, COL.SUB_START);
  var head = sheet.getRange(1, 1, 1, cols).getValues()[0];
  try {
    Logger.log('لغة الجدول: ' + SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetLocale() +
      ' — تفسير الصيغة الغامضة (2/10/2026): ' + (monthFirst_() ? 'mm/dd/yyyy ⇦ 10 فبراير' : 'dd/mm/yyyy ⇦ 2 أكتوبر'));
  } catch (err) { /* تجاهل */ }
  Logger.log('=== رؤوس الأعمدة (كما يقرأها الكود) ===');
  for (var c = 0; c < head.length; c++) {
    var mark = (c + 1 === COL.SUB_DAYS) ? '  ← خانة الأيام' : (c + 1 === COL.SUB_START) ? '  ← خانة بداية الاشتراك' : '';
    Logger.log('عمود ' + (c + 1) + ' = «' + String(head[c] === undefined || head[c] === null ? '' : head[c]) + '»' + mark);
  }

  var last = sheet.getLastRow();
  Logger.log('عدد صفوف المستخدمين: ' + Math.max(last - 1, 0));
  if (!phone) { Logger.log('اكتب رقم الحساب: diagnoseSub("059XXXXXXXX")'); return; }

  var user = findUser_(sheet, phone);
  if (!user) { Logger.log('لا يوجد صف بهذا الرقم (بعد تطبيع الأصفار): ' + phone); return; }

  Logger.log('=== الحساب ' + phone + ' ===');
  Logger.log('الصف المستخدم: ' + user.row + ' — كل الصفوف المطابقة: ' + user.allRows.join(', ') +
             (user.allRows.length > 1 ? '  (يوجد تكرار! احذف الصفوف الزائدة)' : ''));
  Logger.log('عمود ' + COL.SUB_DAYS + ' «الاشتراك_أيام» = «' + rawToText_(user.subDays) + '» | النوع: ' +
             typeName_(user.subDays) + ' | يُقرأ كـ: ' + toDays_(user.subDays));
  Logger.log('عمود ' + COL.SUB_START + ' «بدأ_الاشتراك» = «' + rawToText_(user.subStart) + '» | النوع: ' +
             typeName_(user.subStart) + ' | ISO: ' + (toStartISO_(user.subStart) || '(غير صالح ⇦ يبدأ من اليوم)'));
  var sub = subInfo_(user);
  Logger.log(sub
    ? 'النتيجة: اشتراك ساري — ينتهي ' + rawToText_(new Date(sub.endMs)) + ' (متبقٍ ' + sub.daysLeft + ' يوم)'
    : 'النتيجة: لا اشتراك ساري ⇦ يعيد الخادم sub_expired (السبب: ' + subDebug_(user).reason + ')');
  Logger.log('subDebug = ' + JSON.stringify(subDebug_(user)));
}

/* ---------------------- تشفير كلمة المرور ---------------------- */
function hashPassword_(phone, pass) {
  var data = PEPPER + '|' + phone + '|' + pass;
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, data, Utilities.Charset.UTF_8);
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i];
    if (b < 0) b += 256;
    hex += (b < 16 ? '0' : '') + b.toString(16);
  }
  return hex;
}

/* ---------------------- الجلسة (تووقن موقّع) ---------------------- */
function getSecret_() {
  var props = PropertiesService.getScriptProperties();
  var s = props.getProperty('AUTH_SECRET');
  if (!s) {
    s = randomSecret_();
    props.setProperty('AUTH_SECRET', s);
  }
  return s;
}

function randomSecret_() {
  try {
    return Utilities.base64Encode(Utilities.getRandomValues(new Uint8Array(32)));
  } catch (err) {
    return Utilities.getUuid() + Utilities.getUuid() + Date.now();
  }
}

function hmac_(data) {
  var bytes = Utilities.computeHmacSha256Signature(data, getSecret_(), Utilities.Charset.UTF_8);
  return Utilities.base64Encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function makeToken_(phone) {
  var exp = Date.now() + TOKEN_TTL_DAYS * 86400000;
  var sig = hmac_(phone + '|' + exp);
  return { token: sig + '.' + exp, exp: exp };
}

function checkToken_(phone, token) {
  if (!token || typeof token !== 'string') return false;
  var i = token.lastIndexOf('.');
  if (i <= 0) return false;
  var exp = parseInt(token.slice(i + 1), 10);
  if (!isFinite(exp) || Date.now() > exp) return false;
  return hmac_(phone + '|' + exp) === token.slice(0, i);
}

/* ---------------------- حماية من التخمين ---------------------- */
function checkAttempts_(phone) {
  var key = 'att_' + phone;
  var props = PropertiesService.getScriptProperties();
  var now = Date.now();
  var state = { n: 0, t: now };
  try {
    var raw = props.getProperty(key);
    if (raw) {
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') state = { n: Number(parsed.n) || 0, t: Number(parsed.t) || now };
    }
  } catch (err) { /* تجاهل */ }

  if (now - state.t > LOCK_MINUTES * 60000) state = { n: 0, t: now };
  if (state.n >= MAX_ATTEMPTS) {
    return { locked: true, waitMin: Math.max(1, Math.ceil((state.t + LOCK_MINUTES * 60000 - now) / 60000)), key: key, state: state };
  }
  return { locked: false, key: key, state: state };
}

function bumpAttempts_(key, state) {
  try {
    state.n = (state.n || 0) + 1;
    if (!state.t) state.t = Date.now();
    PropertiesService.getScriptProperties().setProperty(key, JSON.stringify(state));
  } catch (err) { /* تجاهل */ }
}

/* ---------------------- إرسال الرد (JSON أو HTML+postMessage) ---------------------- */
function respond_(obj, payload) {
  var wantHtml = !!(payload && (payload.transport === 'html' || payload.nonce));

  if (wantHtml) {
    var msg = {
      __dtAuth: 1,
      nonce: String(payload.nonce || ''),
      ok: obj && obj.ok === true
    };
    /* نمرّر كل مفاتيح الرد (بيانات المزامنة، المتجر، الأعضاء …) عدا مفاتيح النقل نفسها */
    var skip = { __dtAuth: 1, nonce: 1, transport: 1, action: 1, device: 1 };
    if (obj) {
      for (var k in obj) {
        if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
        if (skip[k]) continue;
        msg[k] = obj[k];
      }
    }
    var json = JSON.stringify(msg).replace(/</g, '\\u003c');
    var html = '<!doctype html><html><head><meta charset="utf-8"><title>dft</title></head><body>' +
      '<script>try{parent.postMessage(' + json + ",'*');}catch(e){}<\/script>" +
      '</body></html>';
    return HtmlOutputFrom_(html);
  }

  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* تفعيل عرض الرد داخل iframe على نطاق آخر (المسار الاحتياطي في auth.js) */
function HtmlOutputFrom_(html) {
  var out = ContentService.createHtmlOutput(html);
  try {
    out.setXFrameOptionsMode(HtmlOutput.XFrameOptionsMode.ALLOWALL);
  } catch (err) { /* بيئة قديمة */ }
  return out;
}

/* ============================================================================
 *  قسم المزامنة — تخزين المنتجات والفواتير والزبائن (والمعلّق وسجل المخزون
 *  والإعدادات) في أوراق Google Sheet، مع عزل تام بين المتاجر.
 *
 *  المبادئ:
 *  1) كل صف في أوراق البيانات يحمل «المتجر» — والخادم يفلتر ويكتب بالمتجر
 *     المسجَّل للحساب فقط، ولا يقبل معرّف متجر من العميل أبداً (عزل حقيقي).
 *  2) «الختم» رقم تصاعدي (ميلي ثانية) يكتبه الخادم وقت الكتابة، وهو مؤشر
 *     الاسترجاع (cursor) عند العميل: يسحب كل ما هو أحدث منه فقط.
 *  3) الحل نزاعات: الأحدث رقماً يفوز (LWW) — يُقارن رقم «_rev» المكتوب داخل
 *     البيانات (كتبه العميل وقت التعديل) برقم «_rev» في الصف الموجود.
 *  4) الحذف ليس مسحاً: يُكتب عمود «محذوف = 1» مع بقاء الصف ليصل الحذف لكل
 *     الأجهزة (tombstone).
 *  5) كل سجل يحفظ «أضافه» و«عدّله» = رقم هاتف المحاسب الذي نفّذ الإجراء.
 *  6) التجزئة: البيانات JSON تُخزَّن في خلايا (البيانات … البيانات_4) لأن
 *     خلية الشيت لا تقبل أكثر من 50 ألف حرف.
 * ========================================================================== */

var ENTITIES = {
  products:  'المنتجات',
  customers: 'الزبائن',
  invoices:  'الفواتير',
  pending:   'المعلّق',
  stockLog:  'سجل_المخزون',
  settings:  'الإعدادات'
};

/* أعمدة أوراق البيانات (ترتيب ثابت) */
var DATA_HEAD = ['المعرّف', 'المتجر', 'الختم', 'محذوف', 'أضافه', 'عدّله', 'الاسم',
                 'البيانات', 'البيانات_2', 'البيانات_3', 'البيانات_4'];
var DATA_COLS = DATA_HEAD.length;      // 11
var CHUNK = 45000;                     // حجم قطعة داخل الخلية (حد الشيت 50 ألف)
var CHUNKS = 4;                        // أقصى عدد قطع = 180 ألف حرف
var MAX_PUSH_ROWS = 20;                // أقصى صفوف في نداء رفع واحد
var MAX_PULL_ROWS = 60;                // أقصى صفوف في نداء سحب واحد

var STORES_SHEET   = 'المتاجر';
var STORES_HEAD    = ['المتجر', 'الكود', 'الاسم', 'المالك', 'أنشأ_في', 'الحالة', 'الإصدارات'];
var MEMBERS_SHEET  = 'أعضاء_المتجر';
var MEMBERS_HEAD   = ['المتجر', 'الهاتف', 'الدور', 'الحالة', 'أضافه', 'أُضيف_في'];
var STORE_CODE_RE  = /^[A-Z2-9]{5,10}$/;

/* =========================== تهيئة الأوراق =========================== */
function ensureDataSheets_(ss) {
  for (var key in ENTITIES) {
    if (!Object.prototype.hasOwnProperty.call(ENTITIES, key)) continue;
    ensurePlainSheet_(ss, ENTITIES[key], DATA_HEAD, '#E8F1EC');
  }
}

function ensureStoresSheets_(ss) {
  ensurePlainSheet_(ss, STORES_SHEET, STORES_HEAD, '#DCEEEC');
  ensurePlainSheet_(ss, MEMBERS_SHEET, MEMBERS_HEAD, '#DCEEEC');
}

function ensurePlainSheet_(ss, name, head, color) {
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(head);
  } else if (sh.getLastRow() === 0) {
    sh.appendRow(head);
  }
  try {
    /* شيت قديم ⇦ عمود جديد بلا عنوان: نُكمل العنوان المفقود قبل أي قراءة بالفهرس */
    var headVals = sh.getRange(1, 1, 1, head.length).getValues()[0];
    var headFix = false;
    for (var hi = 0; hi < head.length; hi++) {
      if (String(headVals[hi] === null || headVals[hi] === undefined ? '' : headVals[hi]) !== String(head[hi] || '')) { headFix = true; break; }
    }
    if (headFix) sh.getRange(1, 1, 1, head.length).setValues([head]);
    sh.getRange(1, 1, 1, head.length).setFontWeight('bold').setBackground(color);
    sh.setFrozenRows(1);
    sh.getRange(2, 1, Math.max(sh.getMaxRows() - 1, 1), head.length).setNumberFormat('@');
  } catch (err) { /* تنسيق اختياري */ }
  return sh;
}

function getEntitySheet_(ss, entity) {
  var name = ENTITIES[entity];
  if (!name) return null;
  var sh = ss.getSheetByName(name);
  if (!sh) { ensureDataSheets_(ss); sh = ss.getSheetByName(name); }
  return sh;
}

function getStoresSheet_(ss) {
  var sh = ss.getSheetByName(STORES_SHEET);
  if (!sh) { ensureStoresSheets_(ss); sh = ss.getSheetByName(STORES_SHEET); }
  return sh;
}

function getMembersSheet_(ss) {
  var sh = ss.getSheetByName(MEMBERS_SHEET);
  if (!sh) { ensureStoresSheets_(ss); sh = ss.getSheetByName(MEMBERS_SHEET); }
  return sh;
}

/* ======================= مصادقة نداء المزامنة ======================= */
function authStore_(payload) {
  var phone = normalizePhone_(payload.phone);
  if (!phone || !checkToken_(phone, payload.token)) return { error: 'session' };

  var sheet = getUserSheet_();
  if (!sheet) return { error: 'server' };

  var user = findUser_(sheet, phone);
  if (!user) return { error: 'session' };
  if (isBlocked_(user)) return { error: 'blocked' };

  ensureSubStart_(sheet, user);
  if (!subInfo_(user)) return { error: 'sub_expired' };

  return {
    sheet: sheet,
    user: user,
    phone: phone,
    name: String(user.name || '').trim(),
    storeId: String(user.store === null || user.store === undefined ? '' : user.store).trim()
  };
}

function storeError_(a) {
  return a && a.error ? { ok: false, error: a.error } : { ok: false, error: 'server' };
}

/* ===================== قراءة/كتابة صفوف البيانات ===================== */
function readDataRows_(sh) {
  var out = { map: {}, maxStamp: 0 };
  var last = sh.getLastRow();
  if (last < 2) return out;
  var width = Math.max(sh.getLastColumn(), DATA_COLS);
  var vals = sh.getRange(2, 1, last - 1, width).getValues();
  for (var i = 0; i < vals.length; i++) {
    var r = vals[i];
    var id = String(r[0] === null || r[0] === undefined ? '' : r[0]).trim();
    if (!id) continue;
    var stamp = Number(r[2]) || 0;
    var data = String(r[7] || '') + String(r[8] || '') + String(r[9] || '') + String(r[10] || '');
    out.map[id] = {
      row: i + 2,
      store: String(r[1] === null || r[1] === undefined ? '' : r[1]).trim(),
      stamp: stamp,
      del: (String(r[3]).toLowerCase() === '1' || String(r[3]).toLowerCase() === 'true'),
      cr: String(r[4] === null || r[4] === undefined ? '' : r[4]).trim(),
      by: String(r[5] === null || r[5] === undefined ? '' : r[5]).trim(),
      name: String(r[6] === null || r[6] === undefined ? '' : r[6]),
      data: data
    };
    if (stamp > out.maxStamp) out.maxStamp = stamp;
  }
  return out;
}

function safeParse_(s) {
  if (!s) return null;
  try { var o = JSON.parse(s); return (o && typeof o === 'object') ? o : null; }
  catch (err) { return null; }
}

function chunkData_(str) {
  var cells = [];
  var s = String(str || '');
  for (var i = 0; i < CHUNKS; i++) cells.push(s.slice(i * CHUNK, (i + 1) * CHUNK));
  return { cells: cells, overflow: s.length > CHUNK * CHUNKS };
}

/* اسم مقروء للصف في الشيت (لأي عين تتصفح الجدول) */
function previewName_(entity, obj) {
  if (!obj) return '';
  try {
    if (entity === 'settings') return String(obj.shopName || 'الإعدادات');
    if (entity === 'invoices') {
      var c = obj.customer && obj.customer.name ? String(obj.customer.name) : '';
      var kind = obj.kind === 'sale' ? 'بيع' : (obj.kind === 'purchase' ? 'شراء' : 'هالك');
      return (c ? c + ' — ' : '') + kind + ' #' + String(obj.number || obj.id || '');
    }
    if (entity === 'pending') return String(obj.customerName || 'فاتورة معلّقة');
    if (entity === 'stockLog') return String(obj.productName || '');
    return String(obj.name || obj.title || '');
  } catch (err) { return ''; }
}

function rowData_(meta) {
  var cells = meta.chunks;
  return [meta.id, meta.store, meta.stamp, meta.del ? 1 : 0, meta.cr, meta.by, meta.name,
          cells[0], cells[1], cells[2], cells[3]];
}

/* ============================== الرفع (push) ============================== */
function handleSyncPush_(payload) {
  var a = authStore_(payload);
  if (a.error) return storeError_(a);
  if (!a.storeId) return { ok: false, error: 'no_store' };

  /* دفعة واحدة تغطي كل الكيانات في نداء واحد (أسرع بكثير من نداء لكل كيان)،
     مع إبقاء الشكل القديم entity+rows صالحاً للتوافق. */
  var batches = [];
  if (Array.isArray(payload.batches) && payload.batches.length) {
    for (var bi = 0; bi < payload.batches.length; bi++) {
      var bb = payload.batches[bi] || {};
      var be = String(bb.entity || '');
      if (!ENTITIES[be] || !Array.isArray(bb.rows) || !bb.rows.length) continue;
      batches.push({ entity: be, rows: bb.rows.slice(0, MAX_PUSH_ROWS) });
    }
  } else if (payload.entity && Array.isArray(payload.rows) && payload.rows.length) {
    batches.push({ entity: String(payload.entity), rows: payload.rows.slice(0, MAX_PUSH_ROWS) });
  }
  if (!batches.length) return { ok: false, error: 'bad-request' };

  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (err) { return { ok: false, error: 'busy' }; }
  try {
    var ss = getSpreadsheet_(false);
    if (!ss) return { ok: false, error: 'server' };

    var results = {};
    var touched = [];
    for (var k = 0; k < batches.length; k++) {
      results[batches[k].entity] = pushRowsLocked_(ss, a, batches[k].entity, batches[k].rows);
      var res = results[batches[k].entity] || {};
      if (Array.isArray(res.applied) && res.applied.length) touched.push(batches[k].entity);
    }
    bumpStoreVers_(ss, a.storeId, touched);      /* علامة التغيّر: يقرأها السحب بدل فتح كل الأوراق */

    var out = { ok: true, results: results, time: new Date().toISOString() };
    if (batches.length === 1) {                    /* توافق مع الشكل القديم */
      var only = results[batches[0].entity] || {};
      out.entity = batches[0].entity;
      out.applied = only.applied || [];
      out.conflicts = only.conflicts || [];
      out.rejected = only.rejected || [];
    }
    return out;
  } finally {
    try { lock.releaseLock(); } catch (err2) { /* تجاهل */ }
  }
}

/* كتابة صفوف كيان واحد — داخل قفل محفوظ بالفعل (تُستدعى من handleSyncPush_) */
function pushRowsLocked_(ss, a, entity, rows) {
  var sh = getEntitySheet_(ss, entity);
  if (!sh) return { applied: [], conflicts: [], rejected: [{ id: '', error: 'server' }] };

  var read = readDataRows_(sh);
  var map = read.map;
  var stamp = Math.max(Date.now(), read.maxStamp + 1);

  var applied = [];
  var conflicts = [];
  var rejects = [];
  var updates = [];
  var appends = [];

  for (var i = 0; i < rows.length; i++) {
    var r = rows[i] || {};
    var id = String(r.id === null || r.id === undefined ? '' : r.id).trim();
    if (!id) continue;
    var rev = Number(r.rev) || 0;
    var del = r.del ? 1 : 0;
    var raw = typeof r.data === 'string' ? r.data : JSON.stringify(r.data || {});
    var parsed = safeParse_(raw);
    var name = previewName_(entity, parsed);
    var ex = map[id];

    if (ex) {
      if (ex.store !== a.storeId) { rejects.push({ id: id, error: 'scope' }); continue; }
      var exObj = safeParse_(ex.data);
      var exRev = exObj ? (Number(exObj._rev) || 0) : 0;
      if (exRev > rev) {
        /* صف أحدث لدى الخادم: لا نكتبه، ونعيده للعميل فيُطبّق هو الآخر (LWW) */
        conflicts.push({ id: id, rev: exRev, del: ex.del ? 1 : 0, data: exObj, stamp: ex.stamp });
        continue;
      }
      var chunks = chunkData_(raw);
      if (chunks.overflow) { rejects.push({ id: id, error: 'too_large' }); continue; }
      updates.push({
        row: ex.row,
        values: rowData_({ id: id, store: a.storeId, stamp: stamp++, del: del,
                           cr: ex.cr || a.phone, by: a.phone, name: name, chunks: chunks.cells })
      });
      applied.push(id);
    } else {
      if (del) { applied.push(id); continue; }   /* حذف سجل غير موجود ⇦ لا شيء */
      var chunks2 = chunkData_(raw);
      if (chunks2.overflow) { rejects.push({ id: id, error: 'too_large' }); continue; }
      appends.push(rowData_({ id: id, store: a.storeId, stamp: stamp++, del: 0,
                              cr: a.phone, by: a.phone, name: name, chunks: chunks2.cells }));
      applied.push(id);
    }
  }

  for (var u = 0; u < updates.length; u++) {
    sh.getRange(updates[u].row, 1, 1, DATA_COLS).setValues([updates[u].values]);
  }
  if (appends.length) {
    sh.getRange(sh.getLastRow() + 1, 1, appends.length, DATA_COLS).setValues(appends);
  }

  return { applied: applied, conflicts: conflicts, rejected: rejects };
}

/* ============================== السحب (pull) ============================== */
function handleSyncPull_(payload) {
  var a = authStore_(payload);
  if (a.error) return storeError_(a);
  if (!a.storeId) return { ok: false, error: 'no_store' };

  var ss = getSpreadsheet_(false);
  if (!ss) return { ok: false, error: 'server' };

  /* دفعة واحدة تغطي كل الكيانات (أقل عدد نداءات ⇦ أسرع)، أو الشكل القديم entity+since */
  if (Array.isArray(payload.entities) && payload.entities.length) {
    var cursors = (payload.cursors && typeof payload.cursors === 'object') ? payload.cursors : {};
    /* بوابة الإصدارات: العميل يرسل إصدارات آخر سحب، فنفتح الأوراق التي تغيّرت
       فقط. الإصدارات تُقرأ أولاً (قبل الأوراق) فلا تفوتنا كتابة واقعة أثناء القراءة. */
    var clientVers = (payload.vers && typeof payload.vers === 'object') ? payload.vers : null;
    var row0 = storeRowById_(ss, a.storeId);
    var vers = (row0 && row0.vers) ? row0.vers : {};
    var results = {};
    for (var ei = 0; ei < payload.entities.length; ei++) {
      var ent = String(payload.entities[ei]);
      if (!ENTITIES[ent]) return { ok: false, error: 'bad-request' };
      var sv = Number(vers[ent]) || 0;
      var cv = clientVers ? (Number(clientVers[ent]) || 0) : -1;
      if (clientVers && sv > 0 && cv === sv) {
        results[ent] = { rows: [], cursor: Number(cursors[ent]) || 0, more: false, total: 0 };
      } else {
        results[ent] = pullRowsLocked_(ss, a, ent, Number(cursors[ent]) || 0);
      }
    }
    return { ok: true, results: results, vers: vers };
  }

  var entity = String(payload.entity || '');
  if (!ENTITIES[entity]) return { ok: false, error: 'bad-request' };
  var part = pullRowsLocked_(ss, a, entity, Number(payload.since) || 0);
  part.ok = true;
  part.entity = entity;
  return part;
}

/* قراءة صفوف كيان واحد بعد مؤشر معيّن (تُستدعى من handleSyncPull_) */
function pullRowsLocked_(ss, a, entity, since) {
  var sh = getEntitySheet_(ss, entity);
  if (!sh) return { rows: [], cursor: since, more: false, total: 0 };

  var read = readDataRows_(sh);
  var list = [];
  for (var id in read.map) {
    if (!Object.prototype.hasOwnProperty.call(read.map, id)) continue;
    var r = read.map[id];
    if (r.store !== a.storeId) continue;              /* عزل: لا يعود سطر متجر آخر */
    if (r.stamp <= since) continue;
    list.push({ id: id, stamp: r.stamp, del: r.del ? 1 : 0, data: safeParse_(r.data) });
  }
  list.sort(function (x, y) { return x.stamp - y.stamp; });

  var more = list.length > MAX_PULL_ROWS;
  var rows = more ? list.slice(0, MAX_PULL_ROWS) : list;
  var cursor = since;
  for (var i = 0; i < rows.length; i++) if (rows[i].stamp > cursor) cursor = rows[i].stamp;

  return { rows: rows, cursor: cursor, more: more, total: list.length };
}

/* =========================== إدارة المتاجر ===========================
   ورقة «المتاجر»: المتجر | الكود | الاسم | المالك | أنشأ_في | الحالة
   ورقة «أعضاء_المتجر»: المتجر | الهاتف | الدور | الحالة | أضافه | أُضيف_في
   الانضمام يتطلب معاً: كود متجر صحيح + دعوة مسبقة برقم الهاتف.          */

function memberRows_(ss, storeId) {
  var sh = getMembersSheet_(ss);
  var last = sh.getLastRow();
  var out = [];
  if (last < 2) return out;
  var vals = sh.getRange(2, 1, last - 1, MEMBERS_HEAD.length).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][0] || '').trim() !== storeId) continue;
    out.push({
      row: i + 2,
      store: storeId,
      phone: normalizePhone_(vals[i][1]),
      role: String(vals[i][2] || '').trim().toLowerCase(),
      status: String(vals[i][3] || '').trim().toLowerCase(),
      by: String(vals[i][4] || '').trim()
    });
  }
  return out;
}

function findMember_(ss, storeId, phone) {
  var rows = memberRows_(ss, storeId);
  for (var i = 0; i < rows.length; i++) if (rows[i].phone === phone) return rows[i];
  return null;
}

/* حالة عضوية المستخدم في متجره (lowercase) — تُستخدم لطرد/منع المعطَّلين.
   ترجع '' إن لم يكن ضمن متجر أو تعذّرت القراءة (لا تُقيّد شيئاً في هذه الحالة). */
function memberStatusFor_(user) {
  try {
    var sid = (user && user.store !== null && user.store !== undefined) ? String(user.store).trim() : '';
    if (!sid) return '';
    var ss = getSpreadsheet_(false);
    if (!ss) return '';
    var me = findMember_(ss, sid, normalizePhone_(user.phone));
    if (!me) return '';
    return String(me.status || '').toLowerCase();
  } catch (e) {
    return '';
  }
}

function storeRowById_(ss, storeId) {
  var sh = getStoresSheet_(ss);
  var last = sh.getLastRow();
  if (last < 2) return null;
  var vals = sh.getRange(2, 1, last - 1, STORES_HEAD.length).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][0] || '').trim() !== storeId) continue;
    return { row: i + 2, id: storeId, code: String(vals[i][1] || '').trim().toUpperCase(),
             name: String(vals[i][2] || ''), owner: normalizePhone_(vals[i][3]),
             created: vals[i][4], status: String(vals[i][5] || 'active').trim().toLowerCase(),
             vers: safeParse_(vals[i][6]) || {} };
  }
  return null;
}

function storeRowByCode_(ss, code) {
  var sh = getStoresSheet_(ss);
  var last = sh.getLastRow();
  if (last < 2) return null;
  var vals = sh.getRange(2, 1, last - 1, STORES_HEAD.length).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][1] || '').trim().toUpperCase() !== code) continue;
    return { row: i + 2, id: String(vals[i][0] || '').trim(), code: code,
             name: String(vals[i][2] || ''), owner: normalizePhone_(vals[i][3]),
             created: vals[i][4], status: String(vals[i][5] || 'active').trim().toLowerCase(),
             vers: safeParse_(vals[i][6]) || {} };
  }
  return null;
}

/* إصدارات كيانات المتجر (عمود الإصدارات): تُرفع مع كل كتابة ناجحة، ويعيدها
   الخادم مع كل سحب ⇦ يقارنها العميل ويقرأ أوراق المتغيّرة فقط. هذا ما يجعل
   نبضة كل ثانية ممكنة بلا إعادة قراءة أوراق كاملة في كل مرة. */
function bumpStoreVers_(ss, storeId, entities) {
  if (!entities || !entities.length) return null;
  var row = storeRowById_(ss, storeId);
  if (!row) return null;
  var cur = row.vers || {};
  for (var i = 0; i < entities.length; i++) {
    var e = entities[i];
    if (!ENTITIES[e]) continue;
    cur[e] = (Number(cur[e]) || 0) + 1;
  }
  var raw = JSON.stringify(cur);
  try {
    getStoresSheet_(ss).getRange(row.row, STORES_HEAD.length, 1, 1).setValue(raw);
  } catch (err) { return null; }
  return cur;
}

function setUserStore_(a, storeId) {
  try {
    a.sheet.getRange(a.user.row, COL.STORE).setValue(storeId ? String(storeId).slice(0, 64) : '');
    a.user.store = storeId;
    a.storeId = storeId;
  } catch (err) { return false; }
  return true;
}

/* دليل أسماء المستخدمين (هاتف ← اسم) — لعرض الأعضاء بالاسم */
function userNamesIndex_() {
  var idx = {};
  try {
    var sheet = getUserSheet_();
    var last = sheet.getLastRow();
    if (last < 2) return idx;
    var width = Math.max(COL.NAME, COL.PHONE);
    var vals = sheet.getRange(2, 1, last - 1, width).getValues();
    for (var i = 0; i < vals.length; i++) {
      var ph = normalizePhone_(vals[i][COL.PHONE - 1]);
      if (!ph) continue;
      idx[ph] = String(vals[i][COL.NAME - 1] || '').trim();
    }
  } catch (err) { /* دليل اختياري */ }
  return idx;
}

function membersPayload_(ss, storeId) {
  var rows = memberRows_(ss, storeId);
  var names = userNamesIndex_();
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var m = rows[i];
    if (m.status === 'removed') continue;
    out.push({ phone: m.phone, name: names[m.phone] || '', role: m.role || 'accountant',
               status: m.status || 'invited' });
  }
  return out;
}

function storePayload_(ss, storeId, myPhone) {
  if (!storeId) return { store: null, members: [] };
  var st = storeRowById_(ss, storeId);
  if (!st) return { store: null, members: [] };
  var me = findMember_(ss, storeId, myPhone);
  return {
    store: {
      id: st.id, code: st.code, name: st.name, owner: st.owner,
      role: (me && me.role) ? me.role : (st.owner === myPhone ? 'owner' : 'accountant'),
      status: (me && me.status) ? me.status : 'active'
    },
    members: membersPayload_(ss, storeId)
  };
}

function genStoreCode_(ss) {
  var abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   /* بلا O/0/I/1 لتفادي اللبس */
  for (var t = 0; t < 30; t++) {
    var s = '';
    for (var i = 0; i < 7; i++) s += abc.charAt(Math.floor(Math.random() * abc.length));
    if (!storeRowByCode_(ss, s)) return s;
  }
  return 'ST' + Date.now().toString(36).toUpperCase().slice(-7);
}

function newStoreId_() {
  try { return 'st_' + Utilities.getUuid().replace(/-/g, '').slice(0, 20); }
  catch (err) { return 'st_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }
}

function handleStoreStatus_(payload) {
  var a = authStore_(payload);
  if (a.error) return storeError_(a);
  var ss = getSpreadsheet_(false);
  if (!ss) return { ok: false, error: 'server' };
  if (a.storeId && !storeRowById_(ss, a.storeId)) setUserStore_(a, '');   /* متجر محذوف يدوياً */
  var p = storePayload_(ss, a.storeId, a.phone);
  return { ok: true, store: p.store, members: p.members, phone: a.phone, name: a.name };
}

function handleStoreCreate_(payload) {
  var a = authStore_(payload);
  if (a.error) return storeError_(a);
  var ss = getSpreadsheet_(false);
  if (!ss) return { ok: false, error: 'server' };
  if (a.storeId) {
    var cur = storeRowById_(ss, a.storeId);
    if (cur) return { ok: false, error: 'already_in_store' };
    setUserStore_(a, '');
  }

  var name = String(payload.name || '').trim().slice(0, 60) || 'متجري';
  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (err) { return { ok: false, error: 'busy' }; }
  try {
    var id = newStoreId_();
    var code = genStoreCode_(ss);
    var now = new Date();
    var st = getStoresSheet_(ss);
    st.appendRow([id, code, name, a.phone, now, 'active']);

    var ms = getMembersSheet_(ss);
    ms.appendRow([id, a.phone, 'owner', 'active', a.phone, now]);

    if (!setUserStore_(a, id)) return { ok: false, error: 'server' };

    var p = storePayload_(ss, id, a.phone);
    return { ok: true, store: p.store, members: p.members, phone: a.phone, name: a.name };
  } finally {
    try { lock.releaseLock(); } catch (err2) { /* تجاهل */ }
  }
}

function handleStoreJoin_(payload) {
  var a = authStore_(payload);
  if (a.error) return storeError_(a);
  var ss = getSpreadsheet_(false);
  if (!ss) return { ok: false, error: 'server' };

  var code = String(payload.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!STORE_CODE_RE.test(code)) return { ok: false, error: 'bad_code' };

  var st = storeRowByCode_(ss, code);
  if (!st || st.status !== 'active') return { ok: false, error: 'bad_code' };
  if (a.storeId === st.id) {
    var same = storePayload_(ss, st.id, a.phone);
    return { ok: true, store: same.store, members: same.members, phone: a.phone, name: a.name };
  }
  if (a.storeId) return { ok: false, error: 'already_in_store' };

  var me = findMember_(ss, st.id, a.phone);
  if (!me || me.status === 'removed') return { ok: false, error: 'not_invited' };

  try {
    var ms = getMembersSheet_(ss);
    ms.getRange(me.row, 4).setValue('active');
    ms.getRange(me.row, 6).setValue(new Date());
    if (!setUserStore_(a, st.id)) return { ok: false, error: 'server' };
  } catch (err) { return { ok: false, error: 'server' }; }

  var p = storePayload_(ss, st.id, a.phone);
  return { ok: true, store: p.store, members: p.members, phone: a.phone, name: a.name };
}

function handleStoreInvite_(payload) {
  var a = authStore_(payload);
  if (a.error) return storeError_(a);
  if (!a.storeId) return { ok: false, error: 'no_store' };

  var ss = getSpreadsheet_(false);
  if (!ss) return { ok: false, error: 'server' };

  var st = storeRowById_(ss, a.storeId);
  if (!st) { setUserStore_(a, ''); return { ok: false, error: 'no_store' }; }
  if (st.owner !== a.phone) return { ok: false, error: 'not_owner' };

  var target = normalizePhone_(payload.target);
  if (!target || target === a.phone) return { ok: false, error: 'bad-request' };

  /* الدعوة تكون لحساب مسجَّل فعلاً (له كلمة مرور في ورقة المستخدمين) */
  var targetUser = findUser_(a.sheet, target);
  if (!targetUser) return { ok: false, error: 'user_not_found' };
  var targetStore = String(targetUser.store === null || targetUser.store === undefined ? '' : targetUser.store).trim();
  if (targetStore && targetStore !== a.storeId) return { ok: false, error: 'target_in_store' };

  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (err) { return { ok: false, error: 'busy' }; }
  try {
    var me = findMember_(ss, a.storeId, target);
    if (me && (me.status === 'active' || me.status === 'invited')) return { ok: false, error: 'already_member' };
    var ms = getMembersSheet_(ss);
    if (me) ms.getRange(me.row, 4).setValue('invited');
    else ms.appendRow([a.storeId, target, 'accountant', 'invited', a.phone, new Date()]);
  } finally {
    try { lock.releaseLock(); } catch (err2) { /* تجاهل */ }
  }

  var p = storePayload_(ss, a.storeId, a.phone);
  return { ok: true, store: p.store, members: p.members };
}

function handleStoreRemove_(payload) {
  var a = authStore_(payload);
  if (a.error) return storeError_(a);
  if (!a.storeId) return { ok: false, error: 'no_store' };

  var ss = getSpreadsheet_(false);
  if (!ss) return { ok: false, error: 'server' };

  var st = storeRowById_(ss, a.storeId);
  if (!st) { setUserStore_(a, ''); return { ok: false, error: 'no_store' }; }
  if (st.owner !== a.phone) return { ok: false, error: 'not_owner' };

  var target = normalizePhone_(payload.target);
  if (!target || target === a.phone) return { ok: false, error: 'bad-request' };

  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (err) { return { ok: false, error: 'busy' }; }
  try {
    var me = findMember_(ss, a.storeId, target);
    if (!me) return { ok: false, error: 'not_member' };
    getMembersSheet_(ss).getRange(me.row, 4).setValue('removed');

    /* إن كان المحاسب مسجَّلاً على هذا المتجر نفصله منه فوراً */
    var tu = findUser_(a.sheet, target);
    if (tu && String(tu.store || '').trim() === a.storeId) {
      try { a.sheet.getRange(tu.row, COL.STORE).setValue(''); } catch (e2) { /* تجاهل */ }
    }
  } finally {
    try { lock.releaseLock(); } catch (err3) { /* تجاهل */ }
  }

  var p = storePayload_(ss, a.storeId, a.phone);
  return { ok: true, store: p.store, members: p.members };
}

/* تفعيل/تعطيل عضوية موظف (المالك فقط، وليس نفسه ولا صاحب المتجر).
   التعطيل يمنعه من الدخول ويطرده إن كان دخلاً (عبر handleVerify_). */
function handleStoreMemberStatus_(payload) {
  var a = authStore_(payload);
  if (a.error) return storeError_(a);
  if (!a.storeId) return { ok: false, error: 'no_store' };

  var ss = getSpreadsheet_(false);
  if (!ss) return { ok: false, error: 'server' };

  var st = storeRowById_(ss, a.storeId);
  if (!st) { setUserStore_(a, ''); return { ok: false, error: 'no_store' }; }
  if (st.owner !== a.phone) return { ok: false, error: 'not_owner' };

  var target = normalizePhone_(payload.target);
  var status = String(payload.status || '').trim().toLowerCase();
  if (status !== 'active' && status !== 'disabled') return { ok: false, error: 'bad-request' };
  /* لا يُسمح بتعطيل صاحب المتجر أو النفس */
  if (!target || target === a.phone) return { ok: false, error: 'bad-request' };

  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (err) { return { ok: false, error: 'busy' }; }
  try {
    var me = findMember_(ss, a.storeId, target);
    if (!me) return { ok: false, error: 'not_member' };
    if (me.role === 'owner') return { ok: false, error: 'bad-request' };
    getMembersSheet_(ss).getRange(me.row, 4).setValue(status);
  } finally {
    try { lock.releaseLock(); } catch (err2) { /* تجاهل */ }
  }

  var p = storePayload_(ss, a.storeId, a.phone);
  return { ok: true, store: p.store, members: p.members };
}

function handleStoreLeave_(payload) {
  var a = authStore_(payload);
  if (a.error) return storeError_(a);
  if (!a.storeId) return { ok: false, error: 'no_store' };

  var ss = getSpreadsheet_(false);
  if (!ss) return { ok: false, error: 'server' };

  var st = storeRowById_(ss, a.storeId);
  if (!st) { setUserStore_(a, ''); return { ok: true, store: null, members: [] }; }
  if (st.owner === a.phone) return { ok: false, error: 'owner_cannot_leave' };

  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (err) { return { ok: false, error: 'busy' }; }
  try {
    var me = findMember_(ss, a.storeId, a.phone);
    if (me) getMembersSheet_(ss).getRange(me.row, 4).setValue('removed');
    setUserStore_(a, '');
  } finally {
    try { lock.releaseLock(); } catch (err2) { /* تجاهل */ }
  }
  return { ok: true, store: null, members: [] };
}

/* ==================== لوحة أدمن المستخدمين والمتاجر ====================
   إجراءان لا يعملان إلا لحساب كُتب في عمود «الصلاحية» من ورقة المستخدمين: admin
   1) admin_list   : قائمة كل مستخدمي الشيت + المتاجر وأكوادها.
   2) admin_assign : تعيين مستخدم مالك متجر (اسم + كود تلقائي) أو محاسباً في متجر
                     موجود، أو فصله عن متجره. */
function authAdmin_(payload) {
  var a = authStore_(payload);
  if (a.error) return a;
  if (!isAdmin_(a.user)) return { error: 'not_admin' };
  return a;
}

function allStoresIndex_(ss) {
  var stores = {};
  var list = [];
  var sh = getStoresSheet_(ss);
  var last = sh.getLastRow();
  if (last < 2) return { map: stores, list: list };
  var vals = sh.getRange(2, 1, last - 1, STORES_HEAD.length).getValues();
  for (var i = 0; i < vals.length; i++) {
    var sid = String(vals[i][0] || '').trim();
    if (!sid) continue;
    var info = {
      id: sid, code: String(vals[i][1] || '').trim().toUpperCase(),
      name: String(vals[i][2] || ''), owner: normalizePhone_(vals[i][3]),
      status: String(vals[i][5] || 'active').trim().toLowerCase(), members: []
    };
    stores[sid] = info;
    list.push(info);
  }
  return { map: stores, list: list };
}

function allMembersByStore_(ss, stores) {
  var sh = getMembersSheet_(ss);
  var last = sh.getLastRow();
  if (last < 2) return;
  var vals = sh.getRange(2, 1, last - 1, MEMBERS_HEAD.length).getValues();
  for (var i = 0; i < vals.length; i++) {
    var sid = String(vals[i][0] || '').trim();
    var st = stores[sid];
    if (!st) continue;
    var status = String(vals[i][3] || '').trim().toLowerCase();
    if (status === 'removed') continue;
    st.members.push({
      phone: normalizePhone_(vals[i][1]),
      role: String(vals[i][2] || '').trim().toLowerCase() || 'accountant',
      status: status || 'invited'
    });
  }
}

/* تنسيق خلية تاريخ/نص للإرسال إلى الداشبورد (yyyy-MM-dd أو yyyy-MM-dd HH:mm) */
function fmtCellDate_(v, withTime) {
  if (Object.prototype.toString.call(v) === '[object Date]') {
    if (isNaN(v.getTime())) return '';
    try {
      return Utilities.formatDate(v, Session.getScriptTimeZone(), withTime ? 'yyyy-MM-dd HH:mm' : 'yyyy-MM-dd');
    } catch (err) { return String(v.toISOString()).slice(0, withTime ? 16 : 10).replace('T', ' '); }
  }
  return String(v === null || v === undefined ? '' : v).trim();
}

function handleAdminList_(payload) {
  var a = authAdmin_(payload);
  if (a.error) return storeError_(a);
  var ss = getSpreadsheet_(false);
  if (!ss) return { ok: false, error: 'server' };
  ensureStoresSheets_(ss);

  var idx = allStoresIndex_(ss);
  allMembersByStore_(ss, idx.map);

  var users = [];
  var sheet = getUserSheet_();
  var last = sheet.getLastRow();
  if (last >= 2) {
    var width = Math.max(COL.SUB_DAYS, COL.SUB_START, COL.STORE, COL.ROLE);
    var vals = sheet.getRange(2, 1, last - 1, width).getValues();
    for (var i = 0; i < vals.length; i++) {
      var row = vals[i];
      var phone = normalizePhone_(row[COL.PHONE - 1]);
      if (!phone) continue;
      var roleRaw = String(row[COL.ROLE - 1] === null || row[COL.ROLE - 1] === undefined ? '' : row[COL.ROLE - 1]).trim().toLowerCase();
      var u = {
        phone: phone,
        name: String(row[COL.NAME - 1] || '').trim(),
        status: String(row[COL.STATUS - 1] || '').trim().toLowerCase(),
        hasPass: String(row[COL.PASS - 1] === null || row[COL.PASS - 1] === undefined ? '' : row[COL.PASS - 1]).trim().length > 0,
        trialStart: fmtCellDate_(row[COL.TRIAL_START - 1], false),
        firstLogin: fmtCellDate_(row[COL.FIRST_LOGIN - 1], true),
        lastLogin: fmtCellDate_(row[COL.LAST_LOGIN - 1], true),
        logins: Number(row[COL.LOGIN_COUNT - 1]) || 0,
        device: String(row[COL.DEVICE - 1] === null || row[COL.DEVICE - 1] === undefined ? '' : row[COL.DEVICE - 1]).trim(),
        ip: String(row[COL.IP - 1] === null || row[COL.IP - 1] === undefined ? '' : row[COL.IP - 1]).trim(),
        store: String(row[COL.STORE - 1] === null || row[COL.STORE - 1] === undefined ? '' : row[COL.STORE - 1]).trim(),
        roleCol: roleRaw,
        admin: isAdmin_({ role: roleRaw }),
        subDays: row[COL.SUB_DAYS - 1],
        subStart: fmtCellDate_(row[COL.SUB_START - 1], false)
      };
      var sub = subInfo_({ subDays: row[COL.SUB_DAYS - 1], subStart: row[COL.SUB_START - 1] });
      u.subLeft = sub ? sub.daysLeft : 0;
      u.subActive = !!sub;
      u.subEndISO = sub ? sub.endMs : 0;
      var st = u.store ? idx.map[u.store] : null;
      u.storeName = st ? st.name : '';
      u.storeCode = st ? st.code : '';
      u.storeOwner = st ? st.owner : '';
      u.storeRole = '';
      if (st) {
        if (st.owner === phone) u.storeRole = 'owner';
        else for (var m = 0; m < st.members.length; m++) {
          if (st.members[m].phone === phone) { u.storeRole = st.members[m].role || 'accountant'; break; }
        }
      }
      users.push(u);
    }
  }

  return { ok: true, users: users, stores: idx.list, phone: a.phone };
}

/* كتابة الدور في عمود «الصلاحية» من ورقة المستخدمين: owner / accountant / فارغ.
   قيمة admin لا تُستبدل أبداً (تفتح الداشبورد) — دور المتجر يبقى في «أعضاء_المتجر». */
function writeRoleCol_(sheet, user, value) {
  try { sheet.getRange(user.row, COL.ROLE).setValue(value || ''); } catch (err) { /* تجاهل */ }
}

/* أدوار العضوية داخل المتجر:
   owner (مالك) · accountant (محاسب عام) · inventory (محاسب جرد) ·
   cashier (محاسب كاشير) · pro (محاسب محترف). */
function isMemberRole_(role) {
  return role === 'owner' || role === 'accountant' || role === 'inventory' || role === 'cashier' || role === 'pro';
}
/* هل هو دور محاسبي تابع للمالك؟ يُخزَّن الدور المحدّد في ورقة «أعضاء_المتجر»،
   وتُكتب القيمة العامة accountant في عمود «الصلاحية» بورقة المستخدمين. */
function isAccountantRole_(role) {
  return role === 'accountant' || role === 'inventory' || role === 'cashier' || role === 'pro';
}

function handleAdminAssign_(payload) {
  var a = authAdmin_(payload);
  if (a.error) return storeError_(a);
  var ss = getSpreadsheet_(false);
  if (!ss) return { ok: false, error: 'server' };
  ensureStoresSheets_(ss);

  var target = normalizePhone_(payload.target);
  if (!target) return { ok: false, error: 'bad-request' };
  var tu = findUser_(a.sheet, target);
  if (!tu) return { ok: false, error: 'user_not_found' };

  var role = String(payload.role || '').trim().toLowerCase();
  if (!isMemberRole_(role) && role !== 'none' && role !== 'admin') return { ok: false, error: 'bad-request' };
  if (role !== 'admin' && target === a.phone) return { ok: false, error: 'self_demote' };   /* لا يفقد الأدمن صلاحيته بنفسه */

  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (err) { return { ok: false, error: 'busy' }; }
  try {
    var ms = getMembersSheet_(ss);
    var oldStore = String(tu.store || '').trim();

    if (role === 'admin') {
      /* منح صلاحية الأدمن: يُكتب في عمود «الصلاحية» دون المساس بمتجره */
      writeRoleCol_(a.sheet, tu, 'admin');

    } else if (role === 'owner') {
      var name = String(payload.storeName || '').trim().slice(0, 60) || 'متجري';
      var st = oldStore ? storeRowById_(ss, oldStore) : null;
      if (st && st.owner !== target) st = null;           /* المتجر يخص صاحباً آخر ⇦ متجراً جديداً */
      if (st) {
        try { getStoresSheet_(ss).getRange(st.row, 3).setValue(name); st.name = name; } catch (e1) { /* تجاهل */ }
      } else {
        var id = newStoreId_();
        var code = genStoreCode_(ss);
        getStoresSheet_(ss).appendRow([id, code, name, target, new Date(), 'active']);
        st = storeRowById_(ss, id);
        if (!st) return { ok: false, error: 'server' };
        try { a.sheet.getRange(tu.row, COL.STORE).setValue(st.id); } catch (e2) { return { ok: false, error: 'server' }; }
        oldStore = '';
      }
      var me = findMember_(ss, st.id, target);
      if (me) {
        ms.getRange(me.row, 3).setValue('owner');
        ms.getRange(me.row, 4).setValue('active');
      } else {
        ms.appendRow([st.id, target, 'owner', 'active', a.phone, new Date()]);
      }
      if (oldStore && oldStore !== st.id) {
        var prev = findMember_(ss, oldStore, target);
        if (prev) ms.getRange(prev.row, 4).setValue('removed');   /* فصله عن متجره السابق */
      }
      try { a.sheet.getRange(tu.row, COL.STORE).setValue(st.id); } catch (e3) { /* تجاهل */ }
      writeRoleCol_(a.sheet, tu, 'owner');   /* الصلاحية = owner (يُسقط صلاحية الأدمن إن وُجدت) */

    } else if (isAccountantRole_(role)) {
      var sid = String(payload.storeId || '').trim();
      if (!sid) {
        var ownerPhone = normalizePhone_(payload.owner || payload.ownerPhone || '');
        if (ownerPhone) {
          var ou = findUser_(a.sheet, ownerPhone);
          if (ou && String(ou.store || '').trim()) sid = String(ou.store).trim();
        }
      }
      var st2 = sid ? storeRowById_(ss, sid) : null;
      if (!st2 || st2.status !== 'active') return { ok: false, error: 'bad_code' };
      if (st2.owner === target) return { ok: false, error: 'bad-request' };   /* المالك لا يُجعل محاسباً */

      var me2 = findMember_(ss, st2.id, target);
      if (me2) {
        ms.getRange(me2.row, 3).setValue(role);   /* الدور المحدّد: accountant/inventory/cashier/pro */
        ms.getRange(me2.row, 4).setValue('active');
      } else {
        ms.appendRow([st2.id, target, role, 'active', a.phone, new Date()]);
      }
      if (oldStore && oldStore !== st2.id) {
        var prev2 = findMember_(ss, oldStore, target);
        if (prev2) ms.getRange(prev2.row, 4).setValue('removed');
      }
      try { a.sheet.getRange(tu.row, COL.STORE).setValue(st2.id); } catch (e4) { return { ok: false, error: 'server' }; }
      writeRoleCol_(a.sheet, tu, 'accountant');   /* «الصلاحية» العامة = accountant (الدور التفصيلي في أعضاء_المتجر) */

    } else {
      /* بدون متجر: فصل الحساب عن متجره إن كان منتمياً إليه */
      if (oldStore) {
        var me3 = findMember_(ss, oldStore, target);
        if (me3) ms.getRange(me3.row, 4).setValue('removed');
        try { a.sheet.getRange(tu.row, COL.STORE).setValue(''); } catch (e5) { /* تجاهل */ }
      }
      writeRoleCol_(a.sheet, tu, '');   /* تفريغ الدور والصلاحية معاً */
    }
  } finally {
    try { lock.releaseLock(); } catch (err2) { /* تجاهل */ }
  }

  return handleAdminList_(payload);   /* القائمة المحدّثة بعد التعديل */
}

/* ==================== إنشاء مستخدم جديد من لوحة الأدمن ====================
   الحقول إلزامية: phone (056/059 — 10 أرقام عند العميل) · name (حرفان+) ·
   pass (4 أحرف+) · subDays (رقم موجب). التواريخ تُملأ تلقائياً باليوم إن فارغة.
   role اختياري: owner (storeName) / accountant (storeId) / admin / none —
   يُنفَّذ التعيين عبر handleAdminAssign_ بعد إنشاء الصف. */
function handleAdminCreate_(payload) {
  var a = authAdmin_(payload);
  if (a.error) return storeError_(a);

  var phone = normalizePhone_(payload.phone);
  var name = String(payload.name === null || payload.name === undefined ? '' : payload.name).trim().slice(0, 60);
  var pass = String(payload.pass || '');
  var status = String(payload.status || '').trim().toLowerCase();
  var device = String(payload.device === null || payload.device === undefined ? '' : payload.device).trim().slice(0, 64);
  var role = String(payload.role || 'none').trim().toLowerCase();

  if (!phone || phone.length < 7) return { ok: false, error: 'bad-request' };
  if (name.length < 2) return { ok: false, error: 'bad-request' };
  if (pass.length < 8) return { ok: false, error: 'bad-request' };
  if (status && status !== 'active' && status !== 'blocked') return { ok: false, error: 'bad-request' };
  if (!isMemberRole_(role) && role !== 'none' && role !== 'admin') return { ok: false, error: 'bad-request' };

  var subDaysVal = toAdminDays_(payload.subDays);
  if (!isFinite(subDaysVal) || subDaysVal < 0) return { ok: false, error: 'bad_subdays' };
  var trialStart = toStartISO_(String(payload.trialStart || '').trim()) || today_();
  var subStart = toStartISO_(String(payload.subStart || '').trim()) || today_();

  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (err) { return { ok: false, error: 'busy' }; }
  try {
    if (findUser_(a.sheet, phone)) return { ok: false, error: 'phone_exists' };
    a.sheet.appendRow([
      phone,                    /* PHONE  */
      hashPassword_(phone, pass), /* PASS */
      name,                     /* NAME   */
      status || 'active',       /* STATUS */
      trialStart,               /* TRIAL_START */
      '',                       /* FIRST_LOGIN */
      '',                       /* LAST_LOGIN  */
      0,                        /* LOGIN_COUNT */
      device,                   /* DEVICE */
      '',                       /* IP */
      subDaysVal,               /* SUB_DAYS  */
      subStart,                 /* SUB_START */
      '',                       /* STORE (يُملأ عند التعيين) */
      ''                        /* ROLE  */
    ]);
  } finally {
    try { lock.releaseLock(); } catch (err2) { /* تجاهل */ }
  }

  if (role !== 'none') {
    return handleAdminAssign_({
      phone: a.phone, token: payload.token,
      target: phone, role: role,
      storeName: payload.storeName, storeId: payload.storeId
    });
  }
  return handleAdminList_(payload);
}

/* ==================== تعديل بيانات مستخدم من لوحة الأدمن ====================
   يقبل كل خانات ورقة المستخدمين القابلة للتعديل:
    newPhone · pass (جديدة، فارغة = بدون تغيير) · name · status · trialStart ·
    subDays · subStart · newDevice (فارغة = فك ربط الجهاز) · ip · admin (1/0).
   تغيير الهاتف يستلزم كلمة مرور جديدة (الملح مشتقّ من الرقم) ويحدّث الهاتف
   القديم في ورقة «أعضاء_المتجر» و«المتاجر» (مالك المتجر). */
function handleAdminUpdate_(payload) {
  var a = authAdmin_(payload);
  if (a.error) return storeError_(a);

  var target = normalizePhone_(payload.target);
  if (!target) return { ok: false, error: 'bad-request' };
  var tu = findUser_(a.sheet, target);
  if (!tu) return { ok: false, error: 'user_not_found' };

  var newPhone = normalizePhone_(payload.newPhone);
  var phoneChanged = !!(newPhone && newPhone !== target);
  var pass = String(payload.pass === null || payload.pass === undefined ? '' : payload.pass);
  var name = (payload.name === undefined) ? null : String(payload.name || '').trim().slice(0, 60);
  var status = String(payload.status || '').trim().toLowerCase();
  var trialStart = String(payload.trialStart || '').trim();
  var subDaysRaw = payload.subDays;
  var subStart = String(payload.subStart || '').trim();
  var newDeviceGiven = payload.newDevice !== undefined;   /* '' = فك ربط الجهاز */
  var newDevice = String(payload.newDevice === null || payload.newDevice === undefined ? '' : payload.newDevice).trim().slice(0, 64);
  var ip = String(payload.ip === null || payload.ip === undefined ? '' : payload.ip).trim().slice(0, 64);
  var adminFlag = payload.admin;   /* 1 / 0 / undefined (= بلا تغيير) */

  if (phoneChanged) {
    if (newPhone.length < 7) return { ok: false, error: 'bad-request' };
    var dupe = findUser_(a.sheet, newPhone);
    if (dupe) return { ok: false, error: 'phone_exists' };
  }
  if (pass && pass.length < 8) return { ok: false, error: 'bad-request' };
  if (phoneChanged && !pass) return { ok: false, error: 'pass_required' };   /* الملح مشتقّ من الرقم */
  if (status && status !== 'active' && status !== 'blocked') return { ok: false, error: 'bad-request' };

  var subDaysVal = null;
  if (subDaysRaw !== undefined && subDaysRaw !== null && String(subDaysRaw).trim() !== '') {
    subDaysVal = toAdminDays_(subDaysRaw);
    if (!isFinite(subDaysVal)) return { ok: false, error: 'bad_subdays' };
  }
  if (trialStart && !toStartISO_(trialStart)) return { ok: false, error: 'bad-request' };
  if (subStart && !toStartISO_(subStart)) return { ok: false, error: 'bad-request' };

  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (err) { return { ok: false, error: 'busy' }; }
  try {
    var sh = a.sheet;
    if (phoneChanged) {
      try { sh.getRange(tu.row, COL.PHONE).setValue(newPhone); } catch (e1) { return { ok: false, error: 'server' }; }
      /* تحديث الهاتف القديم في أوراق المتاجر */
      var ss = getSpreadsheet_(false);
      if (ss) {
        ensureStoresSheets_(ss);
        var ms = getMembersSheet_(ss);
        var lastM = ms.getLastRow();
        if (lastM >= 2) {
          var mvals = ms.getRange(2, 2, lastM - 1, 1).getValues();   /* عمود الهاتف فقط */
          for (var i = 0; i < mvals.length; i++) {
            if (normalizePhone_(mvals[i][0]) !== target) continue;
            ms.getRange(i + 2, 2).setValue(newPhone);
          }
        }
        var stsh = getStoresSheet_(ss);
        var lastS = stsh.getLastRow();
        if (lastS >= 2) {
          var svals = stsh.getRange(2, 4, lastS - 1, 1).getValues();   /* عمود المالك */
          for (var j = 0; j < svals.length; j++) {
            if (normalizePhone_(svals[j][0]) !== target) continue;
            stsh.getRange(j + 2, 4).setValue(newPhone);
          }
        }
      }
      tu.phone = newPhone;
      target = newPhone;
    }
    if (pass) {
      var hashed = hashPassword_(phoneChanged ? newPhone : target, pass);
      try { sh.getRange(tu.row, COL.PASS).setValue(hashed); } catch (e2) { /* تجاهل */ }
    }
    if (name !== null) { try { sh.getRange(tu.row, COL.NAME).setValue(name); } catch (e3) { /* تجاهل */ } }
    if (status) { try { sh.getRange(tu.row, COL.STATUS).setValue(status); } catch (e4) { /* تجاهل */ } }
    if (trialStart) { try { sh.getRange(tu.row, COL.TRIAL_START).setValue(toStartISO_(trialStart)); } catch (e5) { /* تجاهل */ } }
    if (subDaysVal !== null) {
      try { sh.getRange(tu.row, COL.SUB_DAYS).setValue(subDaysVal); } catch (e6) { /* تجاهل */ }
    }
    if (subStart) { try { sh.getRange(tu.row, COL.SUB_START).setValue(toStartISO_(subStart)); } catch (e7) { /* تجاهل */ } }
    if (newDeviceGiven) {
      try { sh.getRange(tu.row, COL.DEVICE).setValue(newDevice); } catch (e8) { /* تجاهل */ }
    }
    if (ip !== undefined && payload.ip !== undefined) {
      try { sh.getRange(tu.row, COL.IP).setValue(ip); } catch (e9) { /* تجاهل */ }
    }
    if (adminFlag === 1 || adminFlag === true || adminFlag === '1') {
      writeRoleCol_(sh, tu, 'admin');
    } else if (adminFlag === 0 || adminFlag === false || adminFlag === '0') {
      /* إلغاء صلاحية الأدمن: يُعاد دوره من ورقة الأعضاء (مالك/محاسب) أو يُفرَّغ */
      var cur = String(tu.role || '').trim().toLowerCase();
      if (isAdmin_({ role: cur })) {
        var restored = '';
        var sid = String(tu.store || '').trim();
        if (sid) {
          var ssr = getSpreadsheet_(false);
          if (ssr) {
            var mem = findMember_(ssr, sid, target);
            if (mem) restored = (mem.role === 'owner') ? 'owner' : 'accountant';
          }
        }
        writeRoleCol_(sh, tu, restored);
      }
    }
  } finally {
    try { lock.releaseLock(); } catch (err2) { /* تجاهل */ }
  }

  return handleAdminList_(payload);
}

/* ============================ تشخيص ============================
   شغّل من محرر Apps Script:  diagnoseSync('059XXXXXXXX')
   يطبع متجر الحساب وحالة أوراق البيانات. */
function diagnoseSync(phoneRaw) {
  var a = authStore_({ phone: phoneRaw, token: 'debug' });
  if (a.error && a.error !== 'session') { Logger.log('خطأ: ' + a.error); return; }
  var phone = normalizePhone_(phoneRaw);
  var sheet = getUserSheet_();
  var user = findUser_(sheet, phone);
  if (!user) { Logger.log('لا يوجد حساب بهذا الرقم'); return; }
  Logger.log('الحساب: ' + phone + ' — المتجر: «' + String(user.store || '(فارغ)') + '»');
  var ss = getSpreadsheet_(false);
  ensureDataSheets_(ss);
  for (var key in ENTITIES) {
    if (!Object.prototype.hasOwnProperty.call(ENTITIES, key)) continue;
    var sh = ss.getSheetByName(ENTITIES[key]);
    Logger.log(ENTITIES[key] + ': ' + Math.max(sh.getLastRow() - 1, 0) + ' صف');
  }
  if (user.store) {
    var st = storeRowById_(ss, String(user.store).trim());
    Logger.log(st ? ('متجر: ' + st.name + ' — كود ' + st.code + ' — مالك ' + st.owner)
                  : 'تحذير: معرّف المتجر غير موجود في ورقة «المتاجر»');
    Logger.log('الأعضاء: ' + JSON.stringify(membersPayload_(ss, String(user.store).trim())));
  }
}
