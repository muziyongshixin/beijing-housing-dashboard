#!/bin/zsh
# Run in the user's Terminal: credentials never go into source or chat.
set -eu
cd "${0:A:h:h}"
print "请在 Supabase 官方页面完成登录，并将网页验证码粘贴到这个终端。"
print "此步骤仅授权本机 CLI，不建表、不上传数据、不发布网站。"
npx --yes supabase@2.117.0 login --agent no --output-format text
print "检查目标项目是否对当前账号可见："
npx --yes supabase@2.117.0 projects list --output json --agent no
print "授权完成。回到对话告诉我即可；不需要发送密码或密钥。"
read -r "?按回车关闭此窗口…"
