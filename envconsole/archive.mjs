// 存档层：负责持久化、版本留档与审计台账，只做存取，不做业务判定。
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "..", "data", "envconsole.json");

export function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function defaultDb() {
  return {
    points: [], // 测点：棚号、测点、设备号、阈值
    readings: [], // 读数版本链（每次上报/更正一条，isCurrent 指向现行版本）
    events: [], // 现行事件（越界/缺测/掉线，未结或已结）
    eventHistory: [], // 事件旧版本快照（读数更正重判后留档）
    commands: [], // 风机指令：建议→下发→申请关闭→确认关闭
    audit: [], // 只追加审计台账
    seq: 0
  };
}

export async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    const db = defaultDb();
    await writeFile(dbPath, JSON.stringify(db, null, 2));
    return db;
  }
  return JSON.parse(await readFile(dbPath, "utf8"));
}

export async function saveDb(db) {
  await writeFile(dbPath, JSON.stringify(db, null, 2));
}

// 只追加，不修改、不删除
export function log(db, type, actor = "system", payload = {}) {
  db.seq += 1;
  db.audit.push({
    seq: db.seq,
    id: newId("au"),
    at: new Date().toISOString(),
    type,
    actor,
    payload
  });
}

// 读数旧版本留档（原地标记，另插新版本）
export function archiveReadingVersion(db, oldDoc) {
  oldDoc.isCurrent = false;
  return oldDoc;
}

// 事件整组重判前，把旧事件快照存入 eventHistory
export function archiveEventSnapshot(db, event, reason, actor) {
  db.eventHistory.push({
    ...event,
    archivedAt: new Date().toISOString(),
    archiveReason: reason,
    archiveActor: actor
  });
}
