(function () {
  "use strict";
  var STORAGE_KEY = "vee_ai_studio_projects_v1";
  var ACTIVE_KEY = "vee_ai_studio_active_v1";
  var HANDOFF_KEY = "vee_ai_studio_handoff_v1";
  var MAX_FILES = 40, MAX_FILE_BYTES = 250000, MAX_PROJECT_BYTES = 2000000;
  var ALLOWLIST = ["fonts.googleapis.com","fonts.gstatic.com","cdn.jsdelivr.net","cdnjs.cloudflare.com","unpkg.com","use.fontawesome.com"];
  var state = { projects: [], project: null, activeFile: "index.html", dirty: false, undo: [], pending: null, previewWidth: "100%", assistantBusy: false };
  var $ = function (id) { return document.getElementById(id); };
  var starter = {
    "index.html": "<!doctype html>\n<html lang=\"en\">\n<head>\n  <meta charset=\"utf-8\">\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n  <title>My first Vee-AI Studio project</title>\n  <link rel=\"stylesheet\" href=\"style.css\">\n</head>\n<body>\n  <main class=\"card\">\n    <span class=\"eyebrow\">BUILT WITH VEE-AI STUDIO</span>\n    <h1>Your next idea starts here.</h1>\n    <p>Edit this project or ask Vee-AI to improve it.</p>\n    <button id=\"helloButton\">Test interaction</button>\n    <p id=\"result\" aria-live=\"polite\"></p>\n  </main>\n  <script src=\"script.js\"></script>\n</body>\n</html>",
    "style.css": "body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f4f6;color:#171717;font-family:Arial,sans-serif}.card{max-width:560px;margin:24px;padding:42px;border-radius:24px;background:white;box-shadow:0 18px 60px #00000012}h1{font-size:clamp(2rem,6vw,3.5rem);line-height:1.05;margin:14px 0}.eyebrow{color:#f14c15;font-size:11px;font-weight:700;letter-spacing:.12em}button{border:0;border-radius:10px;background:#f14c15;color:white;padding:12px 18px;font-weight:700;cursor:pointer}",
    "script.js": "document.getElementById('helloButton').addEventListener('click',function(){document.getElementById('result').textContent='Your preview is running. Keep building!';});"
  };
  function safeParse(value, fallback) { try { return JSON.parse(value) || fallback; } catch (_) { return fallback; } }
  function bytes(value) { return new Blob([value]).size; }
  function safePath(path) {
    path = String(path || "").replace(/\\/g, "/").trim();
    if (!path || path.length > 120 || path.startsWith("/") || path.split("/").some(function (part) { return !part || part === "." || part === ".."; })) return false;
    return /\.(html|css|js|mjs|json|svg|md|txt|xml)$/i.test(path);
  }
  function currentProject() { return state.project; }
  function setStatus(message, error) { $("assistantStatus").textContent = message || ""; $("assistantStatus").style.color = error ? "#c43b30" : ""; }
  function persist() {
    if (!state.project) return;
    state.project.updatedAt = new Date().toISOString();
    var index = state.projects.findIndex(function (p) { return p.id === state.project.id; });
    if (index < 0) state.projects.unshift(state.project); else state.projects[index] = state.project;
    try {
      var payload = JSON.stringify(state.projects);
      if (bytes(payload) > 5000000) throw new Error("Project storage limit reached. Export a backup before continuing.");
      localStorage.setItem(STORAGE_KEY, payload);
      localStorage.setItem(ACTIVE_KEY, state.project.id);
      $("saveState").textContent = "Saved locally";
      $("projectMeta").textContent = (state.project.framework === "html" ? "Static web project" : state.project.framework.toUpperCase() + " project") + " · Guest workspace";
    } catch (error) {
      $("saveState").textContent = "Storage issue";
      setStatus(error.message || "Unable to save in this browser.", true);
    }
  }
  function snapshot(label) {
    if (!state.project) return;
    state.project.versions = state.project.versions || [];
    state.project.versions.unshift({ id: "v" + Date.now(), label: label || "Saved version", createdAt: new Date().toISOString(), files: JSON.parse(JSON.stringify(state.project.files)) });
    state.project.versions = state.project.versions.slice(0, 30);
    persist();
  }
  function makeProject(name, files, framework) {
    return { id: "proj_" + Date.now().toString(36) + Math.random().toString(36).slice(2,7), name: name || "Untitled project", framework: framework || "html", files: files || JSON.parse(JSON.stringify(starter)), versions: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  }
  function selectProject(project) {
    state.project = project;
    state.activeFile = Object.keys(project.files)[0] || "index.html";
    $("projectName").value = project.name;
    $("frameworkSelect").value = project.framework || "html";
    state.dirty = false;
    renderFiles(); loadEditor(); persist(); runPreview();
  }
  function renderFiles() {
    var tree = $("fileTree"); tree.innerHTML = "";
    Object.keys(state.project.files).sort().forEach(function (path) {
      var button = document.createElement("button");
      button.type = "button"; button.className = "file-item" + (path === state.activeFile ? " active" : "");
      button.innerHTML = '<span class="file-icon">▤</span><span></span>';
      button.lastChild.textContent = path;
      button.addEventListener("click", function () { saveEditor(); state.activeFile = path; loadEditor(); renderFiles(); });
      tree.appendChild(button);
    });
  }
  function loadEditor() {
    var value = state.project.files[state.activeFile] || "";
    $("activeFileName").textContent = state.activeFile;
    $("codeEditor").value = value;
    $("languageLabel").textContent = state.activeFile.split(".").pop().toUpperCase();
    $("dirtyMark").style.display = "none";
    state.dirty = false; state.undo = [];
    updateLineNumbers();
  }
  function updateLineNumbers() {
    var count = Math.max(1, $("codeEditor").value.split("\n").length);
    $("lineNumbers").textContent = Array.from({length:count}, function (_,i) { return i + 1; }).join("\n");
  }
  function saveEditor() {
    if (!state.project || !state.activeFile) return;
    var value = $("codeEditor").value;
    if (bytes(value) > MAX_FILE_BYTES) { setStatus("This file is over the 250 KB limit.", true); return; }
    state.project.files[state.activeFile] = value;
    state.dirty = false; $("dirtyMark").style.display = "none"; persist();
  }
  function approvedHosts() {
    return ALLOWLIST.concat((state.project.approvedDomains || []).filter(function (host) { return typeof host === "string"; }));
  }
  function renderPreviewDocument() {
    var files = state.project.files;
    var html = files["index.html"] || "<!doctype html><html><head></head><body></body></html>";
    var css = files["style.css"] || files["styles.css"] || "";
    var js = files["script.js"] || files["app.js"] || "";
    var hosts = approvedHosts().map(function (h) { return "https://" + h; }).join(" ");
    var csp = "default-src 'none'; script-src 'unsafe-inline' " + hosts + "; style-src 'unsafe-inline' " + hosts + "; font-src data: " + hosts + "; img-src data: blob: " + hosts + "; connect-src " + hosts + ";";
    var meta = '<meta http-equiv="Content-Security-Policy" content="' + csp + '">';
    var bridge = "<script>(function(){function send(type,args){try{parent.postMessage({source:'vee-studio-preview',type:type,args:Array.prototype.slice.call(args||[]).map(function(v){try{return typeof v==='string'?v:JSON.stringify(v)}catch(e){return String(v)}})},'*')}catch(e){}}['log','info','warn','error'].forEach(function(k){var old=console[k];console[k]=function(){send(k,arguments);if(old)old.apply(console,arguments)}});window.addEventListener('error',function(e){send('error',[e.message+' at '+e.lineno+':'+e.colno])});window.addEventListener('unhandledrejection',function(e){send('error',[String(e.reason)])});})();<\/script>";
    html = html.replace(/<meta[^>]+http-equiv=[\"']Content-Security-Policy[\"'][^>]*>/ig, "");
    html = html.replace(/<link[^>]+href=[\"'](?:style\.css|styles\.css)[\"'][^>]*>/ig, "");
    html = html.replace(/<script[^>]+src=[\"'](?:script\.js|app\.js)[\"'][^>]*>\s*<\/script>/ig, "");
    var head = html.match(/<head[^>]*>/i);
    if (head) html = html.replace(head[0], head[0] + meta + "<style>" + css.replace(/<\/style/ig,"<\\/style") + "</style>");
    else html = "<!doctype html><html><head>" + meta + "<style>" + css + "</style></head><body>" + html + "</body></html>";
    html = html.replace(/<\/body>/i, bridge + "<script>" + js.replace(/<\/script/ig,"<\\/script") + "<\/script></body>");
    if (!/<\/body>/i.test(html)) html += bridge + "<script>" + js + "<\/script>";
    return html;
  }
  function runPreview() {
    saveEditor();
    var frame = $("previewFrame");
    frame.srcdoc = renderPreviewDocument();
    $("consoleOutput").textContent = "Preview refreshed. External requests are limited to approved resource domains.";
  }
  window.addEventListener("message", function (event) {
    if (event.source !== $("previewFrame").contentWindow || !event.data || event.data.source !== "vee-studio-preview") return;
    var text = (event.data.args || []).join(" ");
    var line = document.createElement("div"); line.textContent = "[" + event.data.type + "] " + text;
    if (event.data.type === "error") line.className = "error";
    $("consoleOutput").appendChild(line); $("consoleOutput").scrollTop = $("consoleOutput").scrollHeight;
  });
  function parseCodeBlocks(reply) {
    var changes = {};
    var regex = /```([a-zA-Z0-9_+.-]*)\s*(?:file=)?([\w./-]+)?\s*\n([\s\S]*?)```/g, match;
    while ((match = regex.exec(reply))) {
      var lang = (match[1] || "").toLowerCase(), path = match[2] || "";
      if (!path || !path.includes(".")) {
        var ext = ({html:"html",htm:"html",css:"css",javascript:"js",js:"js",jsx:"jsx",tsx:"tsx",typescript:"ts",ts:"ts",json:"json",vue:"vue",svg:"svg",markdown:"md",md:"md"})[lang];
        if (!ext) continue;
        path = ext === "html" ? "index.html" : ext === "css" ? "style.css" : ext === "js" ? "script.js" : "src/App." + ext;
      }
      if (safePath(path) && bytes(match[3]) <= MAX_FILE_BYTES) changes[path] = match[3].replace(/\n$/, "");
    }
    return changes;
  }
  function isMajor(changes, prompt) {
    var paths = Object.keys(changes), words = /rebuild|rewrite|redesign|replace the entire|remove all|migrate|authentication|payment|database|routing|framework|refactor|delete/i;
    return paths.length > 2 || words.test(prompt) || paths.some(function (p) { return /(^|\/)(package\.json|vite\.config|next\.config|router|auth|firebase)/i.test(p); });
  }
  function applyChanges(changes, label) {
    var count = Object.keys(state.project.files).length;
    Object.keys(changes).forEach(function (path) { if (!state.project.files[path]) count++; });
    if (count > MAX_FILES) throw new Error("This project exceeds the 40-file limit.");
    var total = Object.keys(state.project.files).reduce(function (sum,p) { return sum + bytes(state.project.files[p]); }, 0);
    Object.keys(changes).forEach(function (p) { total += bytes(changes[p]) - bytes(state.project.files[p] || ""); });
    if (total > MAX_PROJECT_BYTES) throw new Error("This project exceeds the 2 MB guest workspace limit.");
    snapshot("Before AI update");
    Object.keys(changes).forEach(function (path) { state.project.files[path] = changes[path]; });
    state.activeFile = Object.keys(changes)[0];
    renderFiles(); loadEditor(); persist(); runPreview();
    setStatus(label + " Updated " + Object.keys(changes).length + " file(s). Review the preview.");
  }
  function showApproval(changes, prompt) {
    state.pending = changes;
    $("approvalSummary").textContent = "This request changes " + Object.keys(changes).length + " file(s). Vee-AI classified the update as a major project change. Review the file list before applying.";
    $("approvalDiff").textContent = Object.keys(changes).map(function (path) { return "FILE: " + path + "\n" + changes[path].slice(0,1800); }).join("\n\n---\n\n");
    $("approvalDialog").showModal();
  }
  async function askVeeAI(prompt) {
    if (state.assistantBusy) return;
    state.assistantBusy = true;
    var askButton = $("assistantForm").querySelector("button[type=submit]");
    if (askButton) askButton.disabled = true;
    saveEditor();
    var context = Object.keys(state.project.files).map(function (path) { return "\nFILE: " + path + "\n```" + (path.split(".").pop()) + "\n" + state.project.files[path] + "\n```"; }).join("\n");
    var message = "You are helping edit a user's frontend project in Vee-AI Studio. Follow the request and preserve existing functionality. Return each changed file as a fenced code block with the exact relative file path immediately after the language, for example ```html index.html. Return complete file contents, not partial snippets. Do not claim a change was made unless you include the changed file. Do not modify Vee-AI internal infrastructure.\nUSER REQUEST: " + prompt + "\nPROJECT: " + state.project.name + "\nCURRENT FILES:" + context;
    if (message.length > 50000) { setStatus("This project context is too large for one AI request. Reduce the project or ask about fewer files.", true); state.assistantBusy = false; if (askButton) askButton.disabled = false; return; }
    $("assistantStatus").textContent = "Vee-AI is reviewing your project…";
    try {
      var response = await fetch("/.netlify/functions/chat", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({message:message,history:[],selectedModel:"Vee Brain",selectedLanguage:"Auto",memory:[]}) });
      var data = await response.json().catch(function(){return {};});
      if (!response.ok) throw new Error(data.error || "Vee-AI request failed.");
      var reply = data.reply || "";
      var changes = parseCodeBlocks(reply);
      if (!Object.keys(changes).length) { setStatus(reply || "Vee-AI returned no code changes.", false); return; }
      var major = isMajor(changes, prompt);
      if (major) showApproval(changes, prompt);
      else applyChanges(changes, "Automatic small change.");
    } catch (error) { setStatus(error.message || "Unable to contact Vee-AI.", true); }
    finally { state.assistantBusy = false; if (askButton) askButton.disabled = false; }
  }
  function init() {
    state.projects = safeParse(localStorage.getItem(STORAGE_KEY), []);
    if (!Array.isArray(state.projects)) state.projects = [];
    var handoff = safeParse(localStorage.getItem(HANDOFF_KEY), null);
    var handoffProject = null;
    if (handoff && handoff.files && typeof handoff.files === "object") {
      var valid = {};
      Object.keys(handoff.files).forEach(function (p) { if (safePath(p) && typeof handoff.files[p] === "string" && bytes(handoff.files[p]) <= MAX_FILE_BYTES) valid[p] = handoff.files[p]; });
      if (Object.keys(valid).length) {
        handoffProject = makeProject(handoff.name || "Chat project", valid, "html");
        state.projects.unshift(handoffProject);
      }
      localStorage.removeItem(HANDOFF_KEY);
    }
    var activeId = localStorage.getItem(ACTIVE_KEY);
    var project = handoffProject || state.projects.find(function (p) { return p.id === activeId; }) || state.projects[0];
    if (!project) { project = makeProject("My first website", null, "html"); state.projects.unshift(project); }
    selectProject(project);
    $("projectName").addEventListener("change", function () { state.project.name = $("projectName").value.trim() || "Untitled project"; persist(); });
    $("frameworkSelect").addEventListener("change", function () {
      var value = $("frameworkSelect").value;
      if (value !== "html") {
        alert(value.toUpperCase() + " build and preview support is planned for a later Studio build stage. Your current files are unchanged.");
        $("frameworkSelect").value = state.project.framework || "html"; return;
      }
      state.project.framework = value; persist();
    });
    $("codeEditor").addEventListener("input", function () {
      state.undo.push(state.project.files[state.activeFile] || ""); if (state.undo.length > 20) state.undo.shift();
      state.dirty = true; $("dirtyMark").style.display = "inline-block"; updateLineNumbers(); persistDebounced();
    });
    $("codeEditor").addEventListener("scroll", function () { $("lineNumbers").scrollTop = $("codeEditor").scrollTop; });
    $("previewBtn").addEventListener("click", runPreview); $("refreshPreviewBtn").addEventListener("click", runPreview);
    $("copyBtn").addEventListener("click", function () { navigator.clipboard && navigator.clipboard.writeText($("codeEditor").value); });
    $("undoBtn").addEventListener("click", function () { var previous = state.undo.pop(); if (previous === undefined) return; $("codeEditor").value = previous; saveEditor(); loadEditor(); });
    $("addFileBtn").addEventListener("click", function () {
      var path = prompt("New file name, for example components/header.js");
      if (!path) return; if (!safePath(path)) { alert("Use a relative file path ending in html, css, js, json, svg, md or txt. No parent folders."); return; }
      if (Object.keys(state.project.files).length >= MAX_FILES) { alert("Project file limit reached."); return; }
      if (!state.project.files[path]) state.project.files[path] = ""; state.activeFile = path; renderFiles(); loadEditor(); persist();
    });
    $("newProjectBtn").addEventListener("click", function () { saveEditor(); var name = prompt("Project name", "Untitled project"); if (!name) return; var p = makeProject(name); state.projects.unshift(p); selectProject(p); });
    $("saveVersionBtn").addEventListener("click", function () { saveEditor(); snapshot("Manual checkpoint"); setStatus("Version checkpoint saved."); });
    $("historyBtn").addEventListener("click", showHistory); $("restoreBtn").addEventListener("click", restoreLatest);
    $("exportBtn").addEventListener("click", exportProject);
    $("importBtn").addEventListener("click", function () { $("importInput").click(); });
    $("importInput").addEventListener("change", importProject);
    $("domainsBtn").addEventListener("click", function () {
      var current = state.project.approvedDomains || [];
      var entry = prompt("Approved external domains for this project:\n" + (current.length ? current.join("\n") : "No custom domains approved.") + "\n\nEnter a hostname such as api.example.com to add it, or enter an existing hostname to remove it.");
      if (entry === null || !entry.trim()) return;
      var host = entry.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0].split(":")[0];
      if (!/^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) || /^(localhost|.*\.local|.*\.internal)$/.test(host)) {
        alert("Enter a public DNS hostname only. Localhost, private IP addresses and local domains are blocked."); return;
      }
      state.project.approvedDomains = current.slice();
      if (state.project.approvedDomains.includes(host)) {
        if (confirm("Remove " + host + " from the approved list?")) state.project.approvedDomains = state.project.approvedDomains.filter(function (item) { return item !== host; });
      } else state.project.approvedDomains.push(host);
      persist(); runPreview();
    });
        $("clearConsoleBtn").addEventListener("click", function () { $("consoleOutput").textContent = "Console cleared."; });
    document.querySelectorAll(".device").forEach(function (button) { button.addEventListener("click", function () { document.querySelectorAll(".device").forEach(function (b) { b.classList.remove("active"); }); button.classList.add("active"); $("previewFrame").style.width = button.dataset.width; }); });
    $("assistantForm").addEventListener("submit", function (event) { event.preventDefault(); var promptText = $("assistantPrompt").value.trim(); if (!promptText) return; $("assistantPrompt").value = ""; askVeeAI(promptText); });
    $("approveChangesBtn").addEventListener("click", function (event) {
      if (!state.pending) return; event.preventDefault();
      try { applyChanges(state.pending, "Approved major change."); state.pending = null; $("approvalDialog").close(); }
      catch (error) { setStatus(error.message, true); }
    });
    window.addEventListener("beforeunload", saveEditor);
  }
  var saveTimer;
  function persistDebounced() { clearTimeout(saveTimer); $("saveState").textContent = "Saving…"; saveTimer = setTimeout(function () { saveEditor(); }, 350); }
  function showHistory() {
    saveEditor(); var list = $("historyList"); list.innerHTML = "";
    (state.project.versions || []).forEach(function (version) {
      var row = document.createElement("div"); row.className = "history-item";
      var label = document.createElement("span"); label.textContent = version.label + " · " + new Date(version.createdAt).toLocaleString();
      var button = document.createElement("button"); button.textContent = "Restore"; button.addEventListener("click", function () { snapshot("Before restore"); state.project.files = JSON.parse(JSON.stringify(version.files)); state.activeFile = Object.keys(state.project.files)[0]; renderFiles(); loadEditor(); persist(); runPreview(); $("historyDialog").close(); });
      row.append(label,button); list.appendChild(row);
    });
    if (!list.children.length) list.innerHTML = '<p class="empty-state">No saved versions yet. Use Save version before major work.</p>';
    $("historyDialog").showModal();
  }
  function restoreLatest() {
    var versions = state.project.versions || [];
    if (!versions.length) { setStatus("No saved version exists yet.", true); return; }
    var version = versions[0];
    if (!confirm("Restore " + version.label + "? Your current files will first be saved as a recovery version.")) return;
    snapshot("Before restore"); state.project.files = JSON.parse(JSON.stringify(version.files)); state.activeFile = Object.keys(state.project.files)[0]; renderFiles(); loadEditor(); persist(); runPreview();
  }
  function exportProject() {
    saveEditor(); var blob = new Blob([JSON.stringify(state.project,null,2)],{type:"application/json"});
    var url = URL.createObjectURL(blob), a = document.createElement("a"); a.href = url; a.download = (state.project.name || "vee-ai-project").replace(/[^a-z0-9_-]+/gi,"-") + ".json"; a.click(); URL.revokeObjectURL(url);
  }
  function importProject(event) {
    var file = event.target.files && event.target.files[0]; if (!file) return;
    if (file.size > MAX_PROJECT_BYTES) { alert("Project file exceeds 2 MB."); return; }
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var imported = JSON.parse(reader.result), files = {};
        Object.keys(imported.files || {}).forEach(function (path) { if (safePath(path) && typeof imported.files[path] === "string" && bytes(imported.files[path]) <= MAX_FILE_BYTES) files[path] = imported.files[path]; });
        if (!Object.keys(files).length || Object.keys(files).length > MAX_FILES) throw new Error("No valid project files were found.");
        var project = makeProject(imported.name || file.name.replace(/\.json$/i,""), files, "html");
        state.projects.unshift(project); selectProject(project); setStatus("Project imported successfully.");
      } catch (error) { alert(error.message || "Unable to import this project."); }
      $("importInput").value = "";
    };
    reader.readAsText(file);
  }
  window.addEventListener("DOMContentLoaded", init);
})();