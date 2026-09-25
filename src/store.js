import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH || join(__dirname, "..", "data", "pigeons.json");

const seed = {
  pigeons: [
    { ringNo: "CHN-2026-001", owner: "北岸棚", fatherRing: "CHN-2022-188", motherRing: "CHN-2023-512", color: "灰", loft: "北岸A棚", vaccines: [{ date: "2026-04-01", name: "新城疫" }], transfers: [{ date: "2026-04-15", from: "育种棚", to: "北岸棚" }], races: [{ date: "2026-06-01", event: "120公里训放", distance: 120, returnTime: "10:42", rank: 18 }] },
    { ringNo: "CHN-2022-188", owner: "育种棚", fatherRing: "", motherRing: "", color: "雨点", loft: "种鸽棚", vaccines: [], transfers: [], races: [] },
    { ringNo: "CHN-2023-512", owner: "育种棚", fatherRing: "", motherRing: "", color: "红轮", loft: "种鸽棚", vaccines: [], transfers: [], races: [] }
  ],
  env: {
    points: [
      { id: "pt-north-1", loft: "北岸A棚", name: "北侧1号测点", deviceNo: "ENV-N1-001", fanStatus: "off", createdAt: "2026-09-20T08:00:00.000Z" },
      { id: "pt-breed-1", loft: "种鸽棚", name: "种鸽棚1号测点", deviceNo: "ENV-B1-001", fanStatus: "off", createdAt: "2026-09-20T08:00:00.000Z" }
    ],
    readings: [],
    events: [],
    commands: [],
    archives: []
  }
};

export async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  const db = JSON.parse(await readFile(dbPath, "utf8"));
  if (!db.env) db.env = JSON.parse(JSON.stringify(seed.env));
  for (const key of ["points", "readings", "events", "commands", "archives"]) db.env[key] ||= [];
  return db;
}

export async function saveDb(db) {
  await writeFile(dbPath, JSON.stringify(db, null, 2));
}

// 留档：更正旧版本、事件办结、指令撤销/关闭、禁止自动开风机都写进 archives
export function archive(db, entry) {
  db.env.archives.unshift({ id: "arc-" + Math.random().toString(36).slice(2, 8), at: new Date().toISOString(), ...entry });
}
