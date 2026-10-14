(function () {
  var STATUS_META = window.STATUS_META;
  var STALE_MS = 30 * 24 * 60 * 60 * 1000;
  var REFRESH_MS = 8000;
  var $ = function (sel) { return document.querySelector(sel); };
  var show = function (el) { el.hidden = false; };
  var hide = function (el) { el.hidden = true; };
  var PAGE_SIZE = 50;
  var refreshTimer = null;
  var loadedDeployments = [];
  var currentOffset = 0;
  var currentTotal = 0;
  var stats = {};
  var mutedRepos = [];

  function currentFilters() {
    return { status: $("#f-status").value, search: $("#f-search").value.trim() };
  }

  function readFiltersFromUrl() {
    var params = new URLSearchParams(location.search);
    if (params.get("status")) $("#f-status").value = params.get("status");
    if (params.get("search")) $("#f-search").value = params.get("search");
  }

  function syncUrl() {
    var f = currentFilters();
    var params = new URLSearchParams();
    if (f.status) params.set("status", f.status);
    if (f.search) params.set("search", f.search);
    var qs = params.toString();
    history.replaceState(null, "", location.pathname + (qs ? "?" + qs : ""));
  }

  function authHeader() {
    var session = localStorage.getItem("dgs_session_token");
    return session ? { Authorization: "Bearer " + session } : {};
  }

  function fmtDate(iso) {
    if (!iso) return "—";
    try { return new Date(iso).toLocaleString(); } catch (e) { return iso; }
  }

  function fmtAge(iso) {
    if (!iso) return { text: "—", stale: false };
    var ms = Date.now() - new Date(iso).getTime();
    if (!(ms >= 0)) return { text: "—", stale: false };
    var stale = ms > STALE_MS;
    var mins = Math.floor(ms / 60000);
    var text;
    if (mins < 1) text = "à l'instant";
    else if (mins < 60) text = "il y a " + mins + " min";
    else if (mins < 1440) text = "il y a " + Math.floor(mins / 60) + " h";
    else text = "il y a " + Math.floor(mins / 1440) + " j";
    return { text: text, stale: stale };
  }

  function fmtDurationMs(ms) {
    if (ms == null) return "—";
    var s = Math.round(ms / 1000);
    if (s < 60) return s + "s";
    return Math.floor(s / 60) + "min " + (s % 60) + "s";
  }

  function sparkline(days) {
    if (!days || !days.length) return "";
    var max = Math.max.apply(null, days.concat([1]));
    var w = 4, gap = 2, h = 18;
    var bars = days.map(function (v, i) {
      var barH = Math.max(2, Math.round((v / max) * h));
      var x = i * (w + gap);
      return '<rect x="' + x + '" y="' + (h - barH) + '" width="' + w + '" height="' + barH + '" fill="currentColor" opacity="' + (v ? 1 : 0.25) + '"></rect>';
    }).join("");
    var totalW = days.length * (w + gap) - gap;
    return '<svg class="sparkline" width="' + totalW + '" height="' + h + '" viewBox="0 0 ' + totalW + ' ' + h + '" title="Déploiements / jour, 14 derniers jours">' + bars + '</svg>';
  }

  function rowFor(record, opts) {
    opts = opts || {};
    var meta = STATUS_META[record.status] || { emoji: "⚪", label: record.status };
    var repoKey = record.owner + "/" + record.repo;
    var muted = mutedRepos.indexOf(repoKey) !== -1;
    var row = document.createElement("div");
    row.className = "row" + (muted && opts.withHealth ? " muted" : "");
    row.innerHTML =
      '<span class="emoji">' + (muted && opts.withHealth ? "🔧" : meta.emoji) + "</span>" +
      "<span><span class=\"name\">" + repoKey + "</span><br>" +
      "<span class=\"sub\">" + (muted && opts.withHealth ? "Maintenance — " : "") + meta.label + (record.description ? " — " + record.description : "") + " · " + fmtDate(record.updatedAt) + "</span></span>";

    if (opts.withHealth) {
      var s = stats[repoKey];
      if (s) {
        var stats_ = document.createElement("span");
        stats_.className = "stats";
        stats_.innerHTML = sparkline(s.days);
        if (s.successRate != null) {
          var rate = document.createElement("span");
          rate.className = "success-rate " + (s.successRate >= 90 ? "good" : s.successRate >= 60 ? "mid" : "bad");
          rate.textContent = s.successRate + "%";
          rate.title = s.sampleSize + " derniers déploiements";
          stats_.appendChild(rate);
        }
        var elapsed = record.status === "pending" ? Date.now() - new Date(record.createdAt).getTime() : null;
        var slow = elapsed != null && s.avgDurationMs && elapsed > s.avgDurationMs * 1.5;
        var dur = document.createElement("span");
        dur.className = "avg-duration" + (slow ? " slow" : "");
        dur.textContent = slow
          ? "⚠ " + fmtDurationMs(elapsed) + " (moy. " + fmtDurationMs(s.avgDurationMs) + ")"
          : "moy. " + fmtDurationMs(s.avgDurationMs);
        stats_.appendChild(dur);
        row.appendChild(stats_);
      }

      var age = fmtAge(record.updatedAt);
      var ageSpan = document.createElement("span");
      ageSpan.className = "age" + (age.stale ? " stale" : "");
      ageSpan.textContent = age.text;
      row.appendChild(ageSpan);

      var muteBtn = document.createElement("button");
      muteBtn.type = "button";
      muteBtn.className = "mute-btn" + (muted ? " active" : "");
      muteBtn.textContent = muted ? "🔧 Maintenance" : "Marquer maintenance";
      muteBtn.addEventListener("click", function () {
        fetch("/api/repos/" + encodeURIComponent(record.owner) + "/" + encodeURIComponent(record.repo) + "/mute", {
          method: "POST",
          headers: authHeader(),
        })
          .then(function (res) { return res.json(); })
          .then(function () { load(true); });
      });
      row.appendChild(muteBtn);
    }

    var a = document.createElement("a");
    a.className = "detail";
    a.href = "/deployments/" + encodeURIComponent(record.id);
    a.textContent = "Détail →";
    row.appendChild(a);
    return row;
  }

  function renderList() {
    var list = $("#list");
    list.innerHTML = "";
    if (!loadedDeployments.length) list.innerHTML = '<p class="note">Aucun déploiement ne correspond.</p>';
    loadedDeployments.forEach(function (r) { list.appendChild(rowFor(r, {})); });

    var shown = loadedDeployments.length;
    $("#pager-count").textContent = currentTotal
      ? shown + " / " + currentTotal + " déploiement(s)"
      : "";
    $("#load-more").hidden = shown >= currentTotal;
  }

  function renderHealth(health) {
    var el = $("#health");
    el.innerHTML = "";
    if (!health.length) el.innerHTML = '<p class="note">Aucun déploiement suivi pour l\'instant.</p>';
    health.forEach(function (r) { el.appendChild(rowFor(r, { withHealth: true })); });
  }

  function renderTimeline(deployments, filtered) {
    $("#timeline-title").textContent = filtered ? "Activité récente (filtrée)" : "Activité récente (tous sites)";
    var el = $("#timeline");
    el.innerHTML = "";
    if (!deployments.length) { el.innerHTML = '<p class="note">Rien à afficher pour l\'instant.</p>'; return; }
    deployments.slice(0, 80).forEach(function (r) {
      var meta = STATUS_META[r.status] || { emoji: "⚪", label: r.status, color: "#6b7280" };
      var dot = document.createElement("span");
      dot.style.background = meta.color;
      dot.title = r.owner + "/" + r.repo + " — " + meta.label + " · " + fmtDate(r.createdAt);
      el.appendChild(dot);
    });
  }

  var requestToken = 0;
  function load(reset) {
    if (reset) currentOffset = 0;
    var myToken = ++requestToken;
    var f = currentFilters();
    var params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(currentOffset) });
    if (f.status) params.set("status", f.status);
    if (f.search) params.set("search", f.search);

    fetch("/api/deployments?" + params.toString(), { headers: authHeader() })
      .then(function (res) {
        if (res.status === 401) { showGate(); return null; }
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        if (!data || myToken !== requestToken) return;
        currentTotal = data.total;
        stats = data.stats || {};
        mutedRepos = data.mutedRepos || [];
        loadedDeployments = reset ? data.deployments : loadedDeployments.concat(data.deployments);
        currentOffset = loadedDeployments.length;
        if (reset) checkForNewFailures(data.health);
        renderHealth(data.health);
        renderList();
        if (reset) renderTimeline(data.deployments, !!(f.status || f.search));
        show($("#app"));
        hide($("#loading"));
        $("#logout").hidden = false;
      })
      .catch(function () {
        hide($("#loading"));
        showGate();
      });

    if (reset) {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(function () { load(true); }, REFRESH_MS);
    }
  }

  function showGate() {
    hide($("#loading"));
    hide($("#app"));
    show($("#gate"));
  }

  var filterSearchDebounce = null;
  function onFilterChange() {
    syncUrl();
    load(true);
  }
  $("#f-search").addEventListener("input", function () {
    if (filterSearchDebounce) clearTimeout(filterSearchDebounce);
    filterSearchDebounce = setTimeout(onFilterChange, 300);
  });
  $("#f-status").addEventListener("change", onFilterChange);

  $("#load-more").addEventListener("click", function () { load(false); });

  $("#copy-link").addEventListener("click", function () {
    syncUrl();
    copyText(this, location.href);
  });

  function download(filename, content, mime) {
    var blob = new Blob([content], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  $("#export-json").addEventListener("click", function () {
    if (!loadedDeployments.length) return;
    download("deployments.json", JSON.stringify(loadedDeployments, null, 2), "application/json");
  });

  $("#export-csv").addEventListener("click", function () {
    if (!loadedDeployments.length) return;
    var cols = ["id", "owner", "repo", "branch", "appName", "environment", "status", "description", "createdAt", "updatedAt", "finishedAt"];
    var lines = [cols.join(",")];
    loadedDeployments.forEach(function (r) {
      lines.push(cols.map(function (c) {
        var v = r[c] == null ? "" : String(r[c]);
        return '"' + v.replace(/"/g, '""') + '"';
      }).join(","));
    });
    download("deployments.csv", lines.join("\n"), "text/csv");
  });

  var FAVICON_NORMAL = $("#favicon").href;
  var FAVICON_ALERT =
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ccircle cx='50' cy='50' r='45' fill='%23dc2626'/%3E%3C/svg%3E";
  var previousHealthStatus = null;
  var hasFirstLoad = false;

  function setFaviconAlert(on) {
    $("#favicon").href = on ? FAVICON_ALERT : FAVICON_NORMAL;
  }

  function notificationsEnabled() {
    try { return localStorage.getItem("dgs_notifications") === "1"; } catch (e) { return false; }
  }

  function updateNotifButton() {
    $("#notif-toggle").className = notificationsEnabled() ? "active" : "";
  }

  $("#notif-toggle").addEventListener("click", function () {
    if (notificationsEnabled()) {
      try { localStorage.setItem("dgs_notifications", "0"); } catch (e) {}
      updateNotifButton();
      return;
    }
    if (!("Notification" in window)) {
      alert("Ce navigateur ne supporte pas les notifications.");
      return;
    }
    Notification.requestPermission().then(function (perm) {
      if (perm === "granted") {
        try { localStorage.setItem("dgs_notifications", "1"); } catch (e) {}
      }
      updateNotifButton();
    });
  });

  function checkForNewFailures(health) {
    var newFailures = [];
    health.forEach(function (r) {
      var key = r.owner + "/" + r.repo;
      var wasFailing = previousHealthStatus && (previousHealthStatus[key] === "failure" || previousHealthStatus[key] === "error");
      var isFailing = r.status === "failure" || r.status === "error";
      if (isFailing && !wasFailing && hasFirstLoad) newFailures.push(r);
    });
    var nextStatus = {};
    health.forEach(function (r) { nextStatus[r.owner + "/" + r.repo] = r.status; });
    previousHealthStatus = nextStatus;
    hasFirstLoad = true;

    if (newFailures.length) {
      if (document.hidden) setFaviconAlert(true);
      if (notificationsEnabled() && "Notification" in window && Notification.permission === "granted") {
        newFailures.forEach(function (r) {
          new Notification("Déploiement échoué", {
            body: r.owner + "/" + r.repo + " — " + (r.description || r.status),
            icon: FAVICON_ALERT,
          });
        });
      }
    }
  }

  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) setFaviconAlert(false);
  });

  function applyTheme(theme) {
    if (theme) document.documentElement.setAttribute("data-theme", theme);
    else document.documentElement.removeAttribute("data-theme");
  }
  (function initTheme() {
    try {
      var saved = localStorage.getItem("dgs_theme");
      if (saved) applyTheme(saved);
    } catch (e) {}
  })();
  $("#theme-toggle").addEventListener("click", function () {
    var current = document.documentElement.getAttribute("data-theme");
    var prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    var effectiveDark = current ? current === "dark" : prefersDark;
    var next = effectiveDark ? "light" : "dark";
    applyTheme(next);
    try { localStorage.setItem("dgs_theme", next); } catch (e) {}
  });

  $("#pw-submit").addEventListener("click", function () {
    var pw = $("#pw").value;
    if (!pw) return;
    $("#pw-submit").disabled = true;
    $("#pw-error").textContent = "";
    fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pw }),
    })
      .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, body: body }; }); })
      .then(function (r) {
        $("#pw-submit").disabled = false;
        if (!r.ok) {
          $("#pw-error").textContent = r.body.error || "Mot de passe incorrect.";
          return;
        }
        localStorage.setItem("dgs_session_token", r.body.token);
        hide($("#gate"));
        show($("#loading"));
        load(true);
      })
      .catch(function () {
        $("#pw-submit").disabled = false;
        $("#pw-error").textContent = "Erreur réseau, réessaie.";
      });
  });
  $("#pw").addEventListener("keydown", function (e) {
    if (e.key === "Enter") $("#pw-submit").click();
  });

  $("#logout").addEventListener("click", function () {
    if (refreshTimer) clearTimeout(refreshTimer);
    Object.keys(localStorage)
      .filter(function (k) { return k.indexOf("dgs_") === 0; })
      .forEach(function (k) { localStorage.removeItem(k); });
    location.href = location.pathname;
  });

  function renderAuditLog(entries) {
    var el = $("#audit-log");
    el.innerHTML = "";
    if (!entries.length) { el.innerHTML = '<p class="note">Aucune entrée.</p>'; return; }
    var LABELS = {
      login_success: "✅ Connexion réussie",
      login_failure: "❌ Tentative de connexion échouée",
      retry: "🔁 Relance déclenchée",
      password_change: "🔑 Mot de passe changé",
    };
    entries.forEach(function (e) {
      var row = document.createElement("div");
      row.className = "audit-row";
      var time = document.createElement("time");
      time.textContent = fmtDate(e.at);
      var label = (LABELS[e.type] || e.type) +
        (e.repo ? " — " + e.owner + "/" + e.repo : "") +
        (e.ip ? " (" + e.ip + ")" : "");
      var span = document.createElement("span");
      span.textContent = label;
      row.appendChild(time);
      row.appendChild(span);
      el.appendChild(row);
    });
  }

  function loadAuditLog() {
    var params = new URLSearchParams();
    if ($("#audit-type").value) params.set("type", $("#audit-type").value);
    if ($("#audit-ip").value.trim()) params.set("ip", $("#audit-ip").value.trim());
    if ($("#audit-since").value) params.set("since", $("#audit-since").value);
    fetch("/api/audit-log?" + params.toString(), { headers: authHeader() })
      .then(function (res) { return res.ok ? res.json() : { entries: [] }; })
      .then(function (data) { renderAuditLog(data.entries || []); })
      .catch(function () {});
  }
  var auditIpDebounce = null;
  $("#audit-type").addEventListener("change", loadAuditLog);
  $("#audit-ip").addEventListener("input", function () {
    if (auditIpDebounce) clearTimeout(auditIpDebounce);
    auditIpDebounce = setTimeout(loadAuditLog, 300);
  });
  $("#audit-since").addEventListener("change", loadAuditLog);

  $("#toggle-security").addEventListener("click", function () {
    var panel = $("#security-panel");
    var willShow = panel.hidden;
    panel.hidden = !willShow;
    $("#toggle-security").textContent = willShow ? "Masquer" : "Afficher";
    if (willShow) loadAuditLog();
  });

  function copyText(btn, text) {
    var done = function () {
      var original = btn.textContent;
      btn.textContent = "✓ Copié";
      setTimeout(function () { btn.textContent = original; }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(function () { prompt("À copier :", text); });
    } else {
      prompt("À copier :", text);
    }
  }

  var webhookConfig = null;
  $("#toggle-config").addEventListener("click", function () {
    var panel = $("#config-panel");
    var willShow = panel.hidden;
    panel.hidden = !willShow;
    $("#toggle-config").textContent = willShow ? "Masquer" : "Afficher";
    if (willShow && !webhookConfig) {
      fetch("/api/webhook-config", { headers: authHeader() })
        .then(function (res) { return res.json(); })
        .then(function (data) {
          webhookConfig = data;
          $("#config-url").textContent = data.webhookUrl;
          $("#config-header").textContent = data.webhookSecretHeader;
          $("#config-curl").textContent = data.curl;
        })
        .catch(function () {});
    }
  });
  $("#copy-config-url").addEventListener("click", function () { if (webhookConfig) copyText(this, webhookConfig.webhookUrl); });
  $("#copy-config-header").addEventListener("click", function () { if (webhookConfig) copyText(this, webhookConfig.webhookSecretHeader); });
  $("#copy-config-curl").addEventListener("click", function () { if (webhookConfig) copyText(this, webhookConfig.curl); });

  $("#pw-change-submit").addEventListener("click", function () {
    var current = $("#pw-current").value;
    var next = $("#pw-new").value;
    var msg = $("#pw-change-msg");
    msg.textContent = "";
    if (!current || !next) return;
    if (next.length < 8) { msg.textContent = "Le nouveau mot de passe doit faire au moins 8 caractères."; return; }
    $("#pw-change-submit").disabled = true;
    fetch("/api/change-password", {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, authHeader()),
      body: JSON.stringify({ currentPassword: current, newPassword: next }),
    })
      .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, body: body }; }); })
      .then(function (r) {
        $("#pw-change-submit").disabled = false;
        if (!r.ok) { msg.textContent = r.body.error || "Échec du changement de mot de passe."; return; }
        msg.textContent = r.body.warning ? "✓ Changé — " + r.body.warning : "✓ Mot de passe changé.";
        $("#pw-current").value = "";
        $("#pw-new").value = "";
        loadAuditLog();
      })
      .catch(function () {
        $("#pw-change-submit").disabled = false;
        msg.textContent = "Erreur réseau, réessaie.";
      });
  });

  document.addEventListener("keydown", function (e) {
    var tag = (e.target && e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "select" || tag === "textarea") return;
    if (e.key === "/") {
      e.preventDefault();
      $("#f-search").focus();
    } else if (e.key === "r") {
      load(true);
    }
  });

  updateNotifButton();
  readFiltersFromUrl();
  show($("#loading"));
  load(true);
})();
