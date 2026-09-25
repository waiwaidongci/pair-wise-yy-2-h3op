# 赛鸽应用

## 1. 赛鸽血统环号登记站（端口 3024）

```bash
npm start
```

访问 `http://localhost:3024`。支持档案、血统查询、转让和归巢成绩记录。

## 2. 鸽舍环控监测台（端口 3025）

解决电话报温湿度、氨气升高难及时发现的问题。

```bash
npm run console
```

访问 `http://localhost:3025`。数据存于 `data/envconsole.json`（删除后重启会重建演示数据）。

### 分层结构（请求入口 / 判定 / 存档分开）

| 文件 | 职责 |
| --- | --- |
| `envconsole/server.mjs` | **请求入口**：HTTP 路由、入参校验、编排；不含业务规则 |
| `envconsole/judge.mjs` | **判定**：阈值越界、事件生命周期、掉线扫描、风机联锁、更正重判 |
| `envconsole/archive.mjs` | **存档**：JSON 持久化、读数旧版本标记、事件旧版本快照、只追加审计台账 |
| `public/index.html` | 页面：测点 / 事件 / 指令 / 存档 四个视图 |

### 业务规则

- **测点登记**：每棚每测点登记设备号；读数含温度、湿度、氨气、采样时刻（支持电话补录、缺项上报）。
- **未结事件**：读数越界生成未结事件；同一测点连续越界上报并入原事件（不重复开单）；恢复正常自动结事件。读数缺失生成“缺测事件”，超时 15 分钟无上报生成“掉线事件”。
- **风机联锁**：设备掉线或读数缺失时**禁止自动开启**风机，系统只生成“待复核建议”；值班员复核后才可下发，可勾选强制（人工担责）。关闭须换人：下发人 A → 另一人 B 申请关闭 → 第三人 C 确认关闭。
- **更正重判**：读数更正后旧版本留档（`isCurrent=false`），按新值重放该测点全部现行读数重建事件，旧事件整组快照进“事件旧版本”；引用旧事件的指令自动改挂新事件，依据消失时只标“依据失效”，**绝不自动关闭风机**。
- 默认阈值：温度 5–30℃、湿度 40–75%RH、氨气 0–20ppm（可按测点覆盖）。

### 主要接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/points` | 登记测点（shed/name/deviceNo） |
| POST | `/api/readings` | 上报读数（deviceNo + temp/hum/nh3，可缺项） |
| POST | `/api/readings/:id/correct` | 更正读数并重判（actor 必填） |
| GET | `/api/readings` | 读数版本链（含旧版本） |
| GET | `/api/events`、`/api/event-history` | 现行事件 / 旧版本事件 |
| POST | `/api/commands/manual` | 值班员人工下发（override=true 可强制） |
| POST | `/api/commands/:id/issue` | 复核下发自动建议 |
| POST | `/api/commands/:id/action` | `request_close` / `confirm_close` / `cancel_draft` |
| POST | `/api/sweep` | 手动掉线扫描 |
| GET | `/api/audit` | 审计台账（只追加） |

端到端冒烟测试：`node envconsole/smoke.mjs`（需先启动服务，覆盖事件合并、联锁、换人、更正重判等 36 项断言）。
