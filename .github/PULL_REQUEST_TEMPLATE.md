## 改了什么、为什么

（一段话。如果是修缺陷，写清它防的是哪个真实事故）

## 检查

- [ ] `npm run typecheck && npm test` 全绿
- [ ] 改了 `src/` 有对应测试；改了主循环行为在 `ticketRunner.integration.test.ts` 有场景
- [ ] 面向人的文案（群里提示、卡片措辞）没有无意改动
- [ ] 改了用户可见行为 → 同步 `ONBOARDING.md` / `docs/commands.md`
- [ ] 改了配置项 → 同步 `.env.example` / `docs/configuration.md`
- [ ] 改了契约字段 → pipeline-plugin 同时出 PR，版本号已升
- [ ] 没有提交 `.env`、`data/`、`logs/`，日志片段已脱敏
