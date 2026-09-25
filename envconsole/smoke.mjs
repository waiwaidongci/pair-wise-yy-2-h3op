// 端到端冒烟：上报→事件合并→联锁→换人→更正重判
const BASE = "http://localhost:3025";
let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗", name, extra); }
}
async function api(path, opts = {}) {
  const res = await fetch(BASE + path, {
    method: opts.method || "GET",
    headers: opts.body ? { "Content-Type": "application/json" } : {},
    body: opts.body
  });
  const data = await res.json();
  return { status: res.status, data };
}

// 1. 初始演示数据
let s = (await api("/api/state")).data;
check("种子 3 个测点", s.points.length === 3);
const a1 = s.points.find(p => p.deviceNo === "DEV-A1");
const a2 = s.points.find(p => p.deviceNo === "DEV-A2");
const b1 = s.points.find(p => p.deviceNo === "DEV-B1");
check("A1 在线", a1.online);
check("A2 氨气越界", a2.evaluation.violations.some(v => v.metric === "nh3"), JSON.stringify(a2.evaluation));
check("B1 掉线（>15分钟）", b1.offline, "online=" + b1.online);
check("有未结氨气事件", s.events.some(e => e.kind === "breach" && e.metric === "nh3" && e.status === "open"));
check("有 B1 掉线事件", s.events.some(e => e.pointId === b1.id && e.kind === "offline" && e.status === "open"));
check("A棚有自动建议（draft）", s.commands.some(c => c.shed === "A棚" && c.status === "draft"));
check("B棚无自动建议（掉线阻塞）", !s.commands.some(c => c.shed === "B棚"));

// 2. 连续越界上报并入原事件
const beforeCount = s.events.filter(e => e.pointId === a2.id && e.status === "open").length;
const beforeEv = s.events.find(e => e.pointId === a2.id && e.kind === "breach" && e.metric === "nh3" && e.status === "open");
await api("/api/readings", { method: "POST", body: JSON.stringify({ deviceNo: "DEV-A2", values: { temp: 27, hum: 70, nh3: 31 }, actor: "张三" }) });
s = (await api("/api/state")).data;
const afterEv = s.events.find(e => e.id === beforeEv.id && e.status === "open");
check("连续上报并入同一事件", afterEv && afterEv.basisReadingIds.length === beforeEv.basisReadingIds.length + 1);
check("未新增越界事件", s.events.filter(e => e.pointId === a2.id && e.status === "open").length === beforeCount);

// 3. 读数恢复正常 → 事件自动关闭
await api("/api/readings", { method: "POST", body: JSON.stringify({ deviceNo: "DEV-A2", values: { temp: 24, hum: 60, nh3: 8 }, actor: "张三" }) });
s = (await api("/api/state")).data;
check("氨气事件自动关闭", !s.events.some(e => e.id === beforeEv.id && e.status === "open"));
check("自动建议因依据消失作废", s.commands.some(c => c.shed === "A棚" && c.status === "closed" && c.closeReason === "basis_gone_auto_revoked"));

// 4. 再次越界 → 新建议；A棚全部在线可下发
await api("/api/readings", { method: "POST", body: JSON.stringify({ deviceNo: "DEV-A1", values: { temp: 22, hum: 58, nh3: 40 }, actor: "张三" }) });
s = (await api("/api/state")).data;
const draft = s.commands.find(c => c.shed === "A棚" && c.status === "draft");
check("新越界产生新建议", !!draft);
check("建议依据有效", draft.validity === "valid", draft.validity);

// 5. 换人流程：同一人不能申请关闭
let r = await api(`/api/commands/${draft.id}/issue`, { method: "POST", body: JSON.stringify({ actor: "张三" }) });
check("张三下发成功", r.status === 200);
r = await api(`/api/commands/${draft.id}/action`, { method: "POST", body: JSON.stringify({ actor: "张三", action: "request_close" }) });
check("下发人不能申请关闭", r.status === 409, r.data.error);
r = await api(`/api/commands/${draft.id}/action`, { method: "POST", body: JSON.stringify({ actor: "李四", action: "request_close" }) });
check("李四可申请关闭", r.status === 200);
r = await api(`/api/commands/${draft.id}/action`, { method: "POST", body: JSON.stringify({ actor: "李四", action: "confirm_close" }) });
check("申请人不能确认关闭", r.status === 409);
r = await api(`/api/commands/${draft.id}/action`, { method: "POST", body: JSON.stringify({ actor: "王五", action: "confirm_close" }) });
check("第三人确认关闭", r.status === 200 && r.data.status === "closed");

