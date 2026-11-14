// 운영 종료: 이전 보드의 오프라인 캐시를 정리하고 네트워크 응답만 사용한다.
self.addEventListener('install', e => e.waitUntil(self.skipWaiting()));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('wizboard-')).map(k => caches.delete(k)))).then(() => self.clients.claim())));
