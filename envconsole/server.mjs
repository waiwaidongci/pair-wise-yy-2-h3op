// 请求入口层：HTTP 路由、入参解析与校验、编排存档层/判定层。
// 业务判定规则全部在 judge.mjs，本文件不包含阈值与联锁逻辑。
import http from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDb, saveDb, newId, log, archiveReadingVersion } from "./archive.mjs";
import {
  METRICS, pointState, processReading, sweepOffline,
  issueCommand, manualIssue, actCommand, rebuildPoint,
  shedBlockers, nowIso, DEFAULT_THRESHOLDS
} from "./judge.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3025);

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function bad(res, error, extra = {}, status = 400) {
  return sendJson(res, status, { error, ...extra });
}
function normMetric(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function parseIso(v, fallback) {
  if (!v) return fallback;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// 首次启动的演示数据：A棚 A1 正常、A2 氨气越界（产生自动建议）；B棚 B1 掉线
async function seedIfEmpty(db) {
  if (db.points.length) return;
  const makePoint = (shed, name, deviceNo) => ({ id: newId("pt"), shed, name, deviceNo, thresholds: {}, createdAt: nowIso() });
  const a1 = makePoint("A棚", "A棚·东测点", "DEV-A1");
  const a2 = makePoint("A棚", "A棚·西测点", "DEV-A2");
  const b1 = makePoint("B棚", "B棚·中测点", "DEV-B1");
  db.points.push(a1, a2, b1);

  const doc = (point, values, ageMs) => ({
    id: newId("rd"), pointId: point.id, deviceNo: point.deviceNo,
    values, sampledAt: new Date(Date.now() - ageMs).toISOString(),
    receivedAt: new Date(Date.now() - ageMs).toISOString(),
    source: "device", isCurrent: true, version: 1
  });
  processReading(db, doc(a1, { temp: 22.4, hum: 58, nh3: 6 }, 3 * 60 * 1000), { silent: true, actor: "system" });
  processReading(db, doc(a2, { temp: 27.1, hum: 71, nh3: 26.4 }, 2 * 60 * 1000), { silent: true, actor: "system" });
  processReading(db, doc(b1, { temp: 21.0, hum: 55, nh3: 8 }, 30 * 60 * 1000), { silent: true, actor: "system" });
  sweepOffline(db, { silent: true, actor: "system" });
  log(db, "seed", "system", { points: 3 });
  await saveDb(db);
}

function buildState(db) {
  const sheds = [...new Set(db.points.map(p => p.shed))];
  return {
    sheds,
    points: db.points.map(p => pointState(db, p.id)),
    events: db.events,
    commands: db.commands.map(c => ({ ...c, blockersNow: shedBlockers(db, c.shed) })),
    thresholds: DEFAULT_THRESHOLDS,
    offlineMs: 15 * 60 * 1000
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;

    if (req.method === "GET" && p === "/") {
      const html = await readFile(join(__dirname, "..", "public", "index.html"), "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
    }

    const db = await loadDb();
    await seedIfEmpty(db);

    // ---------- 总览 ----------
    if (req.method === "GET" && p === "/api/state") return sendJson(res, 200, buildState(db));

    // ---------- 测点登记 ----------
    if (req.method === "POST" && p === "/api/points") {
      const input = await body(req);
      const shed = String(input.shed || "").trim();
      const name = String(input.name || "").trim();
      const deviceNo = String(input.deviceNo || "").trim();
      if (!shed || !name || !deviceNo) return bad(res, "point_fields_required");
      if (db.points.some(x => x.deviceNo === deviceNo)) return bad(res, "device_no_exists", {}, 409);
      const thresholds = {};
      for (const m of METRICS) {
        const t = input.thresholds?.[m];
        if (t && (t.min !== undefined || t.max !== undefined)) {
          thresholds[m] = { min: t.min !== undefined ? Number(t.min) : DEFAULT_THRESHOLDS[m].min, max: t.max !== undefined ? Number(t.max) : DEFAULT_THRESHOLDS[m].max };
        }
      }
      const point = { id: newId("pt"), shed, name, deviceNo, thresholds, createdAt: nowIso() };
      db.points.push(point);
      log(db, "point_register", input.actor || "值班员", { pointId: point.id, shed, name, deviceNo });
      await saveDb(db);
      return sendJson(res, 201, pointState(db, point.id));
    }

    // ---------- 读数上报（请求入口）----------
    if (req.method === "POST" && p === "/api/readings") {
      const input = await body(req);
      const deviceNo = String(input.deviceNo || "").trim();
      if (!deviceNo) return bad(res, "device_no_required");
      const point = db.points.find(x => x.deviceNo === deviceNo);
      if (!point) return bad(res, "device_not_registered", {}, 404);

      const rawValues = input.values || { temp: input.temp, hum: input.hum, nh3: input.nh3 };
      const values = {};
      for (const m of METRICS) values[m] = normMetric(rawValues?.[m]);
      const sampledAt = parseIso(input.sampledAt, nowIso());
      if (input.sampledAt && !sampledAt) return bad(res, "bad_sampled_at");

      const doc = {
        id: newId("rd"), pointId: point.id, deviceNo, values,
        sampledAt, receivedAt: nowIso(),
        source: input.source || "device",
        reporter: input.actor || "device",
        isCurrent: true, version: 1,
        correctionOf: null
      };
      log(db, "reading_received", doc.reporter, { readingId: doc.id, deviceNo, values, sampledAt });
      processReading(db, doc, { actor: doc.reporter });
      sweepOffline(db, { actor: doc.reporter });
      await saveDb(db);
      return sendJson(res, 201, { reading: doc, point: pointState(db, point.id) });
    }

    // ---------- 读数更正：旧版本留档 + 事件/指令按新值重判 ----------
    const correctMatch = p.match(/^\/api\/readings\/([^/]+)\/correct$/);
    if (correctMatch && req.method === "POST") {
      const input = await body(req);
      const actor = String(input.actor || "").trim();
      if (!actor) return bad(res, "actor_required");
      const original = db.readings.find(r => r.id === correctMatch[1]);
      if (!original) return bad(res, "reading_not_found", {}, 404);
      const rawValues = input.values || { temp: input.temp, hum: input.hum, nh3: input.nh3 };
      const values = {};
      for (const m of METRICS) values[m] = normMetric(rawValues?.[m]);
      if (METRICS.every(m => values[m] === null)) return bad(res, "correction_values_required");

      archiveReadingVersion(db, original);
      const corrected = {
        id: newId("rd"), pointId: original.pointId, deviceNo: original.deviceNo,
        values, sampledAt: parseIso(input.sampledAt, original.sampledAt),
        receivedAt: nowIso(), source: original.source, reporter: original.reporter,
        isCurrent: true, version: original.version + 1,
        correctionOf: original.id,
        correctedBy: actor, correctionReason: input.reason || "",
        correctionNote: { oldValues: original.values }
      };
      db.readings.push(corrected);
      log(db, "reading_corrected", actor, {
        readingId: corrected.id, correctedFrom: original.id,
        oldValues: original.values, newValues: values, reason: input.reason || ""
      });
      const result = rebuildPoint(db, original.pointId, actor);
      await saveDb(db);
      return sendJson(res, 200, { corrected, ...result });
    }

    // ---------- 读数版本链（含留档旧版本）----------
    if (req.method === "GET" && p === "/api/readings") {
      const pointId = url.searchParams.get("pointId");
      const deviceNo = url.searchParams.get("deviceNo");
      let list = db.readings;
      if (pointId) list = list.filter(r => r.pointId === pointId);
      if (deviceNo) list = list.filter(r => r.deviceNo === deviceNo);
      list = [...list].sort((a, b) => b.sampledAt.localeCompare(a.sampledAt) || b.version - a.version);
      return sendJson(res, 200, list);
    }

    // ---------- 事件 ----------
    if (req.method === "GET" && p === "/api/events") {
      const status = url.searchParams.get("status");
      let list = [...db.events].sort((a, b) => b.lastAt.localeCompare(a.lastAt));
      if (status) list = list.filter(e => e.status === status);
      return sendJson(res, 200, list);
    }

    // ---------- 事件旧版本存档 ----------
    if (req.method === "GET" && p === "/api/event-history") {
      return sendJson(res, 200, [...db.eventHistory].sort((a, b) => b.archivedAt.localeCompare(a.archivedAt)));
    }

    // ---------- 指令 ----------
    if (req.method === "GET" && p === "/api/commands") return sendJson(res, 200, db.commands);

    if (req.method === "POST" && p === "/api/commands/manual") {
      const input = await body(req);
      if (!input.actor) return bad(res, "actor_required");
      const result = manualIssue(db, {
        shed: String(input.shed || "").trim(),
        actor: String(input.actor).trim(),
        reason: String(input.reason || ""),
        override: !!input.override
      });
      if (result.error) return bad(res, result.error, { blockers: result.blockers || [] }, result.error === "shed_command_active" ? 409 : 412);
      await saveDb(db);
      return sendJson(res, 201, result.command);
    }

    const cmdMatch = p.match(/^\/api\/commands\/([^/]+)\/(issue|action)$/);
    if (cmdMatch && req.method === "POST") {
      const input = await body(req);
      if (!input.actor) return bad(res, "actor_required");
      let result;
      if (cmdMatch[2] === "issue") {
        result = issueCommand(db, {
          id: cmdMatch[1], actor: String(input.actor).trim(),
          override: !!input.override, reason: String(input.reason || "")
        });
      } else {
        result = actCommand(db, cmdMatch[1], String(input.action || ""), String(input.actor).trim());
      }
      if (result.error) {
        const status = ["command_not_found", "reading_not_found"].includes(result.error) ? 404
          : ["must_be_different_person"].includes(result.error) ? 409 : 412;
        return bad(res, result.error, { detail: result.detail || "", blockers: result.blockers || [] }, status);
      }
      await saveDb(db);
      return sendJson(res, 200, result.command);
    }

    // ---------- 掉线扫描 / 审计台账 ----------
    if (req.method === "POST" && p === "/api/sweep") {
      const input = await body(req);
      sweepOffline(db, { actor: input.actor || "值班员" });
      await saveDb(db);
      return sendJson(res, 200, buildState(db));
    }
    if (req.method === "GET" && p === "/api/audit") {
      return sendJson(res, 200, [...db.audit].sort((a, b) => b.seq - a.seq).slice(0, 300));
    }

    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(port, () => console.log(`Loft environment console listening on http://localhost:${port}`));
