# 道路交付的车道分段与路口连接采集接入约定

## 来源获取

获授权供应方网关 `/roadnet` 返回文件目录、相对path、原始格式、修订号与href。GET `/raw/路径` 获得原始字节，ETag与内容绑定，条件请求304不带正文。legacy只开放第一项，feature开放完整本地资料；不需要访问真实机构或下载生产数据。目录不是完成性证明，文件可有503或404，源缺件和字段未决分别记录。真实格式范围以本文profile为准，不要求实现所引标准所有未使用扩展。

## 数据解释

源端把OpenDRIVE按road/junction拆交，文件名不是道路身份。road id、laneSection s、lane id共同确定局部车道。道路直连只有两侧声明、端点方向及宽度一致才作为confirmed发布。sample r1终点到r2起点是确认连接，输出id=r1:0:-1->r2:0:-1、status=confirmed，sourcePaths至少含两个xodr。j1连接的missing-road不存在，notes含kind=unresolved-link及junction=j1，不按同号车道补连。宽度多项式只在端点求值以判断连接声明是否适用，不要求几何渲染。

## 修订和补件

本地测试可用 `source.state.round=2` 驱动一次修订：road-2把predecessor lane id改成-2，旧连接应不再被声明confirmed，并保留单侧矛盾来源。 `state.failDoc`、`state.missingDoc`可设为目录document.id，分别模拟临时失败与缺件，清空后恢复。采集端只能经HTTP观察，不允许读取source.state或fixture.expectedIds作为采集结果。fixture.expectedIds仅是公开验收对照。原始资料及解释版本需要可核对；失败不能使已确认内容凭空消失。把已取得的文件索引、源端修订、规范化记录及字段来源协同持久化；存储结构可扩展，不规定实现架构。

完整性至少区分取得文件与解释关系两个层次；已隔离的未知字段不能被称作已解释。managed 返回的 documentLevel 统计 total/available/missingOrFailed/degraded，relationLevel 统计 confirmed/unresolved/isolated；任一文档缺件或凭旧证据降级、任一连接未决或任一字段被隔离，complete 都为 false。notes为现有人工诊断入口，可扩展结构，但信息应包含具体资料位置（locations）和未决原因（reason）。文件级原始证据由Repository.retain保留。legacy的人工预览入口继续可用；managed模式负责结构化接入。

managed 持久化在 Repository.state 上扩展 documents（文件索引与 revisions 版本链）、interpretations（按内容 digest 留存的规范化解释，含 documentId/path/revision）、relationships（当前已确认关系，同时发布到 records）、history（confirmed/revised/withdrawn/unresolved/resolved 追加式版本流水，撤回与修订均保留 previous 记录）以及 unresolvedKeys、isolatedKeys、documentNotes 去重索引。采集分 planned/fetched/interpreted/committed 四阶段并逐阶段写 managed 游标；在原件已留存而关系尚未提交时终止进程，重跑可由 evidence 与游标重建文件索引并续跑，不重复抓取、不丢失已确认内容。

## 验证矩阵

1. 按样本跨文件完成 道路/分段/车道复合身份 与 contactPoint方向与边界，不以读取目录或预览摘要代替。
2. 对同一原始资料重复投递及重开存储，规范化身份不膨胀，来源证据仍可追溯。
3. 路口laneLink关联 不因缺件或顺序改变而被默认值掩盖；补件后只重解释受影响对象。
4. 使用round=2比较新旧解释，说明 宽度边界及分片补交 如何留痕。
5. 在原始资料已保存、关系尚未提交等边界终止进程，再启动能识别待完成工作；不得靠固定样本答案实现。

`acceptance/managed.test.mjs`仅覆盖关键正例及重启重投，改动时需按以上矩阵增加适合方案的异常和来源变化测试。资料未齐时保留可解释未决，不为“通过”填充不存在的源值。
