self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open('static-cache').then((cache) => {
            return cache.addAll([
                '/',
                '/app.js',
                '/index.html',
                '/2-add-teams.html',
                '/3-gameplay.html',
                '/end.html',
                '/style.css',
                '/script.js',
                '/questions.js',
                '/game.js',
                '/game2.js',
                '/end.js',
                '/addTeam.js',
                '/manifest.json',
                '/app_icon.png',
                '/app_icon.svg',
                '/logo.png',
                '/speech.png'
            ]);
        })
    );
});

self.addEventListener('fetch', (event) => {
    event.respondWith(
        caches.match(event.request).then((response) => {
            return response || fetch(event.request);
        })
    );
});