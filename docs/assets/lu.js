/* Locally Uncensored — shared marketing behaviour (vanilla, no deps).
   Ported from the lu-labs.ai React components (LuMonogram / SiteNav).
   Builds the 3D monogram, injects the ambient background + atmosphere,
   and wires the theme toggle + mobile nav. Purely visual; no SEO impact. */
(function () {
  "use strict";
  var MARK = "/assets/marketing/";
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ── 3D monogram ──────────────────────────────────────────────────────
  var VARIANTS = {
    nav:  { N: 12, depth: 36, tilt: 16, persp: 400,  size: 52,
            haloBlur: 9,  haloZ: -40,
            glow: "drop-shadow(0 0 2px rgba(139,92,246,0.6))",
            outline: "drop-shadow(0.3px 0.3px 0 rgba(0,0,0,0.55)) drop-shadow(-0.3px -0.3px 0 rgba(0,0,0,0.55)) drop-shadow(0.3px -0.3px 0 rgba(0,0,0,0.55)) drop-shadow(-0.3px 0.3px 0 rgba(0,0,0,0.55))" },
    hero: { N: 18, depth: 92, tilt: 18, persp: 1000, size: 172,
            haloBlur: 30, haloZ: -85,
            glow: "drop-shadow(0 0 6px rgba(139,92,246,0.85)) drop-shadow(0 0 16px rgba(139,92,246,0.5))",
            outline: (function () {
              var o = [];
              [0.55, -0.55].forEach(function (x) {
                [0.55, -0.55].forEach(function (y) { o.push("drop-shadow(" + x + "px " + y + "px 0 rgba(0,0,0,0.55))"); });
              });
              o.push("drop-shadow(0.65px 0 0 rgba(0,0,0,0.55))", "drop-shadow(-0.65px 0 0 rgba(0,0,0,0.55))",
                     "drop-shadow(0 0.65px 0 rgba(0,0,0,0.55))", "drop-shadow(0 -0.65px 0 rgba(0,0,0,0.55))");
              return o.join(" ");
            })() }
  };

  function backLayers(N, depth, base, span) {
    var out = [];
    for (var i = 0; i < N - 1; i++) {
      var t = i / (N - 1);
      out.push({ z: Math.round(t * depth), b: (base + span * t).toFixed(2) });
    }
    return out;
  }

  function img(cls, src, z, filter) {
    var el = document.createElement("img");
    el.className = cls; el.src = src; el.alt = ""; el.setAttribute("aria-hidden", "true");
    el.style.transform = "translateZ(" + z + "px)";
    if (filter) el.style.filter = filter;
    return el;
  }

  function buildMono(host) {
    var v = VARIANTS[host.dataset.mono] || VARIANTS.nav;
    var size = parseInt(host.dataset.size, 10) || v.size;
    host.textContent = "";
    host.style.width = size + "px"; host.style.height = size + "px";

    var stage = document.createElement("div");
    stage.className = "lu-mono-stage";
    stage.style.perspective = v.persp + "px";
    stage.style.perspectiveOrigin = "50% 45%";
    stage.style.width = size + "px"; stage.style.height = size + "px";

    var tilt = document.createElement("div");
    tilt.className = "lu-mono-tilt";
    tilt.style.width = size + "px"; tilt.style.height = size + "px";

    var halo = document.createElement("div");
    halo.className = "lu-mono-halo";
    halo.style.filter = "blur(" + v.haloBlur + "px)";
    halo.style.transform = "translate(-50%,-50%) translateZ(" + v.haloZ + "px)";

    var sway = document.createElement("div");
    sway.className = "lu-mono-sway";
    var extrude = document.createElement("div");
    extrude.className = "lu-mono-extrude";

    backLayers(v.N, v.depth, 0.38, 0.7).forEach(function (l) {
      extrude.appendChild(img("lu-mono-layer", MARK + "lu-ring-flat.png", l.z, "brightness(" + l.b + ")"));
    });
    extrude.appendChild(img("lu-mono-layer", MARK + "lu-ring-metal.png", v.depth, "brightness(1.05) " + v.glow));
    backLayers(v.N, v.depth, 0.4, 0.66).forEach(function (l) {
      extrude.appendChild(img("lu-mono-layer", MARK + "lu-letters-flat.png", l.z, "brightness(" + l.b + ")"));
    });
    extrude.appendChild(img("lu-mono-layer", MARK + "lu-letters-violet.png", v.depth, "brightness(1.05) " + v.outline + " " + v.glow));

    var sheen = document.createElement("div");
    sheen.className = "lu-mono-sheen";
    sheen.style.transform = "translateZ(" + (v.depth + 2) + "px)";

    sway.appendChild(extrude); sway.appendChild(sheen);
    tilt.appendChild(halo); tilt.appendChild(sway);
    stage.appendChild(tilt); host.appendChild(stage);

    if (!reduce) {
      stage.addEventListener("mousemove", function (e) {
        var r = stage.getBoundingClientRect();
        var px = (e.clientX - r.left) / r.width - 0.5;
        var py = (e.clientY - r.top) / r.height - 0.5;
        tilt.style.transform = "rotateX(" + (-py * v.tilt).toFixed(2) + "deg) rotateY(" + (px * v.tilt).toFixed(2) + "deg)";
      });
      stage.addEventListener("mouseleave", function () {
        tilt.style.transform = "rotateX(0deg) rotateY(0deg)";
      });
    }
  }

  // ── Ambient background + atmosphere ──────────────────────────────────
  function injectAmbient() {
    if (!document.querySelector(".lu-bg")) {
      var bg = document.createElement("div"); bg.className = "lu-bg"; bg.setAttribute("aria-hidden", "true");
      ["b1", "b2", "b3", "b4"].forEach(function (c) {
        var b = document.createElement("div"); b.className = "lu-blob " + c; bg.appendChild(b);
      });
      document.body.insertBefore(bg, document.body.firstChild);
    }
    if (!document.querySelector(".lu-atmosphere")) {
      var atm = document.createElement("div"); atm.className = "lu-atmosphere"; atm.setAttribute("aria-hidden", "true");
      var v = document.createElement("div"); v.className = "lu-vignette";
      var g = document.createElement("div"); g.className = "lu-grain";
      atm.appendChild(v); atm.appendChild(g);
      document.body.appendChild(atm);
    }
  }

  // ── Theme toggle (same data-theme mechanism as before) ───────────────
  function wireTheme() {
    var sw = document.getElementById("theme-switch");
    if (!sw) return;
    sw.addEventListener("click", function () {
      var root = document.documentElement;
      root.setAttribute("data-theme", root.getAttribute("data-theme") === "dark" ? "light" : "dark");
    });
  }

  // ── Mobile nav ───────────────────────────────────────────────────────
  function wireNav() {
    var t = document.querySelector(".lu-nav-toggle");
    var links = document.querySelector(".lu-nav-links");
    if (t && links) t.addEventListener("click", function () { links.classList.toggle("open"); });
  }

  // ── Scroll arrow (index) — smooth scroll without adding a hash ────────
  function wireScrollArrow() {
    var a = document.querySelector(".scroll-arrow");
    if (!a) return;
    a.addEventListener("click", function (e) {
      e.preventDefault();
      var t = document.getElementById("content-start");
      if (t) t.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  // ── Language toggle (EN ↔ DE, client-side via Google Translate) ──────
  var LANG_KEY = "lu-lang";
  var FLAG_DE = '<svg viewBox="0 0 60 40" aria-hidden="true"><rect width="60" height="40" fill="#000"/><rect y="13.4" width="60" height="13.3" fill="#D00"/><rect y="26.7" width="60" height="13.3" fill="#FFCE00"/></svg>';
  var FLAG_EN = '<svg viewBox="0 0 60 40" aria-hidden="true"><rect width="60" height="40" fill="#012169"/><path d="M0 0l60 40M60 0L0 40" stroke="#fff" stroke-width="8"/><path d="M0 0l60 40M60 0L0 40" stroke="#C8102E" stroke-width="4"/><path d="M30 0v40M0 20h60" stroke="#fff" stroke-width="13"/><path d="M30 0v40M0 20h60" stroke="#C8102E" stroke-width="8"/></svg>';

  function langPref() {
    try { return localStorage.getItem(LANG_KEY); } catch (e) { return null; }
  }
  function pageLang() { return (document.documentElement.lang || "en").slice(0, 2); }

  function setGoogTrans(v) {
    ["", "; domain=" + location.hostname, "; domain=." + location.hostname].forEach(function (d) {
      document.cookie = v
        ? "googtrans=" + v + "; expires=Fri, 31 Dec 2038 23:59:59 GMT; path=/" + d
        : "googtrans=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/" + d;
    });
  }

  function bootTranslate(target) {
    setGoogTrans("/auto/" + target);
    var brands = document.querySelectorAll(".lu-nav-word, .mast-title");
    for (var i = 0; i < brands.length; i++) brands[i].classList.add("notranslate");
    var holder = document.createElement("div");
    holder.id = "lu-gt"; holder.className = "notranslate";
    document.body.appendChild(holder);
    window.luGTInit = function () {
      new google.translate.TranslateElement({ pageLanguage: pageLang(), includedLanguages: "de,en", autoDisplay: false }, "lu-gt");
    };
    var s = document.createElement("script");
    s.src = "https://translate.google.com/translate_a/element.js?cb=luGTInit";
    s.async = true;
    document.body.appendChild(s);
  }

  function wireLang() {
    if (pageLang() !== "en") return;
    var pref = langPref();
    var target = pref === "de" ? "en" : "de";
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "lu-lang notranslate";
    btn.setAttribute("translate", "no");
    btn.title = target === "de" ? "Auf Deutsch anzeigen" : "Show in English";
    btn.setAttribute("aria-label", btn.title);
    btn.innerHTML = target === "de" ? FLAG_DE : FLAG_EN;
    btn.addEventListener("click", function () {
      try { localStorage.setItem(LANG_KEY, target); } catch (e) {}
      setGoogTrans(target === "de" ? "/auto/de" : null);
      location.reload();
    });
    var right = document.querySelector(".lu-nav-right");
    if (right) right.insertBefore(btn, right.firstChild);
    else { btn.classList.add("fixed"); document.body.appendChild(btn); }

    if (pref === "de") bootTranslate("de");
    else setGoogTrans(null);
  }

  function init() {
    injectAmbient();
    var monos = document.querySelectorAll("[data-mono]");
    for (var i = 0; i < monos.length; i++) buildMono(monos[i]);
    wireTheme(); wireNav(); wireScrollArrow(); wireLang();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
