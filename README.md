# 麦麦插件商店 V3

麦麦（MaiBot）插件商店的前端展示页，使用 React、TypeScript 和 Vite，结合 WebGPU 与 WGSL 实现视觉效果。页面读取仓库内的插件目录快照，提供搜索、分类筛选与详情展示。

## 本地开发

需要 Node.js 24 或更高版本，以及 pnpm。

```bash
pnpm install --frozen-lockfile
pnpm dev
```

开发地址为 `http://localhost:5180`。仓库已包含 `public/data/catalog.json` 和插件图标，可直接启动。

## 检查与构建

```bash
pnpm check
pnpm build
pnpm preview
```

`pnpm check` 依次检查格式、Lint、TypeScript 类型和 WGSL 着色器。构建产物位于 `dist/`，预览服务使用端口 `5180`。

## 更新插件数据

`scripts/sync-data.ts` 从独立的 `maibot-plugin-market` 数据目录生成插件快照，并替换 `public/icons/` 下的图标。默认读取相邻目录 `../maibot-plugin-market/data`：

```bash
pnpm sync:data
```

也可以指定数据目录：

```bash
MAIBOT_MARKET_DATA=/path/to/maibot-plugin-market/data pnpm sync:data
```

源目录需要包含 `normalized/plugins.json`、`normalized/categories.json`、`normalized/authors.json` 和 `icons/`。同步后的 `public/data/catalog.json` 和 `public/icons/` 需要一起提交；日常开发和构建不需要重新同步。

## 目录

- `src/components/`：页面和交互组件。
- `src/data/`：目录类型、读取、搜索与排序。
- `src/map/`：地图布局与相机交互。
- `src/gpu/`：WebGPU 渲染和 WGSL 着色器。
- `src/styles/`：样式与设计变量。
- `public/`：随构建发布的插件快照、图标等静态资源。
- `scripts/`：数据同步脚本。
