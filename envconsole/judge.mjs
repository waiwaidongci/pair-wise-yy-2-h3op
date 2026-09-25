// 判定层：阈值越界、事件生命周期（连续上报并入原事件）、掉线/缺测、
// 风机指令联锁（掉线或缺测禁止自动开启）、读数更正后的重判。
// 只依赖存档层做留档，不接触 HTTP。
import { newId, log, archiveEventSnapshot } from "./archive.mjs";

export const METRICS = ["temp", "hum", "nh3"];
export const METRIC_LABELS = { temp: "温度", hum: "湿度", nh3: "氨气" };
export const METRIC_UNITS = { temp: "℃", hum: "%RH", nh3: "ppm" };

// 默认阈值，可按测点覆盖
export const DEFAULT_THRESHOLDS = {
  temp: { min: 5, max: 30 },
  hum: { min: 40, max: 75 },
  nh3: { min: 0, max: 20 }
};
export const OFFLINE_MS = 15 * 60 * 1000; // 超过 15 分钟无上报视为掉线

export function nowIso() { return new Date().toISOString(); }

export function thresholdsFor(point) {
  return {
    temp: { ...DEFAULT_THRESHOLDS.temp, ...(point.thresholds?.temp || {}) },
    hum: { ...DEFAULT_THRESHOLDS.hum, ...(point.thresholds?.hum || {}) },
    nh3: { ...DEFAULT_THRESHOLDS.nh3, ...(point.thresholds?.nh3 || {}) }
  };
}

// 评估一条完整读数：返回每项越界方向
export function evalReading(values, pointThresholds = {}) {
  const result = { values: {}, violations: [] };
  for (const metric of METRICS) {
    const raw = values?.[metric];
    const value = raw === null || raw === undefined || raw === "" ? null : Number(raw);
    result.values[metric] = value;
    if (value === null || Number.isNaN(value)) continue;
    const t = { ...DEFAULT_THRESHOLDS[metric], ...(pointThresholds[metric] || {}) };
    if (value < t.min) result.violations.push({ metric, level: "low", value, limit: t.min });
    else if (value > t.max) result.violations.push({ metric, level: "high", value, limit: t.max });
  }
  return result;
}

export function isComplete(doc) {
  if (!doc) return false;
  return METRICS.every(m => doc.values?.[m] !== null && doc.values?.[m] !== undefined && doc.values?.[m] !== "");
}

export function currentReadings(db, pointId) {
  return db.readings
    .filter(r => r.pointId === pointId && r.isCurrent)
    .sort((a, b) => a.sampledAt.localeCompare(b.sampledAt) || a.receivedAt.localeCompare(b.receivedAt));
}
export function latestCurrent(db, pointId) {
  const list = currentReadings(db, pointId);
  return list.length ? list[list.length - 1] : null;
}
export function openEvents(db, pointId, kind) {
  return db.events.filter(e => e.pointId === pointId && e.status === "open" && (!kind || e.kind === kind));
}
export function activeCommands(db, shed) {
  return db.commands.filter(c => c.shed === shed && ["draft", "issued", "close_requested"].includes(c.status));
}

function record(db, silent, actor, type, payload) {
  if (!silent) log(db, type, actor, payload);
}

function breachKey(pointId, metric) { return `${pointId}:breach:${metric}`; }

function openBreach(db, point, doc, violation, opts) {
  const ev = {
    id: newId("ev"),
    key: breachKey(point.id, violation.metric),
    pointId: point.id,
    shed: point.shed,
    pointName: point.name,
    deviceNo: point.deviceNo,
    kind: "breach",
    metric: violation.metric,
    level: violation.level,
    status: "open",
    firstAt: doc.sampledAt,
    lastAt: doc.sampledAt,
    firstReadingId: doc.id,
    lastReadingId: doc.id,
    readingValue: violation.value,
    basisReadingIds: [doc.id],
    replayedFromId: opts.originId || null
  };
  db.events.push(ev);
  record(db, opts.silent, opts.actor, "event_open", { eventId: ev.id, pointId: point.id, metric: violation.metric, readingId: doc.id });
  return ev;
}

