/* Tutorial guiado reutilizable (Virelia, 23/11/2026). Sin dependencias.
 *
 * Uso:  GuidedTour.init({ key: "mi-crm", startLabel: "Ver tutorial", spa: false, steps: [ ... ] })
 *
 * Paso: { id, path, target, text?, title, body, placement?, advanceOnClick?, optional? }
 *   path            ruta donde ocurre el paso; si no es la actual, se navega solo.
 *   target          selector CSS del elemento a resaltar.
 *   text            (opcional) entre los elementos que cumplen "target", el primero cuyo texto lo contiene.
 *   placement       top | bottom | left | right | center (por defecto bottom).
 *   advanceOnClick  avanza cuando la persona hace clic de verdad en el elemento resaltado.
 *   optional        si el elemento no existe (p. ej. sección solo de admin), el paso se salta.
 *   requires        selector que debe existir (p. ej. el enlace del menú de esa sección); si no, el paso se salta.
 * spa: true -> navega con history.pushState (React Router, etc.); false -> recarga normal (HTML de servidor).
 * El progreso se guarda en localStorage, así que sobrevive a recargas y a cambios de página.
 */
(function () {
  var cfg, state, ui, cleanup, waitTimer, observer, navAt = 0, gen = 0;

  function load() {
    try { var r = JSON.parse(localStorage.getItem(cfg.key) || "null"); if (r && typeof r.i === "number") return r; } catch (e) {}
    return { active: false, i: 0 };
  }
  function save() { try { localStorage.setItem(cfg.key, JSON.stringify(state)); } catch (e) {} }
  function norm(p) { return (p || "/").replace(/\/+$/, "") || "/"; }
  function here() { return norm(location.pathname); }

  function el(tag, css, text) {
    var n = document.createElement(tag);
    if (css) n.style.cssText = css;
    if (text != null) n.textContent = text;
    return n;
  }

  function find(step) {
    var list = document.querySelectorAll(step.target);
    for (var k = 0; k < list.length; k++) {
      var n = list[k];
      if (n.offsetParent === null && getComputedStyle(n).position !== "fixed") continue; // oculto
      if (!step.text || (n.textContent || "").toLowerCase().indexOf(step.text.toLowerCase()) !== -1) return n;
    }
    return null;
  }

  function goTo(path) {
    if (cfg.spa) {
      history.pushState({}, "", path);
      window.dispatchEvent(new PopStateEvent("popstate"));
    } else {
      location.assign(path);
    }
  }

  function stop() {
    state.active = false; state.i = 0; save();
    teardown();
    renderButton();
  }
  function go(i) {
    if (i < 0) i = 0;
    if (i >= cfg.steps.length) { stop(); return; }
    state.i = i; state.active = true; state.navFor = null; save();
    render();
  }

  function teardown() {
    if (cleanup) { cleanup(); cleanup = null; }
    if (waitTimer) { clearTimeout(waitTimer); waitTimer = null; }
    if (observer) { observer.disconnect(); observer = null; }
    if (ui) { ui.remove(); ui = null; }
    var viejos = document.querySelectorAll('[data-guided-tour-ui]');
    for (var q = 0; q < viejos.length; q++) viejos[q].remove();
  }

  function render() {
    teardown();
    var myGen = ++gen; // cualquier búsqueda anterior queda anulada
    var step = cfg.steps[state.i];
    if (!step) { stop(); return; }
    renderButton();
    if (step.path && here() !== norm(step.path) && state.navFor !== step.id) {
      state.navFor = step.id; save(); // una sola navegación por paso: una redirección del servidor no debe provocar un bucle
      navAt = Date.now();
      goTo(step.path);
      if (cfg.spa) waitAndShow(step, myGen);
      return;
    }
    waitAndShow(step, myGen);
  }

  function waitAndShow(step, myGen) {
    var tries = 0, done = false;
    function attempt() {
      if (done) return true;
      if (myGen !== gen) { done = true; return true; } // anulado por un render más reciente
      if (cfg.spa && step.path && here() !== norm(step.path)) {
        // SPA: si la ruta no coincide tras asentarse, la app redirigió (p. ej. sin permiso): se salta el paso
        if (Date.now() - navAt < 700) return false;
        done = true; if (observer) { observer.disconnect(); observer = null; }
        go(state.i + 1); return true;
      }
      if (!cfg.spa && step.path && here() !== norm(step.path) && state.navFor !== step.id) return false;
      // SPA: justo tras navegar, el elemento encontrado puede ser el de la página anterior; se espera a que se asiente
      if (cfg.spa && Date.now() - navAt < 350) return false;
      var t = find(step);
      if (!t) return false;
      // requires: si el elemento del menú de esa sección no existe (sin permiso), el paso se salta
      if (step.requires && !document.querySelector(step.requires)) { done = true; if (observer) { observer.disconnect(); observer = null; } go(state.i + 1); return true; }
      done = true; if (observer) { observer.disconnect(); observer = null; }
      show(step, t);
      return true;
    }
    if (attempt()) return;
    observer = new MutationObserver(function () { attempt(); });
    observer.observe(document.body, { childList: true, subtree: true });
    (function poll() {
      if (done || myGen !== gen) return;
      tries++;
      if (attempt()) return;
      if (tries >= (cfg.spa ? 40 : 15)) { // ~4 s en SPA, ~1,5 s en HTML de servidor (ya está todo pintado)
        done = true; if (observer) { observer.disconnect(); observer = null; }
        if (step.optional) { go(state.i + 1); return; }
        show(step, null);
        return;
      }
      waitTimer = setTimeout(poll, 100);
    })();
  }

  function show(step, target) {
    var total = cfg.steps.length;
    ui = el("div", "position:fixed;inset:0;z-index:2147483000;pointer-events:none;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif");
    ui.setAttribute("aria-live", "polite"); ui.setAttribute("data-guided-tour-ui", "1");
    document.body.appendChild(ui);

    var shade = "background:rgba(15,23,42,.62);position:absolute;pointer-events:auto;";
    var parts = [el("div", shade), el("div", shade), el("div", shade), el("div", shade)];
    parts.forEach(function (p) { ui.appendChild(p); });
    var ring = el("div", "position:absolute;border-radius:10px;box-shadow:0 0 0 3px " + (cfg.color || "#38bdf8") + ";pointer-events:none;transition:all .18s ease");
    ui.appendChild(ring);
    var blocker = el("div", "position:absolute;pointer-events:auto;background:transparent");
    ui.appendChild(blocker);

    var card = el("div", "position:absolute;pointer-events:auto;background:#fff;color:#1e293b;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.28);padding:16px;font-size:14px;line-height:1.5;max-height:85vh;overflow-y:auto;box-sizing:border-box");
    var count = el("div", "font-size:12px;font-weight:700;color:" + (cfg.color || "#0284c7") + ";margin-bottom:4px", "Paso " + (state.i + 1) + " de " + total);
    var h = el("div", "font-size:16px;font-weight:700;margin-bottom:6px;word-break:break-word", step.title);
    var b = el("div", "color:#475569;margin-bottom:14px;word-break:break-word", step.body);
    var row = el("div", "display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between");
    var exit = el("button", "background:none;border:0;color:#94a3b8;text-decoration:underline;cursor:pointer;font-size:12px;padding:4px 0", "Salir del tutorial");
    exit.type = "button"; exit.onclick = stop;
    var btns = el("div", "display:flex;gap:8px");
    if (state.i > 0) {
      var prev = el("button", "background:#fff;border:1px solid #cbd5e1;color:#334155;border-radius:8px;padding:7px 12px;font-size:13px;cursor:pointer", "Anterior");
      prev.type = "button"; prev.onclick = function () { go(state.i - 1); }; btns.appendChild(prev);
    }
    var last = state.i === total - 1;
    var next = el("button", "background:" + (cfg.color || "#0284c7") + ";border:0;color:#fff;border-radius:8px;padding:7px 14px;font-size:13px;font-weight:600;cursor:pointer", last ? "Finalizar" : (step.advanceOnClick ? "Siguiente" : "Siguiente"));
    next.type = "button"; next.onclick = function () { go(state.i + 1); };
    btns.appendChild(next);
    row.appendChild(exit); row.appendChild(btns);
    card.appendChild(count); card.appendChild(h); card.appendChild(b);
    if (step.advanceOnClick && target) card.appendChild(el("div", "font-size:12px;color:#64748b;margin:-6px 0 12px", "Haz clic en el elemento resaltado para continuar."));
    card.appendChild(row);
    ui.appendChild(card);

    function layout() {
      var vw = window.innerWidth, vh = window.innerHeight;
      var w = Math.max(240, Math.min(330, vw - 32));
      card.style.width = w + "px";
      var cardH = Math.min(card.offsetHeight || 200, vh - 32);
      var top, left;
      if (target) {
        var r = target.getBoundingClientRect();
        var pad = 6, x = r.left - pad, y = r.top - pad, rw = r.width + pad * 2, rh = r.height + pad * 2;
        parts[0].style.cssText = shade + "top:0;left:0;width:100vw;height:" + Math.max(0, y) + "px";
        parts[1].style.cssText = shade + "top:" + (y + rh) + "px;left:0;width:100vw;height:" + Math.max(0, vh - (y + rh)) + "px";
        parts[2].style.cssText = shade + "top:" + y + "px;left:0;width:" + Math.max(0, x) + "px;height:" + rh + "px";
        parts[3].style.cssText = shade + "top:" + y + "px;left:" + (x + rw) + "px;width:" + Math.max(0, vw - (x + rw)) + "px;height:" + rh + "px";
        ring.style.cssText += ";top:" + y + "px;left:" + x + "px;width:" + rw + "px;height:" + rh + "px";
        blocker.style.cssText = "position:absolute;background:transparent;top:" + y + "px;left:" + x + "px;width:" + rw + "px;height:" + rh + "px;pointer-events:" + (step.advanceOnClick ? "none" : "auto");
        var pl = step.placement || "bottom";
        // si no cabe donde se pidió, se prueba el lado opuesto
        if (pl === "bottom" && y + rh + 16 + cardH > vh) pl = "top";
        else if (pl === "top" && y - 16 - cardH < 0) pl = "bottom";
        else if (pl === "right" && x + rw + 16 + w > vw) pl = "left";
        else if (pl === "left" && x - 16 - w < 0) pl = "right";
        if (pl === "bottom") { top = y + rh + 16; left = x; }
        else if (pl === "top") { top = y - 16 - cardH; left = x; }
        else if (pl === "left") { top = y; left = x - w - 16; }
        else if (pl === "right") { top = y; left = x + rw + 16; }
        else { top = vh / 2 - cardH / 2; left = vw / 2 - w / 2; }
        // en pantallas estrechas la tarjeta va siempre abajo o arriba del foco
        if (vw < 700) { left = 16; top = (y + rh + 16 + cardH <= vh) ? y + rh + 16 : Math.max(16, y - 16 - cardH); }
      } else {
        parts[0].style.cssText = shade + "inset:0";
        parts[1].style.display = parts[2].style.display = parts[3].style.display = "none";
        ring.style.display = "none"; blocker.style.display = "none";
        top = vh / 2 - cardH / 2; left = vw / 2 - w / 2;
      }
      left = Math.min(Math.max(16, left), Math.max(16, vw - w - 16));
      top = Math.min(Math.max(16, top), Math.max(16, vh - cardH - 16));
      card.style.top = top + "px"; card.style.left = left + "px";
    }

    if (target) target.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center", inline: "center" });
    layout();
    var rl = function () { if (target && document.body.contains(target)) layout(); };
    window.addEventListener("scroll", rl, true);
    window.addEventListener("resize", rl);
    var raf = setTimeout(layout, 350); // tras el scroll suave
    var watch = null;
    if (target && cfg.spa) {
      watch = new MutationObserver(function () { if (!document.body.contains(target)) { watch.disconnect(); render(); } });
      watch.observe(document.body, { childList: true, subtree: true });
    }

    var onKey = function (e) {
      if (e.key === "Escape") stop();
      else if (e.key === "ArrowRight") go(state.i + 1);
      else if (e.key === "ArrowLeft") go(state.i - 1);
    };
    document.addEventListener("keydown", onKey);

    var onClick = null;
    if (step.advanceOnClick && target) {
      onClick = function () { setTimeout(function () { go(state.i + 1); }, 60); };
      target.addEventListener("click", onClick, true);
    }
    cleanup = function () {
      clearTimeout(raf);
      if (watch) watch.disconnect();
      window.removeEventListener("scroll", rl, true);
      window.removeEventListener("resize", rl);
      document.removeEventListener("keydown", onKey);
      if (onClick && target) target.removeEventListener("click", onClick, true);
    };
    next.focus({ preventScroll: true });
  }

  var btn;
  function renderButton() {
    if (btn) { btn.remove(); btn = null; }
    if (state.active) return;
    btn = el("button", "position:fixed;right:16px;bottom:16px;z-index:2147482000;background:" + (cfg.color || "#0284c7") + ";color:#fff;border:0;border-radius:999px;padding:10px 16px;font:600 13px system-ui,sans-serif;box-shadow:0 6px 18px rgba(0,0,0,.25);cursor:pointer", "? " + (cfg.startLabel || "Ver tutorial"));
    btn.type = "button"; btn.setAttribute("data-tour", "ver-tutorial");
    btn.onclick = function () { go(0); };
    document.body.appendChild(btn);
  }

  window.GuidedTour = {
    init: function (config) {
      if (cfg) return; // ya iniciado (p. ej. React en modo estricto monta dos veces)
      cfg = config; state = load();
      function ready() {
        renderButton();
        if (state.active) render();
        document.addEventListener("click", function (e) {
          var t = e.target && e.target.closest && e.target.closest("[data-tour-start]");
          if (t) { e.preventDefault(); go(0); }
        });
      }
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready); else ready();
      if (cfg.spa) window.addEventListener("popstate", function () { if (state.active) render(); });
    },
    start: function () { go(0); },
    stop: function () { stop(); },
  };
})();
