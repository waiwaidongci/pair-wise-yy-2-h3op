export const envPage = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>鸽舍环控监测台</title>
  <style>
    :root { --bg:#eff2f5; --panel:#fff; --ink:#1f2833; --muted:#697786; --line:#d3dce4; --accent:#315f83; --red:#9b3f35; --green:#2f6b3a; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } main { display:grid; grid-template-columns:430px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card { background:#fff; border:1px solid var(--line); border-radius:8px; padding:16px; } h2 { margin:0 0 12px; font-size:18px; } h3 { margin:0 0 8px; font-size:16px; }
    label { display:block; margin:8px 0 4px; color:var(--muted); font-size:13px; } input,select { width:100%; border:1px solid var(--line); border-radius:6px; padding:8px; font:inherit; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:9px 12px; font-weight:700; cursor:pointer; margin-top:8px; }
    button.mini { padding:5px 9px; font-size:12px; }
    .navlink { color:var(--accent); font-weight:700; text-decoration:none; margin-right:12px; }
    .grid { display:grid; gap:12px; margin-top:14px; }
    .card { display:grid; gap:8px; } .meta { color:var(--muted); font-size:13px; }
    .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:2px 8px; font-size:12px; }
    .small { background:#f8fafb; border:1px solid var(--line); border-radius:8px; padding:10px; }
    .section { margin-top:14px; } .row { display:grid; grid-template-columns:repeat(3,1fr); gap:6px; }
    table { width:100%; border-collapse:collapse; font-size:13px; } th,td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
    th { color:var(--muted); font-weight:400; }
    .badge { display:inline-block; border-radius:4px; padding:2px 7px; font-size:12px; margin:1px 2px 1px 0; }
    .badge.red { background:#f7e3e0; color:var(--red); border:1px solid #e0b7b0; }
    .badge.green { background:#e2f0e4; color:var(--green); border:1px solid #bcd8c2; }
    .badge.gray { background:#eef1f4; color:var(--muted); border:1px solid var(--line); }
    .bad { color:var(--red); font-weight:700; } .ok { color:var(--green); font-weight:700; }
    details { margin-top:6px; } summary { cursor:pointer; color:var(--accent); font-size:13px; }
    #flash { padding:12px 28px 0; } #flash .inner { background:#fff8e6; border:1px solid #ead9a8; border-radius:8px; padding:10px 14px; font-size:13px; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} #flash{padding:10px 16px 0;} }
  </style>
</head>
<body>
  <header>
    <div><h1>鸽舍环控监测台</h1><div class="meta" id="thresholds">温度、湿度、氨气越界判定与风机指令</div></div>
    <div><a class="navlink" href="/">← 鸽籍登记</a><button id="reload">刷新</button></div>
  </header>
  <div id="flash" style="display:none"><div class="inner" id="flashText"></div></div>
  <main>
    <section>
      <form id="pointForm">
        <h2>登记测点</h2>
        <label>棚号</label><input name="loft" required placeholder="如 北岸A棚">
        <label>测点名称</label><input name="name" required placeholder="如 北侧1号测点">
        <label>设备号</label><input name="deviceNo" required placeholder="如 ENV-N1-002">
        <button>保存测点</button>
      </form>
      <div class="grid" id="points"></div>
    </section>
    <section>
      <div class="panel"><h2>越界事件</h2><div id="events"></div></div>
      <div class="panel section"><h2>风机指令</h2><div id="commands"></div></div>
      <div class="panel section"><h2>留档记录</h2><div id="archives"></div></div>
    </section>
  </main>
  <script>
    const state = { thresholds:{}, staleMinutes:30, points:[], readings:[], events:[], commands:[], archives:[] };
    const METRIC = { temperature:"温度", humidity:"湿度", ammonia:"氨气" };
    const UNIT = { temperature:"℃", humidity:"%", ammonia:"ppm" };
    const ACTION = { fan_on:"开启风机", fan_off:"关闭风机" };
    const STATUS = { pending:"待复核", issued:"已下发", closed:"已关闭", cancelled:"已撤销" };
    const PROBLEM = { device_offline:"设备掉线", no_reading:"无读数", bad_sample_time:"采样时刻异常", stale:"采样超期" };

    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ "Content-Type":"application/json" } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error + (data.problems ? "：" + data.problems.map(problemLabel).join("、") : ""));
      return data;
    }
    function esc(value) {
      return String(value == null ? "" : value).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;" }[c]));
    }
    function pad(n) { return String(n).padStart(2, "0"); }
    function localInputValue(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes()); }
    function fmtTime(t) { return t ? new Date(t).toLocaleString("zh-CN", { hour12:false }) : "—"; }
    function problemLabel(p) {
      if (p.indexOf("missing_") === 0) return METRIC[p.slice(8)] + "缺失";
      return PROBLEM[p] || p;
    }
    function valOr(v, unit) { return v === null || v === undefined ? "缺失" : v + unit; }
    function flash(text) {
      document.querySelector("#flash").style.display = "block";
      document.querySelector("#flashText").textContent = text;
      setTimeout(() => { document.querySelector("#flash").style.display = "none"; }, 5000);
    }
    function changesSummary(c) {
      if (!c) return "";
      const parts = [];
      if (c.opened.length) parts.push("新开事件 " + c.opened.length);
      if (c.merged.length) parts.push("并入原事件 " + c.merged.length);
      if (c.closed.length) parts.push("办结事件 " + c.closed.length);
      if (c.proposed.length) parts.push("生成待复核指令 " + c.proposed.length);
      if (c.cancelled.length) parts.push("撤销指令 " + c.cancelled.length);
      if (c.fanOnBlocked) parts.push("设备掉线或读数缺失，已禁止自动开风机");
      return parts.join("；") || "判定无变化";
    }
    function readingCell(r, metric) {
      if (!r || r[metric] === null || r[metric] === undefined) return '<span class="bad">缺失</span>';
      const th = state.thresholds[metric] || {};
      const v = r[metric];
      const bad = (th.min !== undefined && v < th.min) || (th.max !== undefined && v > th.max);
      return '<span class="' + (bad ? "bad" : "ok") + '">' + v + UNIT[metric] + "</span>";
    }
    function fieldInput(pid, f, placeholder, value, mode) {
      const attr = mode === "c" ? "data-cf" : "data-f";
      const valAttr = (value === null || value === undefined) ? "" : ' value="' + value + '"';
      return '<input ' + attr + '="' + f + '" data-p="' + pid + '" placeholder="' + placeholder + '" inputmode="decimal"' + valAttr + ">";
    }

    function renderPoints() {
      document.querySelector("#points").innerHTML = state.points.map(p => {
        const r = p.latestReading;
        const badges = (p.problems || []).map(x => '<span class="badge red">' + problemLabel(x) + "</span>").join("");
        const readingLine = r
          ? "温度 " + readingCell(r, "temperature") + " ｜ 湿度 " + readingCell(r, "humidity") + " ｜ 氨气 " + readingCell(r, "ammonia")
            + '<div class="meta">采样 ' + fmtTime(r.sampledAt) + " · 版本 v" + r.version
            + (r.correctedBy ? " · " + esc(r.correctedBy) + " 更正" : "")
            + (r.deviceStatus === "offline" ? ' · <span class="bad">设备掉线</span>' : "") + "</div>"
          : '<span class="meta">暂无读数，等待设备上报。</span>';
        const versions = state.readings.filter(x => x.pointId === p.id).map(x =>
          '<div class="meta">v' + x.version + " · " + (x.status === "active" ? "当前" : "旧版留档")
          + " · 温度 " + valOr(x.temperature, "℃") + " 湿度 " + valOr(x.humidity, "%") + " 氨气 " + valOr(x.ammonia, "ppm")
          + " · " + fmtTime(x.sampledAt) + (x.correctedBy ? " · " + esc(x.correctedBy) : "") + "</div>"
        ).join("");
        return '<article class="card">'
          + "<h3>" + esc(p.name) + ' <span class="pill">' + esc(p.loft) + "</span></h3>"
          + '<div class="meta">设备号 ' + esc(p.deviceNo) + " ｜ 风机：" + (p.fanStatus === "on" ? '<span class="ok">运转中</span>' : "停止") + " ｜ 未结事件 " + p.openEvents + "</div>"
          + '<div class="small">' + readingLine + (badges ? "<div>" + badges + "</div>" : "") + "</div>"
          + '<details><summary>上报读数</summary>'
            + '<div class="row">' + fieldInput(p.id, "temperature", "温度℃") + fieldInput(p.id, "humidity", "湿度%") + fieldInput(p.id, "ammonia", "氨气ppm") + "</div>"
            + "<label>设备状态</label><select data-f=\"deviceStatus\" data-p=\"" + p.id + '"><option value="online">在线</option><option value="offline">掉线</option></select>'
            + "<label>采样时刻</label><input type=\"datetime-local\" data-f=\"sampledAt\" data-p=\"" + p.id + '">'
            + '<button data-report="' + p.id + '">提交读数</button>'
          + "</details>"
          + (r
            ? '<details><summary>更正最新读数（v' + r.version + "）</summary>"
              + '<div class="row">' + fieldInput(p.id, "temperature", "温度℃", r.temperature, "c") + fieldInput(p.id, "humidity", "湿度%", r.humidity, "c") + fieldInput(p.id, "ammonia", "氨气ppm", r.ammonia, "c") + "</div>"
              + "<label>更正人</label><input data-cf=\"correctedBy\" data-p=\"" + p.id + '">'
              + "<label>更正原因</label><input data-cf=\"reason\" data-p=\"" + p.id + '">'
              + '<button data-correct="' + r.id + '" data-p="' + p.id + '">提交更正并重判</button>'
            + "</details>"
            : "")
          + '<details><summary>读数版本（留档）</summary>' + (versions || '<div class="meta">暂无</div>') + "</details>"
          + '<div class="meta">手动指令</div><div>'
            + '<button class="mini" data-cmd="fan_on" data-point="' + p.id + '">申请开风机</button> '
            + '<button class="mini" data-cmd="fan_off" data-point="' + p.id + '">申请关风机</button>'
          + "</div></article>";
      }).join("");
      bindPointButtons();
      document.querySelectorAll('[data-f="sampledAt"]').forEach(el => { if (!el.value) el.value = localInputValue(new Date()); });
    }

    function renderEvents() {
      const rows = state.events.map(e => {
        const dirText = e.direction === "high" ? "超上限 " : "低于下限 ";
        return "<tr><td>" + e.id + "</td>"
          + "<td>" + esc(e.pointName || e.pointId) + '<div class="meta">' + esc(e.loft || "") + "</div></td>"
          + "<td>" + (METRIC[e.metric] || e.metric) + '<div class="meta">' + dirText + e.limit + (UNIT[e.metric] || "") + "</div></td>"
          + '<td><span class="badge ' + (e.status === "open" ? "red" : "green") + '">' + (e.status === "open" ? "未结" : "已结") + "</span></td>"
          + "<td>" + e.count + " 次</td>"
          + "<td>" + e.lastValue + (UNIT[e.metric] || "") + "</td>"
          + '<td class="meta">' + fmtTime(e.openedAt) + (e.closedAt ? "<br>办结 " + fmtTime(e.closedAt) : "") + "</td></tr>";
      }).join("");
      document.querySelector("#events").innerHTML = rows
        ? "<table><tr><th>事件</th><th>测点</th><th>指标</th><th>状态</th><th>连续上报</th><th>最近值</th><th>时间</th></tr>" + rows + "</table>"
        : '<p class="meta">暂无事件。读数越过阈值时自动生成未结事件，同一测点连续越界并入原事件。</p>';
    }

    function renderCommands() {
      const rows = state.commands.map(c => {
        let ops = "";
        if (c.status === "pending") ops = '<button class="mini" data-review="' + c.id + '">复核下发</button>';
        if (c.status === "issued") ops = '<button class="mini" data-close="' + c.id + '">换人确认关闭</button>';
        const basis = c.basis
          ? '<div class="meta">依据 v' + c.basis.version + "："
            + ["temperature", "humidity", "ammonia"].map(m => METRIC[m] + " " + valOr(c.basis[m], UNIT[m])).join("，") + "</div>"
          : '<div class="meta">无有效读数依据</div>';
        const people = '<div class="meta">发起 ' + esc(c.requestedBy || "—") + " ｜ 复核 " + esc(c.reviewedBy || "—") + " ｜ 确认 " + esc(c.closedBy || "—") + "</div>";
        const cls = c.status === "pending" ? "red" : (c.status === "closed" ? "green" : "gray");
        return "<tr><td>" + c.id + basis + "</td>"
          + "<td>" + esc(c.pointName || c.pointId) + "</td>"
          + "<td>" + (ACTION[c.action] || c.action) + "</td>"
          + '<td><span class="badge ' + cls + '">' + (STATUS[c.status] || c.status) + "</span>" + people + "</td>"
          + "<td>" + ops + "</td></tr>";
      }).join("");
      document.querySelector("#commands").innerHTML = rows
        ? "<table><tr><th>指令/依据</th><th>测点</th><th>动作</th><th>状态/人员</th><th>操作</th></tr>" + rows + "</table>"
        : '<p class="meta">暂无指令。越界后系统只生成待复核指令，经值班员复核才下发，再由另一人确认关闭。</p>';
      document.querySelectorAll("[data-review]").forEach(btn => btn.onclick = async () => {
        const by = prompt("复核人姓名（确认后下发指令；设备掉线或读数缺失时开风机会被拦截）");
        if (!by) return;
        try {
          await api("/api/env/commands/" + btn.dataset.review + "/review", { method: "POST", body: JSON.stringify({ reviewedBy: by }) });
          await load();
        } catch (e) { alert("复核失败：" + e.message); }
      });
      document.querySelectorAll("[data-close]").forEach(btn => btn.onclick = async () => {
        const by = prompt("确认人姓名（须与复核人不同）");
        if (!by) return;
        try {
          await api("/api/env/commands/" + btn.dataset.close + "/close", { method: "POST", body: JSON.stringify({ closedBy: by }) });
          await load();
        } catch (e) { alert("关闭失败：" + e.message); }
      });
    }

    function archiveText(a) {
      if (a.type === "reading_correction") return "读数更正：" + a.readingId + " v" + a.oldVersion.version + " → v" + a.newVersion.version + "（" + esc(a.by) + (a.reason ? "，" + esc(a.reason) : "") + "），旧版本已留档";
      if (a.type === "event_closed") return "事件办结：" + a.eventId + "（" + (METRIC[a.metric] || a.metric) + "，" + a.reason + "）";
      if (a.type === "command_cancelled") return "指令撤销：" + a.commandId + "（" + (ACTION[a.action] || a.action) + "，" + a.reason + "）";
      if (a.type === "command_closed") return "指令关闭：" + a.commandId + "（复核 " + esc(a.reviewedBy) + " / 确认 " + esc(a.closedBy) + "）";
      if (a.type === "fan_on_blocked") return "禁止自动开风机：测点 " + a.pointId + "（" + (a.problems || []).map(problemLabel).join("、") + "）";
      return a.type;
    }
    function renderArchives() {
      document.querySelector("#archives").innerHTML = state.archives.length
        ? state.archives.map(a => '<div class="meta" style="padding:4px 0;border-bottom:1px dashed var(--line)">' + fmtTime(a.at) + " ｜ " + archiveText(a) + "</div>").join("")
        : '<p class="meta">暂无留档。</p>';
    }

    function bindPointButtons() {
      document.querySelectorAll("[data-report]").forEach(btn => btn.onclick = async () => {
        const pid = btn.dataset.report;
        const val = f => { const el = document.querySelector('[data-f="' + f + '"][data-p="' + pid + '"]'); return el ? el.value : ""; };
        const payload = { pointId: pid, temperature: val("temperature"), humidity: val("humidity"), ammonia: val("ammonia"), deviceStatus: val("deviceStatus") };
        if (val("sampledAt")) payload.sampledAt = new Date(val("sampledAt")).toISOString();
        try {
          const r = await api("/api/env/readings", { method: "POST", body: JSON.stringify(payload) });
          flash("读数已入库：" + changesSummary(r.changes));
          await load();
        } catch (e) { alert("上报失败：" + e.message); }
      });
      document.querySelectorAll("[data-correct]").forEach(btn => btn.onclick = async () => {
        const pid = btn.dataset.p;
        const val = f => { const el = document.querySelector('[data-cf="' + f + '"][data-p="' + pid + '"]'); return el ? el.value : ""; };
        try {
          const r = await api("/api/env/readings/" + btn.dataset.correct + "/correct", {
            method: "POST",
            body: JSON.stringify({ temperature: val("temperature"), humidity: val("humidity"), ammonia: val("ammonia"), correctedBy: val("correctedBy"), reason: val("reason") })
          });
          flash("已按更正值重判：" + changesSummary(r.changes));
          await load();
        } catch (e) { alert("更正失败：" + e.message); }
      });
      document.querySelectorAll("[data-cmd]").forEach(btn => btn.onclick = async () => {
        const by = prompt("发起人姓名");
        if (!by) return;
        try {
          await api("/api/env/commands", { method: "POST", body: JSON.stringify({ pointId: btn.dataset.point, action: btn.dataset.cmd, requestedBy: by }) });
          await load();
        } catch (e) { alert("指令申请失败：" + e.message); }
      });
    }

    async function load() {
      const data = await api("/api/env/overview");
      Object.assign(state, data);
      const t = data.thresholds;
      document.querySelector("#thresholds").textContent =
        "越界判定：温度 " + t.temperature.min + "–" + t.temperature.max + "℃ ｜ 湿度 " + t.humidity.min + "–" + t.humidity.max + "% ｜ 氨气 ≤ " + t.ammonia.max
        + "ppm ｜ 采样超期 " + data.staleMinutes + " 分钟、设备掉线或读数缺失时禁止自动开风机";
      renderPoints();
      renderEvents();
      renderCommands();
      renderArchives();
    }
    document.querySelector("#pointForm").onsubmit = async event => {
      event.preventDefault();
      try {
        await api("/api/env/points", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(event.target).entries())) });
        event.target.reset();
        await load();
      } catch (e) { alert("保存失败：" + e.message); }
    };
    document.querySelector("#reload").onclick = load;
    load();
  </script>
</body>
</html>`;
