# 入口与隐式关系发现手册

新语言、新框架或首次接手时读本文件。目的：**先把"哪里有入口"和"关系可能藏在哪"找全，再开始逐个读代码**。找漏入口是遗留系统分析最常见的失败原因——前端看不出来的定时任务、消息消费者、管理后台接口往往才是真正的业务主干。

## 1. 通用探测顺序

1. 构建/依赖清单（`pom.xml`、`build.gradle`、`package.json`、`go.mod`、`requirements.txt`、`Cargo.toml`、`.csproj`）
2. 应用启动入口与配置文件（`main`、`Application.*`、`bootstrap.*`、`appsettings.json`、`*.yaml`）
3. 路由/注册表（路由文件、注解、装饰器、注册中心配置）
4. 定时与异步注册（`@Scheduled`、cron、`setInterval`、队列监听声明）
5. 测试目录——测试常是唯一的"正确用法说明书"

## 2. 入口类型与常见位置

| 入口类型 | 典型声明 | 容易漏的点 |
|---|---|---|
| HTTP / REST | `@RestController`、`@RequestMapping`、`app.get`、`Route::`、DRF `ViewSet` | 网关层转发的路径、版本前缀、`@RequestMapping` 类级+方法级拼接 |
| RPC / IDL | Dubbo `@DubboService`、gRPC `service`、Thrift `service` | proto/thrift 文件与实际实现不同步 |
| 消息消费 | `@KafkaListener`、`@RabbitListener`、`@RocketMQMessageListener`、消费者配置文件 | **订阅关系常写在配置文件或平台控制台，不在代码里** |
| 定时任务 | `@Scheduled`、xxl-job 注册、Quartz Job、`crontab`、K8s CronJob | 任务清单在调度平台配置，代码里只有 handler |
| 管理后台 / 内部接口 | 独立的 admin 模块、`/internal/**`、`@Inner` 类注解 | 常被误排除出"业务功能"范围 |
| 命令行 / 脚本 | `argparse`、`commander`、`flag` | 批处理脚本其实承担核心业务 |
| CLI 事件 / 前端交互 | 按钮回调、`useEffect`、`watch`、事件总线 | 前端功能入口要回溯到后端接口才算闭环 |
| Webhook / 回调 | `/callback`、`/notify`、第三方平台配置 | 第三方后台配置的 URL 在代码里查不到 |
| 数据库触发 / 存储过程 | trigger、procedure | 数据变更可能由 DB 侧发起 |

## 3. 隐式关系：静态图看不见的地方

以下机制会让调用图缺失真实关系，**"没找到调用方"不等于"没有调用方"**。

- **反射与动态调用**：`Class.forName`、`getMethod().invoke`、`system.Reflection`、Python `getattr`、JS 动态 `import()`
- **依赖注入**：Spring `@Autowired` 按接口注入、Guice、.NET DI 容器注册——实现类可能在配置文件里绑定
- **动态路由**：网关 `StripPrefix` 重写、Nginx `rewrite`、`context-path`、前端 baseURL 与服务端前缀不一致
- **框架自动装配**：Spring Boot starter、NestJS 模块、Django app 注册、扫描包路径
- **AOP / 拦截器 / 中间件**：切面改变执行语义，调用图上表现为直接调用
- **消息与事件总线**：topic 名字符串拼接、事件常量类、生产端消费端命名不一致
- **配置驱动的分支**：特性开关、多租户路由、灰度名单，决定哪个分支真正生效
- **序列化映射**：DTO 与实体映射、ORM 隐式关联、`@ManyToOne` 懒加载触发的额外查询
- **SQL 与视图**：MyBatis XML、视图、存储过程里的关联，ORM 代码里完全看不到

## 4. 反向核验动作

想确认"谁在改这张表/这个字段"时，不要只看 ORM 代码：

1. 全局搜表名、字段名的字符串字面量（含 XML、SQL 文件、脚本）
2. 搜 mapper / repository 的方法名与注解
3. 搜数据库触发器和存储过程定义
4. 搜定时任务与消息消费者（它们常绕过业务层直接写库）
5. 查数据变更日志或 binlog 工具配置（若有）
6. 搜报表/ETL/数据同步任务（外部系统可能在写同一张表）

## 5. 工具探测提示

- 先 `which` / `--version` 确认工具存在，不硬编码命令名。
- 图谱类工具适合找"有哪些"，不适合证明"运行时一定发生"。
- 语言服务（LSP）适合精确定位符号与引用，比正则搜更可靠。
- 工具失败时记录：工具名、失败现象、影响范围、替代方法，写进交付说明。
