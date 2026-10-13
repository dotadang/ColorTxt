#!/bin/bash
# 彩读鸿蒙版命令行构建脚本
# 用法: ./build.sh [assembleHap]
# 说明: 使用 DevEco Studio 自带的 arm64 工具链（node/JBR/SDK/hvigor），
#       不依赖系统 Java（系统里若只有 x86 JDK 会导致打包失败）。

set -e

DEVECO=/Applications/DevEco-Studio.app/Contents
export NODE_HOME="$DEVECO/tools/node"
export DEVECO_SDK_HOME="$DEVECO/sdk"
export JAVA_HOME="$DEVECO/jbr/Contents/Home"
export PATH="$NODE_HOME/bin:$JAVA_HOME/bin:$PATH"

cd "$(dirname "$0")"

TASK="${1:-assembleHap}"
"$DEVECO/tools/hvigor/bin/hvigorw" --no-daemon "$TASK"

echo ""
echo "产物: entry/build/default/outputs/default/"
