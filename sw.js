const CACHE="spese-plus-1-3-0";
const ROOT=self.registration.scope;
const CORE=["./","./index.html","./styles.css?v=1.3.0","./app.js?v=1.3.0","./firebase-config.js","./manifest.webmanifest?v=1.3.0","./icon-192.png","./icon-512.png","./apple-touch-icon.png?v=1.3.0"].map(path=>new URL(path,ROOT).toString());

self.addEventListener("install",event=>{
  self.skipWaiting();
  // Un singolo file opzionale non deve impedire l'installazione del nuovo SW.
  event.waitUntil(caches.open(CACHE).then(cache=>Promise.all(
    CORE.map(url=>fetch(url,{cache:"no-store"}).then(response=>{
      if(response&&response.ok)return cache.put(url,response.clone());
    }).catch(()=>undefined))
  )));
});

self.addEventListener("activate",event=>{
  event.waitUntil(Promise.all([
    self.clients.claim(),
    caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key))))
  ]));
});

self.addEventListener("fetch",event=>{
  if(event.request.method!=="GET")return;
  const url=new URL(event.request.url);

  if(url.origin!==self.location.origin){
    if(url.hostname==="www.gstatic.com"&&url.pathname.includes("/firebasejs/")){
      event.respondWith(fetch(event.request).catch(()=>caches.match(event.request)));
    }
    return;
  }

  // Non intercettare risorse esterne al percorso GitHub Pages del progetto.
  if(!url.href.startsWith(ROOT))return;

  const isCore = event.request.mode==="navigate" ||
    /\.(?:html|js|css|webmanifest)$/.test(url.pathname) ||
    url.href===ROOT || url.pathname.endsWith("/sw.js");

  if(isCore){
    // Network-first + no-store: gli aggiornamenti non restano bloccati nella cache HTTP/PWA.
    event.respondWith(fetch(event.request,{cache:"no-store"}).then(response=>{
      if(response&&response.ok){
        const copy=response.clone();
        caches.open(CACHE).then(cache=>cache.put(event.request,copy));
      }
      return response;
    }).catch(()=>caches.match(event.request).then(cached=>cached||caches.match(ROOT))));
    return;
  }

  // Immagini e altre risorse: cache rapida con aggiornamento in background.
  event.respondWith(caches.match(event.request).then(cached=>{
    const fresh=fetch(event.request).then(response=>{
      if(response&&response.ok){
        const copy=response.clone();
        caches.open(CACHE).then(cache=>cache.put(event.request,copy));
      }
      return response;
    }).catch(()=>cached);
    return cached||fresh;
  }));
});
