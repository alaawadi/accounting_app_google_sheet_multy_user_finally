/* ============================================================================
   Service Worker — دفتر التاجر (تطبيق محاسبة وفواتير، ملف واحد index.html)
   مبني على نفس منهجية التطبيق المرجعي (acc_app / data-center):
   - كاشان منفصلان: هيكل التطبيق (App Shell) + كاش وقت التشغيل
   - تثبيت متسامح: فشل ملف واحد لا يُسقط التثبيت كاملاً (Promise.allSettled)
   - التنقّل بين الصفحات: الشبكة أولاً (لضمان ظهور أي تعديل على index.html فوراً)
     ثم الكاش، وأخيراً نسخة محفوظة من التطبيق حتى بدون اتصال
   - باقي الملفات (أيقونات، شعارات وسائل الدفع، manifest، مكتبتا الإكسل والباركود): Stale-While-Revalidate
   - التحديث: النسخة الجديدة تبقى "waiting" حتى يضغط المستخدم "تحديث الآن"
     (التطبيق هو من يرسل SKIP_WAITING ثم يعمل ريلود مرة واحدة) — ولذلك لا
     نستدعي skipWaiting() تلقائياً عند التثبيت
   ============================================================================ */

const CACHE_VERSION = 'v25';
const APP_SHELL_CACHE = `daftar-tajer-shell-${CACHE_VERSION}`;
const RUNTIME_CACHE = `daftar-tajer-runtime-${CACHE_VERSION}`;
const OFFLINE_FALLBACK = './index.html';

/* ملفات هيكل التطبيق — كلها مطلوبة ليعمل التطبيق أوفلاين */
const APP_SHELL_FILES = [
  './index.html',
  './login.html',
  './dashboard.html',
  './auth.js',
  './sync.js',
  './manifest.json',
  './libs/xlsx.full.min.js',
  './libs/html5-qrcode.min.js',
  './icons/favicon-16.png',
  './icons/favicon-32.png',
  './icons/favicon.ico',
  './icons/apple-touch-icon.png',
  './icons/icon-96.png',
  './icons/icon-144.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  /* شعارات وسائل الدفع (بنك / بال باي / جوال باي) — محلية حتى تظهر بلا إنترنت */
  './icons/pay-bank.png',
  './icons/pay-palpay.png',
  './icons/pay-jawwalpay.png',
  /* خط كايرو لاسم التطبيق في الهيدر (يعمل أوفلاين) */
  './fonts/Cairo-arabic.woff2',
  './fonts/Cairo-latin.woff2'
];

/* ------------------------------ التثبيت ------------------------------ */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(APP_SHELL_CACHE).then((cache) =>
      // لو فشل ملف واحد (مثلاً لم يُرفع بعد) يكمل الباقي بدل فشل التثبيت كلياً
      Promise.allSettled(
        APP_SHELL_FILES.map((url) => cache.add(new Request(url, { cache: 'reload' })))
      )
    )
  );
  // ملاحظة: لا نستدعي skipWaiting() هنا — التحديث يُفعَّل من المستخدم عبر زر
  // "تحديث الآن" في التطبيق (رسالة SKIP_WAITING) حتى لا يُستبدل التطبيق فجأة
  // أثناء كتابة فاتورة.
});

/* ------------------------------ التفعيل ------------------------------ */
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable();
      }
    } catch (_e) { /* غير مدعوم */ }

    // حذف أي كاش قديم من إصدارات سابقة
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => key !== APP_SHELL_CACHE && key !== RUNTIME_CACHE)
        .map((key) => caches.delete(key))
    );

    // التحكم بالصفحة المفتوحة حالاً (أول تثبيت بدون ريلود — التطبيق يعالج
    // أول controllerchange بدون إعادة تحميل)
    await self.clients.claim();
  })());
});

