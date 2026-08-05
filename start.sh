#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"
echo "🚀 牛津树单词骑士"
echo "   后端 API:  http://localhost:3000/api/words?level=G1"
echo "   字库统计:  http://localhost:3000/api/stats"
echo "   游戏页面:  http://localhost:3000/"
echo ""
node backend/server.js
