# 赛鸽血统环号登记站 / 鸽舍环控监测台

运行：

```bash
npm start
```

- 鸽籍登记：`http://localhost:3024/`，支持档案、血统查询、转让和归巢成绩。
- 环控监测台：`http://localhost:3024/env`，展示测点、越界事件、风机指令与留档记录。

## 环控监测台

每个测点按「棚号 + 测点名称 + 设备号」登记，上报温度、湿度、氨气和采样时刻。

判定阈值（`src/judge.js`）：温度 5–30℃、湿度 40–80%、氨气 ≤20ppm；采样时刻超过 30 分钟视为不可用。

规则：

- 读数越界生成未结事件；同一测点同一指标连续越界并入原事件，不重复开单。
- 读数恢复正常后事件自动办结。
- 越界后系统只生成「待复核」开风机指令；设备掉线、读数缺失或采样超期时禁止自动开风机（页面申请和复核下发都会拦截）。
- 值班员复核后指令才下发，风机状态随之切换；关闭指令必须由另一名值班员确认（确认人与复核人不能相同）。
- 读数可更正：旧版本保留（`superseded` 留档），事件与指令按新值重新判定——事件办结/新开、依据消失的待复核指令撤销。
- 更正、事件办结、指令撤销/关闭、拦截自动开风机均写入留档记录。

代码按职责拆分：

| 模块 | 职责 |
| --- | --- |
| `src/store.js` | 存档：数据加载/保存、留档写入 |
| `src/judge.js` | 判定：阈值、越界、事件归并、指令生成与更正重判 |
| `src/envApi.js` | 请求入口：`/api/env/*` 路由，只做解析/调用/落库 |
| `src/envPage.js` | 监测台页面（测点、事件、指令） |
| `src/http.js` | 公共 HTTP 工具 |

API：`GET /api/env/overview`、`POST /api/env/points`、`POST /api/env/readings`、`POST /api/env/readings/:id/correct`、`POST /api/env/commands`、`POST /api/env/commands/:id/review`、`POST /api/env/commands/:id/close`。

数据保存在 `data/pigeons.json`（鸽籍与环控共用一个文件），可用 `DB_PATH` 环境变量指定其他存档路径。
