# 道路交付的车道分段与路口连接采集

Node.js 22.23.4 ESM 资料接入服务。现有服务提供单文件预览、原始字节留存和重复导入；自动结构化接入由managed模式调用。`docs/protocol.md`说明获授权来源的资料范围、引用语义和修订行为，`fixtures/raw`是极小本地合成原件，不含真实机构账号或个人数据。

## 环境与可执行命令

只需要Linux、Node.js 22.23.4和npm，无第三方包。package-lock.json与源码共同保存，安装、测试和运行不下载任何资料或依赖。

```sh
npm run build
npm test
npm run demo
```

build逐个检查src、simulator、scripts、test、acceptance内的ESM语法；test验证旧版预览、来源HTTP缓存与故障响应、存储重开。demo当场创建空目录并启动真实回环HTTP服务、调用采集器后打印取得的记录、来源证据和请求列表；结束时关闭服务并清理临时目录。它不是日志回放，也不会把预览结果说成完整接入。固定小样本预计数秒，可在90秒内现场展示。

## 调用边界

`collect({base,repository,mode})`是采集入口，默认旧预览模式；`mode:'managed'`供上层请求结构化接入。返回值延续imported和complete，complete只能表示协议下已核对的完成状态，不可由HTTP200或预览成功推断。`Repository`中的records、evidence、cursors、notes是现有持久化接口，可为业务一致性扩展结构及事务；旧记录和原始字节应继续可读。

`createSource({scenario:'legacy'|'feature'})`创建本地来源，提供base/state/requests/close；legacy只含首个文件，feature开放整组关联资料。测试用state.round、failDoc、missingDoc驱动来源变动，采集端只经HTTP观察这些变化，不读取模拟器内部数据。详细字段及公开行为矩阵见协议。

## 特性验收与恢复

```sh
npm run acceptance
```

acceptance与基线回归分开。当前预览器尚不产生结构化业务关系，因此其中两项业务断言预期失败；这是新增能力，不是依赖或启动问题。请按协议增加缺件、引用冲突、修订、数据边界及进程终止恢复的测试，不能删断言、固定输出样本答案或让原始证据与规范化结果错位。

## 离线容器

```sh
docker build --pull=false -t opendrive-lanes:local .
docker run --rm --network none opendrive-lanes:local npm test
docker run --rm --network none opendrive-lanes:local npm run demo
```

Dockerfile使用node:22.23.4-bookworm-slim，不安装额外依赖。镜像准备好后正式命令禁网运行，来源和接入器在同一应用容器中通过回环HTTP协作，无需浏览器、设备、外部数据库或额外容器。
