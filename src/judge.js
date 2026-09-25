import { archive } from "./store.js";

// 判定模块：阈值、读数可用性、越界事件、风机指令与更正重判

export const THRESHOLDS = {
  temperature: { label: "温度", unit: "℃", min: 5, max: 30 },
  humidity: { label: "湿度", unit: "%", min: 40, max: 80 },
  ammonia: { label: "氨气", unit: "ppm", min: 0, max: 20 }
};
export const STALE_MINUTES = 30; // 采样时刻超过 30 分钟视为读数不可用

const now = () => new Date().toISOString();
export const newId = prefix => prefix + "-" + Math.random().toString(36).slice(2, 8);

export function latestReading(db, pointId) {
  const list = db.env.readings.filter(r => r.pointId === pointId && r.status === "active");
  list.sort((a, b) => (b.sampledAt + b.receivedAt).localeCompare(a.sampledAt + a.receivedAt));
  return list[0] || null;
}

// 读数可用性：无读数、设备掉线、指标缺失、采样超期都算不可用
export function readingProblems(reading, at = new Date()) {
  if (!reading) return ["no_reading"];
  const problems = [];
  if (reading.deviceStatus === "offline") problems.push("device_offline");
  for (const metric of Object.keys(THRESHOLDS)) {
    const value = reading[metric];
    if (value === null || value === undefined || Number.isNaN(Number(value))) problems.push("missing_" + metric);
  }
  const age = (at - new Date(reading.sampledAt)) / 60000;
  if (Number.isNaN(age)) problems.push("bad_sample_time");
  else if (age > STALE_MINUTES) problems.push("stale");
  return problems;
}

export function violationsOf(reading) {
  const out = [];
  if (!reading || reading.deviceStatus === "offline") return out;
  for (const [metric, rule] of Object.entries(THRESHOLDS)) {
    const value = reading[metric];
    if (value === null || value === undefined || Number.isNaN(Number(value))) continue;
    if (value < rule.min) out.push({ metric, value, limit: rule.min, direction: "low" });
    if (value > rule.max) out.push({ metric, value, limit: rule.max, direction: "high" });
  }
  return out;
}

// 任一指标超上限即需要通风
const needsFan = violations => violations.some(v => v.direction === "high");

function closeEvent(db, event, reading, reason) {
  event.status = "closed";
  event.closedAt = now();
  event.history.push({ at: now(), note: "读数恢复正常，事件办结（" + reason + "）", value: reading ? reading[event.metric] : null });
  archive(db, { type: "event_closed", eventId: event.id, pointId: event.pointId, metric: event.metric, reason });
}

// 同一测点同一指标已有未结事件则并入，否则生成新的未结事件
function recordViolation(db, point, violation, reading, changes) {
  const open = db.env.events.find(e => e.pointId === point.id && e.metric === violation.metric && e.status === "open");
  if (open) {
    open.readingIds.push(reading.id);
    open.lastValue = violation.value;
    open.lastAt = reading.sampledAt;
    open.count += 1;
    open.history.push({ at: now(), note: "同一测点连续越界，并入原事件", value: violation.value });
    changes.merged.push(open.id);
    return;
  }
  const event = {
    id: newId("ev"), pointId: point.id, loft: point.loft, pointName: point.name,
    metric: violation.metric, direction: violation.direction, limit: violation.limit,
    status: "open", firstValue: violation.value, lastValue: violation.value, count: 1,
    readingIds: [reading.id], openedAt: reading.sampledAt, lastAt: reading.sampledAt, closedAt: null,
    history: [{ at: now(), note: "读数越界，生成未结事件", value: violation.value }]
  };
  db.env.events.unshift(event);
  changes.opened.push(event.id);
}

export function proposeCommand(db, point, action, reading, violations, changes, requestedBy = "system") {
  const dup = db.env.commands.find(c => c.pointId === point.id && c.action === action && c.status === "pending");
  if (dup) return dup;
  const command = {
    id: newId("cmd"), pointId: point.id, loft: point.loft, pointName: point.name,
    action, status: "pending",
    requestedBy, reviewedBy: null, reviewedAt: null, closedBy: null, closedAt: null,
    basis: reading
      ? { readingId: reading.id, version: reading.version, temperature: reading.temperature, humidity: reading.humidity, ammonia: reading.ammonia, sampledAt: reading.sampledAt, violations }
      : null,
    createdAt: now(),
    history: [{ at: now(), note: (requestedBy === "system" ? "系统按判定生成" : requestedBy + " 发起") + "待复核指令：" + (action === "fan_on" ? "开启风机" : "关闭风机") }]
  };
  db.env.commands.unshift(command);
  changes.proposed.push(command.id);
  return command;
}

function cancelCommand(db, command, reason, changes) {
  command.status = "cancelled";
  command.history.push({ at: now(), note: "重判后依据消失，指令撤销：" + reason });
  archive(db, { type: "command_cancelled", commandId: command.id, pointId: command.pointId, action: command.action, reason });
  changes.cancelled.push(command.id);
}

// 重判入口：新读数入库或读数更正后调用，事件和指令全部按当前最新值重新判定
export function rejudgePoint(db, point, reason) {
  const changes = { opened: [], merged: [], closed: [], proposed: [], cancelled: [], fanOnBlocked: false };
  const reading = latestReading(db, point.id);
  const violations = violationsOf(reading);
  const problems = readingProblems(reading);

  // 有该指标的可信正常值时，办结对应未结事件；掉线或缺失不办结
  for (const event of db.env.events.filter(e => e.pointId === point.id && e.status === "open")) {
    const value = reading ? reading[event.metric] : null;
    const valid = reading && reading.deviceStatus !== "offline" && value !== null && value !== undefined && !Number.isNaN(Number(value));
    if (valid && !violations.some(v => v.metric === event.metric)) {
      closeEvent(db, event, reading, reason);
      changes.closed.push(event.id);
    }
  }
  for (const violation of violations) recordViolation(db, point, violation, reading, changes);

  // 风机指令：设备掉线或读数缺失时禁止自动开启
  const high = needsFan(violations);
  const usable = problems.length === 0;
  if (high && point.fanStatus !== "on") {
    if (usable) {
      proposeCommand(db, point, "fan_on", reading, violations, changes);
    } else {
      changes.fanOnBlocked = true;
      archive(db, { type: "fan_on_blocked", pointId: point.id, readingId: reading.id, problems });
    }
  }
  if (!high && point.fanStatus === "on" && usable) {
    proposeCommand(db, point, "fan_off", reading, violations, changes);
  }

  // 更正后依据消失/重现：撤销仍待复核的相反指令
  for (const command of db.env.commands.filter(c => c.pointId === point.id && c.status === "pending")) {
    if (command.action === "fan_on" && !high) cancelCommand(db, command, "越界已消除（" + reason + "）", changes);
    if (command.action === "fan_off" && high) cancelCommand(db, command, "仍存在越界（" + reason + "）", changes);
  }
  return changes;
}
