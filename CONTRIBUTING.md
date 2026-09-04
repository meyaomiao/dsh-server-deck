# 协作

改这个仓库（代码、配置、CI、非平凡文档）之前先有 Issue。只读解释不必开。

默认链路：

```
聊天拍板 → Issue（或更新已有单）
        → 独立分支 issue-N-slug（不要占用 main checkout）
        → 最小完整改动 + 本地验证
        → Draft PR（做完应关单用 Closes #N，索引用 Refs #N）
        → CI 绿
        → 维护者 Review → Ready → merge 到 main
        → 用户明确说「发布」之后才 npm publish / 打 tag
```

铁律：

- 一个执行 Issue，一个分支，一个 PR。
- 执行者停在 Draft PR，不自行 Ready / merge / 发版。
- `main` 是唯一长期开发线。
- 合并 ≠ 上线。生产发布必须单独授权。
- 关单看用户效果，不看「有相关文件」或 Release notes。

思考原则、角色、关单标准见 [AI-ISSUE-WORKFLOW.md](./AI-ISSUE-WORKFLOW.md)。

标签最少：`type:`（feat / bug / docs / cleanup）+ `priority:`（p1 / p2）+ 可选 `status:blocked`。
