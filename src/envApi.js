import { saveDb, archive } from "./store.js";
import { THRESHOLDS, STALE_MINUTES, latestReading, readingProblems, violationsOf, rejudgePoint, proposeCommand, newId } from "./judge.js";
import { body, sendJson } from "./http.js";

// 请求入口：只负责解析请求、调用判定、落库；业务规则在 judge.js，存取在 store.js

const numOrNull = value => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
};

function enrichPoint(db, point) {
  const reading = latestReading(db, point.id);
  return {
    ...point,
    latestReading: reading,
    problems: readingProblems(reading),
    openEvents: db.env.events.filter(e => e.pointId === point.id && e.status === "open").length
  };
}

export async function handleEnvApi(req, res, url, db) {
  if (req.method === "GET" && url.pathname === "/api/env/overview") {
    sendJson(res, 200, {
      thresholds: THRESHOLDS,
      staleMinutes: STALE_MINUTES,
      points: db.env.points.map(p => enrichPoint(db, p)),
      readings: db.env.readings.slice(0, 100),
      events: db.env.events,
      commands: db.env.commands,
      archives: db.env.archives.slice(0, 50)
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/env/points") {
    const input = await body(req);
    if (!input.loft || !input.name || !input.deviceNo) { sendJson(res, 400, { error: "missing_fields" }); return true; }
    if (db.env.points.some(p => p.deviceNo === input.deviceNo)) { sendJson(res, 409, { error: "device_exists" }); return true; }
    const point = { id: newId("pt"), loft: input.loft, name: input.name, deviceNo: input.deviceNo, fanStatus: "off", createdAt: new Date().toISOString() };
    db.env.points.push(point);
    await saveDb(db);
    sendJson(res, 201, point);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/env/readings") {
    const input = await body(req);
    const point = db.env.points.find(p => p.id === input.pointId);
    if (!point) { sendJson(res, 404, { error: "point_not_found" }); return true; }
    const reading = {
      id: newId("rd"), pointId: point.id, deviceNo: input.deviceNo || point.deviceNo,
      temperature: numOrNull(input.temperature), humidity: numOrNull(input.humidity), ammonia: numOrNull(input.ammonia),
      sampledAt: input.sampledAt || new Date().toISOString(), receivedAt: new Date().toISOString(),
      deviceStatus: input.deviceStatus === "offline" ? "offline" : "online",
      version: 1, status: "active"
    };
    db.env.readings.unshift(reading);
    const changes = rejudgePoint(db, point, "新读数入库");
    await saveDb(db);
    sendJson(res, 201, { reading, problems: readingProblems(reading), changes });
    return true;
  }

  const correctMatch = url.pathname.match(/^\/api\/env\/readings\/([^/]+)\/correct$/);
  if (req.method === "POST" && correctMatch) {
    const reading = db.env.readings.find(r => r.id === decodeURIComponent(correctMatch[1]));
    if (!reading) { sendJson(res, 404, { error: "reading_not_found" }); return true; }
    if (reading.status !== "active") { sendJson(res, 409, { error: "already_superseded" }); return true; }
    const input = await body(req);
    const point = db.env.points.find(p => p.id === reading.pointId);

    // 旧版本保留在 readings 中（status=superseded），同时写入留档
    const oldVersion = { ...reading };
    reading.status = "superseded";
    reading.supersededAt = new Date().toISOString();
    const corrected = {
      id: newId("rd"), pointId: reading.pointId, deviceNo: reading.deviceNo,
      temperature: numOrNull(input.temperature), humidity: numOrNull(input.humidity), ammonia: numOrNull(input.ammonia),
      sampledAt: reading.sampledAt, receivedAt: new Date().toISOString(),
      deviceStatus: reading.deviceStatus, version: reading.version + 1,
      corrects: reading.id, correctedBy: input.correctedBy || "未署名", correctionReason: input.reason || "",
      status: "active"
    };
    db.env.readings.unshift(corrected);
    archive(db, {
      type: "reading_correction", pointId: point.id, readingId: reading.id,
      oldVersion, newVersion: { ...corrected }, by: corrected.correctedBy, reason: corrected.correctionReason
    });

    // 按新值重判事件和指令
    const changes = rejudgePoint(db, point, "读数更正 v" + oldVersion.version + "→v" + corrected.version);
    await saveDb(db);
    sendJson(res, 200, { reading: corrected, changes });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/env/commands") {
    const input = await body(req);
    const point = db.env.points.find(p => p.id === input.pointId);
    if (!point) { sendJson(res, 404, { error: "point_not_found" }); return true; }
    if (!["fan_on", "fan_off"].includes(input.action)) { sendJson(res, 400, { error: "bad_action" }); return true; }
    const reading = latestReading(db, point.id);
    // 设备掉线或读数缺失时，风机不能自动开启
    if (input.action === "fan_on") {
      const problems = readingProblems(reading);
      if (problems.length) { sendJson(res, 409, { error: "fan_on_blocked", problems }); return true; }
    }
    const changes = { proposed: [] };
    const command = proposeCommand(db, point, input.action, reading, violationsOf(reading), changes, input.requestedBy || "值班员");
    await saveDb(db);
    sendJson(res, 201, command);
    return true;
  }

  const commandMatch = url.pathname.match(/^\/api\/env\/commands\/([^/]+)\/(review|close)$/);
  if (req.method === "POST" && commandMatch) {
    const command = db.env.commands.find(c => c.id === decodeURIComponent(commandMatch[1]));
    if (!command) { sendJson(res, 404, { error: "command_not_found" }); return true; }
    const input = await body(req);
    const point = db.env.points.find(p => p.id === command.pointId);

    if (commandMatch[2] === "review") {
      // 值班员复核后才下发；复核时再次校验读数可用性
      if (command.status !== "pending") { sendJson(res, 409, { error: "not_pending" }); return true; }
      if (command.action === "fan_on") {
        const problems = readingProblems(latestReading(db, point.id));
        if (problems.length) { sendJson(res, 409, { error: "fan_on_blocked", problems }); return true; }
      }
      if (!input.reviewedBy) { sendJson(res, 400, { error: "missing_reviewed_by" }); return true; }
      command.status = "issued";
      command.reviewedBy = input.reviewedBy;
      command.reviewedAt = new Date().toISOString();
      point.fanStatus = command.action === "fan_on" ? "on" : "off";
      command.history.push({ at: new Date().toISOString(), note: command.reviewedBy + " 复核通过，指令下发" });
    } else {
      // 换人确认关闭：确认人不得与复核人相同
      if (command.status !== "issued") { sendJson(res, 409, { error: "not_issued" }); return true; }
      if (!input.closedBy) { sendJson(res, 400, { error: "missing_closed_by" }); return true; }
      if (input.closedBy === command.reviewedBy) { sendJson(res, 409, { error: "different_operator_required" }); return true; }
      command.status = "closed";
      command.closedBy = input.closedBy;
      command.closedAt = new Date().toISOString();
      command.history.push({ at: new Date().toISOString(), note: command.closedBy + " 换人确认，指令关闭" });
      archive(db, { type: "command_closed", commandId: command.id, pointId: command.pointId, action: command.action, reviewedBy: command.reviewedBy, closedBy: command.closedBy });
    }
    await saveDb(db);
    sendJson(res, 200, command);
    return true;
  }

  return false;
}