/* --------------------- جلب الشبكة مع مهلة زمنية ---------------------- */
function fetchWithTimeout(request, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms);
    fetch(request).then(
      (response) => { clearTimeout(timer); resolve(response); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

/* -------- التنقّل بين الصفحات: الشبكة أولاً ثم الكاش ثم أوفلاين -------- */
async function handleNavigation(request, event) {
  // طلب التنقّل المسبق من المتصفح (أسرع استجابة وبدون إلغاء preload)
  const preload = (event && event.preloadResponse)
    ? event.preloadResponse.catch(() => null)
    : Promise.resolve(null);

  const fresh = await preload
    .then((preloaded) => preloaded || fetchWithTimeout(request, 3000))
    .then(async (response) => {
      if (response && response.ok) {
        const cache = await caches.open(APP_SHELL_CACHE);
        await cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  // الشبكة متاحة → نخدم النسخة الجديدة (أي تعديل محلّي على index.html يظهر فوراً)
  if (fresh) return fresh;

  // بدون شبكة: نسخة الكاش أولاً (ignoreSearch لتجاوز معاملات البحث)
  let cached = await caches.match(request, { ignoreSearch: true });
  if (!cached) cached = await caches.match(OFFLINE_FALLBACK);
  if (cached) return cached;

  return new Response(
    '<!doctype html><html dir="rtl" lang="ar"><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>لا يوجد اتصال</title>' +
    '<body style="margin:0;display:grid;place-items:center;min-height:100vh;' +
    'font-family:Tajawal,Segoe UI,Tahoma,sans-serif;background:#101A24;color:#fff;text-align:center">' +
    '<div><h1 style="font-size:20px;margin:0 0 8px">لا يوجد اتصال بالإنترنت</h1>' +
    '<p style="opacity:.75;margin:0 0 16px">افتح التطبيق مرة أخرى عند عودة الشبكة</p>' +
    '<button onclick="location.reload()" style="font:inherit;padding:10px 22px;border:0;border-radius:10px;' +
    'background:#17A79C;color:#fff;cursor:pointer">إعادة المحاولة</button></div></body></html>',
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

/* --------- باقي الطلبات: Stale-While-Revalidate ----------------------- */
async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  // ignoreSearch: تجاهل معاملات الاستعلام (?v= مثلاً) حتى لا تفشل مطابقة الصور المحفوظة محلياً
  const inRuntime = await cache.match(request, { ignoreSearch: true });
  // إن لم يكن الملف في كاش وقت التشغيل نبحث في باقي الكاشات (منها هيكل التطبيق):
  // بدون هذا يعود 504 لملف من ملفات التطبيق أثناء عدم الاتصال لمجرد أنه لم يُطلب من قبل
  const cached = inRuntime || await caches.match(request, { ignoreSearch: true });
  const alreadyInShell = !inRuntime && !!cached;

  const networkFetch = fetchWithTimeout(request, 4000)
    .then(async (response) => {
      // الكاش فقط لما هو صالح — لا نخزّن أخطاء 404/500 (وردود CDN الشفافة مسموحة)
      // ولا نكرر ملفاً موجوداً أصلاً في كاش هيكل التطبيق
      if (response && (response.ok || response.type === 'opaque') && response.status !== 206 && !alreadyInShell) {
        await cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  if (cached) {
    // نخدم المحفوظ فوراً ونحدّث الكاش بالخلفية (الوعد يبقى حياً حتى ينتهي)
    void networkFetch;
    return cached;
  }
  const fresh = await networkFetch;
  return fresh || new Response('', { status: 504 });
}

/* ------------------------------ الاعتراض ----------------------------- */
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // غير http/https (امتدادات المتصفح مثلاً) — لا علاقة لها بالتطبيق
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // حماية أخيرة: أي خطأ غير متوقع داخل معالج الطلب يعود بالكاش إن وجد،
  // وإلا استجابة 504 — بدل أن يتحوّل الفشل لخطأ شبكة صريح أمام المستخدم
  const respond = (p) => event.respondWith(
    p.catch(() =>
      caches.match(request, { ignoreSearch: true })
        .then((m) => m || new Response('', { status: 504 }))
        .catch(() => new Response('', { status: 504 }))
    )
  );

  if (request.mode === 'navigate' || request.destination === 'document') {
    respond(handleNavigation(request, event));
    return;
  }

  // نفس الأصل + ملفات CDN الخارجية: SWR حتى يعمل التطبيق أوفلاين
  respond(staleWhileRevalidate(request));
});

/* -------- رسائل من الصفحة: SKIP_WAITING للتحديث، PING للاستكشاف -------- */
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  if (data.type === 'PING' && event.ports && event.ports[0]) {
    event.ports[0].postMessage({ type: 'PONG', version: CACHE_VERSION });
  }
});
