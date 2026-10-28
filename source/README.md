# Locus — концепт склада с роботами

Концепт-сайт: 3D-склад электрических компонентов, по которому постоянно ездят роботы.
Ничего не сохраняется — после перезагрузки страницы демо-склад начинается заново.

## Как это работает
- 18 зон, 240 стеллажей, ~24 500 коробок. Всё живёт в памяти браузера.
- Симуляция идёт всегда: на Receiving приходят коробки, роботы раскладывают их по адресам;
  появляются заказы, роботы везут коробки на Dispatch, оттуда они уезжают к клиенту.
  Поток сам держит запас на уровне стартового.
- Действия пользователя превращаются в работу для роботов:
  - **Receive** — коробки приезжают на Receiving, робот отвозит их на выбранный адрес;
  - **Move** (в карточке адреса или коробки) — робот перевозит коробки;
  - **Ship** — заказ в Orders (или кнопка Ship в карточке коробки), робот везёт коробку на Dispatch.
- **Edit layout** (меню аватара) — зоны и стеллажи, Undo последних 10 изменений.
  Роботы перестраивают маршруты под новую планировку.
- Inventory, History, Live floor / Orders / Fleet — живые представления той же симуляции.

## Разработка
```
npm install
npm run dev     # http://127.0.0.1:5173
npm test        # логика склада и роботов
npm run build   # сборка в dist/
```
Папка `../locus-cloudflare` — содержимое `dist/` для деплоя на Cloudflare Pages.

Главные файлы: `main.js` (интерфейс), `warehouse-robots.js` (симуляция — единственный источник
данных о коробках), `scene.js` (3D), `model.js` / `storage.js` (склад, адреса, стеллажи).

### Blender models

`assets/warehouse-models.json` contains the evaluated carton, pallet and Airis meshes exported from the warehouse Blender scene. `scripts/export-blender-assets.py` regenerates them; set `LOCUS_ASSET_OUTPUT` to the absolute output JSON path before running the script in Blender. The source objects are `Главная коробка`, `Главный поддон` and `Робот • без груза`. Export does not change the scene.

Carton tape and handling symbols are geometry. Robot wheels, flush LEDs and its single black platform come from Blender. Geometry and materials are shared across clones; shelf cargo is instanced by material. Pallet bevels are omitted at warehouse scale to reduce triangles; warm wood grain is recreated in the web shader. Blender procedural cardboard bump is not exported. Racks remain parametric to preserve editable dimensions and storage addresses, with uniform grey metal and pallets sized to each address. Cargo placement and robot handoffs share the pallet support height.

Run `npm test` and `npm run build`, then copy the contents of `dist/` to `../locus-cloudflare/` for the existing Cloudflare Pages deployment.

### Rendering budget

The warehouse overview uses 12-triangle carton silhouettes; selecting a rack restores its Blender carton details. Pallets use two shared instance batches, with detailed boards within 45 scene units of the camera or on the selected rack. LOD matrices refresh after 2 units of camera movement or a selection change. This reduces overview carton/pallet geometry from 5,059,368 to 379,752 triangles on the seeded 24,446-box, 7,200-pallet layout (92%; excludes rack steelwork, robots and extra shadow passes). This is a geometry budget, not a measured FPS guarantee.

Cargo buffers are reused between inventory changes, growing only when needed. Shadows update at most 20 times per second; camera and robot motion retain the display frame rate. `warehouse-lod.test.js` covers LOD transitions, resource reuse, bounds and the seeded geometry budget.

### Cloudflare Workers Builds

The repository root contains `wrangler.jsonc` for the existing Worker `warehouse`. It serves the committed `locus-cloudflare/` directory. Set the Workers Builds root directory to the repository root; the deployment command is `npx wrangler deploy`. No build command is required when deploying the committed bundle. The configured preview-branch command is `npx wrangler preview`; it requires the top-level `previews: {}` block in `wrangler.jsonc`. Assets and compatibility settings remain at the top level.

Validate the deployment configuration from the repository root with `npx wrangler deploy --dry-run`. This checks packaging without publishing. If a Cloudflare check fails before a build log is produced, inspect the account/build settings in the Cloudflare dashboard; local application tests cannot validate those settings.
