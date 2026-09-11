/* ============================================================
   Flakymama — map widget for Webflow  ·  v2 (real tiles)
   ------------------------------------------------------------
   Renders real street tiles from OpenFreeMap via MapLibre GL JS.
   Falls back to the illustrated map if tiles or the library fail,
   so an outage degrades instead of breaking.

   No account. No API key. No card. No build step.

   WHAT CHANGED FROM v1
   - Real streets, water, parks, labels — every city works with
     no per-city artwork.
   - MapLibre GL JS loads itself from a CDN; you still paste one
     script tag.
   - The Webflow side is UNCHANGED: same embeds, same classes,
     same CMS fields. `data-map-art` now only affects the fallback.

   HOW IT WORKS
   1. Webflow renders one hidden <div class="cafe-data"> per cafe
      inside the Collection List (see embeds.html).
   2. This script reads those elements and drops a numbered pin
      for each, fitted to the whole set.
   3. Scrolling the list highlights the matching pin and eases the
      map to it; clicking a pin scrolls to the matching entry.

   WHERE TO PASTE
   Page Settings → Custom Code → Before </body>:
       <script src="URL-TO-THIS-FILE"></script>

   REQUIRED MARKUP (built in the Webflow canvas)
   - <div id="flaky-map"></div>   the map container
   - .cafe-data    one per cafe, inside the Collection Item
   - .cafe-entry   the visible cafe list item
   - .cafe-num     the numbered circle inside .cafe-entry

   ATTRIBUTION
   MapLibre renders the OpenStreetMap credit automatically in the
   bottom corner (compact mode: a small (i) that expands on click).
   OSM data is ODbL-licensed, so the credit is legally required — it
   can be restyled or collapsed, never removed.

   SWITCHING TILE PROVIDERS
   Change CFG.styleUrl. Nothing else in this file is provider
   specific, so moving to MapTiler, Mapbox, or a self-hosted
   style is a one-line edit.

   HOSTING
   CFG.styleUrl defaults to null, which means "flaky-style.json,
   sitting next to this script". Keep the two files in the same
   folder and this file needs no edit on any host — GitHub Pages,
   jsDelivr, Webflow Assets, your own server. Set CFG.styleUrl (or
   the container's data-map-style attribute) only to override that.

   CONTROLS
   + / - zoom.  (o) refits every pin in frame.  Scroll-wheel zoom
   is deliberately off — see CFG.wheelZoom.
   ============================================================ */

