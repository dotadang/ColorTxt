#!/bin/bash
# 彩读鸿蒙版一键迭代：Web 构建 → HAP 构建 → 真机安装 → 启动
# 用法: ./harmony/deploy.sh
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> 1/3 构建移动 Web 包"
npm run build:mobile

echo "==> 2/3 构建 HAP"
./harmony/build.sh > /dev/null

echo "==> 3/3 安装并启动"
HDC=/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains/hdc
"$HDC" install -r harmony/entry/build/default/outputs/default/entry-default-signed.hap
"$HDC" shell aa start -a EntryAbility -b com.ssnangua.colortxtmobile && echo "已启动（若手机锁屏请解锁后手动点开）"