function mergeBreach(db, ev, doc, value, opts) {
  ev.lastAt = doc.sampledAt;
  ev.lastReadingId = doc.id;
  ev.readingValue = value;
  ev.basisReadingIds.push(doc.id);
  record(db, opts.silent, opts.actor, "event_merge", { eventId: ev.id, pointId: ev.pointId, metric: ev.metric, readingId: doc.id });
}

function closeEvent(db, ev, reason, readingId, opts) {
  ev.status = "closed";
  ev.resolvedAt = opts.at || nowIso();
  ev.closeReason = reason;
  if (readingId) ev.resolvedReadingId = readingId;
  record(db, opts.silent, opts.actor, "event_close", { eventId: ev.id, pointId: ev.pointId, kind: ev.kind, reason });
}

function openMissing(db, point, doc, opts) {
  const ev = {
    id: newId("ev"),
    key: `${point.id}:missing`,
    pointId: point.id, shed: point.shed, pointName: point.name, deviceNo: point.deviceNo,
    kind: "missing", metric: null, level: null, status: "open",
    firstAt: doc.sampledAt, lastAt: doc.sampledAt,
    firstReadingId: doc.id, lastReadingId: doc.id,
    readingValue: null, basisReadingIds: [doc.id],
    replayedFromId: opts.originId || null
  };
  db.events.push(ev);
  record(db, opts.silent, opts.actor, "event_open", { eventId: ev.id, pointId: point.id, kind: "missing", readingId: doc.id });
  return ev;
}

// 处理一条已入库的现行读数（上报或更正重放共用）
export function processReading(db, doc, opts = {}) {
  const silent = !!opts.silent;
  const actor = opts.actor || "system";
  const point = db.points.find(p => p.id === doc.pointId);
  if (!db.readings.some(r => r.id === doc.id)) db.readings.push(doc);

  if (isComplete(doc)) {
    const evaluation = evalReading(doc.values, point.thresholds || {});
    for (const metric of METRICS) {
      const v = evaluation.violations.find(x => x.metric === metric);
      const open = db.events.find(e => e.pointId === point.id && e.kind === "breach" && e.metric === metric && e.status === "open");
      if (v) {
        if (open) mergeBreach(db, open, doc, v.value, { silent, actor });
        else openBreach(db, point, doc, v, { silent, actor, originId: opts.originMap?.get(breachKey(point.id, metric)) });
      } else if (open) {
        closeEvent(db, open, "reading_back_normal", doc.id, { silent, actor, at: doc.sampledAt });
      }
    }
    const miss = db.events.find(e => e.pointId === point.id && e.kind === "missing" && e.status === "open");
    if (miss) closeEvent(db, miss, "reading_resumed", doc.id, { silent, actor, at: doc.sampledAt });
  } else {
    // 读数缺失：开/并入缺测事件；越界事件维持未结，绝不因缺测而关闭
    const miss = db.events.find(e => e.pointId === point.id && e.kind === "missing" && e.status === "open");
    if (miss) {
      miss.lastAt = doc.sampledAt;
      miss.lastReadingId = doc.id;
      miss.basisReadingIds.push(doc.id);
      record(db, silent, actor, "event_merge", { eventId: miss.id, kind: "missing", readingId: doc.id });
    } else {
      openMissing(db, point, doc, { silent, actor, originId: opts.originMap?.get(`${point.id}:missing`) });
    }
  }

  if (!opts.noFanSync) syncFanForSheds(db, [point.shed], { silent, actor });
  return pointState(db, point.id);
}

