# 牛津树单词骑士 (Oxford Word Knight)

基于牛津树 G1→G2 分级体系的单词学习游戏。

## 快速开始

### 1. 安装依赖
```bash
cd oxford-word-knight
npm install
```

### 2. 启动服务器
```bash
npm start
```

### 3. 打开游戏
浏览器访问: http://localhost:3000

## 字库导入

### CSV 格式要求
文件必须包含以下三列（英文逗号分隔）：
```
oxford_level,word,hint
G1,run,快速移动
G1,jump,离开地面的动作
G2,algorithm,解决问题的步骤
```

- `oxford_level`: 仅支持 `G1` 或 `G2`
- `word`: 英文单词（必填）
- `hint`: 中文提示（可选）

### 导入方式
1. 在 Excel 中编辑字库
2. 文件 → 另存为 → CSV (逗号分隔)
3. 在游戏页面点击上传按钮选择 CSV 文件

或直接调用 API:
```bash
curl -X POST http://localhost:3000/api/import \
  --data-binary @sample-words.csv
```

## API
- `GET /api/words?level=G1` - 随机获取10个单词
- `GET /api/stats` - 查看字库统计
- `POST /api/import` - 导入CSV字库

## 项目结构
```
oxford-word-knight/
├── backend/
│   └── server.js       # Node.js 后端
├── frontend/
│   └── index.html      # 游戏前端
├── sample-words.csv    # 示例字库
└── package.json
```

## 依赖
- Node.js v18+
- better-sqlite3 (SQLite数据库)
- csv-parse (CSV解析)
