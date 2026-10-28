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