// 扫描掉线：超时无现行上报则开/留掉线事件，恢复后自动关闭
export function sweepOffline(db, opts = {}) {
  const silent = !!opts.silent;
  const actor = opts.actor || "system";
  const at = opts.at || nowIso();
  const changedSheds = new Set();
  for (const point of db.points) {
    const latest = latestCurrent(db, point.id);
    const offline = !latest || at.localeCompare(latest.receivedAt) >= 0 &&
      (new Date(at).getTime() - new Date(latest.receivedAt).getTime() > OFFLINE_MS);
    const open = db.events.find(e => e.pointId === point.id && e.kind === "offline" && e.status === "open");
    if (offline && !open) {
      db.events.push({
        id: newId("ev"), key: `${point.id}:offline`,
        pointId: point.id, shed: point.shed, pointName: point.name, deviceNo: point.deviceNo,
        kind: "offline", metric: null, level: null, status: "open",
        firstAt: at, lastAt: at, firstReadingId: latest?.id || null, lastReadingId: latest?.id || null,
        readingValue: null, basisReadingIds: latest ? [latest.id] : [],
        replayedFromId: opts.originMap?.get(`${point.id}:offline`) || null
      });
      record(db, silent, actor, "event_open", { eventId: "new", pointId: point.id, kind: "offline" });
      changedSheds.add(point.shed);
    } else if (!offline && open) {
      closeEvent(db, open, "device_back_online", latest?.id, { silent, actor, at });
      changedSheds.add(point.shed);
    }
  }
  if (!opts.noFanSync) syncFanForSheds(db, [...changedSheds], { silent, actor });
}

// 某棚当前“禁止自动开启”的阻塞原因：设备掉线或读数缺失
export function shedBlockers(db, shed) {
  const blockers = [];
  for (const p of db.points.filter(x => x.shed === shed)) {
    const latest = latestCurrent(db, p.id);
    if (!latest) {
      blockers.push({ pointId: p.id, deviceNo: p.deviceNo, pointName: p.name, reason: "device_offline", detail: "从无上报" });
    } else if (new Date().getTime() - new Date(latest.receivedAt).getTime() > OFFLINE_MS) {
      blockers.push({ pointId: p.id, deviceNo: p.deviceNo, pointName: p.name, reason: "device_offline", detail: `最后上报 ${latest.receivedAt}` });
    } else if (!isComplete(latest)) {
      blockers.push({ pointId: p.id, deviceNo: p.deviceNo, pointName: p.name, reason: "reading_missing", detail: "温度/湿度/氨气读数不全" });
    }
  }
  return blockers;
}

// 风机联锁：按棚同步“自动建议”。掉线或缺测 → 不允许自动开启。
export function syncFanForSheds(db, sheds, opts = {}) {
  const silent = !!opts.silent;
  const actor = opts.actor || "system";
  for (const shed of sheds) {
    const blockers = shedBlockers(db, shed);
    const openBreaches = db.events.filter(e => e.shed === shed && e.kind === "breach" && e.status === "open");
    const commands = activeCommands(db, shed);

    for (const cmd of commands) {
      const basisOpen = cmd.basisEventIds.filter(id => db.events.some(e => e.id === id && e.status === "open"));
      if (cmd.kind === "auto" && cmd.status === "draft") {
        cmd.blockers = blockers;
        if (openBreaches.length === 0) {
          // 越界依据消失：自动建议作废（尚未下发，不影响设备）
          cmd.status = "closed";
          cmd.closedAt = nowIso();
          cmd.closeReason = "basis_gone_auto_revoked";
          cmd.validity = "invalid";
          cmd.invalidReason = "越界事件已解除，自动建议作废";
          record(db, silent, actor, "command_auto_revoke", { commandId: cmd.id, shed });
        } else if (blockers.length) {
          cmd.validity = "blocked";
          cmd.invalidReason = "设备掉线或读数缺失，禁止自动开启，等待值班员复核";
        } else {
          cmd.validity = "valid";
          cmd.invalidReason = null;
          cmd.basisEventIds = openBreaches.map(e => e.id);
        }
      } else {
        // 已进入人工流程的指令：依据被重判掉时只标记失效，绝不自动关闭风机
        cmd.blockers = blockers;
        const lost = cmd.basisEventIds.filter(id => !db.events.some(e => e.id === id));
        if (lost.length) {
          cmd.validity = "invalid";
          cmd.invalidReason = "触发指令的事件经更正重判后不存在，需人工复核";
        } else if (basisOpen.length === 0 && cmd.basisEventIds.length > 0) {
          cmd.validity = "invalid";
          cmd.invalidReason = "触发事件已解除，等待换人确认关闭";
        }
      }
    }

    // 条件齐备才生成自动建议；有任何在途指令则不重复生成
    if (openBreaches.length && blockers.length === 0 && commands.length === 0) {
      const cmd = {
        id: newId("cmd"),
        shed,
        action: "fan_on",
        kind: "auto",
        status: "draft",
        basisEventIds: openBreaches.map(e => e.id),
        blockers: [],
        validity: "valid",
        invalidReason: null,
        createdAt: nowIso(),
        createActor: "system",
        issuedBy: null, issuedAt: null,
        requestedCloseBy: null, requestedCloseAt: null,
        closeConfirmedBy: null, closedAt: null, closeReason: null
      };
      db.commands.push(cmd);
      record(db, silent, actor, "command_propose", { commandId: cmd.id, shed, basisEventIds: cmd.basisEventIds });
    }
  }
}

