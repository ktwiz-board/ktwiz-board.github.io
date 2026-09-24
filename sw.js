// wiz board 서비스워커 — 설치형 앱(PWA/TWA) 요건 + 오프라인 대비
// 원칙: 실시간 데이터는 절대 캐시에서 먼저 주지 않는다.
//  - 페이지(HTML)·version.txt·data/: 네트워크 우선, 실패 시에만 캐시(오프라인 폴백)
//  - img/·manifest: 캐시 우선(바뀌면 CACHE 이름을 올려 교체)
//  - 외부 출처(GitHub API, Open-Meteo, GA 등): 관여하지 않음
const CACHE = 'wizboard-v1';
const CORE = ['./', 'index.html', 'manifest.json', 'img/app/icon-192.png', 'img/app/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;

  const networkFirst = req.mode === 'navigate' || url.pathname.endsWith('.html') ||
    url.pathname.endsWith('version.txt') || url.pathname.includes('/data/');

  if (networkFirst) {
    e.respondWith(
      fetch(req).then(res => {
        if (res.ok && req.mode === 'navigate') {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put('index.html', copy));
        }
        return res;
      }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('index.html')))
    );
    return;
  }

  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok && url.pathname.includes('/img/')) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
      }
      return res;
    }))
  );
});
