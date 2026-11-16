# 道路交付的车道分段与路口连接采集

Node.js 22.23.4 ESM 资料接入服务。服务同时提供两条路径：legacy 单文件预览（原始字节留存和重复导入）与 managed 结构化接入。`docs/protocol.md`说明获授权来源的资料范围、引用语义和修订行为，`fixtures/raw`是极小本地合成原件，不含真实机构账号或个人数据。

## 环境与可执行命令

只需要Linux、Node.js 22.23.4和npm，无第三方包。package-lock.json与源码共同保存，安装、测试和运行不下载任何资料或依赖。

```sh
npm run build
npm test
npm run demo
```

build逐个检查src、simulator、scripts、test、acceptance内的ESM语法；test验证旧版预览、来源HTTP缓存与故障响应、存储重开，以及OpenDRIVE规范化与拓扑解释单元规则。demo当场创建空目录并启动真实回环HTTP服务、调用managed采集后打印取得的记录、来源证据、未决诊断和请求列表；结束时关闭服务并清理临时目录。它不是日志回放，也不会把未决关系说成已闭合。固定小样本预计数秒，可在90秒内现场展示。

## 调用边界

`collect({base,repository,mode})`是采集入口，默认旧预览模式；`mode:'managed'`供上层请求结构化接入。返回值延续imported和complete，complete只能表示协议下已核对的完成状态，不可由HTTP200或预览成功推断。managed 返回值另含 documentLevel（取得/缺件/降级计数）与 relationLevel（confirmed/unresolved/isolated 计数）；任一文档缺件或降级、任一连接未决、任一未建模字段未解释，complete 都为 false。

`Repository`中的records、evidence、cursors、notes是现有持久化接口，可为业务一致性扩展结构及事务；旧记录和原始字节应继续可读。managed 模式额外持久化 documents（文件索引与版本链）、interpretations（按 digest 留存的规范化解释）、relationships（当前已确认关系，同时发布到 records）、history（confirmed/revised/withdrawn/unresolved/resolved 追加式版本流水）与 unresolvedKeys/isolatedKeys/documentNotes 诊断索引。撤回关系只移动当前视图并在 history 留痕，不删除任何 raw 证据或旧版解释。

`createSource({scenario:'legacy'|'feature'})`创建本地来源，提供base/state/requests/close；legacy只含首个文件，feature开放整组关联资料。测试用state.round、failDoc、missingDoc驱动来源变动，采集端只经HTTP观察这些变化，不读取模拟器内部数据。详细字段及公开行为矩阵见协议。

## 结构化接入如何判定连接

- 复合身份是 `road id : laneSection s : lane id`，文件名不参与身份；同号车道在不同道路或分段中是不同对象，绝不按编号或几何距离补连。
- 道路直连必须同时满足：两侧 road link 互相指向、contactPoint 在匹配边界相遇、两侧车道 link 互相指向、边界宽度多项式可求值且非零，才发布 `status=confirmed`，并保留两侧 xodr 的 documentId/path/revision/精确位置。
- 任一条件不满足（缺件、单侧声明、contactPoint 矛盾、车道缺失、宽度为零或不可求值）只产出带资料位置与原因的 `unresolved-link` note，对应连接保持未决，不影响其他已确认关系。
- 路口 junction laneLink 以 junction 文件为权威来源；引用的道路或车道缺失时连接未决（含 junction/connection 上下文），缺 junction 文件只让引用该路口的连接未决。
- 未建模元素与属性进入 isolated 诊断，不能被称作已解释。

## 特性验收与恢复

```sh
npm run acceptance
```

acceptance与基线回归分开，覆盖协议验证矩阵：跨文件复合身份与 contactPoint 方向、重复投递与重开不膨胀、缺件/503/404 隔离与补件恢复、round=2 修订撤回与旧版拓扑留痕、零宽度与未知宽度边界、未建模字段隔离、路口缺失车道，以及在“原件已留存、关系尚未提交”边界终止进程后的识别与续跑。请按协议继续增加缺件、引用冲突、修订、数据边界及进程终止恢复的测试，不能删断言、固定输出样本答案或让原始证据与规范化结果错位。

## 离线容器

```sh
docker build --pull=false -t opendrive-lanes:local .
docker run --rm --network none opendrive-lanes:local npm test
docker run --rm --network none opendrive-lanes:local npm run demo
```

Dockerfile使用node:22.23.4-bookworm-slim，不安装额外依赖。镜像准备好后正式命令禁网运行，来源和接入器在同一应用容器中通过回环HTTP协作，无需浏览器、设备、外部数据库或额外容器。