// 人工下发：值班员复核。自动建议转“已下发”，或在阻塞时强制人工下发（须确认风险）
export function issueCommand(db, { id, actor, override = false, reason = "" }) {
  const cmd = db.commands.find(c => c.id === id);
  if (!cmd) return { error: "command_not_found" };
  if (cmd.status !== "draft") return { error: "command_not_draft" };
  const blockers = shedBlockers(db, cmd.shed);
  if (cmd.kind === "auto" && blockers.length && !override) {
    return { error: "command_blocked", blockers };
  }
  cmd.status = "issued";
  cmd.issuedBy = actor;
  cmd.issuedAt = nowIso();
  cmd.blockers = blockers;
  if (override && blockers.length) {
    cmd.kind = "manual";
    cmd.override = true;
    cmd.reason = reason || "值班员复核后强制下发";
    cmd.validity = "override";
    cmd.invalidReason = null;
  }
  log(db, "command_issue", actor, { commandId: cmd.id, shed: cmd.shed, override: !!override });
  return { command: cmd };
}

// 人工直接起草并下发（含阻塞情况下的强制下发）
export function manualIssue(db, { shed, actor, reason, override }) {
  if (activeCommands(db, shed).length) return { error: "shed_command_active" };
  const blockers = shedBlockers(db, shed);
  if (blockers.length && !override) return { error: "command_requires_override", blockers };
  const openBreaches = db.events.filter(e => e.shed === shed && e.kind === "breach" && e.status === "open");
  const cmd = {
    id: newId("cmd"),
    shed, action: "fan_on",
    kind: "manual",
    status: "issued",
    basisEventIds: openBreaches.map(e => e.id),
    blockers,
    validity: blockers.length ? "override" : "valid",
    invalidReason: blockers.length ? "设备掉线或读数缺失，值班员复核后强制下发" : null,
    override: blockers.length > 0,
    reason: reason || (blockers.length ? "值班员复核后强制下发" : "值班员复核下发"),
    createdAt: nowIso(), createActor: actor,
    issuedBy: actor, issuedAt: nowIso(),
    requestedCloseBy: null, requestedCloseAt: null,
    closeConfirmedBy: null, closedAt: null, closeReason: null
  };
  db.commands.push(cmd);
  log(db, "command_manual_issue", actor, { commandId: cmd.id, shed, blocked: blockers.length > 0 });
  return { command: cmd };
}

// 换人流程：下发人 A → 另一人申请关闭 → 再由第三人确认关闭（确认人不得为前两人）
export function actCommand(db, id, action, actor) {
  const cmd = db.commands.find(c => c.id === id);
  if (!cmd) return { error: "command_not_found" };
  if (action === "request_close") {
    if (cmd.status !== "issued") return { error: "command_not_issued" };
    if (actor === cmd.issuedBy) return { error: "must_be_different_person", detail: "申请关闭人不能与下发人相同" };
    cmd.status = "close_requested";
    cmd.requestedCloseBy = actor;
    cmd.requestedCloseAt = nowIso();
    log(db, "command_request_close", actor, { commandId: cmd.id, shed: cmd.shed });
    return { command: cmd };
  }
  if (action === "confirm_close") {
    if (cmd.status !== "close_requested") return { error: "close_not_requested" };
    if (actor === cmd.issuedBy || actor === cmd.requestedCloseBy) {
      return { error: "must_be_different_person", detail: "确认关闭必须换人，不能与下发人或申请关闭人相同" };
    }
    cmd.status = "closed";
    cmd.closeConfirmedBy = actor;
    cmd.closedAt = nowIso();
    cmd.closeReason = "confirmed_closed";
    cmd.validity = cmd.validity === "invalid" ? "invalid_closed" : "closed";
    log(db, "command_confirm_close", actor, { commandId: cmd.id, shed: cmd.shed });
    syncFanForSheds(db, [cmd.shed], { actor });
    return { command: cmd };
  }
  if (action === "cancel_draft") {
    if (cmd.status !== "draft") return { error: "command_not_draft" };
    cmd.status = "closed";
    cmd.closedAt = nowIso();
    cmd.closeReason = "draft_cancelled";
    log(db, "command_cancel_draft", actor, { commandId: cmd.id, shed: cmd.shed });
    return { command: cmd };
  }
  return { error: "unknown_action" };
}

