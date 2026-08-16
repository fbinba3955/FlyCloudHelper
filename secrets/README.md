# Docker Secret 文件

此目录只提交说明文件，实际 Secret 已被 `.gitignore` 忽略。

- `credential-master-key.txt`：可选的外部主密钥，至少 32 个字符；未提供时服务会自动生成并在首次设置后提示备份。

TMDB Key 不再通过 Docker Secret 文件配置，请登录超级管理员后台并进入“系统配置”页面维护。

使用 Secret 覆盖配置启动：

```sh
docker compose -f compose.yml -f compose.secrets.yml up -d --build
```
