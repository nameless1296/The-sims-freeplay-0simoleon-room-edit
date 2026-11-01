# FreePlay 建造机制参考研究

本文件记录在实现 L 型房间之前所做的原版参考资料核实，作为规格书 §6.3 与
「先取得真实 FreePlay 参考截图，再实现 L 型几何逻辑」这一开发要求的证据。

截图来源：**The Girl Who Games** 的 FreePlay 建造教程（2020 年版，含 Renovator 分步图），
已保存在 `docs/refs/` 目录内。

---

## 1. 原版操作流程（分步图 1–7）

| 步骤 | 说明 | 截图 |
|---|---|---|
| 1 | 进入 ROOMS / 家具建造模式。提示原文：*"To build a room, hold and drag on the grass or anywhere within an existing house. A green room means it's clear to build, red means that it cannot be built."* | `freeplay-renovator-guide.jpg` 上 |
| 2 | 点击橙色 **Room Renovator** 按钮（与普通 Room 按钮成对出现，可来回切换） | 同上 |
| 3 | 房间四角出现**黄色 L 形边框 + 黄色箭头锚点**，锚点外侧另有白色三角（表示可拖出）。提示原文：*"Drag out a yellow arrow anchor point to extend a wall out. A green extrusion means it's clear to build, red means that it cannot be built. Tap the orange Room Renovator button to swap between the regular Rooms and Room Renovator modes."* | `freeplay-anchor-corners.png` |
| 4 | 拖动锚点后，房间从该角**拉出一条 1 格厚的条带**，条带尽头显示绿色勾 / 红色叉 / 价格 | `freeplay-drag-extend.png` |
| 5 | 点绿色勾确认 | 同上 |
| 6 | 切回普通 **Room** 模式，仍可拖动该段使其**变宽 / 变窄**，再确认 | `freeplay-renovator-guide.jpg` 左下 |
| 7 | 最终是**一个完整的 L 型房间**（墙体连续、内部无隔墙） | `freeplay-renovator-guide.jpg` 右下 |

## 2. 从截图推出的几何规则

1. 可延伸的锚点位于**矩形房间的 4 个角**，每个角两个方向（沿水平墙、沿垂直墙），
   因此有 8 个可拖动方向。
2. 延伸条带**只有 1 格厚**，其余部分保持不动 —— 因此结果必然是一个「缺一个角的矩形」，
   即标准 L 型。
3. 条带长度 k 格 → footprint 在该方向加长 k 格，同时在对角挖去 `k × (另一方向 − 1)`
   的区域。面积精确增加 k 格。
4. L 型始终是**单个房间**，可以继续用普通 Room 模式调整延伸段宽度。
5. 延伸缩短到 0 格时房间回到矩形。

## 3. 本项目的实现映射

| 规则 | 代码位置 |
|---|---|
| 8 个锚点（4 角 × 2 方向） | `editor.js → anchorsOf()` |
| 延伸数学（1 格厚条带） | `geometry.js → renovatorExtend()` |
| 只有矩形才能再延伸 | `renovatorExtend()` 开头 `if (isL(room)) return null` |
| 延伸段宽度调整 | `geometry.js → innerCornerOf() / setInnerCorner()`（Select & Renovator 两种模式都可用） |
| 缩到 0 格还原矩形 | `geometry.js → normalizeShape()`、`toRectangle()` |
| 绿色/红色拖动预览 | `editor.js → setPreview()` + `drawPreview()` |
| 只能矩形或 L | `geometry.js` 数据模型本身（footprint + 单个角缺口） |

## 4. 其它核实到的旁证

- 官方建造提示：*"Drag on walls marked with a white highlight to resize existing rooms."* ——
  本项目用白色方块手柄表示可拖动的边/角。
- 最小房间 **1 × 2**（1 × 1 不存在），与规格书 §5.2 完全一致。
- 地块尺寸：Standard 18 × 18、Premium（Ocean View）18 × 36、Penthouse 26 × 12。
- 房间之间可以共用墙线；无法把两个房间合并，也没有「删墙」功能 —— 与本项目
  「允许相邻、不允许重叠、删除不影响其它房间」一致。

## 5. 未采用的 FreePlay 细节（及原因）

| 细节 | 不采用原因 |
|---|---|
| 建造费用（Simoleons）与绿色勾/红色叉确认按钮 | 平面规划工具无货币概念；用手势松手 + 撤销替代确认步骤 |
| 多楼层 / 房间上方有房间时禁止删除 | 规格书 §9 明确 V1.0 不做多楼层 |
| 同尺寸相邻房间可联动缩放 | FreePlay 特有联动，规格书未要求，且与「删除不得影响其他房间」的独立性原则冲突 |
| U / T / 十字等复合形状 | 违反永久设计原则 §1.1 |