export function pointState(db, pointId) {
  const point = db.points.find(p => p.id === pointId);
  if (!point) return null;
  const latest = latestCurrent(db, pointId);
  const offline = !latest || new Date().getTime() - new Date(latest.receivedAt).getTime() > OFFLINE_MS;
  const evaluation = latest && isComplete(latest) ? evalReading(latest.values, point.thresholds || {}) : null;
  return {
    ...point,
    thresholds: thresholdsFor(point),
    lastSeen: latest?.receivedAt || null,
    online: !offline,
    offline,
    latest: latest ? {
      readingId: latest.id,
      sampledAt: latest.sampledAt,
      receivedAt: latest.receivedAt,
      source: latest.source,
      values: latest.values,
      complete: isComplete(latest),
      version: latest.version
    } : null,
    complete: latest ? isComplete(latest) : false,
    evaluation: evaluation ? {
      values: evaluation.values,
      violations: evaluation.violations
    } : null,
    openEvents: db.events.filter(e => e.pointId === pointId && e.status === "open")
  };
}

// 更正后重判：归档旧事件 → 用现行读数版本链重放 → 重建事件 → 修正指令依据
export function rebuildPoint(db, pointId, actor) {
  const point = db.points.find(p => p.id === pointId);
  if (!point) return { error: "point_not_found" };
  const oldEvents = db.events.filter(e => e.pointId === pointId);

  // 旧版本事件全部留档
  for (const ev of oldEvents) {
    archiveEventSnapshot(db, ev, "reading_corrected", actor);
  }
  db.events = db.events.filter(e => e.pointId !== pointId);

  // 旧事件 id → 新事件 id 的映射（按自然键，只收本次重放真正新建的事件）
  const originMap = new Map();
  for (const ev of oldEvents) originMap.set(ev.key, ev.id);
  const idMap = new Map();
  const oldIds = new Set(oldEvents.map(e => e.id));

  const docs = currentReadings(db, pointId);
  for (const doc of docs) {
    const freshIds = new Set(db.events.map(e => e.id));
    processReading(db, doc, { silent: true, noFanSync: true, actor, originMap });
    for (const ev of db.events) {
      if (!freshIds.has(ev.id) && ev.replayedFromId) idMap.set(ev.replayedFromId, ev.id);
    }
  }

  // 修正引用该测点事件的指令依据；丢失依据的已下发指令只标失效，不自动关风机
  for (const cmd of db.commands) {
    if (!cmd.basisEventIds.some(id => oldIds.has(id))) continue;
    const remapped = [];
    let lost = 0;
    for (const id of cmd.basisEventIds) {
      if (!oldIds.has(id)) { remapped.push(id); continue; }
      if (idMap.has(id)) remapped.push(idMap.get(id));
      else lost += 1;
    }
    cmd.basisEventIds = remapped;
    if (lost > 0 && cmd.status !== "draft") {
      cmd.validity = "invalid";
      cmd.invalidReason = "读数更正重判后，原触发事件不存在，需人工复核（未自动关闭风机）";
      log(db, "command_invalidated_by_correction", actor, { commandId: cmd.id, pointId });
    }
  }

  sweepOffline(db, { silent: true, noFanSync: true, actor });
  syncFanForSheds(db, [...new Set(db.points.map(p => p.shed))], { silent: true, actor });
  log(db, "point_rebuilt", actor, { pointId, archivedEvents: oldEvents.length, replayedReadings: docs.length });
  return { point: pointState(db, pointId), archived: oldEvents.length, replayed: docs.length };
}
