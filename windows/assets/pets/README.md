# 自定义桌宠格式

在客户端的“桌宠 → 打开自定义桌宠目录”中打开用户目录。每个桌宠使用一个独立文件夹，至少包含 `pet.json` 和一张透明背景图片。

```json
{
  "id": "my-pet",
  "name": "我的桌宠",
  "author": "作者名",
  "actions": {
    "idle": "idle.png",
    "thinking": "thinking.png",
    "executing": "executing.png",
    "success": "success.png",
    "error": "error.png"
  }
}
```

- `id` 只能使用英文字母、数字、短横线和下划线。
- `idle` 必填，其余动作可省略；省略时自动使用 `idle`。
- 支持 PNG、WebP 和 GIF。建议使用透明背景、正方形画布和相近的人物尺寸。
- 新增文件后，在桌宠设置中点击“刷新角色列表”。