(function () {
  "use strict";

  /* Our own URL, captured while the script is executing — document.currentScript
     is null inside any later callback, so it has to be read here. Used to find
     flaky-style.json in the same folder. Empty when inlined rather than linked. */
  var SELF_SRC = (document.currentScript && document.currentScript.src) || "";

  var CFG = {
    /* Tiles. null = use flaky-style.json from this script's own folder.
       Set a URL to override: the site palette elsewhere, or an OpenFreeMap
       preset — .../styles/positron | bright | liberty */
    styleUrl: null,
    fallbackStyleUrl: "https://tiles.openfreemap.org/styles/positron",

    /* MapLibre GL JS, pinned. Bump the version deliberately, never
       automatically — an unpinned CDN URL is a silent breakage risk. */
    maplibreJs: "https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js",
    maplibreCss: "https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css",

    mapSelector: "#flaky-map",
    dataSelector: ".cafe-data",
    entrySelector: ".cafe-entry",
    numSelector: ".cafe-num",

    accent: null,        // null = read --accent from the page
    scrollOffset: 90,    // px of sticky nav to clear when scrolling to an entry
    fitPadding: 56,      // px of breathing room around the pin set (narrow frames use 30)
    pinPadding: 18,      // markers are ~30px wide and centre-anchored, so pad for the pin itself
    maxFitZoom: 15.2,    // only applies when a single pin is on the map
    wheelZoom: false,    // true re-enables scroll-wheel zoom over the map
    focusZoom: 15,       // zoom used when a list entry takes focus
    libTimeout: 9000,    // ms to wait for MapLibre before falling back
    tileTimeout: 11000   // ms to wait for first render before falling back
  };

  var MW = 1000, MH = 611; // fallback artboard size

  function ready(fn) {
    if (document.readyState !== "loading") fn();
    else document.addEventListener("DOMContentLoaded", fn);
  }

  ready(function () {
    var host = document.querySelector(CFG.mapSelector);
    if (!host) return;

    /* ---------- 1. read cafe data out of the DOM ---------- */
    var cafes = [].slice.call(document.querySelectorAll(CFG.dataSelector))
      .map(function (el) {
        return {
          name: (el.dataset.name || "").trim(),
          slug: (el.dataset.slug || "").trim(),
          lat: parseFloat(el.dataset.lat),
          lng: parseFloat(el.dataset.lng)
        };
      })
      .filter(function (c) { return isFinite(c.lat) && isFinite(c.lng); });

    if (!cafes.length) {
      host.setAttribute("data-flaky-state", "no-data");
      if (window.console) {
        console.warn("[flaky-map] No valid .cafe-data elements found. Check that " +
          "the Latitude/Longitude CMS fields are filled in, are Number fields " +
          "(not Plain Text), and that the embed's CMS tokens were inserted with " +
          "'+ Add Field' rather than typed by hand.");
      }
      return;
    }
    cafes.forEach(function (c, i) { c.i = i; c.num = i + 1; });

    var accent = CFG.accent || getComputedStyle(document.documentElement)
      .getPropertyValue("--accent").trim() || "#C13B22";

    injectStyles(accent);
    if (getComputedStyle(host).position === "static") host.style.position = "relative";
    host.style.overflow = "hidden";

    var entries = [].slice.call(document.querySelectorAll(CFG.entrySelector));
    var settled = false;

    function settle(mode, fn) {
      if (settled) return;
      settled = true;
      host.setAttribute("data-flaky-state", mode);
      fn();
    }

    /* ---------- 2. try tiles, fall back if anything goes wrong ---------- */
    loadMapLibre(function (ok) {
      if (!ok) {
        if (window.console) console.warn("[flaky-map] MapLibre failed to load — using the illustrated fallback.");
        return settle("fallback", function () { initFallback(host, cafes, entries, accent); });
      }
      initTiles(host, cafes, entries, accent, settle);
    });

    setTimeout(function () {
      settle("fallback", function () {
        if (window.console) console.warn("[flaky-map] Tiles did not render in time — using the illustrated fallback.");
        initFallback(host, cafes, entries, accent);
      });
    }, CFG.tileTimeout);

    wireRailFade();
  });

  /* ============ tile renderer ============ */

  function initTiles(host, cafes, entries, accent, settle) {
    var styleUrl = resolveStyleUrl(host);

    var map;
    try {
      map = new window.maplibregl.Map({
        container: host,
        style: styleUrl,
        center: [cafes[0].lng, cafes[0].lat],
        zoom: 12,
        attributionControl: { compact: true },
        preserveDrawingBuffer: true,  // lets screenshots / PDF export capture the map
        cooperativeGestures: false,
        dragRotate: false,
        pitchWithRotate: false,
        touchZoomRotate: true
      });
    } catch (e) {
      if (window.console) console.warn("[flaky-map] MapLibre threw on init:", e);
      return settle("fallback", function () { initFallback(host, cafes, entries, accent); });
    }

    map.touchZoomRotate && map.touchZoomRotate.disableRotation();
    // Wheel zoom hijacks page scroll on a page people read top to bottom.
    if (!CFG.wheelZoom) map.scrollZoom.disable();
    map.addControl(new window.maplibregl.NavigationControl({ showCompass: false }), "top-left");
    map.addControl(new ResetControl(function () { fitAll(map, host, cafes); }), "top-left");

    var styleFailed = false;
    map.on("error", function (e) {
      var msg = (e && e.error && e.error.message) || "";
      // A missing style is fatal; a few missing tiles are not.
      if (/style|glyph/i.test(msg) && !styleFailed) {
        styleFailed = true;
        if (window.console) console.warn("[flaky-map] Style failed to load, retrying with the OpenFreeMap preset:", msg);
        try { map.setStyle(CFG.fallbackStyleUrl); } catch (err) {}
      }
    });

    map.on("load", function () {
      settle("tiles", function () {});

      var bounds = new window.maplibregl.LngLatBounds();
      var pins = cafes.map(function (c) {
        bounds.extend([c.lng, c.lat]);
        var el = buildPin(c, accent);
        el.addEventListener("click", function (ev) {
          ev.stopPropagation();
          scrollToEntry(c.i);
        });
        new window.maplibregl.Marker({ element: el, anchor: "center" })
          .setLngLat([c.lng, c.lat])
          .addTo(map);
        return el;
      });

      fitAll(map, host, cafes);

      var active = null, userMoving = false;
      ["dragstart", "zoomstart"].forEach(function (ev) {
        map.on(ev, function () { userMoving = true; });
      });
      ["dragend", "zoomend"].forEach(function (ev) {
        map.on(ev, function () { userMoving = false; });
      });

      function setActive(i, recenter) {
        if (!pins[i]) return;
        if (i !== active) {
          if (active != null && pins[active]) pins[active].classList.remove("is-on");
          pins[i].classList.add("is-on");
          paintNums(entries, i, accent);
          active = i;
        }
        if (recenter && !userMoving) {
          map.easeTo({
            center: [cafes[i].lng, cafes[i].lat],
            zoom: Math.max(map.getZoom(), CFG.focusZoom),
            duration: 620
          });
        }
      }

      function scrollToEntry(i) {
        var el = entries[i];
        setActive(i, true);
        if (!el) return;
        window.scrollTo({
          top: el.getBoundingClientRect().top + window.pageYOffset - CFG.scrollOffset,
          behavior: "smooth"
        });
      }

      observeEntries(entries, function (i) { setActive(i, true); });
      setActive(0, false);
      window.addEventListener("resize", function () { map.resize(); });
      if (window.ResizeObserver) new ResizeObserver(function () { map.resize(); }).observe(host);
    });
  }

  /* Fit every pin in frame.
     fitBounds' maxZoom clamps the camera BEFORE the bounds fit, so in a narrow
     container (a sidebar map) the outermost pins fall off canvas. cameraForBounds
     computes the camera honestly; maxZoom is applied only when a single pin would
     otherwise zoom to rooftop level. */
  function fitAll(map, host, cafes) {
    if (!cafes.length) return;
    map.resize();
    var w = host.clientWidth || 0, h = host.clientHeight || w;
    var lngs = cafes.map(function (c) { return c.lng; });
    var lats = cafes.map(function (c) { return c.lat; });
    var sw = [Math.min.apply(null, lngs), Math.min.apply(null, lats)];
    var ne = [Math.max.apply(null, lngs), Math.max.apply(null, lats)];
    var pad = (w < 560 ? 30 : CFG.fitPadding) + CFG.pinPadding;
    var cam = null;
    try { cam = map.cameraForBounds([sw, ne], { padding: pad }); } catch (e) { cam = null; }
    if (!cam) {
      var cy = (sw[1] + ne[1]) / 2;
      var dLng = Math.max(1e-6, ne[0] - sw[0]);
      var dLat = Math.max(1e-6, ne[1] - sw[1]);
      var zx = Math.log2(((w - pad * 2) * 360) / (512 * dLng));
      var zy = Math.log2(((h - pad * 2) * 360) / (512 * dLat / Math.cos(cy * Math.PI / 180)));
      cam = { center: [(sw[0] + ne[0]) / 2, cy], zoom: Math.max(9, Math.min(zx, zy)) };
    }
    if (cafes.length === 1) cam.zoom = Math.min(cam.zoom, CFG.maxFitZoom);
    map.jumpTo({ center: cam.center, zoom: cam.zoom });
  }

  /* ============ illustrated fallback ============ */
  /* Shown only when tiles are unavailable. Static — pan and zoom
     live in the tile renderer. Geographically fitted, so pins keep
     their correct relative positions. */

  function initFallback(host, cafes, entries, accent) {
    host.innerHTML = "";
    host.style.userSelect = "none";

    var art = (host.dataset.mapArt || "").toLowerCase();
    var B;
    if (art === "sf") {
      B = { w: -122.520, e: -122.375, s: 37.740, n: 37.810 };
    } else {
      var lats = cafes.map(function (c) { return c.lat; });
      var lngs = cafes.map(function (c) { return c.lng; });
      var padY = Math.max((Math.max.apply(null, lats) - Math.min.apply(null, lats)) * 0.18, 0.004);
      var padX = Math.max((Math.max.apply(null, lngs) - Math.min.apply(null, lngs)) * 0.18, 0.005);
      B = {
        s: Math.min.apply(null, lats) - padY, n: Math.max.apply(null, lats) + padY,
        w: Math.min.apply(null, lngs) - padX, e: Math.max.apply(null, lngs) + padX
      };
    }

    var world = document.createElement("div");
    world.style.cssText = "position:absolute;inset:0;overflow:hidden;";
    world.innerHTML = art === "sf" ? sfBackdrop() : gridBackdrop();
    var svg = world.firstChild;
    svg.setAttribute("preserveAspectRatio", "xMidYMid slice");
    svg.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;";
    host.appendChild(world);

    var pins = cafes.map(function (c) {
      var el = buildPin(c, accent);
      el.classList.add("flaky-pin--abs");
      el.style.left = ((c.lng - B.w) / (B.e - B.w) * 100) + "%";
      el.style.top = ((B.n - c.lat) / (B.n - B.s) * 100) + "%";
      el.addEventListener("click", function (ev) {
        ev.stopPropagation();
        var t = entries[c.i];
        if (t) {
          window.scrollTo({
            top: t.getBoundingClientRect().top + window.pageYOffset - CFG.scrollOffset,
            behavior: "smooth"
          });
        }
      });
      world.appendChild(el);
      return el;
    });

    var note = document.createElement("div");
    note.textContent = "Illustrative map";
    note.style.cssText = "position:absolute;bottom:8px;right:10px;z-index:500;" +
      "font:500 10px/1 inherit;color:rgba(26,23,20,.5);background:rgba(255,255,255,.72);" +
      "padding:3px 6px;border-radius:4px;";
    host.appendChild(note);

    var active = null;
    observeEntries(entries, function (i) {
      if (i === active || !pins[i]) return;
      if (active != null && pins[active]) pins[active].classList.remove("is-on");
      pins[i].classList.add("is-on");
      paintNums(entries, i, accent);
      active = i;
    });
    if (pins[0]) { pins[0].classList.add("is-on"); paintNums(entries, 0, accent); active = 0; }
  }

  /* ============ shared helpers ============ */

  /* Style URL, most specific wins:
       1. data-map-style on the container  — per-page override
       2. CFG.styleUrl                     — explicit, set by hand
       3. flaky-style.json beside this file — the normal case
       4. OpenFreeMap positron              — last resort, warns */
  function resolveStyleUrl(host) {
    var explicit = (host && host.dataset.mapStyle) || CFG.styleUrl;
    if (explicit && !/YOUR-HOST/.test(explicit)) return explicit;

    if (SELF_SRC) {
      try { return new URL("flaky-style.json", SELF_SRC).href; } catch (e) {}
    }

    if (window.console) {
      console.warn("[flaky-map] Could not resolve flaky-style.json — using the " +
        "OpenFreeMap preset. The map works, it just won't match the site palette. " +
        "Either host flaky-style.json beside this script, or set CFG.styleUrl.");
    }
    return CFG.fallbackStyleUrl;
  }

  /* Refit-to-all-pins control. MapLibre ships zoom and compass; this is the
     third button the spec asks for — once someone has panned off to Daly City,
     it puts every pin back in frame. */
  function ResetControl(onReset) { this._onReset = onReset; }

  ResetControl.prototype.onAdd = function (map) {
    this._map = map;
    var wrap = document.createElement("div");
    wrap.className = "maplibregl-ctrl maplibregl-ctrl-group";
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "flaky-ctrl-reset";
    btn.title = "Show all pins";
    btn.setAttribute("aria-label", "Show all pins");
    var icon = document.createElement("span");
    icon.className = "maplibregl-ctrl-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "\u25CE";
    btn.appendChild(icon);
    btn.addEventListener("click", this._onReset);
    wrap.appendChild(btn);
    this._container = wrap;
    return wrap;
  };

  ResetControl.prototype.onRemove = function () {
    if (this._container && this._container.parentNode) {
      this._container.parentNode.removeChild(this._container);
    }
    this._map = undefined;
  };

  function buildPin(c, accent) {
    var el = document.createElement("button");
    el.className = "flaky-pin";
    el.type = "button";
    el.setAttribute("aria-label", c.num + ". " + c.name);
    el.title = c.num + ". " + c.name;
    var shape = document.createElement("span");
    shape.className = "flaky-pin-shape";
    var num = document.createElement("span");
    num.className = "flaky-pin-num";
    num.textContent = c.num;
    el.appendChild(shape);
    el.appendChild(num);
    return el;
  }

  function paintNums(entries, i, accent) {
    entries.forEach(function (entry, idx) {
      var num = entry.querySelector(CFG.numSelector);
      if (!num) return;
      var on = idx === i;
      num.style.background = on ? accent : "#fff";
      num.style.color = on ? "#fff" : accent;
    });
  }

  function observeEntries(entries, onEnter) {
    if (!window.IntersectionObserver || !entries.length) return;
    var io = new IntersectionObserver(function (list) {
      list.forEach(function (e) {
        if (!e.isIntersecting) return;
        var idx = entries.indexOf(e.target);
        if (idx > -1) onEnter(idx);
      });
    }, { rootMargin: "-45% 0px -45% 0px", threshold: 0 });
    entries.forEach(function (el) { io.observe(el); });
  }

  function loadMapLibre(done) {
    if (window.maplibregl) return done(true);

    if (!document.querySelector('link[data-flaky-maplibre]')) {
      var css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = CFG.maplibreCss;
      css.setAttribute("data-flaky-maplibre", "");
      document.head.appendChild(css);
    }

    var finished = false;
    var end = function (ok) { if (!finished) { finished = true; done(ok); } };

    var js = document.createElement("script");
    js.src = CFG.maplibreJs;
    js.async = true;
    js.onload = function () { end(!!window.maplibregl); };
    js.onerror = function () { end(false); };
    document.head.appendChild(js);
    setTimeout(function () { end(!!window.maplibregl); }, CFG.libTimeout);
  }

  function injectStyles(accent) {
    if (document.getElementById("flaky-map-styles")) return;
    var s = document.createElement("style");
    s.id = "flaky-map-styles";
    s.textContent =
      ".cafe-data{display:none !important;}" +
      ".flaky-pin{width:30px;height:30px;padding:0;border:0;background:none;position:relative;" +
      "cursor:pointer;font-family:inherit;line-height:1;}" +
      ".flaky-pin--abs{position:absolute;margin:-15px 0 0 -15px;}" +
      ".flaky-pin-shape{position:absolute;inset:0;border-radius:50% 50% 50% 2px;" +
      "transform:rotate(45deg);background:#fff;border:1.5px solid " + accent + ";" +
      "box-shadow:0 2px 6px rgba(0,0,0,.28);transition:background .18s,transform .18s;}" +
      ".flaky-pin-num{position:absolute;inset:0;display:flex;align-items:center;" +
      "justify-content:center;font-weight:800;font-size:13px;color:" + accent + ";" +
      "transition:color .18s;pointer-events:none;}" +
      ".flaky-pin.is-on{z-index:9999;}" +
      ".flaky-pin.is-on .flaky-pin-shape{background:" + accent + ";transform:rotate(45deg) scale(1.22);}" +
      ".flaky-pin.is-on .flaky-pin-num{color:#fff;}" +
      ".maplibregl-ctrl-attrib{font-family:inherit !important;font-size:10px !important;}" +
      ".maplibregl-ctrl-group{border-radius:8px !important;box-shadow:0 1px 5px rgba(0,0,0,.28) !important;}" +
      ".flaky-ctrl-reset .maplibregl-ctrl-icon{display:flex;align-items:center;" +
      "justify-content:center;font:400 17px/1 inherit;color:#333;" +
      "background-image:none !important;}" +
      ".flaky-ctrl-reset:hover .maplibregl-ctrl-icon{color:" + accent + ";}";
    document.head.appendChild(s);
  }

  function wireRailFade() {
    var rail = document.querySelector(".more-maps-scroll");
    var fade = document.querySelector(".more-maps-fade");
    if (!rail || !fade) return;
    var upd = function () {
      fade.style.opacity =
        (rail.scrollLeft + rail.clientWidth >= rail.scrollWidth - 2) ? "0" : "1";
    };
    rail.addEventListener("scroll", upd, { passive: true });
    window.addEventListener("resize", upd);
    upd();
  }

  /* ============ fallback artwork ============ */

  function gridBackdrop() {
    var grid = "";
    for (var x = 0; x <= MW; x += 80) grid += '<line x1="' + x + '" y1="0" x2="' + x + '" y2="' + MH + '"/>';
    for (var y = 0; y <= MH; y += 68) grid += '<line x1="0" y1="' + y + '" x2="' + MW + '" y2="' + y + '"/>';
    return '<svg viewBox="0 0 ' + MW + ' ' + MH + '" xmlns="http://www.w3.org/2000/svg">' +
      '<rect width="' + MW + '" height="' + MH + '" fill="#f6f2e8"/>' +
      '<g stroke="#e6ddcb" stroke-width="1.2">' + grid + '</g></svg>';
  }

  function sfBackdrop() {
    var land = "M40,44 L560,20 L720,26 L812,96 L905,300 L862,600 L40,606 Z";
    var grid = "";
    for (var x = 80; x < MW; x += 80) grid += '<line x1="' + x + '" y1="0" x2="' + x + '" y2="' + MH + '"/>';
    for (var y = 64; y < MH; y += 68) grid += '<line x1="0" y1="' + y + '" x2="' + MW + '" y2="' + y + '"/>';
    var hoods = [
      ["RICHMOND", 250, 250], ["SUNSET", 250, 478], ["GOLDEN GATE PARK", 258, 368],
      ["HAIGHT", 470, 398], ["CASTRO", 548, 452], ["MISSION", 618, 476],
      ["PACIFIC HTS", 560, 208], ["NOB HILL", 700, 222], ["NORTH BEACH", 772, 138],
      ["DOWNTOWN", 772, 262], ["SOMA", 706, 336], ["POTRERO HILL", 800, 470], ["BAYVIEW", 812, 560]
    ].map(function (h) {
      return '<text x="' + h[1] + '" y="' + h[2] + '" fill="#b0a48c" font-family="inherit" ' +
        'font-size="12.5" font-weight="700" letter-spacing="1.1" text-anchor="middle">' + h[0] + '</text>';
    }).join("");
    return '<svg viewBox="0 0 ' + MW + ' ' + MH + '" xmlns="http://www.w3.org/2000/svg">' +
      '<defs><clipPath id="flakyland"><path d="' + land + '"/></clipPath>' +
      '<linearGradient id="flakywater" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" stop-color="#e3eef4"/><stop offset="1" stop-color="#cadeeb"/></linearGradient>' +
      '<filter id="flakyshadow" x="-20%" y="-20%" width="140%" height="140%">' +
      '<feDropShadow dx="0" dy="3" stdDeviation="8" flood-color="#5a6b78" flood-opacity="0.18"/>' +
      '</filter></defs>' +
      '<rect width="' + MW + '" height="' + MH + '" fill="url(#flakywater)"/>' +
      '<path d="' + land + '" fill="#f6f2e8" filter="url(#flakyshadow)"/>' +
      '<g clip-path="url(#flakyland)" stroke="#e6ddcb" stroke-width="1.2">' + grid + '</g>' +
      '<rect x="66" y="350" width="398" height="34" rx="17" fill="#d9e6bf" clip-path="url(#flakyland)"/>' +
      '<g clip-path="url(#flakyland)" stroke="#e0d4bb" stroke-width="5" opacity=".85" stroke-linecap="round">' +
      '<line x1="600" y1="470" x2="840" y2="146"/><line x1="110" y1="300" x2="905" y2="300"/>' +
      '<line x1="470" y1="40" x2="470" y2="600"/></g>' +
      '<path d="' + land + '" fill="none" stroke="#c4d3dd" stroke-width="2.4"/>' +
      '<text x="906" y="250" fill="#93b0c2" font-family="inherit" font-size="14" font-weight="700" ' +
      'letter-spacing="2.5" text-anchor="middle" transform="rotate(90 906 250)">SAN FRANCISCO BAY</text>' +
      hoods + '</svg>';
  }
})();