// 6. 读数缺失：不能自动开启
await api("/api/readings", { method: "POST", body: JSON.stringify({ deviceNo: "DEV-A1", values: { temp: 55, hum: null, nh3: null }, actor: "张三" }) });
s = (await api("/api/state")).data;
const a1now = s.points.find(p => p.deviceNo === "DEV-A1");
check("缺测时不判越界（仅有值项目）", a1now.complete === false);
check("生成缺测事件", s.events.some(e => e.pointId === a1.id && e.kind === "missing" && e.status === "open"));
const aDraft = s.commands.find(c => c.shed === "A棚" && c.status === "draft");
check("缺测时自动建议被阻塞（禁止自动开启）", !aDraft || aDraft.validity !== "valid");
if (aDraft) {
  r = await api(`/api/commands/${aDraft.id}/issue`, { method: "POST", body: JSON.stringify({ actor: "张三" }) });
  check("阻塞时普通下发被拒", r.status === 412, r.data.error);
  r = await api(`/api/commands/${aDraft.id}/issue`, { method: "POST", body: JSON.stringify({ actor: "张三", override: true, reason: "电话核实氨气刺鼻" }) });
  check("强制下发成功（人工担责）", r.status === 200 && r.data.kind === "manual");
  // 清理：李四申请、王五关闭
  await api(`/api/commands/${aDraft.id}/action`, { method: "POST", body: JSON.stringify({ actor: "李四", action: "request_close" }) });
  await api(`/api/commands/${aDraft.id}/action`, { method: "POST", body: JSON.stringify({ actor: "王五", action: "confirm_close" }) });
}
// 恢复完整读数关闭缺测事件
await api("/api/readings", { method: "POST", body: JSON.stringify({ deviceNo: "DEV-A1", values: { temp: 22, hum: 58, nh3: 6 }, actor: "张三" }) });

// 7. 更正重判：先制造越界，再把首读改成正常，验证事件/指令重算与留档
await api("/api/readings", { method: "POST", body: JSON.stringify({ deviceNo: "DEV-A2", values: { temp: 24, hum: 60, nh3: 88 }, actor: "张三" }) });
s = (await api("/api/state")).data;
const nh3Open = s.events.find(e => e.pointId === a2.id && e.kind === "breach" && e.metric === "nh3" && e.status === "open");
check("A2 新氨气越界事件", !!nh3Open);
const cDraft = s.commands.find(c => c.shed === "A棚" && c.status === "draft");
check("越界后自动建议生成", !!cDraft && cDraft.validity === "valid");

// 更正该读数为正常值
const readings = (await api(`/api/readings?pointId=${a2.id}`)).data;
const target = readings.find(x => x.values.nh3 === 88);
r = await api(`/api/readings/${target.id}/correct`, { method: "POST", body: JSON.stringify({ values: { temp: 24, hum: 60, nh3: 8 }, actor: "赵六", reason: "电话报数误记，复核正常" }) });
check("更正接口 200", r.status === 200);
check("重放读数条数>0", r.data.replayed > 0);
s = (await api("/api/state")).data;
check("重判后无未结氨气事件", !s.events.some(e => e.pointId === a2.id && e.kind === "breach" && e.metric === "nh3" && e.status === "open"));
const versions = (await api(`/api/readings?pointId=${a2.id}`)).data;
const oldV = versions.find(v => v.id === target.id);
check("旧版本留档 isCurrent=false", oldV && oldV.isCurrent === false && oldV.version === 1);
check("新版本为现行", versions.some(v => v.correctionOf === target.id && v.isCurrent === true && v.values.nh3 === 8));
const hist = (await api("/api/event-history")).data;
check("事件旧版本已归档", hist.some(h => h.pointId === a2.id && h.metric === "nh3"));
check("自动建议重判后作废", s.commands.some(c => c.shed === "A棚" && c.status === "closed" && c.closeReason === "basis_gone_auto_revoked"));

// 8. 已下发指令遇更正依据失效：不自动关闭，标 invalid
await api("/api/readings", { method: "POST", body: JSON.stringify({ deviceNo: "DEV-A1", values: { temp: 22, hum: 58, nh3: 77 }, actor: "张三" }) });
s = (await api("/api/state")).data;
const d2 = s.commands.find(c => c.shed === "A棚" && c.status === "draft");
await api(`/api/commands/${d2.id}/issue`, { method: "POST", body: JSON.stringify({ actor: "张三" }) });
const r2 = (await api(`/api/readings?pointId=${a1.id}`)).data;
const bad = r2.find(x => x.values.nh3 === 77);
await api(`/api/readings/${bad.id}/correct`, { method: "POST", body: JSON.stringify({ values: { temp: 22, hum: 58, nh3: 6 }, actor: "赵六", reason: "复核更正" }) });
s = (await api("/api/state")).data;
const cmdNow = s.commands.find(c => c.id === d2.id);
check("已下发指令未被自动关闭", cmdNow.status === "issued");
check("依据失效标记 invalid", cmdNow.validity === "invalid", cmdNow.validity);

// 9. 审计只追加
const audit = (await api("/api/audit")).data;
check("审计台账有序且含关键类型", audit.some(a => a.type === "reading_corrected") && audit.some(a => a.type === "command_confirm_close") && audit.some(a => a.type === "event_merge"));

console.log(`\n${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
